-- Admin checks a fictional customer's consultation request. No contact or delivery occurs.
create table public.cargo_staging_followups (
 request_id uuid primary key references public.cargo_staging_quote_responses(request_id),
 status text not null default 'reviewing' check(status in ('reviewing','checked')),
 started_at timestamptz not null default now(),
 checked_at timestamptz,
 check((status='reviewing' and checked_at is null) or (status='checked' and checked_at is not null and checked_at>=started_at))
);
alter table public.cargo_staging_followups enable row level security;
revoke all on public.cargo_staging_followups from public,anon,authenticated;
grant select,insert,update on public.cargo_staging_followups to service_role;
create function public.cargo_staging_followup_check(p_operator_id uuid,p_id uuid,p_action text)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare r public.cargo_staging_verified_requests%rowtype; f public.cargo_staging_followups%rowtype; v_response text;
begin
 if p_operator_id is null or p_id is null or p_action is null or p_action not in ('start','complete') then
  return jsonb_build_object('ok',false,'reason','INVALID_INPUT');end if;
 perform 1 from public.cargo_operator_accounts where user_id=p_operator_id;
 if not found then return jsonb_build_object('ok',false,'reason','OPERATOR_ONLY');end if;
 perform 1 from public.cargo_intake_control where id=1 and intake_enabled=false and captcha_required=true and contact_verification_required=true for share;
 if not found then return jsonb_build_object('ok',false,'reason','INTAKE_MUST_BE_OFF');end if;
 select * into r from public.cargo_staging_verified_requests where id=p_id and operator_id=p_operator_id for update;
 if not found then return jsonb_build_object('ok',false,'reason','REQUEST_NOT_FOUND');end if;
 if r.status is distinct from 'operator_reviewing' then return jsonb_build_object('ok',false,'reason','REVIEW_REQUIRED');end if;
 select response into v_response from public.cargo_staging_quote_responses where request_id=r.id and mode='ADMIN_SIMULATION';
 if v_response is distinct from 'interested' then return jsonb_build_object('ok',false,'reason','INTEREST_REQUIRED');end if;
 select * into f from public.cargo_staging_followups where request_id=r.id for update;
 if not found then
  if p_action='complete' then return jsonb_build_object('ok',false,'reason','FOLLOWUP_REQUIRED');end if;
  insert into public.cargo_staging_followups(request_id) values(r.id) returning * into f;
 elsif p_action='complete' and f.status='reviewing' then
  update public.cargo_staging_followups set status='checked',checked_at=clock_timestamp() where request_id=r.id returning * into f;
 end if;
 return jsonb_build_object('ok',true,'status',f.status);
end;
$$;
revoke all on function public.cargo_staging_followup_check(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.cargo_staging_followup_check(uuid,uuid,text) to service_role;
