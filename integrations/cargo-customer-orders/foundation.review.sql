-- STAGE 1 DEVELOPMENT CANDIDATE ONLY. Not a production deployment script.
-- Apply after existing intake, quote, follow-up, closed-retention and
-- decision-concurrency definitions, in an isolated database only.
-- No scheduling, cleanup invocation, mail, gate changes, payment or dispatch.
begin;

create table public.cargo_customer_order_agreements (
 request_id uuid not null references public.cargo_customer_intake_requests(id) on delete cascade,
 version integer not null check(version>0),
 amount_yen integer not null check(amount_yen between 1 and 10000000),
 pickup_at timestamptz not null check(pickup_at>=timestamptz '0001-01-01 00:00:00+00' and pickup_at<timestamptz '10000-01-01 00:00:00+00'),
 delivery_at timestamptz check(delivery_at>=pickup_at and delivery_at<timestamptz '10000-01-01 00:00:00+00'),
 customer_confirmed_at timestamptz not null check(customer_confirmed_at>=timestamptz '0001-01-01 00:00:00+00' and customer_confirmed_at<timestamptz '10000-01-01 00:00:00+00'),
 confirmation_method text not null check(confirmation_method in ('email','phone','in_person','other')),
 recorded_by uuid not null references auth.users(id),
 recorded_at timestamptz not null default clock_timestamp(),
 encrypted_payload bytea not null check(octet_length(encrypted_payload) between 29 and 20000 and get_byte(encrypted_payload,0)=1),
 primary key(request_id,version)
);
create table public.cargo_customer_orders (
 request_id uuid primary key references public.cargo_customer_intake_requests(id) on delete restrict,
 status text not null check(status in ('accepted','preparing','in_transit','completed','cancelled')),
 version integer not null check(version>0),
 active_agreement_version integer not null,
 accepted_by uuid not null references auth.users(id),
 accepted_at timestamptz not null,
 updated_by uuid not null references auth.users(id),
 updated_at timestamptz not null,
 completed_at timestamptz,
 cancelled_at timestamptz,
 retention_policy text not null default 'undetermined_hold' check(retention_policy='undetermined_hold'),
 retention_until timestamptz check(retention_until is null),
 foreign key(request_id) references public.cargo_customer_quote_replies(request_id) on delete restrict,
 foreign key(request_id,active_agreement_version)
  references public.cargo_customer_order_agreements(request_id,version) on delete restrict,
 check((status='completed')=(completed_at is not null)),
 check((status='cancelled')=(cancelled_at is not null)),
 check(isfinite(accepted_at) and isfinite(updated_at) and updated_at>=accepted_at)
);
create table public.cargo_customer_order_events (
 request_id uuid not null references public.cargo_customer_intake_requests(id) on delete cascade,
 sequence integer not null check(sequence>0),
 operation_id uuid not null unique,
 kind text not null check(kind in ('customer_agreement_recorded','order_accepted','agreement_applied','status_changed')),
 from_status text check(from_status in ('accepted','preparing','in_transit','completed','cancelled')),
 to_status text check(to_status in ('accepted','preparing','in_transit','completed','cancelled')),
 order_version integer not null check(order_version>=0),
 agreement_version integer not null check(agreement_version>0),
 actor_id uuid not null references auth.users(id),
 recorded_at timestamptz not null default clock_timestamp(),
 encrypted_payload bytea check(octet_length(encrypted_payload) between 29 and 20000 and get_byte(encrypted_payload,0)=1),
 primary key(request_id,sequence)
);
alter table public.cargo_customer_order_agreements enable row level security;
alter table public.cargo_customer_orders enable row level security;
alter table public.cargo_customer_order_events enable row level security;
revoke all on public.cargo_customer_order_agreements,public.cargo_customer_orders,
 public.cargo_customer_order_events from public,anon,authenticated,service_role;
grant select,insert on public.cargo_customer_order_agreements,public.cargo_customer_order_events to service_role;
grant select,insert,update on public.cargo_customer_orders to service_role;

