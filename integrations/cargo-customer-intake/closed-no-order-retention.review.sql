-- Approved policy 2026-10-15: closed consultations without a contract,
-- 30 days after an explicit operator closure. STAGING ONLY deployment.
-- Apply after schema.review.sql, quotes.review.sql and followup.review.sql.
-- Does not change intake_enabled, send mail, or touch owner-test tables.
begin;
alter table public.cargo_customer_intake_requests
 add column closed_no_order_at timestamptz,
 add column retention_hold boolean not null default true,
 add constraint cargo_retention_closure_check check (
  closed_no_order_at is null or status='closed'
 );
create index cargo_customer_retention_due_idx
 on public.cargo_customer_intake_requests(closed_no_order_at,id)
 where closed_no_order_at is not null and retention_hold=false;

create table public.cargo_customer_retention_runs (
 id uuid primary key default gen_random_uuid(),
 ran_at timestamptz not null default clock_timestamp(),
 requests_deleted integer not null check(requests_deleted between 0 and 100),
 quotes_deleted integer not null,
 followups_deleted integer not null,
 events_deleted integer not null,
 drafts_deleted integer not null
);
alter table public.cargo_customer_retention_runs enable row level security;
revoke all on public.cargo_customer_retention_runs from public,anon,authenticated;
grant select,insert on public.cargo_customer_retention_runs to service_role;

-- Backend must verify the operator JWT before forwarding p_operator_id.
-- Explicit true means no contract/order and no record-keeping need.
create or replace function public.cargo_customer_close_no_order(
 p_request_id uuid,p_operator_id uuid,p_no_order_confirmed boolean default false
) returns jsonb language plpgsql security invoker set search_path='' as $body$
declare
 v_request public.cargo_customer_intake_requests%rowtype;
 v_quote public.cargo_customer_quote_replies%rowtype;
 v_followup public.cargo_customer_quote_followups%rowtype;
 v_now timestamptz:=clock_timestamp();
begin
 if p_request_id is null or p_operator_id is null
  or p_no_order_confirmed is distinct from true then
  return jsonb_build_object('ok',false,'reason','NO_ORDER_CONFIRMATION_REQUIRED');
 end if;
 if not exists(select 1 from public.cargo_operator_accounts where user_id=p_operator_id) then
  return jsonb_build_object('ok',false,'reason','OPERATOR_ONLY');
 end if;
 select * into v_request from public.cargo_customer_intake_requests
  where id=p_request_id for update;
 if not found then return jsonb_build_object('ok',false,'reason','NOT_FOUND'); end if;
 if v_request.closed_no_order_at is not null then
  return jsonb_build_object('ok',false,'reason','ALREADY_CLOSED');
 end if;
 select * into v_quote from public.cargo_customer_quote_replies
  where request_id=p_request_id for update;
 if found and v_quote.delivery_status in ('sending','delivery_unknown') then
  return jsonb_build_object('ok',false,'reason','DELIVERY_RECONCILIATION_REQUIRED');
 end if;
 select * into v_followup from public.cargo_customer_quote_followups
  where request_id=p_request_id for update;
 if found and v_followup.stage<>'closed_no_order' then
  return jsonb_build_object('ok',false,'reason','FOLLOWUP_NOT_CLOSED_NO_ORDER');
 end if;
 if v_request.status not in ('pending_operator_review','operator_reviewing','declined','quoted','closed') then
  return jsonb_build_object('ok',false,'reason','STATUS_CHANGED');
 end if;
 update public.cargo_customer_intake_requests
  set status='closed',closed_no_order_at=v_now,retention_hold=false,
      delete_after=v_now+interval '30 days'
  where id=p_request_id;
 return jsonb_build_object('ok',true,'reason','CLOSED_NO_ORDER',
  'delete_after',v_now+interval '30 days');
end;
$body$;

