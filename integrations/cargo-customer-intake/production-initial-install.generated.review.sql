-- REVIEW ONLY. First customer-schema install; NOT authorization to execute.
-- Expected target: kvoaorzdewwirqryeizq. Verify the actual connection separately.
-- Existing core data stays in place. No users, test rows, secrets, cron or mail.
-- Mail budget initializes DISABLED at 1/1 placeholders; review before enabling.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
lock table public.cargo_intake_control in share row exclusive mode;
do $preflight$
declare n text;
begin
 if not exists(select 1 from public.cargo_intake_control where id=1
  and intake_enabled=false and captcha_required=true and contact_verification_required=true) then
  raise exception 'CARGO_INSTALL_REQUIRES_PROTECTED_OFF';
 end if;
 if to_regclass('auth.users') is null or to_regclass('public.cargo_operator_accounts') is null then
  raise exception 'CARGO_INSTALL_CORE_DEPENDENCY_MISSING';
 end if;
 if not exists(select 1 from public.cargo_operator_accounts) then raise exception 'CARGO_INSTALL_OPERATOR_MISSING'; end if;
 if not has_table_privilege('service_role','public.cargo_intake_control','SELECT')
  or not has_table_privilege('service_role','public.cargo_intake_control','UPDATE')
  or not has_table_privilege('service_role','public.cargo_operator_accounts','SELECT') then
  raise exception 'CARGO_INSTALL_CORE_ROLE_REVIEW_REQUIRED';
 end if;
 foreach n in array array['cargo_customer_intake_drafts','cargo_customer_intake_requests','cargo_customer_quote_replies','cargo_customer_mail_budget','cargo_customer_quote_followups','cargo_customer_quote_followup_events','cargo_customer_retention_runs'] loop
  if to_regclass('public.'||n) is not null then raise exception 'CARGO_INSTALL_SCHEMA_ALREADY_PRESENT'; end if;
 end loop;
 if exists(select 1 from pg_proc where pronamespace='public'::regnamespace and proname like 'cargo_customer_%') then
  raise exception 'CARGO_INSTALL_ROUTINE_ALREADY_PRESENT';
 end if;
end;
$preflight$;

-- SOURCE integrations/cargo-customer-intake/schema.review.sql blob eec368e9fe2521289cad5835b2e1604a759b1def
create table public.cargo_customer_intake_drafts (
 id uuid primary key,
 attempt_id uuid not null unique,
 contact_hmac bytea not null check(octet_length(contact_hmac)=32),
 encrypted_payload bytea,
 constraint cargo_customer_draft_payload_check check (
  (consumed_at is null and encrypted_payload is not null and octet_length(encrypted_payload)>=29)
  or (consumed_at is not null and encrypted_payload is null)
 ),
 code_hmac bytea not null check(octet_length(code_hmac)=32),
 attempts smallint not null default 0 check(attempts between 0 and 5),
 created_at timestamptz not null default now(),
 expires_at timestamptz not null,
 consumed_at timestamptz,
 delete_after timestamptz not null default (now()+interval '30 minutes'),
 constraint cargo_customer_draft_validity check (expires_at<=delete_after)
);
create index cargo_customer_intake_drafts_cleanup_idx
 on public.cargo_customer_intake_drafts(delete_after);

create table public.cargo_customer_intake_requests (
 id uuid primary key default gen_random_uuid(),
 source_draft_id uuid not null unique,
 contact_hmac bytea not null check(octet_length(contact_hmac)=32),
 encrypted_payload bytea not null check(octet_length(encrypted_payload)>=29),
 status text not null default 'pending_operator_review'
  check(status in ('pending_operator_review','operator_reviewing','declined','quoted','closed')),
 created_at timestamptz not null default now(),
 -- Retention policy MUST be approved and automated before launch.
 delete_after timestamptz not null default (now()+interval '30 days')
);
create index cargo_customer_intake_requests_status_idx
 on public.cargo_customer_intake_requests(status,created_at);