-- Accepted records stay protected even after completion or cancellation.
-- Legacy closure/hold-release/direct deletion cannot turn them into no-order cases.
create function public.cargo_customer_order_request_guard()
 returns trigger language plpgsql security invoker set search_path='' as $guard$
begin
 if exists(select 1 from public.cargo_customer_orders where request_id=old.id) then
  if tg_op='DELETE' then
   raise exception using errcode='23514',message='CARGO_ORDER_RETENTION_PROTECTED';
  end if;
  if new.id is distinct from old.id or new.status<>'quoted'
   or new.closed_no_order_at is not null or not new.retention_hold then
   raise exception using errcode='23514',message='CARGO_ORDER_RETENTION_PROTECTED';
  end if;
 end if;
 if tg_op='DELETE' then return old; end if;
 return new;
end;
$guard$;
create trigger cargo_customer_order_request_guard
 before update or delete on public.cargo_customer_intake_requests
 for each row execute function public.cargo_customer_order_request_guard();

-- The old pre-order follow-up screen also has a terminal no-order stage.
-- Serialize it with acceptance; it must not strand an already accepted order.
create function public.cargo_customer_order_followup_guard()
 returns trigger language plpgsql security invoker set search_path='' as $guard$
begin
 if new.stage='closed_no_order' then
  perform 1 from public.cargo_customer_intake_requests where id=new.request_id for update;
  if exists(select 1 from public.cargo_customer_orders where request_id=new.request_id) then
   raise exception using errcode='23514',message='CARGO_ORDER_RETENTION_PROTECTED';
  end if;
 end if;
 return new;
end;
$guard$;
create trigger cargo_customer_order_followup_guard
 before insert or update on public.cargo_customer_quote_followups
 for each row execute function public.cargo_customer_order_followup_guard();

-- History is append-only. Pre-acceptance histories alone follow the existing
-- explicitly closed/no-order consultation cascade; accepted histories never do.
create function public.cargo_customer_order_history_guard()
 returns trigger language plpgsql security invoker set search_path='' as $guard$
begin
 if tg_op='UPDATE' or exists(select 1 from public.cargo_customer_orders where request_id=old.request_id) then
  raise exception using errcode='23514',message='CARGO_ORDER_HISTORY_IMMUTABLE';
 end if;
 return old;
end;
$guard$;
create trigger cargo_customer_order_agreement_history_guard
 before update or delete on public.cargo_customer_order_agreements
 for each row execute function public.cargo_customer_order_history_guard();
create trigger cargo_customer_order_event_history_guard
 before update or delete on public.cargo_customer_order_events
 for each row execute function public.cargo_customer_order_history_guard();

-- Even trusted direct inserts join the parent lock protocol. This makes the
-- read SHARE lock meaningful for every history append, not just API commands.
create function public.cargo_customer_order_append_guard()
 returns trigger language plpgsql security invoker set search_path='' as $guard$
declare
 v_request public.cargo_customer_intake_requests%rowtype;
 v_order public.cargo_customer_orders%rowtype;
 v_latest integer;
 v_delivery text;
