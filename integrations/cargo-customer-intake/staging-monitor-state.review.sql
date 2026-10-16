-- STAGING ONLY: hvdoqcrnztqmbzgwrovd. No schedule is installed by this file.
-- Persist only the latest sanitized health state; never customer data or error text.
begin;
create table public.cargo_staging_monitor_state (
 id smallint primary key check(id=1),
 checked_at timestamptz not null,
 ok boolean not null,
 issues text[] not null,
 counts jsonb not null check(jsonb_typeof(counts)='object'),
 last_ok_at timestamptz,
 last_failure_at timestamptz,
 consecutive_failures bigint not null default 0 check(consecutive_failures>=0),
 total_failures bigint not null default 0 check(total_failures>=0)
);
alter table public.cargo_staging_monitor_state enable row level security;
revoke all on public.cargo_staging_monitor_state from public,anon,authenticated;
grant select,insert,update on public.cargo_staging_monitor_state to service_role;

create function public.cargo_staging_monitor_snapshot()
returns jsonb language sql security invoker set search_path='' as $snapshot$
-- BEGIN SNAPSHOT
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
-- END SNAPSHOT
$snapshot$;
revoke all on function public.cargo_staging_monitor_snapshot() from public,anon,authenticated;
grant execute on function public.cargo_staging_monitor_snapshot() to service_role;

create function public.cargo_staging_monitor_tick()
returns jsonb language plpgsql security invoker set search_path='' as $tick$
declare
 v jsonb; j jsonb; v_counts jsonb:='{}'::jsonb;
 v_issues text[]:='{}'; v_now timestamptz; v_prefix text;
 v_success timestamptz; v_failure timestamptz; v_ok boolean;
begin
 insert into public.cargo_staging_monitor_state(id,checked_at,ok,issues,counts)
 values (1,clock_timestamp(),false,array['NOT_CHECKED'],'{}') on conflict(id) do nothing;
 -- Serialize before reading: an older concurrent result cannot overwrite a newer one.
 perform 1 from public.cargo_staging_monitor_state where id=1 for update;
 v_now:=clock_timestamp();
 begin
  v:=public.cargo_staging_monitor_snapshot();
  v_counts:=v->'counts';
  if v->'control' is null or v->'control'='null'::jsonb then
   v_issues:=array_append(v_issues,'INVALID_CONTROL');
  elsif (v#>>'{control,captcha_required}')::boolean is distinct from true
    or (v#>>'{control,contact_verification_required}')::boolean is distinct from true then
   v_issues:=array_append(v_issues,'REQUIRED_PROTECTION_DISABLED');
  end if;
  if (v_counts->>'delivery_unknown')::bigint>0 then v_issues:=array_append(v_issues,'QUOTE_DELIVERY_UNKNOWN'); end if;
  if (v_counts->>'sending_over_10m')::bigint>0 then v_issues:=array_append(v_issues,'QUOTE_SEND_STALLED'); end if;
  if (v_counts->>'drafts_overdue_15m')::bigint>0 then v_issues:=array_append(v_issues,'DRAFT_CLEANUP_BACKLOG'); end if;
  if (v_counts->>'expired_trials_enabled_2m')::bigint>0 then v_issues:=array_append(v_issues,'TRIAL_EXPIRY_STALLED'); end if;
  if (v#>>'{control,intake_enabled}')::boolean and (v_counts->>'active_owner_trials')::bigint<>1 then
   v_issues:=array_append(v_issues,'INTAKE_ON_WITHOUT_SINGLE_ACTIVE_TRIAL');
  end if;
  for j in select value from jsonb_array_elements(v->'jobs') loop
   v_prefix:=upper(replace(replace(j->>'name','cargo-staging-',''),'-','_'));
   if (j->>'present')::boolean is distinct from true
    or (j->>'active')::boolean is distinct from true
    or (j->>'schedule_matches')::boolean is distinct from true then
    v_issues:=array_append(v_issues,v_prefix||'_CONFIG');
    continue;
   end if;
   v_success:=(j->>'last_success')::timestamptz;
   v_failure:=(j->>'last_failure')::timestamptz;
   if v_success is null or v_success>v_now+interval '1 minute'
    or v_now-v_success>make_interval(secs=>(j->>'max_age_seconds')::integer) then
    v_issues:=array_append(v_issues,v_prefix||'_STALE');
   end if;
   if v_failure>v_now+interval '1 minute' then
    v_issues:=array_append(v_issues,v_prefix||'_INVALID_HISTORY');
   elsif v_failure is not null and (v_success is null or v_failure>v_success) then
    v_issues:=array_append(v_issues,v_prefix||'_FAILED');
   end if;
  end loop;
 exception when others then
  -- Do not persist SQLERRM, identifiers from failed SQL, or return_message.
  v_issues:=array['MONITOR_CHECK_FAILED'];v_counts:='{}'::jsonb;
 end;
 v_ok:=cardinality(v_issues)=0;
 update public.cargo_staging_monitor_state
 set checked_at=v_now,ok=v_ok,issues=v_issues,counts=v_counts,
  last_ok_at=case when v_ok then v_now else last_ok_at end,
  last_failure_at=case when v_ok then last_failure_at else v_now end,
  consecutive_failures=case when v_ok then 0 else consecutive_failures+1 end,
  total_failures=total_failures+case when v_ok then 0 else 1 end
 where id=1;
 return jsonb_build_object('ok',v_ok,'checked_at',v_now,'issues',to_jsonb(v_issues),'counts',v_counts);
end;
$tick$;
revoke all on function public.cargo_staging_monitor_tick() from public,anon,authenticated;
grant execute on function public.cargo_staging_monitor_tick() to service_role;
commit;