alter table public.cargo_customer_intake_drafts enable row level security;
alter table public.cargo_customer_intake_requests enable row level security;
revoke all on public.cargo_customer_intake_drafts from public,anon,authenticated;
revoke all on public.cargo_customer_intake_requests from public,anon,authenticated;
grant select,insert,update,delete on public.cargo_customer_intake_drafts to service_role;
grant select,insert,update on public.cargo_customer_intake_requests to service_role;

-- Exactly-once OTP consumption and queue creation share ONE DB transaction.
-- A false return never creates a customer queue entry.
create or replace function public.cargo_customer_intake_verify_commit(
 p_draft_id uuid,p_code_hmac bytea
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
 v_draft public.cargo_customer_intake_drafts%rowtype;
 v_request uuid;
 v_now timestamptz;
 v_attempts integer;
begin
 if p_draft_id is null or p_code_hmac is null
    or octet_length(p_code_hmac)<>32 then
   return jsonb_build_object('ok',false,'reason','INVALID_INPUT');
 end if;
 -- FOR SHARE serializes with administrative changes to the intake switch.
 perform 1 from public.cargo_intake_control
  where id=1 and intake_enabled=true
   and captcha_required=true and contact_verification_required=true
  for share;
 if not found then
   return jsonb_build_object('ok',false,'reason','PUBLIC_INTAKE_DISABLED');
 end if;
 select * into v_draft from public.cargo_customer_intake_drafts
  where id=p_draft_id for update;
 if not found then return jsonb_build_object('ok',false,'reason','NOT_FOUND'); end if;
 v_now:=clock_timestamp();
 if v_draft.consumed_at is not null then
   return jsonb_build_object('ok',false,'reason','ALREADY_USED');
 end if;
 if v_now>=v_draft.expires_at then
   return jsonb_build_object('ok',false,'reason','EXPIRED');
 end if;
 if v_draft.attempts>=5 then
   return jsonb_build_object('ok',false,'reason','LOCKED');
 end if;
 if v_draft.code_hmac<>p_code_hmac then
   update public.cargo_customer_intake_drafts
    set attempts=least(5,attempts+1) where id=p_draft_id
    returning attempts into v_attempts;
   return jsonb_build_object('ok',false,
    'reason',case when v_attempts>=5 then 'LOCKED' else 'INVALID_CODE' end);
 end if;
 insert into public.cargo_customer_intake_requests
  (source_draft_id,contact_hmac,encrypted_payload)
 values (v_draft.id,v_draft.contact_hmac,v_draft.encrypted_payload)
 returning id into v_request;
 -- Clear draft PII once moved to the operator review queue.
 update public.cargo_customer_intake_drafts
  set consumed_at=v_now,encrypted_payload=null
  where id=p_draft_id;
 return jsonb_build_object('ok',true,'reason','PENDING_OPERATOR_REVIEW',
  'request_id',v_request);
end;
$$;

revoke all on function public.cargo_customer_intake_verify_commit(uuid,bytea)
 from public,anon,authenticated;
grant execute on function public.cargo_customer_intake_verify_commit(uuid,bytea)
 to service_role;

-- Operator-only retention maintenance, not scheduled in this review.
-- Does not alter verified requests; retention for those needs operator policy.
create or replace function public.cargo_customer_intake_cleanup(
 p_limit integer default 100
) returns integer language plpgsql security invoker set search_path='' as $$
declare v_count integer:=0;
begin
 if p_limit is null or p_limit<1 or p_limit>100 then return 0; end if;
 with expired as (
  select id from public.cargo_customer_intake_drafts
   where delete_after<clock_timestamp()
   order by delete_after,id for update skip locked limit p_limit
 )
 delete from public.cargo_customer_intake_drafts d
  using expired e where d.id=e.id;
 get diagnostics v_count=row_count;
 return v_count;
end;
$$;
revoke all on function public.cargo_customer_intake_cleanup(integer)
 from public,anon,authenticated;
grant execute on function public.cargo_customer_intake_cleanup(integer)
 to service_role;

-- SOURCE integrations/cargo-customer-intake/quotes.review.sql blob 344941b896922e5738d1dae0125836a49c96af1a
create table public.cargo_customer_quote_replies (
 request_id uuid primary key references public.cargo_customer_intake_requests(id) on delete restrict,
 prepared_by uuid not null references auth.users(id),
 amount_yen integer not null check (amount_yen between 1 and 10000000),
 terms text not null check (char_length(terms) between 30 and 1200),
 valid_until timestamptz not null,
 delivery_status text not null default 'ready_to_send'
  check (delivery_status in ('ready_to_send','sending','sent','delivery_unknown')),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 delivery_attempted_at timestamptz,
 sent_at timestamptz,
 provider_message_id text,
 -- Only the HMAC of a random 256-bit email reply token is stored.
 response_token_hmac bytea check (
  response_token_hmac is null or octet_length(response_token_hmac)=32
 ),
 response_state text check (response_state in ('interested','declined')),
 responded_at timestamptz,
 constraint cargo_quote_response_integrity check (
  (response_state is null and responded_at is null) or
  (response_state is not null and responded_at is not null)
 )
);
alter table public.cargo_customer_quote_replies enable row level security;
revoke all on public.cargo_customer_quote_replies from public,anon,authenticated;
grant select,insert,update on public.cargo_customer_quote_replies to service_role;

create or replace function public.cargo_customer_quote_prepare(
 p_request_id uuid,p_operator_id uuid,p_amount_yen integer,
 p_terms text,p_valid_until timestamptz
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
 v_request public.cargo_customer_intake_requests%rowtype;
 v_existing public.cargo_customer_quote_replies%rowtype;
 v_now timestamptz;
begin
 if p_request_id is null or p_operator_id is null
  or p_amount_yen is null or p_amount_yen<1 or p_amount_yen>10000000
  or p_terms is null or char_length(btrim(p_terms))<30
  or char_length(p_terms)>1200 or p_valid_until is null then
  return jsonb_build_object('ok',false,'reason','INVALID_INPUT');
 end if;
 v_now:=clock_timestamp();
 if p_valid_until<=v_now+interval '5 minutes'
  or p_valid_until>v_now+interval '14 days' then
  return jsonb_build_object('ok',false,'reason','INVALID_EXPIRY');
 end if;
 if not exists(select 1 from public.cargo_operator_accounts where user_id=p_operator_id) then
  return jsonb_build_object('ok',false,'reason','OPERATOR_ONLY');
 end if;
 select * into v_request from public.cargo_customer_intake_requests
  where id=p_request_id for update;
 if not found or v_request.status<>'operator_reviewing' then
  return jsonb_build_object('ok',false,'reason','REQUEST_NOT_REVIEWABLE');
 end if;
 select * into v_existing from public.cargo_customer_quote_replies
  where request_id=p_request_id for update;
 if found and v_existing.delivery_status<>'ready_to_send' then
  return jsonb_build_object('ok',false,'reason','DELIVERY_ALREADY_ATTEMPTED');
 end if;
 insert into public.cargo_customer_quote_replies
  (request_id,prepared_by,amount_yen,terms,valid_until,updated_at)
 values (p_request_id,p_operator_id,p_amount_yen,btrim(p_terms),p_valid_until,v_now)
 on conflict(request_id) do update
  set prepared_by=excluded.prepared_by,amount_yen=excluded.amount_yen,
      terms=excluded.terms,valid_until=excluded.valid_until,updated_at=v_now;
 return jsonb_build_object('ok',true,'reason','QUOTE_READY_TO_SEND',
  'request_id',p_request_id,'amount_yen',p_amount_yen);
end;
$$;

-- One and only one sender may claim an email delivery attempt.
-- A failed/ambiguous delivery is NOT retried automatically.
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

-- Preserve unknown delivery state when provider delivery is ambiguous.
-- This is irreversible without a manual reconciliation and new quote.
create or replace function public.cargo_customer_quote_finalize(
 p_request_id uuid,p_operator_id uuid,p_provider_accepted boolean,
 p_provider_message_id text default null
) returns jsonb language plpgsql security invoker set search_path='' as $$
declare
 v_quote public.cargo_customer_quote_replies%rowtype;
 v_now timestamptz;
begin
 if p_request_id is null or p_operator_id is null or p_provider_accepted is null
  or (p_provider_message_id is not null and char_length(p_provider_message_id)>200) then
  return jsonb_build_object('ok',false,'reason','INVALID_INPUT');
 end if;
 if not exists(select 1 from public.cargo_operator_accounts where user_id=p_operator_id) then
  return jsonb_build_object('ok',false,'reason','OPERATOR_ONLY');
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
   sent_at=case when p_provider_accepted then v_now else null end,
   updated_at=v_now
  where request_id=p_request_id;
 if p_provider_accepted then
  update public.cargo_customer_intake_requests set status='quoted'
   where id=p_request_id and status='operator_reviewing';
  if not found then raise exception 'CUSTOMER_REQUEST_STATUS_CHANGED'; end if;
 end if;
 return jsonb_build_object('ok',true,
  'reason',case when p_provider_accepted then 'QUOTE_PROVIDER_ACCEPTED'
      else 'DELIVERY_UNKNOWN' end);
end;
$$;

revoke all on function public.cargo_customer_quote_prepare(uuid,uuid,integer,text,timestamptz)
 from public,anon,authenticated;
grant execute on function public.cargo_customer_quote_prepare(uuid,uuid,integer,text,timestamptz)
 to service_role;
revoke all on function public.cargo_customer_quote_claim_send(uuid,uuid,bytea)
 from public,anon,authenticated;
grant execute on function public.cargo_customer_quote_claim_send(uuid,uuid,bytea)
 to service_role;
revoke all on function public.cargo_customer_quote_finalize(uuid,uuid,boolean,text)
 from public,anon,authenticated;
grant execute on function public.cargo_customer_quote_finalize(uuid,uuid,boolean,text)
 to service_role;

-- Customer may express interest or decline using a one-time email-only secret.
-- THIS IS NOT A CONTRACT ACCEPTANCE, PAYMENT, DRIVER ASSIGNMENT, OR BOOKING.
-- Only service_role invokes; token HMAC is checked atomically in the DB.
create or replace function public.cargo_customer_quote_reply(
 p_request_id uuid,p_response_token_hmac bytea,
 p_choice text default null
) returns jsonb language plpgsql security invoker set search_path='' as $$
declare
 v_request public.cargo_customer_intake_requests%rowtype;
 v_quote public.cargo_customer_quote_replies%rowtype;
 v_now timestamptz;
begin
 if p_request_id is null or p_response_token_hmac is null
  or octet_length(p_response_token_hmac)<>32
  or (p_choice is not null and p_choice not in ('interested','declined')) then
  return jsonb_build_object('ok',false,'reason','INVALID_INPUT');
 end if;
 perform 1 from public.cargo_intake_control
  where id=1 and intake_enabled=true and captcha_required=true
   and contact_verification_required=true for share;
 if not found then
  return jsonb_build_object('ok',false,'reason','PUBLIC_INTAKE_DISABLED');
 end if;
 -- Stable lock order prevents interleaving with quote preparation/send.
 select * into v_request from public.cargo_customer_intake_requests
  where id=p_request_id for update;
 if not found or v_request.status<>'quoted' then
  return jsonb_build_object('ok',false,'reason','QUOTE_NOT_AVAILABLE');
 end if;
 select * into v_quote from public.cargo_customer_quote_replies
  where request_id=p_request_id for update;
 if not found or v_quote.delivery_status<>'sent'
  or v_quote.response_token_hmac is null
  or v_quote.response_token_hmac<>p_response_token_hmac then
  return jsonb_build_object('ok',false,'reason','QUOTE_NOT_AVAILABLE');
 end if;
 v_now:=clock_timestamp();
 if v_quote.valid_until<=v_now then
  return jsonb_build_object('ok',false,'reason','EXPIRED');
 end if;
 if p_choice is null then
  return jsonb_build_object('ok',true,'reason','QUOTE_VIEW',
   'amount_yen',v_quote.amount_yen,'terms',v_quote.terms,
   'valid_until',v_quote.valid_until,'reply_state',v_quote.response_state);
 end if;
 if v_quote.responded_at is not null then
  return jsonb_build_object('ok',false,'reason','ALREADY_REPLIED');
 end if;
 update public.cargo_customer_quote_replies
  set response_state=p_choice,responded_at=v_now,updated_at=v_now
  where request_id=p_request_id;
 return jsonb_build_object('ok',true,
  'reason',case when p_choice='interested' then 'INTEREST_RECORDED'
     else 'DECLINE_RECORDED' end,
  'operator_review_required',true,
  'dispatch_created',false,'payment_created',false,
  'contract_confirmed',false);
end;
$$;
revoke all on function public.cargo_customer_quote_reply(uuid,bytea,text)
 from public,anon,authenticated;
grant execute on function public.cargo_customer_quote_reply(uuid,bytea,text)
 to service_role;

-- SOURCE integrations/cargo-customer-intake/mail-budget.review.sql blob 6a4972f6ae98a8b58fd5a2c0da2cd4af72eb9333
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
 (id,enabled,hourly_limit,daily_limit,hour_started_at,day_started_at)
 values(1,false,1,1,date_trunc('hour',clock_timestamp()),
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

-- SOURCE integrations/cargo-customer-intake/followup.review.sql blob b8d3b4fcc4cb0bd689a3a87d1d7535d78c2faac3
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
  or v_quote.response_state is distinct from 'interested' then
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

-- SOURCE integrations/cargo-customer-intake/closed-no-order-retention.review.sql blob 64e694a33066a3b0cb6f6c4e60bd128c7f9d3783
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

do $postflight$
declare n text;
begin
 if not exists(select 1 from public.cargo_intake_control where id=1
  and intake_enabled=false and captcha_required=true and contact_verification_required=true) then
  raise exception 'CARGO_INSTALL_CONTROL_CHANGED';
 end if;
 foreach n in array array['cargo_customer_intake_drafts','cargo_customer_intake_requests','cargo_customer_quote_replies','cargo_customer_mail_budget','cargo_customer_quote_followups','cargo_customer_quote_followup_events','cargo_customer_retention_runs'] loop
  if not (select relrowsecurity from pg_class where oid=to_regclass('public.'||n))
   or has_table_privilege('anon','public.'||n,'SELECT,INSERT,UPDATE,DELETE')
   or has_table_privilege('authenticated','public.'||n,'SELECT,INSERT,UPDATE,DELETE') then
   raise exception 'CARGO_INSTALL_TABLE_ACCESS_UNSAFE';
  end if;
 end loop;
 if exists(select 1 from pg_proc where pronamespace='public'::regnamespace and proname like 'cargo_customer_%'
   and (prosecdef or has_function_privilege('anon',oid,'EXECUTE') or has_function_privilege('authenticated',oid,'EXECUTE'))) then
  raise exception 'CARGO_INSTALL_ROUTINE_ACCESS_UNSAFE';
 end if;
 if not exists(select 1 from public.cargo_customer_mail_budget where id=1 and enabled=false
  and hourly_limit=1 and daily_limit=1 and hour_attempts=0 and day_attempts=0) then
  raise exception 'CARGO_INSTALL_MAIL_MUST_REMAIN_DISABLED';
 end if;
end;
$postflight$;
commit;
