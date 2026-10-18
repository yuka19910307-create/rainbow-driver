-- STAGING ONLY hvdoqcrnztqmbzgwrovd. Requires staging-monitor-state.review.sql.
-- Preflight the exact job name before running; never overwrite an existing job.
do $schedule$
begin
 if exists(select 1 from cron.job where jobname='cargo-staging-health-monitor') then
  raise exception 'CARGO_MONITOR_JOB_ALREADY_EXISTS';
 end if;
 perform cron.schedule('cargo-staging-health-monitor','*/5 * * * *',
  'select public.cargo_staging_monitor_tick();');
end;
$schedule$;
