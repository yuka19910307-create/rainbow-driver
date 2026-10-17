-- STAGING ONLY. Never include in the production migration or public client grants.
-- Creates no active test and never changes the intake switch.
create table public.cargo_staging_owner_test_runs (
 owner_id uuid primary key references auth.users(id),
 draft_id uuid not null unique,
 created_at timestamptz not null default clock_timestamp(),
 expires_at timestamptz not null,
 enabled boolean not null default false,
 start_claimed boolean not null default false,
 quote_claimed boolean not null default false,
 constraint cargo_staging_owner_fixed check (owner_id='5ccbfcd5-bd0f-4a9a-b570-223b3deb2567'::uuid),
 constraint cargo_staging_test_window check (expires_at>created_at and expires_at<=created_at+interval '30 minutes')
);
alter table public.cargo_staging_owner_test_runs enable row level security;
revoke all on public.cargo_staging_owner_test_runs from public,anon,authenticated;
grant select,insert,update on public.cargo_staging_owner_test_runs to service_role;

create function public.cargo_staging_owner_test_authorize(
 p_owner_id uuid,p_action text,p_target_id uuid default null,p_claim boolean default false
) returns jsonb language plpgsql security invoker set search_path='' as $$
declare v_run public.cargo_staging_owner_test_runs%rowtype; v_now timestamptz;
begin
 if p_owner_id is distinct from '5ccbfcd5-bd0f-4a9a-b570-223b3deb2567'::uuid or
    p_action is null or p_action not in ('status','start','verify','quote_send','view','reply','mail_check','quote_mail_check') or
    p_claim is null or (p_claim and p_action not in ('start','quote_send')) then
  return jsonb_build_object('ok',false);
 end if;
 select * into v_run from public.cargo_staging_owner_test_runs where owner_id=p_owner_id for update;
 v_now:=clock_timestamp();
 if not found or not v_run.enabled or v_now<v_run.created_at or v_now>=v_run.expires_at then
  return jsonb_build_object('ok',false);
 end if;
 if p_action in ('start','verify','mail_check') then
  if p_target_id is distinct from v_run.draft_id then return jsonb_build_object('ok',false); end if;
  if p_action='start' and v_run.start_claimed then return jsonb_build_object('ok',false); end if;
  if p_action in ('verify','mail_check') and not v_run.start_claimed then return jsonb_build_object('ok',false); end if;
 elsif p_action in ('quote_send','view','reply','quote_mail_check') then
  if not exists(select 1 from public.cargo_customer_intake_requests where id=p_target_id and source_draft_id=v_run.draft_id) then
   return jsonb_build_object('ok',false);
  end if;
  if p_action='quote_send' and v_run.quote_claimed then return jsonb_build_object('ok',false); end if;
  if p_action in ('view','reply','quote_mail_check') and not v_run.quote_claimed then return jsonb_build_object('ok',false); end if;
 end if;
 if p_claim then
  update public.cargo_staging_owner_test_runs set
   start_claimed=start_claimed or p_action='start',quote_claimed=quote_claimed or p_action='quote_send'
   where owner_id=p_owner_id;
 end if;
 return jsonb_build_object('ok',true,'draft_id',v_run.draft_id,'expires_at',v_run.expires_at);
end $$;
revoke all on function public.cargo_staging_owner_test_authorize(uuid,text,uuid,boolean) from public,anon,authenticated;
grant execute on function public.cargo_staging_owner_test_authorize(uuid,text,uuid,boolean) to service_role;
