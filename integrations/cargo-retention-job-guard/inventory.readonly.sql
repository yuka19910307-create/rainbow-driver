-- REVIEW ONLY. Run in an explicitly READ ONLY transaction after independently
-- checking the project. This SELECT never invokes cleanup or changes cron.
-- Arbitrary names, commands, schedules, owners, hosts and database names are
-- deliberately not emitted. Unknown/wrapped commands need a separate audit.
with
expected(target,jobname,routine) as (values
 ('drafts','cargo-production-expired-intake-drafts','cargo_customer_intake_cleanup'),
 ('closed','cargo-production-closed-no-order-retention','cargo_customer_closed_cleanup')
),
catalog as materialized (
 select j.jobid,j.jobname,j.command,j.database,j.active,j.schedule from cron.job j
),
related as materialized (
 select j.*,
  (select e.target from expected e where e.jobname=j.jobname) as canonical_name,
  exists(select 1 from expected e where lower(j.jobname)=e.jobname and j.jobname<>e.jobname) as case_variant_name,
  (select jsonb_agg(e.target order by e.target) from expected e
   where lower(j.jobname)=e.jobname or j.command ~* e.routine) as targets
 from catalog j
 where exists(select 1 from expected e
  where lower(j.jobname)=e.jobname or j.command ~* e.routine)
),
classified as materialized (
 select j.*,
  case
   when j.command ~* '^[[:space:]]*select[[:space:]]+public[.]cargo_customer_intake_cleanup[[:space:]]*[(][[:space:]]*100[[:space:]]*[)][[:space:]]*;?[[:space:]]*$' then 'drafts'
   when j.command ~* '^[[:space:]]*select[[:space:]]+public[.]cargo_customer_closed_cleanup[[:space:]]*[(][[:space:]]*100[[:space:]]*[)][[:space:]]*;?[[:space:]]*$' then 'closed'
   else null
  end as direct_target,
  case
   when j.schedule ~ '^[[:space:]]*[0-9]+[[:space:]]+seconds[[:space:]]*$' then 'second_interval'
   when j.schedule ~ '^[[:space:]]*[[:alnum:]*/,-]+([[:space:]]+[[:alnum:]*/,-]+){4}[[:space:]]*$' then 'cron_expression'
   else 'unrecognized'
  end as schedule_kind,
  dense_rank() over(order by j.schedule nulls first) as schedule_equality_group
 from related j
)
select jsonb_build_object(
 'schema_version',1,'scope','cargo-retention-job-registration-inventory',
 'observed_at',statement_timestamp(),
 'read_only_transaction',current_setting('transaction_read_only')='on',
 'catalog_visibility_complete',not pg_catalog.row_security_active('cron.job'::regclass),
 'visible_job_count',(select count(*) from catalog),
 'related_job_count',(select count(*) from classified),
 'jobs',coalesce((select jsonb_agg(jsonb_build_object(
  'jobid',j.jobid,'canonical_name',j.canonical_name,
  'case_variant_name',j.case_variant_name,'targets',j.targets,
  'active',j.active,'same_database',j.database is not distinct from current_database(),
  'direct_batch_100_target',j.direct_target,
  'schedule_kind',j.schedule_kind,'schedule_equality_group',j.schedule_equality_group
 ) order by j.jobid)
 from (select * from classified order by jobid limit 1000) j),'[]'::jsonb)
) as cargo_retention_job_inventory;