begin
 select * into v_request from public.cargo_customer_intake_requests where id=new.request_id for update;
 if not found or v_request.status<>'quoted' or v_request.closed_no_order_at is not null then
  raise exception using errcode='23514',message='CARGO_ORDER_REQUEST_NOT_ORDERABLE';
 end if;
 select delivery_status into v_delivery from public.cargo_customer_quote_replies where request_id=new.request_id for update;
 if not found or v_delivery<>'sent' then
  raise exception using errcode='23514',message='CARGO_ORDER_QUOTE_NOT_SENT';
 end if;
 select * into v_order from public.cargo_customer_orders where request_id=new.request_id;
 if tg_table_name='cargo_customer_order_agreements' then
  select coalesce(max(version),0) into v_latest from public.cargo_customer_order_agreements where request_id=new.request_id;
  if new.version<>v_latest+1 or v_order.status in ('completed','cancelled')
   or new.customer_confirmed_at>clock_timestamp() or new.recorded_at>clock_timestamp()
   or not exists(select 1 from public.cargo_operator_accounts where user_id=new.recorded_by) then
   raise exception using errcode='23514',message='CARGO_ORDER_INVALID_AGREEMENT';
  end if;
 else
  select coalesce(max(sequence),0) into v_latest from public.cargo_customer_order_events where request_id=new.request_id;
  if new.sequence<>v_latest+1 or new.order_version<>coalesce(v_order.version,0)
   or new.to_status is distinct from v_order.status or new.recorded_at>clock_timestamp()
   or not exists(select 1 from public.cargo_operator_accounts where user_id=new.actor_id)
   or not exists(select 1 from public.cargo_customer_order_agreements where request_id=new.request_id and version=new.agreement_version) then
   raise exception using errcode='23514',message='CARGO_ORDER_INVALID_EVENT';
  end if;
  if (new.kind='customer_agreement_recorded' and (new.from_status is distinct from new.to_status or new.encrypted_payload is not null))
   or (new.kind='order_accepted' and (new.from_status is not null or new.to_status is distinct from 'accepted' or new.encrypted_payload is not null))
   or (new.kind='agreement_applied' and (new.from_status is null or new.from_status is distinct from new.to_status or new.encrypted_payload is not null))
   or (new.kind='status_changed' and (new.from_status is null or new.to_status is null or new.from_status=new.to_status or new.encrypted_payload is null)) then
   raise exception using errcode='23514',message='CARGO_ORDER_INVALID_EVENT';
  end if;
 end if;
 return new;
end;
$guard$;
create trigger cargo_customer_order_agreement_append_guard
 before insert on public.cargo_customer_order_agreements
 for each row execute function public.cargo_customer_order_append_guard();
create trigger cargo_customer_order_event_append_guard
 before insert on public.cargo_customer_order_events
 for each row execute function public.cargo_customer_order_append_guard();

-- Trusted backend writes still have to obey business invariants. All order
-- writers lock the parent consultation first, then quote, then existing order.
create function public.cargo_customer_order_write_guard()
 returns trigger language plpgsql security invoker set search_path='' as $guard$
declare
 v_request public.cargo_customer_intake_requests%rowtype;
 v_delivery text;
 v_latest integer;
begin
 if tg_op='DELETE' then
  raise exception using errcode='23514',message='CARGO_ORDER_RETENTION_PROTECTED';
 end if;
 select * into v_request from public.cargo_customer_intake_requests
  where id=new.request_id for update;
 if not found or v_request.status<>'quoted' or v_request.closed_no_order_at is not null then
  raise exception using errcode='23514',message='CARGO_ORDER_REQUEST_NOT_ORDERABLE';
 end if;
 select delivery_status into v_delivery from public.cargo_customer_quote_replies
  where request_id=new.request_id for update;
 if not found or v_delivery<>'sent' then
  raise exception using errcode='23514',message='CARGO_ORDER_QUOTE_NOT_SENT';
 end if;
 if not exists(select 1 from public.cargo_operator_accounts where user_id=new.updated_by)
  or (tg_op='INSERT' and not exists(select 1 from public.cargo_operator_accounts where user_id=new.accepted_by)) then
  raise exception using errcode='23514',message='CARGO_ORDER_OPERATOR_REQUIRED';
 end if;
 select max(version) into v_latest from public.cargo_customer_order_agreements where request_id=new.request_id;
 if tg_op='INSERT' then
  if new.status<>'accepted' or new.version<>1 or new.active_agreement_version is distinct from v_latest
   or new.updated_by<>new.accepted_by or new.updated_at<>new.accepted_at then
   raise exception using errcode='23514',message='CARGO_ORDER_INVALID_INITIAL_STATE';
  end if;
 else
  if new.request_id<>old.request_id or new.accepted_by<>old.accepted_by or new.accepted_at<>old.accepted_at
   or old.status in ('completed','cancelled') or new.version<>old.version+1
   or new.updated_at<old.updated_at then
   raise exception using errcode='23514',message='CARGO_ORDER_INVALID_UPDATE';
  end if;
  if new.active_agreement_version<>old.active_agreement_version then
   if new.status<>old.status or new.active_agreement_version is distinct from v_latest then
    raise exception using errcode='23514',message='CARGO_ORDER_INVALID_AGREEMENT_CHANGE';
   end if;
  elsif not ((old.status='accepted' and new.status in ('preparing','cancelled'))
   or (old.status='preparing' and new.status in ('in_transit','cancelled'))
   or (old.status='in_transit' and new.status in ('completed','cancelled'))) then
   raise exception using errcode='23514',message='CARGO_ORDER_INVALID_TRANSITION';
  elsif new.status<>'cancelled' and new.active_agreement_version is distinct from v_latest then
   raise exception using errcode='23514',message='CARGO_ORDER_PENDING_AGREEMENT';
  end if;
  if new.completed_at is distinct from old.completed_at and new.status<>'completed'
   or new.cancelled_at is distinct from old.cancelled_at and new.status<>'cancelled' then
   raise exception using errcode='23514',message='CARGO_ORDER_INVALID_TERMINAL_TIMESTAMP';
  end if;
 end if;
 if (new.status='completed' and new.completed_at<>new.updated_at)
  or (new.status='cancelled' and new.cancelled_at<>new.updated_at) then
  raise exception using errcode='23514',message='CARGO_ORDER_INVALID_TERMINAL_TIMESTAMP';
 end if;
 return new;
