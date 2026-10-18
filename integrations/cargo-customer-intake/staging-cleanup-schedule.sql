-- Staging only: hvdoqcrnztqmbzgwrovd. General intake remains OFF.
-- Uses existing delete_after (30 minutes). Each run removes at most 100 drafts.
-- Does not delete verified request/quote/followup records or owner-test records.
create extension if not exists pg_cron;
select cron.schedule('cargo-staging-expired-intake-drafts','*/5 * * * *','select public.cargo_customer_intake_cleanup(100);');
