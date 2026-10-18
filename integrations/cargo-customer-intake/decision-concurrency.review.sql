-- DEVELOPMENT / ISOLATED REVIEW ONLY. Never run the initial-install SQL again.
-- Apply after the existing quote, follow-up and closed-retention definitions.
-- No gate changes, scheduling, cleanup calls, messages, bookings or payments.
begin;

create function public.cargo_customer_request_decide(
 p_request_id uuid,p_operator_id uuid,p_expected_status text,p_next_status text
) returns jsonb language plpgsql security invoker set search_path='' as $decision$
declare
 v_request public.cargo_customer_intake_requests%rowtype;
 v_quote public.cargo_customer_quote_replies%rowtype;
begin
 if p_request_id is null or p_operator_id is null
  or p_expected_status is null or p_next_status is null
  or not ((p_expected_status='pending_operator_review' and p_next_status in ('operator_reviewing','declined'))
   or (p_expected_status='operator_reviewing' and p_next_status='declined')) then
  return jsonb_build_object('ok',false,'reason','INVALID_TRANSITION');
 end if;
 -- Only the protected backend forwards an identity verified using getUser.
 if not exists(select 1 from public.cargo_operator_accounts where user_id=p_operator_id) then
  return jsonb_build_object('ok',false,'reason','OPERATOR_ONLY');
 end if;
 select * into v_request from public.cargo_customer_intake_requests
  where id=p_request_id for update;
 if not found or v_request.status<>p_expected_status or v_request.closed_no_order_at is not null then
  return jsonb_build_object('ok',false,'reason','STATUS_CHANGED');
 end if;
 select * into v_quote from public.cargo_customer_quote_replies
  where request_id=p_request_id for update;
 if found and v_quote.delivery_status<>'ready_to_send' then
  return jsonb_build_object('ok',false,'reason','DELIVERY_RECONCILIATION_REQUIRED');
 end if;
 update public.cargo_customer_intake_requests set status=p_next_status where id=p_request_id;
 return jsonb_build_object('ok',true,'reason','DECISION_RECORDED','id',p_request_id,'status',p_next_status);
end;
$decision$;

-- A legacy backend still using a direct status CAS must not bypass the guard.
-- UPDATE already owns the request row; acquire the quote row second, as all RPCs do.
create function public.cargo_customer_decline_guard()
 returns trigger language plpgsql security invoker set search_path='' as $guard$
declare v_delivery text;
begin
 if old.status not in ('pending_operator_review','operator_reviewing')
  or old.closed_no_order_at is not null then
  raise exception using errcode='23514',message='CARGO_DECISION_STATUS_CHANGED';
 end if;
 select delivery_status into v_delivery from public.cargo_customer_quote_replies
  where request_id=old.id for update;
 if found and v_delivery<>'ready_to_send' then
  raise exception using errcode='23514',message='CARGO_DECISION_DELIVERY_PROTECTED';
 end if;
 return new;
end;
$guard$;
create trigger cargo_customer_decline_guard
 before update of status on public.cargo_customer_intake_requests
 for each row when (old.status is distinct from new.status and new.status='declined')
 execute function public.cargo_customer_decline_guard();

-- Same request -> quote lock order as prepare, claim, reply, closure and follow-up.
-- Recording a previously claimed outcome remains possible after the intake gate is OFF.
create or replace function public.cargo_customer_quote_finalize(
 p_request_id uuid,p_operator_id uuid,p_provider_accepted boolean,
 p_provider_message_id text default null
) returns jsonb language plpgsql security invoker set search_path='' as $finalize$
declare
 v_request public.cargo_customer_intake_requests%rowtype;
 v_quote public.cargo_customer_quote_replies%rowtype;
 v_now timestamptz;