end;
$guard$;
create trigger cargo_customer_order_write_guard
 before insert or update or delete on public.cargo_customer_orders
 for each row execute function public.cargo_customer_order_write_guard();

-- Every version of an order must have an immutable, attributable matching event
-- by commit. This also rejects otherwise-valid direct updates without history.
create function public.cargo_customer_order_audit_guard()
 returns trigger language plpgsql security invoker set search_path='' as $guard$
begin
 if not exists(select 1 from public.cargo_customer_order_events e
  where e.request_id=new.request_id and e.order_version=new.version
   and e.agreement_version=new.active_agreement_version and e.actor_id=new.updated_by
   and e.to_status=new.status and e.recorded_at=new.updated_at
   and ((tg_op='INSERT' and e.kind='order_accepted' and e.from_status is null)
    or (tg_op='UPDATE' and e.kind=case when new.status=old.status then 'agreement_applied' else 'status_changed' end
     and e.from_status=old.status))) then
  raise exception using errcode='23514',message='CARGO_ORDER_AUDIT_REQUIRED';
 end if;
 return null;
end;
$guard$;
create constraint trigger cargo_customer_order_audit_guard
 after insert or update on public.cargo_customer_orders deferrable initially deferred
 for each row execute function public.cargo_customer_order_audit_guard();

create function public.cargo_customer_order_command(
 p_request_id uuid,p_operator_id uuid,p_operation_id uuid,p_action text,p_expected_order_version integer,
 p_expected_agreement_version integer default null,p_agreement_version integer default null,
 p_amount_yen integer default null,p_pickup_at timestamptz default null,p_delivery_at timestamptz default null,
 p_customer_confirmed_at timestamptz default null,p_confirmation_method text default null,
 p_encrypted_payload bytea default null,p_next_status text default null,p_confirmation text default null
) returns jsonb language plpgsql security invoker set search_path='' as $command$
declare
 v_request public.cargo_customer_intake_requests%rowtype;
 v_order public.cargo_customer_orders%rowtype;
 v_delivery text;
 v_latest integer;
 v_sequence integer;
 v_now timestamptz;
 v_kind text;
 v_from text;
 v_to text;
 v_order_version integer;
 v_agreement_version integer;
