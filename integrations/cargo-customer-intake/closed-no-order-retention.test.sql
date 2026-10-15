begin;
set local role service_role;
do $test$
declare
 v_owner uuid; v_ids uuid[]; v_id uuid; v_source uuid;
 v_result jsonb; v_before timestamptz; i integer;
begin
 select user_id into strict v_owner from public.cargo_operator_accounts limit 1;
 v_ids:=array[]::uuid[];
 for i in 1..7 loop
  v_id:=gen_random_uuid(); v_ids:=array_append(v_ids,v_id);
  insert into public.cargo_customer_intake_requests
   (id,source_draft_id,contact_hmac,encrypted_payload,status,
    closed_no_order_at,retention_hold,delete_after)
  values(v_id,gen_random_uuid(),decode(repeat('00',32),'hex'),
   decode(repeat('00',29),'hex'),
   case when i=1 then 'operator_reviewing' else 'closed' end,
   case when i=1 then null when i=3 then now()-interval '29 days'
    else now()-interval '31 days' end,
   i in (1,4), now()-interval '1 day');
 end loop;
 -- 1: active but old; 2: due; 3: not yet due; 4: hold;
 -- 5: offline record; 6: ambiguous mail; 7: explicitly closed now.
 insert into public.cargo_customer_quote_replies
  (request_id,prepared_by,amount_yen,terms,valid_until,delivery_status)
 values(v_ids[2],v_owner,10000,repeat('test ',8),now()-interval '1 day','sent'),
       (v_ids[6],v_owner,10000,repeat('test ',8),now()-interval '1 day','delivery_unknown');
 insert into public.cargo_customer_quote_followups
  (request_id,stage,operator_note,updated_by)
 values(v_ids[2],'closed_no_order','synthetic no order',v_owner),
       (v_ids[5],'handled_offline','synthetic preserved',v_owner);
 insert into public.cargo_customer_quote_followup_events
  (request_id,new_stage,operator_note,operator_id)
 values(v_ids[2],'closed_no_order','synthetic no order',v_owner);
 select source_draft_id into v_source from public.cargo_customer_intake_requests where id=v_ids[2];
 insert into public.cargo_customer_intake_drafts
  (id,attempt_id,contact_hmac,encrypted_payload,code_hmac,expires_at,consumed_at)
 values(v_source,gen_random_uuid(),decode(repeat('00',32),'hex'),null,
  decode(repeat('00',32),'hex'),now()+interval '10 minutes',now());

 v_result:=public.cargo_customer_close_no_order(v_ids[1],v_owner,false);
 if v_result->>'reason'<>'NO_ORDER_CONFIRMATION_REQUIRED' then raise exception 'missing explicit confirmation guard'; end if;
 v_result:=public.cargo_customer_close_no_order(v_ids[1],gen_random_uuid(),true);
 if v_result->>'reason'<>'OPERATOR_ONLY' then raise exception 'missing operator guard'; end if;
 -- Active and held stay excluded even if their original delete_after is old.
 v_result:=public.cargo_customer_closed_cleanup(0);
 if v_result->>'reason'<>'INVALID_LIMIT' then raise exception 'limit guard'; end if;
 -- Reset row 7 to ordinary review; verify closure gets a fresh 30 days.
 update public.cargo_customer_intake_requests set closed_no_order_at=null,status='operator_reviewing',retention_hold=true where id=v_ids[7];
 v_before:=clock_timestamp();
 v_result:=public.cargo_customer_close_no_order(v_ids[7],v_owner,true);
 if v_result->>'reason'<>'CLOSED_NO_ORDER' then raise exception 'closure failed'; end if;
 if not exists(select 1 from public.cargo_customer_intake_requests where id=v_ids[7]
  and closed_no_order_at>=v_before and delete_after>=v_before+interval '30 days') then raise exception 'closure deadline'; end if;
 v_result:=public.cargo_customer_retention_set_hold(v_ids[7],v_owner,true);
 if not (v_result->>'ok')::boolean then raise exception 'hold failed'; end if;
 v_result:=public.cargo_customer_retention_set_hold(v_ids[1],v_owner,false);
 if v_result->>'reason'<>'CLOSURE_REQUIRED' then raise exception 'active release guard'; end if;
 v_result:=public.cargo_customer_retention_set_hold(v_ids[7],v_owner,false);
 if not (v_result->>'ok')::boolean then raise exception 'hold release failed'; end if;
 v_result:=public.cargo_customer_closed_cleanup(100);
 if (v_result->>'requests_deleted')::integer<>1
  or (v_result->>'quotes_deleted')::integer<>1
  or (v_result->>'followups_deleted')::integer<>1
  or (v_result->>'events_deleted')::integer<>1
  or (v_result->>'drafts_deleted')::integer<>1 then
  raise exception 'unexpected deletion counts: %',v_result;
 end if;
 if (select count(*) from public.cargo_customer_intake_requests where id=any(v_ids))<>6 then
  raise exception 'protected rows missing';
 end if;
 v_result:=public.cargo_customer_closed_cleanup(100);
 if (v_result->>'requests_deleted')::integer<>0 then raise exception 'cleanup not idempotent'; end if;
 if has_function_privilege('anon','public.cargo_customer_closed_cleanup(integer)','execute')
  or has_function_privilege('authenticated','public.cargo_customer_close_no_order(uuid,uuid,boolean)','execute')
  or has_table_privilege('anon','public.cargo_customer_retention_runs','select') then
  raise exception 'public access was granted';
 end if;
end;
$test$;
rollback;
select jsonb_build_object('synthetic_assertions','passed; transaction rolled back',
 'request_count',(select count(*) from public.cargo_customer_intake_requests),
 'retention_run_count',(select count(*) from public.cargo_customer_retention_runs),
 'intake_enabled',(select intake_enabled from public.cargo_intake_control where id=1));
