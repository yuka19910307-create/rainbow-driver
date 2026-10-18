-- STAGING ONLY: hvdoqcrnztqmbzgwrovd. Run with a privileged SQL connection.
-- A SELECT-only snapshot: no functions invoked, mail, cleanup, locks or mutations.
-- Does not return customer IDs, payloads, HMACs, OTPs, tokens or provider errors.
with observed as (select statement_timestamp() as at),
expected(name,schedule,max_age_seconds) as (values
 ('cargo-staging-expired-intake-drafts','*/5 * * * *',1200),
 ('cargo-staging-closed-no-order-retention','17 * * * *',5400),
 ('cargo-staging-owner-mail-trial-expire','* * * * *',300)
), jobs as (
 select e.name,e.max_age_seconds,j.jobid is not null as present,
  coalesce(j.active,false) as active,coalesce(j.schedule=e.schedule,false) as schedule_matches,
  (select max(d.end_time) from cron.job_run_details d
   where d.jobid=j.jobid and d.status='succeeded') as last_success,
  (select max(d.end_time) from cron.job_run_details d
   where d.jobid=j.jobid and d.status='failed') as last_failure
 from expected e left join cron.job j on j.jobname=e.name
)
select jsonb_build_object(
 'schema_version',1,'scope','staging-cargo-monitor','observed_at',o.at,
 'control',(select jsonb_build_object('intake_enabled',intake_enabled,
   'captcha_required',captcha_required,'contact_verification_required',contact_verification_required)
  from public.cargo_intake_control where id=1),
 'counts',jsonb_build_object(
  'delivery_unknown',(select count(*) from public.cargo_customer_quote_replies where delivery_status='delivery_unknown'),
  'sending_over_10m',(select count(*) from public.cargo_customer_quote_replies
   where delivery_status='sending' and (delivery_attempted_at is null or delivery_attempted_at<o.at-interval '10 minutes')),
  'drafts_overdue_15m',(select count(*) from public.cargo_customer_intake_drafts where delete_after<o.at-interval '15 minutes'),
  'expired_trials_enabled_2m',(select count(*) from public.cargo_staging_owner_test_runs
   where enabled and expires_at<o.at-interval '2 minutes'),
  'active_owner_trials',(select count(*) from public.cargo_staging_owner_test_runs where enabled and expires_at>o.at)
 ),
 'jobs',(select jsonb_agg(jsonb_build_object('name',name,'present',present,'active',active,
  'schedule_matches',schedule_matches,'max_age_seconds',max_age_seconds,
  'last_success',last_success,'last_failure',last_failure) order by name) from jobs)
) as cargo_monitor_snapshot from observed o;
