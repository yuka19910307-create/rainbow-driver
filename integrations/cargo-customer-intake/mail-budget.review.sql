-- Shared cap for customer OTP and operator quote delivery attempts.
-- STAGING DEFAULTS ONLY: 10/hour, 50/JST calendar day; not a provider quota guarantee.
-- Owner-only test senders and other apps are outside this counter.
begin;
create table public.cargo_customer_mail_budget (
 id integer primary key check(id=1),
 enabled boolean not null default true,
 hourly_limit integer not null check(hourly_limit between 1 and 1000),
 daily_limit integer not null check(daily_limit between 1 and 10000 and daily_limit>=hourly_limit),
 hour_started_at timestamptz not null,
 day_started_at date not null,
 hour_attempts integer not null default 0 check(hour_attempts>=0),
 day_attempts integer not null default 0 check(day_attempts>=0)
);
alter table public.cargo_customer_mail_budget enable row level security;
revoke all on public.cargo_customer_mail_budget from public,anon,authenticated;
grant select,update on public.cargo_customer_mail_budget to service_role;
insert into public.cargo_customer_mail_budget
 (id,hourly_limit,daily_limit,hour_started_at,day_started_at)
 values(1,10,50,date_trunc('hour',clock_timestamp()),
  (clock_timestamp() at time zone 'Asia/Tokyo')::date);

create or replace function public.cargo_customer_mail_budget_claim()
 returns jsonb language plpgsql security invoker set search_path='' as $body$
declare
 v_budget public.cargo_customer_mail_budget%rowtype;
 v_now timestamptz; v_hour timestamptz; v_day date;
 v_h integer; v_d integer;
begin
 select * into v_budget from public.cargo_customer_mail_budget where id=1 for update;
 if not found or v_budget.enabled is distinct from true then
  return jsonb_build_object('allowed',false,'reason','MAIL_BUDGET_UNAVAILABLE');
 end if;
 v_now:=clock_timestamp();
 v_hour:=date_trunc('hour',v_now);
 v_day:=(v_now at time zone 'Asia/Tokyo')::date;
 v_h:=case when v_budget.hour_started_at=v_hour then v_budget.hour_attempts else 0 end;
 v_d:=case when v_budget.day_started_at=v_day then v_budget.day_attempts else 0 end;
 if v_h>=v_budget.hourly_limit or v_d>=v_budget.daily_limit then
  return jsonb_build_object('allowed',false,'reason','MAIL_BUDGET_EXHAUSTED');
 end if;
 update public.cargo_customer_mail_budget set hour_started_at=v_hour,
  day_started_at=v_day,hour_attempts=v_h+1,day_attempts=v_d+1 where id=1;
 -- Never refund unknown/failed delivery: a provider may already have sent it.
 return jsonb_build_object('allowed',true);
end;
$body$;
revoke all on function public.cargo_customer_mail_budget_claim() from public,anon,authenticated;
grant execute on function public.cargo_customer_mail_budget_claim() to service_role;

create or replace function public.cargo_customer_quote_claim_send(
 p_request_id uuid,p_operator_id uuid,p_response_token_hmac bytea
) returns jsonb language plpgsql security invoker set search_path='' as $cargo_quote_claim_body$
declare
 v_request public.cargo_customer_intake_requests%rowtype;
 v_quote public.cargo_customer_quote_replies%rowtype;
 v_now timestamptz;
 v_budget jsonb;
begin
 if p_request_id is null or p_operator_id is null
  or p_response_token_hmac is null or octet_length(p_response_token_hmac)<>32 then
  return jsonb_build_object('ok',false,'reason','INVALID_INPUT');
 end if;
 perform 1 from public.cargo_intake_control
  where id=1 and intake_enabled=true and captcha_required=true
   and contact_verification_required=true for share;
 if not found then
  return jsonb_build_object('ok',false,'reason','PUBLIC_INTAKE_DISABLED');
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
 if not found then
  return jsonb_build_object('ok',false,'reason','QUOTE_NOT_PREPARED');
 end if;
 if v_quote.delivery_status<>'ready_to_send' then
  return jsonb_build_object('ok',false,'reason','DELIVERY_ALREADY_ATTEMPTED');
 end if;
 v_now:=clock_timestamp();
 if v_quote.valid_until<=v_now then
  return jsonb_build_object('ok',false,'reason','EXPIRED');
 end if;
 v_budget:=public.cargo_customer_mail_budget_claim();
 if v_budget->>'allowed' is distinct from 'true' then
  return jsonb_build_object('ok',false,'reason',coalesce(v_budget->>'reason','MAIL_BUDGET_UNAVAILABLE'));
 end if;
 update public.cargo_customer_quote_replies
  set delivery_status='sending',delivery_attempted_at=v_now,updated_at=v_now,
      response_token_hmac=p_response_token_hmac
  where request_id=p_request_id;
 return jsonb_build_object('ok',true,'reason','SENDING_CLAIMED',
  'request_id',p_request_id,'amount_yen',v_quote.amount_yen,
  'terms',v_quote.terms,'valid_until',v_quote.valid_until);
end;
$cargo_quote_claim_body$;
commit;