-- A hold protects legal/accounting/dispute records; releasing it starts a fresh
-- 30-day interval, never an immediate deletion of old held records.
create or replace function public.cargo_customer_retention_set_hold(
 p_request_id uuid,p_operator_id uuid,p_hold boolean
) returns jsonb language plpgsql security invoker set search_path='' as $body$
begin
 if p_request_id is null or p_operator_id is null or p_hold is null then
  return jsonb_build_object('ok',false,'reason','INVALID_INPUT');
 end if;
 if not exists(select 1 from public.cargo_operator_accounts where user_id=p_operator_id) then
  return jsonb_build_object('ok',false,'reason','OPERATOR_ONLY');
 end if;
 perform 1 from public.cargo_customer_intake_requests where id=p_request_id for update;
 if not found then return jsonb_build_object('ok',false,'reason','NOT_FOUND'); end if;
 if not p_hold and not exists(select 1 from public.cargo_customer_intake_requests
  where id=p_request_id and status='closed' and closed_no_order_at is not null) then
  return jsonb_build_object('ok',false,'reason','CLOSURE_REQUIRED');
 end if;
 update public.cargo_customer_intake_requests set retention_hold=p_hold,
  closed_no_order_at=case when not p_hold and retention_hold
   then clock_timestamp() else closed_no_order_at end,
  delete_after=case when not p_hold and retention_hold
   then clock_timestamp()+interval '30 days' else delete_after end
  where id=p_request_id;
 return jsonb_build_object('ok',true,'reason','RETENTION_HOLD_UPDATED');
end;
$body$;

create or replace function public.cargo_customer_closed_cleanup(p_limit integer default 100)
 returns jsonb language plpgsql security invoker set search_path='' as $body$
declare
 v_ids uuid[];
 v_sources uuid[];
 v_requests integer:=0; v_quotes integer:=0; v_followups integer:=0;
 v_events integer:=0; v_drafts integer:=0;
begin
 if p_limit is null or p_limit<1 or p_limit>100 then
  return jsonb_build_object('ok',false,'reason','INVALID_LIMIT');
 end if;
 -- Request lock serializes with operator closure, holds and the existing APIs.
 select array_agg(c.id),array_agg(c.source_draft_id) into v_ids,v_sources
 from (
  select r.id,r.source_draft_id from public.cargo_customer_intake_requests r
  where r.status='closed' and r.closed_no_order_at is not null
   and r.closed_no_order_at<=clock_timestamp()-interval '30 days'
   and r.delete_after<=clock_timestamp() and r.retention_hold=false
   and not exists(select 1 from public.cargo_customer_quote_followups f
    where f.request_id=r.id and f.stage<>'closed_no_order')
   and not exists(select 1 from public.cargo_customer_quote_replies q
    where q.request_id=r.id and q.delivery_status in ('sending','delivery_unknown'))
  order by r.closed_no_order_at,r.id for update of r skip locked limit p_limit
 ) c;
 if coalesce(cardinality(v_ids),0)>0 then
  delete from public.cargo_customer_quote_followup_events where request_id=any(v_ids);
  get diagnostics v_events=row_count;
  delete from public.cargo_customer_quote_followups where request_id=any(v_ids);
  get diagnostics v_followups=row_count;
  delete from public.cargo_customer_quote_replies where request_id=any(v_ids);
  get diagnostics v_quotes=row_count;
  delete from public.cargo_customer_intake_requests where id=any(v_ids);
  get diagnostics v_requests=row_count;
  delete from public.cargo_customer_intake_drafts
   where id=any(v_sources) and consumed_at is not null;
  get diagnostics v_drafts=row_count;
 end if;
 -- Aggregate counts only: no email, note, request ID, ciphertext or token in logs.
 insert into public.cargo_customer_retention_runs
  (requests_deleted,quotes_deleted,followups_deleted,events_deleted,drafts_deleted)
 values(v_requests,v_quotes,v_followups,v_events,v_drafts);
 return jsonb_build_object('ok',true,'requests_deleted',v_requests,
  'quotes_deleted',v_quotes,'followups_deleted',v_followups,
  'events_deleted',v_events,'drafts_deleted',v_drafts);
end;
$body$;

revoke all on function public.cargo_customer_close_no_order(uuid,uuid,boolean) from public,anon,authenticated;
revoke all on function public.cargo_customer_retention_set_hold(uuid,uuid,boolean) from public,anon,authenticated;
revoke all on function public.cargo_customer_closed_cleanup(integer) from public,anon,authenticated;
grant execute on function public.cargo_customer_close_no_order(uuid,uuid,boolean) to service_role;
grant execute on function public.cargo_customer_retention_set_hold(uuid,uuid,boolean) to service_role;
grant execute on function public.cargo_customer_closed_cleanup(integer) to service_role;
grant delete on public.cargo_customer_intake_requests,public.cargo_customer_quote_replies,
 public.cargo_customer_quote_followups,public.cargo_customer_quote_followup_events to service_role;
commit;