begin
 if p_request_id is null or p_operator_id is null or p_operation_id is null
  or p_expected_order_version is null or p_expected_order_version<0
  or p_action is null or p_action not in ('record_agreement','accept_order','apply_agreement','change_status')
  or p_confirmation is distinct from (case p_action
   when 'record_agreement' then 'RECORD_OBSERVED_CUSTOMER_AGREEMENT'
   when 'accept_order' then 'RECORD_OPERATOR_ACCEPTANCE'
   when 'apply_agreement' then 'APPLY_RECORDED_AGREEMENT'
   when 'change_status' then 'RECORD_DELIVERY_STATE_CHANGE' end) then
  return jsonb_build_object('ok',false,'reason','INVALID_INPUT');
 end if;
 if not exists(select 1 from public.cargo_operator_accounts where user_id=p_operator_id) then
  return jsonb_build_object('ok',false,'reason','OPERATOR_ONLY');
 end if;
 select * into v_request from public.cargo_customer_intake_requests where id=p_request_id for update;
 if not found then return jsonb_build_object('ok',false,'reason','NOT_FOUND'); end if;
 if exists(select 1 from public.cargo_customer_order_events where operation_id=p_operation_id) then
  return jsonb_build_object('ok',false,'reason','OPERATION_ALREADY_RECORDED');
 end if;
 select delivery_status into v_delivery from public.cargo_customer_quote_replies where request_id=p_request_id for update;
 if v_request.status<>'quoted' or v_request.closed_no_order_at is not null or v_delivery is distinct from 'sent'
  or exists(select 1 from public.cargo_customer_quote_followups where request_id=p_request_id and stage='closed_no_order') then
  return jsonb_build_object('ok',false,'reason','REQUEST_NOT_ORDERABLE');
 end if;
 select * into v_order from public.cargo_customer_orders where request_id=p_request_id for update;
 v_order_version:=coalesce(v_order.version,0);
 v_from:=v_order.status;
 if p_expected_order_version<>v_order_version then
  return jsonb_build_object('ok',false,'reason','ORDER_VERSION_CONFLICT');
 end if;
 if v_order.status in ('completed','cancelled') then
  return jsonb_build_object('ok',false,'reason','TERMINAL_ORDER');
 end if;
 select coalesce(max(version),0) into v_latest from public.cargo_customer_order_agreements where request_id=p_request_id;
 select coalesce(max(sequence),0)+1 into v_sequence from public.cargo_customer_order_events where request_id=p_request_id;
 v_now:=clock_timestamp();
 v_to:=v_from;
 if p_action='record_agreement' then
  if p_expected_agreement_version is null or p_expected_agreement_version<0
   or p_agreement_version is not null or p_next_status is not null
   or p_amount_yen is null or p_amount_yen not between 1 and 10000000
   or p_pickup_at is null or p_pickup_at<timestamptz '0001-01-01 00:00:00+00' or p_pickup_at>=timestamptz '10000-01-01 00:00:00+00'
   or (p_delivery_at is not null and (p_delivery_at>=timestamptz '10000-01-01 00:00:00+00' or p_delivery_at<p_pickup_at))
   or p_customer_confirmed_at is null or p_customer_confirmed_at<timestamptz '0001-01-01 00:00:00+00' or p_customer_confirmed_at>v_now
   or p_confirmation_method is null or p_confirmation_method not in ('email','phone','in_person','other')
   or p_encrypted_payload is null or octet_length(p_encrypted_payload) not between 29 and 20000
   or get_byte(p_encrypted_payload,0)<>1 then
   return jsonb_build_object('ok',false,'reason','INVALID_INPUT');
  end if;
  if p_expected_agreement_version<>v_latest then
   return jsonb_build_object('ok',false,'reason','AGREEMENT_VERSION_CONFLICT');
  end if;
  v_agreement_version:=v_latest+1;
  insert into public.cargo_customer_order_agreements
   (request_id,version,amount_yen,pickup_at,delivery_at,customer_confirmed_at,confirmation_method,recorded_by,recorded_at,encrypted_payload)
  values(p_request_id,v_agreement_version,p_amount_yen,p_pickup_at,p_delivery_at,p_customer_confirmed_at,p_confirmation_method,p_operator_id,v_now,p_encrypted_payload);
  v_kind:='customer_agreement_recorded';
 else
  if p_expected_agreement_version is not null or p_amount_yen is not null or p_pickup_at is not null
   or p_delivery_at is not null or p_customer_confirmed_at is not null or p_confirmation_method is not null then
   return jsonb_build_object('ok',false,'reason','INVALID_INPUT');
  end if;
  if p_action in ('accept_order','apply_agreement') then
   if p_next_status is not null or p_encrypted_payload is not null then
    return jsonb_build_object('ok',false,'reason','INVALID_INPUT');
   end if;
   if v_latest=0 or p_agreement_version is null then
    return jsonb_build_object('ok',false,'reason','AGREEMENT_REQUIRED');
   end if;
   if p_agreement_version<>v_latest then
    return jsonb_build_object('ok',false,'reason','AGREEMENT_VERSION_CONFLICT');
   end if;
   v_agreement_version:=p_agreement_version;
   if p_action='accept_order' then
    if v_order_version<>0 then return jsonb_build_object('ok',false,'reason','ORDER_ALREADY_EXISTS'); end if;
    v_order_version:=1;v_to:='accepted';v_kind:='order_accepted';
    insert into public.cargo_customer_orders
     (request_id,status,version,active_agreement_version,accepted_by,accepted_at,updated_by,updated_at)
    values(p_request_id,v_to,v_order_version,v_agreement_version,p_operator_id,v_now,p_operator_id,v_now);
    update public.cargo_customer_intake_requests set retention_hold=true where id=p_request_id;
   else
    if v_order_version=0 then return jsonb_build_object('ok',false,'reason','ORDER_REQUIRED'); end if;
    if v_order.active_agreement_version=p_agreement_version then
     return jsonb_build_object('ok',false,'reason','AGREEMENT_VERSION_CONFLICT');
    end if;
    v_order_version:=v_order_version+1;v_kind:='agreement_applied';
    update public.cargo_customer_orders set active_agreement_version=v_agreement_version,
     version=v_order_version,updated_by=p_operator_id,updated_at=v_now where request_id=p_request_id;
   end if;
  else
   if p_agreement_version is not null or p_next_status is null
    or p_encrypted_payload is null or octet_length(p_encrypted_payload) not between 29 and 20000
    or get_byte(p_encrypted_payload,0)<>1 then
    return jsonb_build_object('ok',false,'reason','INVALID_INPUT');
   end if;
   if v_order_version=0 then return jsonb_build_object('ok',false,'reason','ORDER_REQUIRED'); end if;
   if not ((v_from='accepted' and p_next_status in ('preparing','cancelled'))
    or (v_from='preparing' and p_next_status in ('in_transit','cancelled'))
    or (v_from='in_transit' and p_next_status in ('completed','cancelled'))) then
    return jsonb_build_object('ok',false,'reason','INVALID_TRANSITION');
   end if;
   if p_next_status<>'cancelled' and v_order.active_agreement_version<>v_latest then
    return jsonb_build_object('ok',false,'reason','PENDING_AGREEMENT');
   end if;
   v_agreement_version:=v_order.active_agreement_version;
   v_order_version:=v_order_version+1;v_to:=p_next_status;v_kind:='status_changed';
   update public.cargo_customer_orders set status=v_to,version=v_order_version,
    updated_by=p_operator_id,updated_at=v_now,
    completed_at=case when v_to='completed' then v_now else completed_at end,
    cancelled_at=case when v_to='cancelled' then v_now else cancelled_at end
   where request_id=p_request_id;
  end if;
 end if;
 insert into public.cargo_customer_order_events
  (request_id,sequence,operation_id,kind,from_status,to_status,order_version,agreement_version,actor_id,recorded_at,encrypted_payload)
 values(p_request_id,v_sequence,p_operation_id,v_kind,v_from,v_to,v_order_version,v_agreement_version,p_operator_id,v_now,
  case when p_action='change_status' then p_encrypted_payload else null end);
 return jsonb_build_object('ok',true,'reason','OK','request_id',p_request_id,
  'order_version',v_order_version,'agreement_version',v_agreement_version,'status',v_to);
