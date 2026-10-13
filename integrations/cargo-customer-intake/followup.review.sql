-- Draft-only cargo quote follow-up. Apply only in an isolated database.
-- Recording a customer contact never books, dispatches or charges.
begin;
create table public.cargo_customer_quote_followups (
 request_id uuid primary key references public.cargo_customer_intake_requests(id) on delete restrict,
 stage text not null check(stage in ('contact_attempted','awaiting_reply','handled_offline','closed_no_order')),
 operator_note text not null check(char_length(operator_note) between 5 and 600),
 updated_by uuid not null references auth.users(id),
 updated_at timestamptz not null default now()
);
create table public.cargo_customer_quote_followup_events (
 id bigint generated always as identity primary key,
 request_id uuid not null references public.cargo_customer_intake_requests(id) on delete restrict,
 prior_stage text, new_stage text not null,
 operator_note text not null,
 operator_id uuid not null references auth.users(id),
 created_at timestamptz not null default now()
);
alter table public.cargo_customer_quote_followups enable row level security;
alter table public.cargo_customer_quote_followup_events enable row level security;
revoke all on public.cargo_customer_quote_followups from public,anon,authenticated;
revoke all on public.cargo_customer_quote_followup_events from public,anon,authenticated;
grant select,insert,update on public.cargo_customer_quote_followups to service_role;
grant select,insert on public.cargo_customer_quote_followup_events to service_role;
create or replace function public.cargo_customer_followup_save(
 p_request_id uuid,p_operator_id uuid,p_expected_stage text,p_next_stage text,p_note text
) returns jsonb language plpgsql security invoker set search_path=''
as $body$
declare
 v_request public.cargo_customer_intake_requests%rowtype;
 v_quote public.cargo_customer_quote_replies%rowtype;
 v_old public.cargo_customer_quote_followups%rowtype;
 v_note text;
begin
 v_note:=btrim(coalesce(p_note,''));
 if p_request_id is null or p_operator_id is null
  or p_next_stage is null or p_next_stage not in
   ('contact_attempted','awaiting_reply','handled_offline','closed_no_order')
  or (p_expected_stage is not null and p_expected_stage not in
   ('contact_attempted','awaiting_reply','handled_offline','closed_no_order'))
  or char_length(v_note)<5 or char_length(v_note)>600 then
  return jsonb_build_object('ok',false,'reason','INVALID_INPUT');
 end if;
 perform 1 from public.cargo_intake_control where id=1 and intake_enabled=true
  and captcha_required=true and contact_verification_required=true for share;
 if not found then return jsonb_build_object('ok',false,'reason','PUBLIC_INTAKE_DISABLED'); end if;
 if not exists(select 1 from public.cargo_operator_accounts where user_id=p_operator_id) then
  return jsonb_build_object('ok',false,'reason','OPERATOR_ONLY');
 end if;
 select * into v_request from public.cargo_customer_intake_requests
  where id=p_request_id for update;
 if not found or v_request.status<>'quoted' then
  return jsonb_build_object('ok',false,'reason','REQUEST_NOT_QUOTED');
 end if;
 select * into v_quote from public.cargo_customer_quote_replies
  where request_id=p_request_id for update;
 if not found or v_quote.delivery_status<>'sent'
  or v_quote.response_state<>'interested' then
  return jsonb_build_object('ok',false,'reason','CUSTOMER_INTEREST_REQUIRED');
 end if;
 select * into v_old from public.cargo_customer_quote_followups
  where request_id=p_request_id for update;
 if not found then
  if p_expected_stage is not null then
   return jsonb_build_object('ok',false,'reason','STATUS_CHANGED');
  end if;
  if p_next_stage not in ('contact_attempted','closed_no_order') then
   return jsonb_build_object('ok',false,'reason','INVALID_TRANSITION');
  end if;
 else
  if p_expected_stage is distinct from v_old.stage then
   return jsonb_build_object('ok',false,'reason','STATUS_CHANGED');
  end if;
  if v_old.stage in ('handled_offline','closed_no_order') then
   return jsonb_build_object('ok',false,'reason','ALREADY_CLOSED');
  end if;
  if not ((v_old.stage='contact_attempted' and p_next_stage in
    ('awaiting_reply','handled_offline','closed_no_order'))
    or (v_old.stage='awaiting_reply' and p_next_stage in
    ('contact_attempted','handled_offline','closed_no_order'))) then
   return jsonb_build_object('ok',false,'reason','INVALID_TRANSITION');
  end if;
 end if;
 insert into public.cargo_customer_quote_followups
  (request_id,stage,operator_note,updated_by) values
  (p_request_id,p_next_stage,v_note,p_operator_id)
 on conflict(request_id) do update set
  stage=excluded.stage,operator_note=excluded.operator_note,
  updated_by=excluded.updated_by,updated_at=clock_timestamp();
 insert into public.cargo_customer_quote_followup_events
  (request_id,prior_stage,new_stage,operator_note,operator_id)
 values(p_request_id,v_old.stage,p_next_stage,v_note,p_operator_id);
 return jsonb_build_object('ok',true,'reason','FOLLOWUP_RECORDED',
  'stage',p_next_stage,'booking_confirmed',false,
  'dispatch_created',false,'payment_created',false,'customer_notified',false);
end;
$body$;
revoke all on function public.cargo_customer_followup_save(uuid,uuid,text,text,text)
 from public,anon,authenticated;
grant execute on function public.cargo_customer_followup_save(uuid,uuid,text,text,text)
 to service_role;
commit;
