-- Fixed fictional staging requests only. Never stores customer input or contacts.
create table public.cargo_staging_verified_requests (
 id uuid primary key default gen_random_uuid(),
 source_draft_id uuid not null unique,
 operator_id uuid not null references public.cargo_operator_accounts(user_id),
 scenario text not null default 'FICTIONAL_V1' check(scenario='FICTIONAL_V1'),
 status text not null default 'pending_operator_review' check(status in ('pending_operator_review','operator_reviewing')),
 created_at timestamptz not null default now(),
 review_started_at timestamptz,
 check((status='pending_operator_review' and review_started_at is null) or (status='operator_reviewing' and review_started_at is not null))
);
alter table public.cargo_staging_verified_requests enable row level security;
revoke all on public.cargo_staging_verified_requests from public,anon,authenticated;
grant select,insert,update on public.cargo_staging_verified_requests to service_role;
create function public.cargo_staging_verified_save(p_operator_id uuid,p_subject bytea,p_fingerprint bytea)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare b public.cargo_operator_draft_otp_bindings%rowtype; r public.cargo_staging_verified_requests%rowtype;
begin
 if p_operator_id is null or p_subject is null or octet_length(p_subject)<>32
  or p_fingerprint is null or octet_length(p_fingerprint)<>32 then
  return jsonb_build_object('ok',false,'reason','INVALID_INPUT');end if;
 perform 1 from public.cargo_operator_accounts where user_id=p_operator_id;
 if not found then return jsonb_build_object('ok',false,'reason','OPERATOR_ONLY');end if;
 perform 1 from public.cargo_intake_control where id=1 and intake_enabled=false
  and captcha_required=true and contact_verification_required=true for share;
 if not found then return jsonb_build_object('ok',false,'reason','INTAKE_MUST_BE_OFF');end if;
 select * into b from public.cargo_operator_draft_otp_bindings
  where operator_id=p_operator_id and subject_hmac=p_subject
  and draft_fingerprint_hmac=p_fingerprint and claimed_at is not null
  and claimed_at>=created_at and claimed_at<expires_at
  order by created_at desc,draft_id desc limit 1 for update;
 if not found then return jsonb_build_object('ok',false,'reason','VERIFIED_DRAFT_REQUIRED');end if;
 select * into r from public.cargo_staging_verified_requests where source_draft_id=b.draft_id;
 if found then return jsonb_build_object('ok',true,'request_id',r.id,'status',r.status,'already_saved',true);end if;
 if b.delete_after<=clock_timestamp() then return jsonb_build_object('ok',false,'reason','VERIFIED_DRAFT_WINDOW_ENDED');end if;
 insert into public.cargo_staging_verified_requests(source_draft_id,operator_id)
 values(b.draft_id,p_operator_id) returning * into r;
 return jsonb_build_object('ok',true,'request_id',r.id,'status',r.status,'already_saved',false);
end;
$$;
revoke all on function public.cargo_staging_verified_save(uuid,bytea,bytea) from public,anon,authenticated;
grant execute on function public.cargo_staging_verified_save(uuid,bytea,bytea) to service_role;

create function public.cargo_staging_verified_start_review(p_operator_id uuid,p_id uuid)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare r public.cargo_staging_verified_requests%rowtype;
begin
 perform 1 from public.cargo_operator_accounts where user_id=p_operator_id;
 if not found then return jsonb_build_object('ok',false,'reason','OPERATOR_ONLY');end if;
 perform 1 from public.cargo_intake_control where id=1 and intake_enabled=false and captcha_required=true and contact_verification_required=true for share;
 if not found then return jsonb_build_object('ok',false,'reason','INTAKE_MUST_BE_OFF');end if;
 select * into r from public.cargo_staging_verified_requests where id=p_id and operator_id=p_operator_id for update;
 if not found then return jsonb_build_object('ok',false,'reason','REQUEST_NOT_FOUND');end if;
 if r.status='pending_operator_review' then
  update public.cargo_staging_verified_requests set status='operator_reviewing',review_started_at=clock_timestamp() where id=p_id;
 end if;
 return jsonb_build_object('ok',true,'status','operator_reviewing');
end;$$;
revoke all on function public.cargo_staging_verified_start_review(uuid,uuid) from public,anon,authenticated;
grant execute on function public.cargo_staging_verified_start_review(uuid,uuid) to service_role;