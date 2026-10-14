-- Isolated free staging only. Fixed fictional scenario; no customer payload.
create table public.cargo_staging_samples (
 id uuid primary key default gen_random_uuid(),
 operator_id uuid not null unique references public.cargo_operator_accounts(user_id) on delete cascade,
 scenario text not null default 'FICTIONAL_V1' check (scenario='FICTIONAL_V1'),
 status text not null default 'pending_review' check(status in ('pending_review','reviewed')),
 created_at timestamptz not null default now(),
 reviewed_at timestamptz,
 check((status='pending_review' and reviewed_at is null) or (status='reviewed' and reviewed_at is not null))
);
alter table public.cargo_staging_samples enable row level security;
revoke all on public.cargo_staging_samples from public,anon,authenticated;
grant select,insert,update on public.cargo_staging_samples to service_role;
create function public.cargo_staging_sample_action(p_operator_id uuid,p_action text)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare r public.cargo_staging_samples%rowtype;
begin
 if p_action is null or p_action not in ('load','create','review') then
  return jsonb_build_object('ok',false,'error','INVALID_ACTION');
 end if;
 perform 1 from public.cargo_operator_accounts where user_id=p_operator_id;
 if not found then return jsonb_build_object('ok',false,'error','OPERATOR_ONLY'); end if;
 perform 1 from public.cargo_intake_control where id=1 and intake_enabled=false
  and captcha_required=true and contact_verification_required=true for share;
 if not found then return jsonb_build_object('ok',false,'error','INTAKE_MUST_BE_OFF'); end if;
 if p_action='create' then
  insert into public.cargo_staging_samples(operator_id) values(p_operator_id)
  on conflict(operator_id) do nothing;
 elsif p_action='review' then
  update public.cargo_staging_samples set status='reviewed',reviewed_at=clock_timestamp()
   where operator_id=p_operator_id and status='pending_review';
 end if;
 select * into r from public.cargo_staging_samples where operator_id=p_operator_id;
 if not found then
  if p_action='review' then return jsonb_build_object('ok',false,'error','SAMPLE_NOT_FOUND'); end if;
  return jsonb_build_object('ok',true,'sample',null);
 end if;
 return jsonb_build_object('ok',true,'sample',jsonb_build_object(
  'id',r.id,'scenario',r.scenario,'status',r.status,'created_at',r.created_at,'reviewed_at',r.reviewed_at));
end;
$$;
revoke all on function public.cargo_staging_sample_action(uuid,text) from public,anon,authenticated;
grant execute on function public.cargo_staging_sample_action(uuid,text) to service_role;
