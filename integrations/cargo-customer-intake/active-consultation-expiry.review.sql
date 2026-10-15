-- STAGING: separate active-consultation lifetime from closed-record deletion.
-- The quote deadline, request status, operator/secret checks and intake gate remain.
begin;
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

create or replace function public.cargo_customer_quote_claim_send(
 p_request_id uuid,p_operator_id uuid,p_response_token_hmac bytea
) returns jsonb language plpgsql security invoker set search_path='' as $cargo_quote_claim_body$
declare
 v_request public.cargo_customer_intake_requests%rowtype;
 v_quote public.cargo_customer_quote_replies%rowtype;
 v_now timestamptz;
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
 update public.cargo_customer_quote_replies
  set delivery_status='sending',delivery_attempted_at=v_now,updated_at=v_now,
      response_token_hmac=p_response_token_hmac
  where request_id=p_request_id;
 return jsonb_build_object('ok',true,'reason','SENDING_CLAIMED',
  'request_id',p_request_id,'amount_yen',v_quote.amount_yen,
  'terms',v_quote.terms,'valid_until',v_quote.valid_until);
end;
$cargo_quote_claim_body$;

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
commit;