begin
 if p_request_id is null or p_operator_id is null or p_provider_accepted is null
  or (p_provider_message_id is not null and char_length(p_provider_message_id)>200)
  or (p_provider_accepted and (p_provider_message_id is null or char_length(btrim(p_provider_message_id))=0)) then
  return jsonb_build_object('ok',false,'reason','INVALID_INPUT');
 end if;
 if not exists(select 1 from public.cargo_operator_accounts where user_id=p_operator_id) then
  return jsonb_build_object('ok',false,'reason','OPERATOR_ONLY');
 end if;
 select * into v_request from public.cargo_customer_intake_requests
  where id=p_request_id for update;
 if not found or v_request.status<>'operator_reviewing' then
  return jsonb_build_object('ok',false,'reason','REQUEST_NOT_REVIEWABLE');
 end if;
 select * into v_quote from public.cargo_customer_quote_replies
  where request_id=p_request_id for update;
 if not found or v_quote.delivery_status<>'sending' then
  return jsonb_build_object('ok',false,'reason','NOT_SENDING');
 end if;
 v_now:=clock_timestamp();
 update public.cargo_customer_quote_replies
  set delivery_status=case when p_provider_accepted then 'sent' else 'delivery_unknown' end,
   provider_message_id=case when p_provider_accepted then p_provider_message_id else null end,
   sent_at=case when p_provider_accepted then v_now else null end,updated_at=v_now
  where request_id=p_request_id;
 if p_provider_accepted then
  update public.cargo_customer_intake_requests set status='quoted' where id=p_request_id;
 end if;
 return jsonb_build_object('ok',true,
  'reason',case when p_provider_accepted then 'QUOTE_PROVIDER_ACCEPTED' else 'DELIVERY_UNKNOWN' end);
end;
$finalize$;

-- Preserve the adopted 30-day interval even when closure waits for another writer.
-- Only the timestamp placement differs from the existing closure definition.
create or replace function public.cargo_customer_close_no_order(
 p_request_id uuid,p_operator_id uuid,p_no_order_confirmed boolean default false
) returns jsonb language plpgsql security invoker set search_path='' as $closure$
declare
 v_request public.cargo_customer_intake_requests%rowtype;
 v_quote public.cargo_customer_quote_replies%rowtype;
 v_followup public.cargo_customer_quote_followups%rowtype;
 v_now timestamptz;
begin
 if p_request_id is null or p_operator_id is null or p_no_order_confirmed is distinct from true then
  return jsonb_build_object('ok',false,'reason','NO_ORDER_CONFIRMATION_REQUIRED');
 end if;
 if not exists(select 1 from public.cargo_operator_accounts where user_id=p_operator_id) then
  return jsonb_build_object('ok',false,'reason','OPERATOR_ONLY');
 end if;
 select * into v_request from public.cargo_customer_intake_requests where id=p_request_id for update;
 if not found then return jsonb_build_object('ok',false,'reason','NOT_FOUND'); end if;
 if v_request.closed_no_order_at is not null then
  return jsonb_build_object('ok',false,'reason','ALREADY_CLOSED');
 end if;
 select * into v_quote from public.cargo_customer_quote_replies where request_id=p_request_id for update;
 if found and v_quote.delivery_status in ('sending','delivery_unknown') then
  return jsonb_build_object('ok',false,'reason','DELIVERY_RECONCILIATION_REQUIRED');
 end if;
 select * into v_followup from public.cargo_customer_quote_followups where request_id=p_request_id for update;
 if found and v_followup.stage<>'closed_no_order' then
  return jsonb_build_object('ok',false,'reason','FOLLOWUP_NOT_CLOSED_NO_ORDER');
 end if;
 if v_request.status not in ('pending_operator_review','operator_reviewing','declined','quoted','closed') then
  return jsonb_build_object('ok',false,'reason','STATUS_CHANGED');
 end if;
 v_now:=clock_timestamp();
 update public.cargo_customer_intake_requests
  set status='closed',closed_no_order_at=v_now,retention_hold=false,delete_after=v_now+interval '30 days'
  where id=p_request_id;
 return jsonb_build_object('ok',true,'reason','CLOSED_NO_ORDER','delete_after',v_now+interval '30 days');
end;
$closure$;

revoke all on function public.cargo_customer_request_decide(uuid,uuid,text,text) from public,anon,authenticated;
revoke all on function public.cargo_customer_decline_guard() from public,anon,authenticated,service_role;
revoke all on function public.cargo_customer_quote_finalize(uuid,uuid,boolean,text) from public,anon,authenticated;
revoke all on function public.cargo_customer_close_no_order(uuid,uuid,boolean) from public,anon,authenticated;
grant execute on function public.cargo_customer_request_decide(uuid,uuid,text,text) to service_role;
grant execute on function public.cargo_customer_quote_finalize(uuid,uuid,boolean,text) to service_role;
grant execute on function public.cargo_customer_close_no_order(uuid,uuid,boolean) to service_role;
commit;
