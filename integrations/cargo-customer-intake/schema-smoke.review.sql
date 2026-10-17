-- Disposable PostgreSQL only. Applies after cargo-customer-intake/schema.review.sql.
\set ON_ERROR_STOP on
do $$
declare
 v_result jsonb;
 v_draft uuid:='cccccccc-cccc-4ccc-8ccc-ccccccccccc1';
 v_draft2 uuid:='cccccccc-cccc-4ccc-8ccc-ccccccccccc2';
 v_count integer;
begin
 if not (select relrowsecurity from pg_class
   where oid='public.cargo_customer_intake_drafts'::regclass) or
   not (select relrowsecurity from pg_class
   where oid='public.cargo_customer_intake_requests'::regclass) then
  raise exception 'CUSTOMER_TABLE_RLS_MISSING';
 end if;
 if has_table_privilege('anon','public.cargo_customer_intake_drafts','SELECT')
  or has_table_privilege('authenticated','public.cargo_customer_intake_requests','SELECT')
  or has_function_privilege('anon','public.cargo_customer_intake_verify_commit(uuid,bytea)','EXECUTE')
  or has_function_privilege('authenticated','public.cargo_customer_intake_verify_commit(uuid,bytea)','EXECUTE')
 then raise exception 'CUSTOMER_DATA_PUBLIC_ACCESS';end if;
 -- Under OFF gate, even a synthetically valid proof cannot create a queue request.
 insert into public.cargo_customer_intake_drafts
  (id,attempt_id,contact_hmac,encrypted_payload,code_hmac,expires_at)
 values(v_draft,'dddddddd-dddd-4ddd-8ddd-ddddddddddd1',
  decode(repeat('ab',32),'hex'),decode(repeat('ab',30),'hex'),
  decode(repeat('cd',32),'hex'),now()+interval '10 minutes');
 v_result:=public.cargo_customer_intake_verify_commit(v_draft,decode(repeat('cd',32),'hex'));
 if v_result->>'reason'<>'PUBLIC_INTAKE_DISABLED' then
  raise exception 'OFF_GATE_NOT_ENFORCED %',v_result;end if;
 if (select count(*) from public.cargo_customer_intake_requests)<>0 then
  raise exception 'OFF_GATE_CREATED_CUSTOMER_REQUEST';end if;
 -- Simulate future explicit intake enable ONLY in this disposable container.
 update public.cargo_intake_control set intake_enabled=true where id=1;
 v_result:=public.cargo_customer_intake_verify_commit(v_draft,decode(repeat('ef',32),'hex'));
 if v_result->>'reason'<>'INVALID_CODE' then
  raise exception 'WRONG_CODE_ACCEPTED %',v_result;end if;
 if (select attempts from public.cargo_customer_intake_drafts where id=v_draft)<>1 then
  raise exception 'WRONG_CODE_DID_NOT_COUNT';end if;
 v_result:=public.cargo_customer_intake_verify_commit(v_draft,decode(repeat('cd',32),'hex'));
 if v_result->>'reason'<>'PENDING_OPERATOR_REVIEW' then
  raise exception 'VALID_CUSTOMER_OTP_FAILED %',v_result;end if;
 if (select count(*) from public.cargo_customer_intake_requests where source_draft_id=v_draft)<>1 then
  raise exception 'CUSTOMER_REQUEST_NOT_CREATED_ONCE';end if;
 if not exists(select 1 from public.cargo_customer_intake_drafts
  where id=v_draft and consumed_at is not null and encrypted_payload is null) then
  raise exception 'CUSTOMER_DRAFT_CIPHERTEXT_NOT_ERASED';end if;
 v_result:=public.cargo_customer_intake_verify_commit(v_draft,decode(repeat('cd',32),'hex'));
 if v_result->>'reason'<>'ALREADY_USED' then
  raise exception 'REPLAY_ACCEPTED %',v_result;end if;
 insert into public.cargo_customer_intake_drafts
  (id,attempt_id,contact_hmac,encrypted_payload,code_hmac,expires_at)
 values(v_draft2,'dddddddd-dddd-4ddd-8ddd-ddddddddddd2',
  decode(repeat('12',32),'hex'),decode(repeat('ab',30),'hex'),
  decode(repeat('34',32),'hex'),now()-interval '1 minute');
 v_result:=public.cargo_customer_intake_verify_commit(v_draft2,decode(repeat('34',32),'hex'));
 if v_result->>'reason'<>'EXPIRED' then
  raise exception 'EXPIRED_CUSTOMER_OTP_ACCEPTED %',v_result;end if;
 update public.cargo_intake_control set intake_enabled=false where id=1;
 if (select intake_enabled from public.cargo_intake_control where id=1) is not false then
  raise exception 'DISPOSABLE_INTAKE_GATE_NOT_RESET';end if;
 raise notice 'PASS: customer intake tables private, OFF blocks queue, OTP single use, invalid code, expiry, ciphertext erased';
end $$;
