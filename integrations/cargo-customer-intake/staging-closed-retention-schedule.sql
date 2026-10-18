-- STAGING ONLY: run after closed-no-order-retention.review.sql.
-- No customer notification. cron.job_run_details records failures.
select cron.schedule(
 'cargo-staging-closed-no-order-retention',
 '17 * * * *',
 'select public.cargo_customer_closed_cleanup(100);'
);