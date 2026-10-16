create table public.cargo_staging_owner_e2e_drafts (like public.cargo_customer_intake_drafts including defaults including constraints including indexes);
create table public.cargo_staging_owner_e2e_requests (like public.cargo_customer_intake_requests including defaults including constraints including indexes);
alter table public.cargo_staging_owner_e2e_requests add foreign key (source_draft_id) references public.cargo_staging_owner_e2e_drafts(id);
create table public.cargo_staging_owner_e2e_sends (operator_id uuid primary key references auth.users(id),challenge_id uuid not null unique,created_at timestamptz not null default now());
alter table public.cargo_staging_owner_e2e_drafts enable row level security;
alter table public.cargo_staging_owner_e2e_requests enable row level security;
alter table public.cargo_staging_owner_e2e_sends enable row level security;
revoke all on public.cargo_staging_owner_e2e_drafts,public.cargo_staging_owner_e2e_requests,public.cargo_staging_owner_e2e_sends from public,anon,authenticated;
grant select,insert,update,delete on public.cargo_staging_owner_e2e_drafts to service_role;
grant select,insert,update on public.cargo_staging_owner_e2e_requests to service_role;
grant select,insert on public.cargo_staging_owner_e2e_sends to service_role;
CREATE OR REPLACE FUNCTION public.cargo_staging_owner_e2e_verify(p_draft_id uuid, p_code_hmac bytea)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
 v_draft public.cargo_staging_owner_e2e_drafts%rowtype;
 v_request uuid;
 v_now timestamptz;
 v_attempts integer;
begin
 if not exists (
 select 1 from public.cargo_staging_owner_e2e_sends s
 join public.cargo_operator_accounts a on a.user_id=s.operator_id
 join auth.users u on u.id=s.operator_id
 where s.challenge_id=p_draft_id and lower(u.email)='yuka19910307@gmail.com'
 ) then return jsonb_build_object('ok',false,'reason','OWNER_TEST_REQUIRED'); end if;
 if p_draft_id is null or p_code_hmac is null
    or octet_length(p_code_hmac)<>32 then
   return jsonb_build_object('ok',false,'reason','INVALID_INPUT');
 end if;
 -- FOR SHARE serializes with administrative changes to the intake switch.
 perform 1 from public.cargo_intake_control
  where id=1 and intake_enabled=false
   and captcha_required=true and contact_verification_required=true
  for share;
 if not found then
   return jsonb_build_object('ok',false,'reason','PUBLIC_INTAKE_DISABLED');
 end if;
 select * into v_draft from public.cargo_staging_owner_e2e_drafts
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
   update public.cargo_staging_owner_e2e_drafts
    set attempts=least(5,attempts+1) where id=p_draft_id
    returning attempts into v_attempts;
   return jsonb_build_object('ok',false,
    'reason',case when v_attempts>=5 then 'LOCKED' else 'INVALID_CODE' end);
 end if;
 insert into public.cargo_staging_owner_e2e_requests
  (source_draft_id,contact_hmac,encrypted_payload)
 values (v_draft.id,v_draft.contact_hmac,v_draft.encrypted_payload)
 returning id into v_request;
 -- Clear draft PII once moved to the operator review queue.
 update public.cargo_staging_owner_e2e_drafts
  set consumed_at=v_now,encrypted_payload=null
  where id=p_draft_id;
 return jsonb_build_object('ok',true,'reason','PENDING_OPERATOR_REVIEW',
  'request_id',v_request);
end;
$function$
;
revoke all on function public.cargo_staging_owner_e2e_verify(uuid,bytea) from public,anon,authenticated;
grant execute on function public.cargo_staging_owner_e2e_verify(uuid,bytea) to service_role;
