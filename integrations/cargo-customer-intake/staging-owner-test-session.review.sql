-- STAGING ONLY. Requires the already-deployed owner-test guards on all three customer endpoints.
-- Installation creates no trial, sends no mail, and does not change the intake control.
begin;
create function public.cargo_staging_owner_test_session(p_owner_id uuid,p_action text)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare v_run public.cargo_staging_owner_test_runs%rowtype; v_now timestamptz;
 v_gate public.cargo_intake_control%rowtype;v_request uuid;v_status text;v_delivery text;v_reply text;
begin
 if p_owner_id is distinct from '5ccbfcd5-bd0f-4a9a-b570-223b3deb2567'::uuid or
    p_action is null or p_action not in ('status','begin','finish') or
    not exists(select 1 from public.cargo_operator_accounts where user_id=p_owner_id) then
  return jsonb_build_object('ok',false,'reason','OWNER_ONLY');
 end if;
 select * into v_gate from public.cargo_intake_control where id=1 for update;
 if not found then return jsonb_build_object('ok',false,'reason','CONTROL_UNAVAILABLE');end if;
 select * into v_run from public.cargo_staging_owner_test_runs where owner_id=p_owner_id for update;
 v_now:=clock_timestamp();
 if p_action='begin' and v_run.owner_id is null then
  if v_gate.intake_enabled or not v_gate.captcha_required or not v_gate.contact_verification_required then
   return jsonb_build_object('ok',false,'reason','CONTROL_NOT_READY');
  end if;
  insert into public.cargo_staging_owner_test_runs(owner_id,draft_id,created_at,expires_at,enabled)
   values(p_owner_id,gen_random_uuid(),v_now,v_now+interval '30 minutes',true) returning * into v_run;
  -- Customer endpoints still deny every anonymous/non-owner caller via their mandatory staging guard.
  update public.cargo_intake_control set intake_enabled=true where id=1;
  v_gate.intake_enabled:=true;
 elsif p_action='finish' and v_run.owner_id is not null then
  update public.cargo_staging_owner_test_runs set enabled=false where owner_id=p_owner_id returning * into v_run;
  update public.cargo_intake_control set intake_enabled=false where id=1;
  v_gate.intake_enabled:=false;
 end if;
 if v_run.owner_id is not null then
  select id,status into v_request,v_status from public.cargo_customer_intake_requests where source_draft_id=v_run.draft_id;
  select delivery_status,response_state into v_delivery,v_reply from public.cargo_customer_quote_replies where request_id=v_request;
 end if;
 return jsonb_build_object('ok',true,
  'state',case when v_run.owner_id is null then 'NOT_STARTED'
   when v_run.enabled and v_now<v_run.expires_at and v_gate.intake_enabled then 'ACTIVE' else 'CLOSED' end,
  'draft_id',v_run.draft_id,'expires_at',v_run.expires_at,
  'start_claimed',coalesce(v_run.start_claimed,false),'quote_claimed',coalesce(v_run.quote_claimed,false),
  'draft_exists',exists(select 1 from public.cargo_customer_intake_drafts where id=v_run.draft_id),
  'request_id',v_request,'request_status',v_status,'delivery_status',v_delivery,'reply_state',v_reply);
end $$;
revoke all on function public.cargo_staging_owner_test_session(uuid,text) from public,anon,authenticated;
grant execute on function public.cargo_staging_owner_test_session(uuid,text) to service_role;
grant update(intake_enabled) on public.cargo_intake_control to service_role;

create function public.cargo_staging_owner_test_expire()
returns integer language plpgsql security invoker set search_path='' as $$
declare v_count integer;
begin
 perform 1 from public.cargo_intake_control where id=1 for update;
 update public.cargo_staging_owner_test_runs set enabled=false
  where enabled and expires_at<=clock_timestamp();
 get diagnostics v_count=row_count;
 if v_count>0 then update public.cargo_intake_control set intake_enabled=false where id=1;end if;
 return v_count;
end $$;
revoke all on function public.cargo_staging_owner_test_expire() from public,anon,authenticated;
grant execute on function public.cargo_staging_owner_test_expire() to service_role;

commit;
