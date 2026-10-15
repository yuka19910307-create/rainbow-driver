-- Rollback-only; no intake switch change, API call, PII or external mail.
begin;
set local role service_role;
do $test$
declare v_result jsonb;
begin
 if has_table_privilege('anon','public.cargo_customer_mail_budget','SELECT')
  or has_function_privilege('authenticated','public.cargo_customer_mail_budget_claim()','EXECUTE')
  then raise exception 'MAIL_BUDGET_PUBLIC_ACCESS'; end if;
 update public.cargo_customer_mail_budget set enabled=true,hourly_limit=2,daily_limit=3,
  hour_started_at=date_trunc('hour',clock_timestamp()),
  day_started_at=(clock_timestamp() at time zone 'Asia/Tokyo')::date,
  hour_attempts=0,day_attempts=0 where id=1;
 for i in 1..2 loop
  v_result:=public.cargo_customer_mail_budget_claim();
  if v_result->>'allowed'<>'true' then raise exception 'EXPECTED_BUDGET_CLAIM'; end if;
 end loop;
 v_result:=public.cargo_customer_mail_budget_claim();
 if v_result->>'reason'<>'MAIL_BUDGET_EXHAUSTED' then raise exception 'HOUR_CAP_BYPASS'; end if;
 if (select day_attempts from public.cargo_customer_mail_budget where id=1)<>2 then
  raise exception 'DENIAL_CHARGED'; end if;
 update public.cargo_customer_mail_budget set hour_started_at=clock_timestamp()-interval '2 hours' where id=1;
 v_result:=public.cargo_customer_mail_budget_claim();
 if v_result->>'allowed'<>'true' then raise exception 'HOUR_RESET_FAILED'; end if;
 update public.cargo_customer_mail_budget set hour_started_at=clock_timestamp()-interval '2 hours' where id=1;
 v_result:=public.cargo_customer_mail_budget_claim();
 if v_result->>'reason'<>'MAIL_BUDGET_EXHAUSTED' then raise exception 'DAY_CAP_BYPASS'; end if;
 update public.cargo_customer_mail_budget set day_started_at=(clock_timestamp() at time zone 'Asia/Tokyo')::date-1 where id=1;
 v_result:=public.cargo_customer_mail_budget_claim();
 if v_result->>'allowed'<>'true' then raise exception 'JST_DAY_RESET_FAILED'; end if;
 if (select day_attempts from public.cargo_customer_mail_budget where id=1)<>1 then raise exception 'RESET_COUNT'; end if;
 update public.cargo_customer_mail_budget set enabled=false where id=1;
 v_result:=public.cargo_customer_mail_budget_claim();
 if v_result->>'reason'<>'MAIL_BUDGET_UNAVAILABLE' then raise exception 'DISABLED_BUDGET_ALLOWED'; end if;
end;
$test$;
rollback;
select jsonb_build_object('rollback_tests','passed',
 'intake_enabled',(select intake_enabled from public.cargo_intake_control where id=1),
 'hour_attempts',(select hour_attempts from public.cargo_customer_mail_budget where id=1),
 'day_attempts',(select day_attempts from public.cargo_customer_mail_budget where id=1));
