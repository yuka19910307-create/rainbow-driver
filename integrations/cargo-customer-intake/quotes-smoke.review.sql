-- Isolated, synthetic quote workflow tests. Runs ONLY in disposable PostgreSQL.
\set ON_ERROR_STOP on
do $$
declare
 v_one uuid;
 v_two uuid:='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee2';
 v_operator uuid:='11111111-1111-4111-8111-111111111111';
 v_not_operator uuid:='99999999-9999-4999-8999-999999999999';
 v_a jsonb;
 v_count integer;
 v_terms text:='高速道路・駐車料金は別途実費です。税込・税抜と消費税の扱いは個別に確認し、荷役・待機の追加条件は担当者の説明に従います。';
begin
 if has_table_privilege('anon','public.cargo_customer_quote_replies','SELECT')
  or has_table_privilege('authenticated','public.cargo_customer_quote_replies','UPDATE')
  or has_function_privilege('anon','public.cargo_customer_quote_prepare(uuid,uuid,integer,text,timestamptz)','EXECUTE')
  or has_function_privilege('authenticated','public.cargo_customer_quote_claim_send(uuid,uuid,bytea)','EXECUTE')
  or has_function_privilege('anon','public.cargo_customer_quote_finalize(uuid,uuid,boolean,text)','EXECUTE')
  or has_function_privilege('anon','public.cargo_customer_quote_reply(uuid,bytea,text)','EXECUTE')
  or has_function_privilege('authenticated','public.cargo_customer_quote_reply(uuid,bytea,text)','EXECUTE')
 then raise exception 'QUOTE_PUBLIC_ACCESS_LEAK'; end if;
 select id into v_one from public.cargo_customer_intake_requests
  where source_draft_id='cccccccc-cccc-4ccc-8ccc-ccccccccccc1'::uuid;
 if v_one is null then raise exception 'CUSTOMER_TEST_REQUEST_NOT_FOUND'; end if;
 update public.cargo_customer_intake_requests
  set status='operator_reviewing' where id=v_one;
 v_a:=public.cargo_customer_quote_prepare(v_one,v_not_operator,25000,v_terms,now()+interval '2 days');
 if v_a->>'reason'<>'OPERATOR_ONLY' then raise exception 'QUOTE_NON_OPERATOR_ALLOWED %',v_a; end if;
 v_a:=public.cargo_customer_quote_prepare(v_one,v_operator,25000,'短い',now()+interval '2 days');
 if v_a->>'reason'<>'INVALID_INPUT' then raise exception 'QUOTE_INVALID_TERMS_ACCEPTED %',v_a; end if;
 v_a:=public.cargo_customer_quote_prepare(v_one,v_operator,25000,v_terms,now()+interval '2 days');
 if v_a->>'reason'<>'QUOTE_READY_TO_SEND' then raise exception 'QUOTE_DRAFT_SAVE_FAILED %',v_a; end if;
 v_a:=public.cargo_customer_quote_prepare(v_one,v_operator,26000,v_terms,now()+interval '2 days');
 if v_a->>'reason'<>'QUOTE_READY_TO_SEND' then raise exception 'QUOTE_DRAFT_REVISION_FAILED %',v_a; end if;
 -- A paused public intake switch must block real mail claim.
 v_a:=public.cargo_customer_quote_claim_send(v_one,v_operator,decode(repeat('aa',32),'hex'));
 if v_a->>'reason'<>'PUBLIC_INTAKE_DISABLED' then raise exception 'QUOTE_OFF_GATE_BYPASS %',v_a; end if;
 if (select delivery_status from public.cargo_customer_quote_replies where request_id=v_one)<>'ready_to_send' then
  raise exception 'QUOTE_OFF_GATE_CHANGED_STATE'; end if;
 update public.cargo_intake_control set intake_enabled=true where id=1;
 v_a:=public.cargo_customer_quote_claim_send(v_one,v_operator,decode(repeat('aa',32),'hex'));
 if v_a->>'reason'<>'SENDING_CLAIMED' or (v_a->>'amount_yen')::integer<>26000 then
  raise exception 'QUOTE_CLAIM_FAILED %',v_a; end if;
 v_a:=public.cargo_customer_quote_claim_send(v_one,v_operator,decode(repeat('aa',32),'hex'));
 if v_a->>'reason'<>'DELIVERY_ALREADY_ATTEMPTED' then
  raise exception 'QUOTE_DUPLICATE_SEND_CLAIM %',v_a; end if;
 v_a:=public.cargo_customer_quote_prepare(v_one,v_operator,99999,v_terms,now()+interval '3 days');
 if v_a->>'reason'<>'DELIVERY_ALREADY_ATTEMPTED' then
  raise exception 'QUOTE_EDIT_AFTER_SEND_CLAIM %',v_a; end if;
 v_a:=public.cargo_customer_quote_finalize(v_one,v_operator,true,'synthetic-provider-id');
 if v_a->>'reason'<>'QUOTE_PROVIDER_ACCEPTED' then raise exception 'QUOTE_FINALIZE_FAILED %',v_a; end if;
 if (select status from public.cargo_customer_intake_requests where id=v_one)<>'quoted' then
  raise exception 'QUOTE_DID_NOT_UPDATE_REQUEST'; end if;
 -- Customer quote response requires a token matching the HMAC stored at send claim.
 v_a:=public.cargo_customer_quote_reply(v_one,decode(repeat('dd',32),'hex'),null);
 if v_a->>'reason'<>'QUOTE_NOT_AVAILABLE' then
  raise exception 'WRONG_REPLY_TOKEN_ACCEPTED %',v_a; end if;
 v_a:=public.cargo_customer_quote_reply(v_one,decode(repeat('aa',32),'hex'),null);
 if v_a->>'reason'<>'QUOTE_VIEW' or (v_a->>'amount_yen')::integer<>26000 then
  raise exception 'QUOTED_AMOUNT_UNAVAILABLE %',v_a; end if;
 v_a:=public.cargo_customer_quote_reply(v_one,decode(repeat('aa',32),'hex'),'interested');
 if v_a->>'reason'<>'INTEREST_RECORDED'
  or v_a->>'contract_confirmed'<>'false'
  or v_a->>'dispatch_created'<>'false'
  or v_a->>'payment_created'<>'false' then
  raise exception 'NON_BINDING_INTEREST_RECORD_FAILED %',v_a; end if;
 v_a:=public.cargo_customer_quote_reply(v_one,decode(repeat('aa',32),'hex'),'declined');
 if v_a->>'reason'<>'ALREADY_REPLIED' then
  raise exception 'CUSTOMER_REPLY_REPLAY_ACCEPTED %',v_a; end if;
 if (select response_state from public.cargo_customer_quote_replies
    where request_id=v_one)<>'interested' then
  raise exception 'CUSTOMER_REPLY_OVERWRITTEN'; end if;
 v_a:=public.cargo_customer_quote_finalize(v_one,v_operator,true,'synthetic-provider-id');
 if v_a->>'reason'<>'NOT_SENDING' then raise exception 'QUOTE_FINALIZE_REPLAY %',v_a; end if;
 -- A separate request with an unknown delivery remains retry-blocked.
 insert into public.cargo_customer_intake_requests
  (id,source_draft_id,contact_hmac,encrypted_payload,status)
 values (v_two,'ffffffff-ffff-4fff-8fff-fffffffffff2',decode(repeat('12',32),'hex'),
  decode(repeat('ab',40),'hex'),'operator_reviewing');
 v_a:=public.cargo_customer_quote_prepare(v_two,v_operator,43000,v_terms,now()+interval '2 days');
 if v_a->>'reason'<>'QUOTE_READY_TO_SEND' then raise exception 'SECOND_QUOTE_PREPARE_FAILED %',v_a; end if;
 v_a:=public.cargo_customer_quote_claim_send(v_two,v_operator,decode(repeat('bb',32),'hex'));
 if v_a->>'reason'<>'SENDING_CLAIMED' then raise exception 'SECOND_QUOTE_SEND_CLAIM_FAILED %',v_a; end if;
 v_a:=public.cargo_customer_quote_finalize(v_two,v_operator,false,null);
 if v_a->>'reason'<>'DELIVERY_UNKNOWN' then raise exception 'UNKNOWN_DELIVERY_NOT_RECORDED %',v_a; end if;
 v_a:=public.cargo_customer_quote_claim_send(v_two,v_operator,decode(repeat('bb',32),'hex'));
 if v_a->>'reason'<>'DELIVERY_ALREADY_ATTEMPTED' then raise exception 'UNKNOWN_DELIVERY_RETRIED %',v_a; end if;
 if (select status from public.cargo_customer_intake_requests where id=v_two)<>'operator_reviewing' then
  raise exception 'UNKNOWN_DELIVERY_WRONGLY_QUOTED'; end if;
 if (select count(*) from public.cargo_customer_quote_replies)<>2 then
  raise exception 'QUOTE_ROWS_UNEXPECTED';end if;
 update public.cargo_intake_control set intake_enabled=false where id=1;
 v_a:=public.cargo_customer_quote_reply(v_one,decode(repeat('aa',32),'hex'),null);
 if v_a->>'reason'<>'PUBLIC_INTAKE_DISABLED' then
  raise exception 'CUSTOMER_REPLY_BYPASSED_OFF_GATE %',v_a; end if;
 raise notice 'PASS: quote prepare, single delivery, secret matching, one-time nonbinding interest, intake OFF gate';
end $$;
