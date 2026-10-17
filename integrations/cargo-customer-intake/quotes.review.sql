-- REVIEW ONLY: manually prepared cargo quotations with at-most-once delivery attempts.
-- Extends schema.review.sql. DO NOT APPLY TO PRODUCTION.
-- The operator enters a final yen amount and explicit tax/toll/waiting terms.
-- This schema never creates Square payments, dispatches or binding contracts.
begin;

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


commit;
