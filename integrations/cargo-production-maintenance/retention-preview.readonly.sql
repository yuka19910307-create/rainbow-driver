-- REVIEW ONLY: SELECT, no cleanup invocation, row locks, cron change or network.
-- Confirm the selected Supabase project separately. scope is a format label.
-- Counts estimate one batch of the existing cleanup functions; concurrent row
-- locks/changes and the cleanup's later clock_timestamp() can change the result.
with
observed as materialized (select statement_timestamp() as at),
expired_drafts as materialized (
 select d.id from public.cargo_customer_intake_drafts d,observed o
 where d.delete_after<o.at
),
draft_batch as materialized (
 select d.id from public.cargo_customer_intake_drafts d,observed o
 where d.delete_after<o.at order by d.delete_after,d.id limit 100
),
closed_eligible as materialized (
 select r.id,r.source_draft_id,r.closed_no_order_at
 from public.cargo_customer_intake_requests r,observed o
 where r.status='closed' and r.closed_no_order_at is not null
  and r.closed_no_order_at<=o.at-interval '30 days'
  and r.delete_after<=o.at and r.retention_hold=false
  and not exists(select 1 from public.cargo_customer_quote_followups f
   where f.request_id=r.id and f.stage<>'closed_no_order')
  and not exists(select 1 from public.cargo_customer_quote_replies q
   where q.request_id=r.id and q.delivery_status in ('sending','delivery_unknown'))
),
closed_batch as materialized (
 select id,source_draft_id from closed_eligible order by closed_no_order_at,id limit 100
),
related_jobs as materialized (
 -- Deliberately conservative text match: counts obvious differently named
 -- cleanup jobs, including inactive ones. Not an SQL parser or wrapper audit.
 select j.jobid,j.active,j.database
 from cron.job j
 where j.jobname in ('cargo-production-expired-intake-drafts','cargo-production-closed-no-order-retention')
  or j.command ~* 'cargo_customer_(intake|closed)_cleanup'
)
select jsonb_build_object(
 'schema_version',1,'scope','production-cargo-retention-preview',
 'observed_at',(select at from observed),'batch_limit',100,
 'drafts',jsonb_build_object(
  'eligible',(select count(*) from expired_drafts),
  'batch',(select count(*) from draft_batch)),
 'closed',jsonb_build_object(
  'eligible',(select count(*) from closed_eligible),
  'batch',jsonb_build_object(
   'requests',(select count(*) from closed_batch),
   'quotes',(select count(*) from public.cargo_customer_quote_replies q join closed_batch b on b.id=q.request_id),
   'followups',(select count(*) from public.cargo_customer_quote_followups f join closed_batch b on b.id=f.request_id),
   'events',(select count(*) from public.cargo_customer_quote_followup_events e join closed_batch b on b.id=e.request_id),
   'consumed_source_drafts',(select count(*) from public.cargo_customer_intake_drafts d join closed_batch b on b.source_draft_id=d.id where d.consumed_at is not null)),
  -- Categories overlap; do not add these counts together.
  'protected',jsonb_build_object(
   'held',(select count(*) from public.cargo_customer_intake_requests where retention_hold=true),
   'unclosed_followup',(select count(*) from public.cargo_customer_intake_requests r where exists(select 1 from public.cargo_customer_quote_followups f where f.request_id=r.id and f.stage<>'closed_no_order')),
   'unresolved_delivery',(select count(*) from public.cargo_customer_intake_requests r where exists(select 1 from public.cargo_customer_quote_replies q where q.request_id=r.id and q.delivery_status in ('sending','delivery_unknown'))))),
 'existing_cleanup_jobs',jsonb_build_object(
  'related',(select count(*) from related_jobs),
  'active',(select count(*) from related_jobs where active=true),
  'other_database',(select count(*) from related_jobs where database is distinct from current_database())),
 'history',jsonb_build_object(
  'application_runs',(select count(*) from public.cargo_customer_retention_runs),
  'related_cron_runs',(select count(*) from cron.job_run_details d join related_jobs j on j.jobid=d.jobid))
) as cargo_retention_preview;
