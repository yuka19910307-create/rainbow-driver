// Disposable PostgreSQL only. All schema/data changes roll back per case.
'use strict';
const fs=require('node:fs'),assert=require('node:assert/strict'),{spawnSync}=require('node:child_process');
const {assess}=require('../scripts/check-cargo-monitor.cjs');
const snapshotSql=fs.readFileSync('integrations/cargo-customer-intake/staging-monitor.readonly.sql','utf8');
const migration=fs.readFileSync('integrations/cargo-customer-intake/staging-monitor-state.review.sql','utf8');
assert(migration.includes('-- BEGIN SNAPSHOT\n'+snapshotSql+'-- END SNAPSHOT'));
const ddl=migration.replace(/^begin;\n/m,'').replace(/\ncommit;\s*$/,'');
const setup=`
update public.cargo_customer_quote_replies set delivery_status='sent';
update public.cargo_intake_control set intake_enabled=false,captcha_required=true,contact_verification_required=true where id=1;
create schema cron;
create table cron.job(jobid bigint,jobname text,schedule text,active boolean);
create table cron.job_run_details(jobid bigint,status text,end_time timestamptz);
insert into cron.job values (1,'cargo-staging-expired-intake-drafts','*/5 * * * *',true),(2,'cargo-staging-closed-no-order-retention','17 * * * *',true),(3,'cargo-staging-owner-mail-trial-expire','* * * * *',true);
insert into cron.job_run_details select jobid,'succeeded',now()-interval '1 minute' from cron.job;
`;
const permissions=`
do $assert$
begin
 if not (select relrowsecurity from pg_class where oid='public.cargo_staging_monitor_state'::regclass) then raise exception 'RLS missing'; end if;
 if has_table_privilege('anon','public.cargo_staging_monitor_state','SELECT') or has_table_privilege('authenticated','public.cargo_staging_monitor_state','UPDATE') then raise exception 'client access'; end if;
 if has_function_privilege('anon','public.cargo_staging_monitor_tick()','EXECUTE') or has_function_privilege('authenticated','public.cargo_staging_monitor_snapshot()','EXECUTE') then raise exception 'client execute'; end if;
 if exists(select 1 from pg_proc where oid in ('public.cargo_staging_monitor_tick()'::regprocedure,'public.cargo_staging_monitor_snapshot()'::regprocedure) and prosecdef) then raise exception 'privileged function'; end if;
end;
$assert$;
`;
function run(body){
 const r=spawnSync('docker',['exec','-i','cargo-otp-ci-postgres','psql','-X','-qAt','-U','postgres','-v','ON_ERROR_STOP=1'],{input:'begin;\n'+setup+ddl+permissions+body+'\nrollback;',encoding:'utf8'});
 assert.equal(r.status,0,r.stderr);return r.stdout.trim().split('\n').filter(Boolean).map(x=>JSON.parse(x));
}
for(const [name,mutation] of [
 ['healthy',''],
 ['unknown quote',"update public.cargo_customer_quote_replies set delivery_status='delivery_unknown';"],
 ['stalled quote',"update public.cargo_customer_quote_replies set delivery_status='sending',delivery_attempted_at=now()-interval '11 minutes';"],
 ['missing job','delete from cron.job where jobid=1;'],
 ['stale job',"update cron.job_run_details set end_time=now()-interval '6 minutes' where jobid=3;"],
 ['failed job',"insert into cron.job_run_details values (2,'failed',now()-interval '30 seconds');"],
 ['protection off','update public.cargo_intake_control set captcha_required=false where id=1;'],
 ['intake without trial','update public.cargo_intake_control set intake_enabled=true where id=1;']
]){
 const rows=run(mutation+`select public.cargo_staging_monitor_tick();
 select jsonb_build_object('snapshot',public.cargo_staging_monitor_snapshot(),'state',(select to_jsonb(s) from public.cargo_staging_monitor_state s where id=1));`);
 const {snapshot,state}=rows[1];const result=assess(snapshot);
 assert.equal(rows[0].ok,result.ok,name);assert.equal(state.ok,result.ok,name);
 assert.deepEqual(state.issues.sort(),result.issues.sort(),name);assert.equal(state.total_failures,result.ok?0:1);
 assert.equal(state.consecutive_failures,result.ok?0:1);console.log('PASS persisted monitor/JS parity: '+name);
}
const recovery=run(`update public.cargo_customer_quote_replies set delivery_status='delivery_unknown';
 select public.cargo_staging_monitor_tick();select public.cargo_staging_monitor_tick();
 update public.cargo_customer_quote_replies set delivery_status='sent';select public.cargo_staging_monitor_tick();
 select to_jsonb(s) from public.cargo_staging_monitor_state s where id=1;`);
assert.equal(recovery[3].ok,true);assert.equal(recovery[3].consecutive_failures,0);assert.equal(recovery[3].total_failures,2);assert(recovery[3].last_ok_at&&recovery[3].last_failure_at);
console.log('PASS persisted failure counters and recovery');
const failed=run(`select public.cargo_staging_monitor_tick();drop function public.cargo_staging_monitor_snapshot();
 select public.cargo_staging_monitor_tick();select to_jsonb(s) from public.cargo_staging_monitor_state s where id=1;`);
assert.equal(failed[1].ok,false);assert.deepEqual(failed[2].issues,['MONITOR_CHECK_FAILED']);assert.deepEqual(failed[2].counts,{});assert(failed[2].last_ok_at);assert.equal(failed[2].total_failures,1);
assert(!JSON.stringify(failed[2]).includes('does not exist'));console.log('PASS failed check persists generic issue without SQL error text');
