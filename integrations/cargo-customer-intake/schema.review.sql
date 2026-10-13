-- REVIEW ONLY. Customer email OTP + encrypted intake queue.
-- DO NOT apply to live Supabase while cargo_intake_control.intake_enabled=false.
-- Do not grant access to anon/authenticated; only the guarded Edge Function
-- with service_role may read or modify these records.
begin;

create table public.cargo_customer_intake_drafts (
 id uuid primary key,
 attempt_id uuid not null unique,
 contact_hmac bytea not null check(octet_length(contact_hmac)=32),
 encrypted_payload bytea,
 constraint cargo_customer_draft_payload_check check (
  (consumed_at is null and encrypted_payload is not null and octet_length(encrypted_payload)>=29)
  or (consumed_at is not null and encrypted_payload is null)
 ),
 code_hmac bytea not null check(octet_length(code_hmac)=32),
 attempts smallint not null default 0 check(attempts between 0 and 5),
 created_at timestamptz not null default now(),
 expires_at timestamptz not null,
 consumed_at timestamptz,
 delete_after timestamptz not null default (now()+interval '30 minutes'),
 constraint cargo_customer_draft_validity check (expires_at<=delete_after)
);
create index cargo_customer_intake_drafts_cleanup_idx
 on public.cargo_customer_intake_drafts(delete_after);

create table public.cargo_customer_intake_requests (
 id uuid primary key default gen_random_uuid(),
 source_draft_id uuid not null unique,
 contact_hmac bytea not null check(octet_length(contact_hmac)=32),
 encrypted_payload bytea not null check(octet_length(encrypted_payload)>=29),
 status text not null default 'pending_operator_review'
  check(status in ('pending_operator_review','operator_reviewing','declined','quoted','closed')),
 created_at timestamptz not null default now(),
 -- Retention policy MUST be approved and automated before launch.
 delete_after timestamptz not null default (now()+interval '30 days')
);
create index cargo_customer_intake_requests_status_idx
 on public.cargo_customer_intake_requests(status,created_at);

alter table public.cargo_customer_intake_drafts enable row level security;
alter table public.cargo_customer_intake_requests enable row level security;
revoke all on public.cargo_customer_intake_drafts from public,anon,authenticated;
revoke all on public.cargo_customer_intake_requests from public,anon,authenticated;
grant select,insert,update,delete on public.cargo_customer_intake_drafts to service_role;
grant select,insert,update on public.cargo_customer_intake_requests to service_role;

-- Exactly-once OTP consumption and queue creation share ONE DB transaction.
-- A false return never creates a customer queue entry.
create or replace function public.cargo_customer_intake_verify_commit(
 p_draft_id uuid,p_code_hmac bytea
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
 v_draft public.cargo_customer_intake_drafts%rowtype;
 v_request uuid;
 v_now timestamptz;
 v_attempts integer;
begin
 if p_draft_id is null or p_code_hmac is null
    or octet_length(p_code_hmac)<>32 then
   return jsonb_build_object('ok',false,'reason','INVALID_INPUT');
 end if;
 -- FOR SHARE serializes with administrative changes to the intake switch.
 perform 1 from public.cargo_intake_control
  where id=1 and intake_enabled=true
   and captcha_required=true and contact_verification_required=true
  for share;
 if not found then
   return jsonb_build_object('ok',false,'reason','PUBLIC_INTAKE_DISABLED');
 end if;
 select * into v_draft from public.cargo_customer_intake_drafts
  where id=p_draft_id for update;
 if not found then return jsonb_build_object('ok',false,'reason','NOT_FOUND'); end if;
 v_now:=clock_timestamp();
 if v_draft.consumed_at is not null then
   return jsonb_build_object('ok',false,'reason','ALREADY_USED');
 end if;
 if v_now>=v_draft.expires_at then
   return jsonb_build_object('ok',false,'reason','EXPIRED');
 end if;
 if v_draft.attempts>=5 then
   return jsonb_build_object('ok',false,'reason','LOCKED');
 end if;
 if v_draft.code_hmac<>p_code_hmac then
   update public.cargo_customer_intake_drafts
    set attempts=least(5,attempts+1) where id=p_draft_id
    returning attempts into v_attempts;
   return jsonb_build_object('ok',false,
    'reason',case when v_attempts>=5 then 'LOCKED' else 'INVALID_CODE' end);
 end if;
 insert into public.cargo_customer_intake_requests
  (source_draft_id,contact_hmac,encrypted_payload)
 values (v_draft.id,v_draft.contact_hmac,v_draft.encrypted_payload)
 returning id into v_request;
 -- Clear draft PII once moved to the operator review queue.
 update public.cargo_customer_intake_drafts
  set consumed_at=v_now,encrypted_payload=null
  where id=p_draft_id;
 return jsonb_build_object('ok',true,'reason','PENDING_OPERATOR_REVIEW',
  'request_id',v_request);
end;
$$;

revoke all on function public.cargo_customer_intake_verify_commit(uuid,bytea)
 from public,anon,authenticated;
grant execute on function public.cargo_customer_intake_verify_commit(uuid,bytea)
 to service_role;

-- Operator-only retention maintenance, not scheduled in this review.
-- Does not alter verified requests; retention for those needs operator policy.
create or replace function public.cargo_customer_intake_cleanup(
 p_limit integer default 100
) returns integer language plpgsql security invoker set search_path='' as $$
declare v_count integer:=0;
begin
 if p_limit is null or p_limit<1 or p_limit>100 then return 0; end if;
 with expired as (
  select id from public.cargo_customer_intake_drafts
   where delete_after<clock_timestamp()
   order by delete_after,id for update skip locked limit p_limit
 )
 delete from public.cargo_customer_intake_drafts d
  using expired e where d.id=e.id;
 get diagnostics v_count=row_count;
 return v_count;
end;
$$;
revoke all on function public.cargo_customer_intake_cleanup(integer)
 from public,anon,authenticated;
grant execute on function public.cargo_customer_intake_cleanup(integer)
 to service_role;
commit;
