-- PRODUCTION HOLD ONLY: expected project kvoaorzdewwirqryeizq.
-- Verify the selected project separately; scope is a label, not an attestation.
-- SELECT only. Requires privileged access and the existing pg_cron relations.
-- No payloads, identifiers, links, credentials, SQL commands or error text leave the DB.
-- Job names/cadences below are reviewed proposals, NOT installed by this file.
with observed as (select statement_timestamp() as at),
expected(name,schedule,command,max_age_seconds) as (values
 ('cargo-production-expired-intake-drafts','*/5 * * * *','select public.cargo_customer_intake_cleanup(100);',1200),
 ('cargo-production-closed-no-order-retention','17 * * * *','select public.cargo_customer_closed_cleanup(100);',5400)
), jobs as (
 select e.name,e.max_age_seconds,j.jobid is not null as present,
  coalesce(j.active,false) as active,coalesce(j.schedule=e.schedule,false) as schedule_matches,
  coalesce(j.command=e.command,false) as command_matches,
  coalesce(j.database=current_database(),false) as database_matches,
  (select max(d.end_time) from cron.job_run_details d
   where d.jobid=j.jobid and d.status='succeeded') as last_success,
  (select max(d.end_time) from cron.job_run_details d
   where d.jobid=j.jobid and d.status='failed') as last_failure
 from expected e left join cron.job j on j.jobname=e.name
), expected_tables(name) as (values
 ('cargo_customer_intake_drafts'),('cargo_customer_intake_requests'),
 ('cargo_customer_quote_replies'),('cargo_customer_mail_budget'),
 ('cargo_customer_quote_followups'),('cargo_customer_quote_followup_events'),
 ('cargo_customer_retention_runs')
), tables as (
 select c.oid,c.relrowsecurity from expected_tables e
 join pg_namespace n on n.nspname='public'
 join pg_class c on c.relnamespace=n.oid and c.relname=e.name and c.relkind='r'
), expected_signatures(signature) as (values
 ('public.cargo_customer_intake_verify_commit(uuid,bytea)'),
 ('public.cargo_customer_intake_cleanup(integer)'),
 ('public.cargo_customer_quote_prepare(uuid,uuid,integer,text,timestamptz)'),
 ('public.cargo_customer_quote_claim_send(uuid,uuid,bytea)'),
 ('public.cargo_customer_quote_finalize(uuid,uuid,boolean,text)'),
 ('public.cargo_customer_quote_reply(uuid,bytea,text)'),
 ('public.cargo_customer_mail_budget_claim()'),
 ('public.cargo_customer_followup_save(uuid,uuid,text,text,text)'),
 ('public.cargo_customer_close_no_order(uuid,uuid,boolean)'),
 ('public.cargo_customer_retention_set_hold(uuid,uuid,boolean)'),
 ('public.cargo_customer_closed_cleanup(integer)')
), expected_routines as (
 select to_regprocedure(signature)::oid as oid from expected_signatures
), routines as (
 select p.oid,p.prosecdef from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public' and left(p.proname,15)='cargo_customer_'
)
select jsonb_build_object(
 'schema_version',1,'scope','production-cargo-prelaunch-hold','observed_at',o.at,
 'control',(select jsonb_build_object('intake_enabled',intake_enabled,
   'captcha_required',captcha_required,'contact_verification_required',contact_verification_required)
  from public.cargo_intake_control where id=1),
 'mail_budget',(select jsonb_build_object('enabled',enabled,'hourly_limit',hourly_limit,
   'daily_limit',daily_limit,'hour_attempts',hour_attempts,'day_attempts',day_attempts)
  from public.cargo_customer_mail_budget where id=1),
 'counts',jsonb_build_object(
  'drafts',(select count(*) from public.cargo_customer_intake_drafts),
  'requests',(select count(*) from public.cargo_customer_intake_requests),
  'quotes',(select count(*) from public.cargo_customer_quote_replies),
  'followups',(select count(*) from public.cargo_customer_quote_followups),
  'followup_events',(select count(*) from public.cargo_customer_quote_followup_events),
  'retention_runs',(select count(*) from public.cargo_customer_retention_runs),
  'delivery_unknown',(select count(*) from public.cargo_customer_quote_replies where delivery_status='delivery_unknown'),
  'sending_over_10m',(select count(*) from public.cargo_customer_quote_replies
   where delivery_status='sending' and (delivery_attempted_at is null or delivery_attempted_at<o.at-interval '10 minutes')),
  'drafts_overdue_15m',(select count(*) from public.cargo_customer_intake_drafts where delete_after<o.at-interval '15 minutes'),
  'closed_cleanup_overdue_90m',(select count(*) from public.cargo_customer_intake_requests r
   where r.status='closed' and r.closed_no_order_at<=o.at-interval '30 days 90 minutes'
    and r.delete_after<=o.at-interval '90 minutes' and r.retention_hold=false
    and not exists(select 1 from public.cargo_customer_quote_followups f
     where f.request_id=r.id and f.stage<>'closed_no_order')
    and not exists(select 1 from public.cargo_customer_quote_replies q
     where q.request_id=r.id and q.delivery_status in ('sending','delivery_unknown'))),
  'held_closed_requests',(select count(*) from public.cargo_customer_intake_requests
   where status='closed' and closed_no_order_at is not null and retention_hold=true)
 ),
 'customer_security',jsonb_build_object(
  'tables_present',(select count(*) from tables),
  'tables_rls_enabled',(select count(*) from tables where relrowsecurity),
  'tables_client_access',(select count(*) from tables where
   has_table_privilege('anon',oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
   or has_table_privilege('authenticated',oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
   or has_any_column_privilege('anon',oid,'SELECT,INSERT,UPDATE,REFERENCES')
   or has_any_column_privilege('authenticated',oid,'SELECT,INSERT,UPDATE,REFERENCES')),
  'functions_present',(select count(*) from routines),
  'functions_missing',(select count(*) from expected_routines where oid is null),
  'functions_unexpected',(select count(*) from routines r where not exists
   (select 1 from expected_routines e where e.oid=r.oid)),
  'functions_security_definer',(select count(*) from routines where prosecdef),
  'functions_client_execute',(select count(*) from routines where
   has_function_privilege('anon',oid,'EXECUTE') or has_function_privilege('authenticated',oid,'EXECUTE'))
 ),
 'jobs',(select jsonb_agg(jsonb_build_object('name',name,'present',present,'active',active,
  'schedule_matches',schedule_matches,'command_matches',command_matches,
  'database_matches',database_matches,'max_age_seconds',max_age_seconds,
  'last_success',last_success,'last_failure',last_failure) order by name) from jobs)
) as cargo_production_monitor_snapshot from observed o;