exception when unique_violation then
 -- The exception subtransaction rolls back ALL writes, including an order or
 -- agreement inserted before a competing operation UUID was discovered.
 return jsonb_build_object('ok',false,'reason','OPERATION_ALREADY_RECORDED');
end;
$command$;

-- One parent SHARE lock covers the whole read. Writers and deletion own UPDATE
-- locks on the same parent, so conditions/history/order never form a torn view.
create function public.cargo_customer_order_read(
 p_request_id uuid,p_operator_id uuid,p_before_event_sequence integer default null,p_before_agreement_version integer default null
) returns jsonb language plpgsql security invoker set search_path='' as $read$
declare v_order jsonb;v_agreements jsonb;v_events jsonb;
begin
 if p_request_id is null or p_operator_id is null
  or (p_before_event_sequence is not null and p_before_event_sequence<1)
  or (p_before_agreement_version is not null and p_before_agreement_version<1) then
  return jsonb_build_object('ok',false,'reason','INVALID_INPUT');
 end if;
 if not exists(select 1 from public.cargo_operator_accounts where user_id=p_operator_id) then
  return jsonb_build_object('ok',false,'reason','OPERATOR_ONLY');
 end if;
 perform 1 from public.cargo_customer_intake_requests where id=p_request_id for share;
 if not found then return jsonb_build_object('ok',false,'reason','NOT_FOUND'); end if;
 select to_jsonb(o) into v_order from public.cargo_customer_orders o where request_id=p_request_id;
 select coalesce(jsonb_agg(to_jsonb(a) order by a.version desc),'[]'::jsonb) into v_agreements from
  (select * from public.cargo_customer_order_agreements where request_id=p_request_id
   and (p_before_agreement_version is null or version<p_before_agreement_version) order by version desc limit 51) a;
 select coalesce(jsonb_agg(to_jsonb(e) order by e.sequence desc),'[]'::jsonb) into v_events from
  (select * from public.cargo_customer_order_events where request_id=p_request_id
   and (p_before_event_sequence is null or sequence<p_before_event_sequence) order by sequence desc limit 51) e;
 return jsonb_build_object('ok',true,'request_id',p_request_id,'order',v_order,'agreements',v_agreements,'events',v_events);
