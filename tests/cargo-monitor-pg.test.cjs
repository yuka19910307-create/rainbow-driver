// Disposable PostgreSQL fixture only. Never uses a remote DB or mail service.
'use strict';
const fs=require('node:fs'),{spawnSync}=require('node:child_process'),assert=require('node:assert/strict');
const {assess}=require('../scripts/check-cargo-monitor.cjs');
const sql=fs.readFileSync('integrations/cargo-customer-intake/staging-monitor.readonly.sql','utf8');
const setup=`
-- Normalize earlier synthetic mail-failure fixtures inside this rollback-only test.
update public.cargo_customer_quote_replies set delivery_status='sent';
create schema cron;
create table cron.job(jobid bigint,jobname text,schedule text,active boolean);
create table cron.job_run_details(jobid bigint,status text,end_time timestamptz);
insert into cron.job values
 (1,'cargo-staging-expired-intake-drafts','*/5 * * * *',true),
 (2,'cargo-staging-closed-no-order-retention','17 * * * *',true),
 (3,'cargo-staging-owner-mail-trial-expire','* * * * *',true);
insert into cron.job_run_details select jobid,'succeeded',now()-interval '1 minute' from cron.job;
update public.cargo_intake_control set intake_enabled=false,captcha_required=true,contact_verification_required=true where id=1;
`;
for(const [name,mutation,expected] of [
 ['healthy','',null],
 ['unknown quote',"update public.cargo_customer_quote_replies set delivery_status='delivery_unknown';",'QUOTE_DELIVERY_UNKNOWN'],
 ['stalled quote',"update public.cargo_customer_quote_replies set delivery_status='sending',delivery_attempted_at=now()-interval '11 minutes';",'QUOTE_SEND_STALLED'],
 ['missing job','delete from cron.job where jobid=1;','EXPIRED_INTAKE_DRAFTS_CONFIG'],
 ['stale job',"update cron.job_run_details set end_time=now()-interval '6 minutes' where jobid=3;",'OWNER_MAIL_TRIAL_EXPIRE_STALE'],
 ['latest failure',"insert into cron.job_run_details values (2,'failed',now()-interval '30 seconds');",'CLOSED_NO_ORDER_RETENTION_FAILED'],
 ['later recovery',"insert into cron.job_run_details values (2,'failed',now()-interval '30 seconds'),(2,'succeeded',now()-interval '10 seconds');",null]
]){
 const r=spawnSync('docker',['exec','-i','cargo-otp-ci-postgres','psql','-X','-qAt','-U','postgres','-v','ON_ERROR_STOP=1'],{input:'begin;\n'+setup+mutation+'\n'+sql+'\nrollback;',encoding:'utf8'});
 assert.equal(r.status,0,'SQL fixture failed: '+name+' '+r.stderr);
 const snapshot=JSON.parse(r.stdout.trim());const result=assess(snapshot);
 if(expected)assert(result.issues.includes(expected),name+': '+JSON.stringify(result));else assert.deepEqual(result,{ok:true,issues:[]},name);
 console.log('PASS monitor SQL/classifier: '+name+' (rolled back)');
}
