-- Run ONLY in the disposable GitHub Actions PostgreSQL 16 container
-- AFTER customer schema, quotes schema/smoke and followup.review.sql.
\set ON_ERROR_STOP on
do $$
declare
 v_request uuid;
 v_operator constant uuid:='11111111-1111-4111-8111-111111111111';
 v_not_operator constant uuid:='99999999-9999-4999-8999-999999999999';
 v_result jsonb;
 v_events integer;
begin
 if not (select relrowsecurity from pg_class
  where oid='public.cargo_customer_quote_followups'::regclass)
 or not (select relrowsecurity from pg_class
  where oid='public.cargo_customer_quote_followup_events'::regclass) then
  raise exception 'FOLLOWUP_RLS_MISSING';
 end if;
 if has_table_privilege('anon','public.cargo_customer_quote_followups','SELECT')
  or has_table_privilege('authenticated','public.cargo_customer_quote_followup_events','INSERT')
  or has_function_privilege('anon','public.cargo_customer_followup_save(uuid,uuid,text,text,text)','EXECUTE')
  or has_function_privilege('authenticated','public.cargo_customer_followup_save(uuid,uuid,text,text,text)','EXECUTE')
 then raise exception 'FOLLOWUP_PUBLIC_ACCESS_EXPOSED'; end if;
 select id into v_request from public.cargo_customer_intake_requests
  where source_draft_id='cccccccc-cccc-4ccc-8ccc-ccccccccccc1'::uuid;
 if v_request is null then raise exception 'INTERESTED_QUOTE_FIXTURE_NOT_FOUND';end if;
 -- The quotes smoke test leaves public intake OFF.
 v_result:=public.cargo_customer_followup_save(
  v_request,v_operator,null,'contact_attempted','架空のお客様に連絡した記録です。');
 if v_result->>'reason'<>'PUBLIC_INTAKE_DISABLED' then
  raise exception 'FOLLOWUP_OFF_GATE_BYPASS %',v_result; end if;
 update public.cargo_intake_control set intake_enabled=true where id=1;
 v_result:=public.cargo_customer_followup_save(
  v_request,v_not_operator,null,'contact_attempted','架空のお客様に連絡した記録です。');
 if v_result->>'reason'<>'OPERATOR_ONLY' then
  raise exception 'FOLLOWUP_NON_OPERATOR_ALLOWED %',v_result;end if;
 -- Missing or declined customer replies must never allow contact follow-up.
 update public.cargo_customer_quote_replies
  set response_state=null,responded_at=null where request_id=v_request;
 v_result:=public.cargo_customer_followup_save(
  v_request,v_operator,null,'contact_attempted','未回答の架空のお客様についての拒否テスト。');
 if v_result->>'reason' is distinct from 'CUSTOMER_INTEREST_REQUIRED' then
  raise exception 'FOLLOWUP_UNANSWERED_CUSTOMER_ALLOWED %',v_result;end if;
 update public.cargo_customer_quote_replies
  set response_state='declined',responded_at=clock_timestamp() where request_id=v_request;
 v_result:=public.cargo_customer_followup_save(
  v_request,v_operator,null,'contact_attempted','辞退した架空のお客様についての拒否テスト。');
 if v_result->>'reason' is distinct from 'CUSTOMER_INTEREST_REQUIRED' then
  raise exception 'FOLLOWUP_DECLINED_CUSTOMER_ALLOWED %',v_result;end if;
 if exists(select 1 from public.cargo_customer_quote_followups where request_id=v_request)
  or exists(select 1 from public.cargo_customer_quote_followup_events where request_id=v_request)
 then raise exception 'REJECTED_FOLLOWUP_CREATED_RECORDS';end if;
 update public.cargo_customer_quote_replies
  set response_state='interested',responded_at=clock_timestamp() where request_id=v_request;
 v_result:=public.cargo_customer_followup_save(
  v_request,v_operator,null,'awaiting_reply','架空のお客様の返答を待つ。');
 if v_result->>'reason'<>'INVALID_TRANSITION' then
  raise exception 'FOLLOWUP_SKIPPED_CONTACT_STAGE %',v_result;end if;
 v_result:=public.cargo_customer_followup_save(
  v_request,v_operator,null,'contact_attempted','短い');
 if v_result->>'reason'<>'INVALID_INPUT' then
  raise exception 'FOLLOWUP_SHORT_NOTE_ALLOWED %',v_result;end if;
 v_result:=public.cargo_customer_followup_save(
  v_request,v_operator,null,'contact_attempted','メールにて架空のお客様へ個別連絡済みです。');
 if v_result->>'reason'<>'FOLLOWUP_RECORDED' or
   v_result->>'booking_confirmed'<>'false' or
   v_result->>'dispatch_created'<>'false' or
   v_result->>'payment_created'<>'false' or
   v_result->>'customer_notified'<>'false' then
   raise exception 'FOLLOWUP_FIRST_STAGE_FAILED %',v_result;end if;
 v_result:=public.cargo_customer_followup_save(
  v_request,v_operator,null,'contact_attempted','同時更新による上書きを試みるテスト。');
 if v_result->>'reason'<>'STATUS_CHANGED' then
  raise exception 'FOLLOWUP_STALE_WRITE_ALLOWED %',v_result;end if;
 v_result:=public.cargo_customer_followup_save(
  v_request,v_operator,'contact_attempted','awaiting_reply','架空のお客様の返事をお待ちしています。');
 if v_result->>'reason'<>'FOLLOWUP_RECORDED' then
  raise exception 'FOLLOWUP_WAIT_STAGE_FAILED %',v_result;end if;
 v_result:=public.cargo_customer_followup_save(
  v_request,v_operator,'awaiting_reply','handled_offline','架空の案件は管理者が外部で対応済みと記録しました。');
 if v_result->>'reason'<>'FOLLOWUP_RECORDED' then
  raise exception 'FOLLOWUP_FINISH_STAGE_FAILED %',v_result;end if;
 v_result:=public.cargo_customer_followup_save(
  v_request,v_operator,'handled_offline','contact_attempted','終了後に戻そうとする操作です。');
 if v_result->>'reason'<>'ALREADY_CLOSED' then
  raise exception 'FOLLOWUP_REOPENED_COMPLETED %',v_result;end if;
 select count(*) into v_events from public.cargo_customer_quote_followup_events
  where request_id=v_request;
 if v_events<>3 then raise exception 'FOLLOWUP_AUDIT_EVENTS_WRONG %',v_events;end if;
 if (select status from public.cargo_customer_intake_requests where id=v_request)<>'quoted' then
  raise exception 'FOLLOWUP_MODIFIED_BOOKING_STATUS';end if;
 update public.cargo_intake_control set intake_enabled=false where id=1;
 raise notice 'PASS: operator follow-up, optimistic locking, transition rules, event history, OFF gate, no auto booking';
end $$;
set role service_role;
do $$
declare
 v_request uuid;
 v_result jsonb;
begin
 select id into v_request from public.cargo_customer_intake_requests
  where source_draft_id='cccccccc-cccc-4ccc-8ccc-ccccccccccc1'::uuid;
 v_result:=public.cargo_customer_followup_save(
  v_request,'11111111-1111-4111-8111-111111111111',
  'handled_offline','contact_attempted','サービスロールによる停止時の確認。');
 if v_result->>'reason'<>'PUBLIC_INTAKE_DISABLED' then
  raise exception 'SERVICE_ROLE_OFF_GATE_FAILED %',v_result;end if;
end $$;
reset role;