end;
$read$;

-- Keep the old RPC behavior for unaccepted consultations. Accepted cases get
-- a structured refusal before legacy code reaches the independent row guard.
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
 if exists(select 1 from public.cargo_customer_orders where request_id=p_request_id) then
  return jsonb_build_object('ok',false,'reason','ORDER_RETENTION_PROTECTED');
 end if;
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
 if not p_hold and exists(select 1 from public.cargo_customer_orders where request_id=p_request_id) then
  return jsonb_build_object('ok',false,'reason','ORDER_RETENTION_PROTECTED');
 end if;
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

-- Preserve the established unaccepted-case 30-day criteria and deletion order.
-- Only accepted-order exclusion is added; no schedule or actual deletion call.
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
   and not exists(select 1 from public.cargo_customer_orders o where o.request_id=r.id)
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

revoke all on function public.cargo_customer_order_request_guard(),
 public.cargo_customer_order_history_guard(),public.cargo_customer_order_write_guard(),
 public.cargo_customer_order_audit_guard(),public.cargo_customer_order_append_guard(),
 public.cargo_customer_order_followup_guard() from public,anon,authenticated,service_role;
revoke all on function public.cargo_customer_order_command(uuid,uuid,uuid,text,integer,integer,integer,integer,timestamptz,timestamptz,timestamptz,text,bytea,text,text)
 from public,anon,authenticated;
grant execute on function public.cargo_customer_order_command(uuid,uuid,uuid,text,integer,integer,integer,integer,timestamptz,timestamptz,timestamptz,text,bytea,text,text)
 to service_role;
revoke all on function public.cargo_customer_order_read(uuid,uuid,integer,integer) from public,anon,authenticated;
grant execute on function public.cargo_customer_order_read(uuid,uuid,integer,integer) to service_role;
revoke all on function public.cargo_customer_close_no_order(uuid,uuid,boolean),
 public.cargo_customer_retention_set_hold(uuid,uuid,boolean),
 public.cargo_customer_closed_cleanup(integer) from public,anon,authenticated;
grant execute on function public.cargo_customer_close_no_order(uuid,uuid,boolean),
 public.cargo_customer_retention_set_hold(uuid,uuid,boolean) to service_role;
grant execute on function public.cargo_customer_closed_cleanup(integer) to service_role;
commit;
