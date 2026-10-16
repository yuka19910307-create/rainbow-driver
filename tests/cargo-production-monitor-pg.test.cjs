// CI-only disposable PostgreSQL fixture. No Supabase endpoint or service credentials.
'use strict';
const fs=require('node:fs'),{spawnSync}=require('node:child_process'),assert=require('node:assert/strict');
const {assess}=require('../scripts/check-cargo-production-monitor.cjs');
const sql=fs.readFileSync('integrations/cargo-customer-intake/production-monitor.readonly.sql','utf8');
const container='cargo-otp-ci-postgres',database='cargo_production_monitor_ci_'+process.pid;
function psql(input,db=database){
 const r=spawnSync('docker',['exec','-i',container,'psql','-X','-qAt','-U','postgres','-d',db,'-v','ON_ERROR_STOP=1'],{input,encoding:'utf8'});
 assert.equal(r.status,0,'Disposable monitor SQL failed: '+r.stderr);return r.stdout.trim();
}
const tables=['cargo_customer_intake_drafts','cargo_customer_intake_requests','cargo_customer_quote_replies',
 'cargo_customer_mail_budget','cargo_customer_quote_followups','cargo_customer_quote_followup_events','cargo_customer_retention_runs'];
// Same public names and argument type identities as the installed candidate;
// bodies are inert SELECTs, never the customer mutation/cleanup implementation.
const signatures=[
 'cargo_customer_intake_verify_commit(uuid,bytea)',
 'cargo_customer_intake_cleanup(integer)',
 'cargo_customer_quote_prepare(uuid,uuid,integer,text,timestamptz)',
 'cargo_customer_quote_claim_send(uuid,uuid,bytea)',
 'cargo_customer_quote_finalize(uuid,uuid,boolean,text)',
 'cargo_customer_quote_reply(uuid,bytea,text)',
 'cargo_customer_mail_budget_claim()',
 'cargo_customer_followup_save(uuid,uuid,text,text,text)',
 'cargo_customer_close_no_order(uuid,uuid,boolean)',
 'cargo_customer_retention_set_hold(uuid,uuid,boolean)',
 'cargo_customer_closed_cleanup(integer)'
];
const setup=`
create table public.cargo_intake_control(id integer,intake_enabled boolean,captcha_required boolean,contact_verification_required boolean);
insert into public.cargo_intake_control values(1,false,true,true);
create table public.cargo_customer_intake_drafts(delete_after timestamptz,encrypted_payload text);
create table public.cargo_customer_intake_requests(id integer,status text,closed_no_order_at timestamptz,delete_after timestamptz,retention_hold boolean);
create table public.cargo_customer_quote_replies(request_id integer,delivery_status text,delivery_attempted_at timestamptz);
create table public.cargo_customer_mail_budget(id integer,enabled boolean,hourly_limit integer,daily_limit integer,hour_attempts integer,day_attempts integer);
insert into public.cargo_customer_mail_budget values(1,false,1,1,0,0);
create table public.cargo_customer_quote_followups(request_id integer,stage text);
create table public.cargo_customer_quote_followup_events(id integer);
create table public.cargo_customer_retention_runs(id integer);
${tables.map(t=>`alter table public.${t} enable row level security; revoke all on public.${t} from public,anon,authenticated;`).join('\n')}
${signatures.map(signature=>`create function public.${signature} returns integer language sql security invoker as 'select 1'; revoke all on function public.${signature} from public,anon,authenticated;`).join('\n')}
create schema cron;
create table cron.job(jobid bigint,jobname text,schedule text,command text,database text,active boolean);
create table cron.job_run_details(jobid bigint,status text,end_time timestamptz);
insert into cron.job values
 (1,'cargo-production-expired-intake-drafts','*/5 * * * *','select public.cargo_customer_intake_cleanup(100);',current_database(),true),
 (2,'cargo-production-closed-no-order-retention','17 * * * *','select public.cargo_customer_closed_cleanup(100);',current_database(),true);
insert into cron.job_run_details select jobid,'succeeded',now()-interval '1 minute' from cron.job;
`;
const eligible="insert into public.cargo_customer_intake_requests values(1,'closed',now()-interval '32 days',now()-interval '2 hours',false);";
psql('create database '+database+';','postgres');
try{
 psql(setup);
 for(const [name,mutation,expected,absent] of [
  ['empty protected hold','',null],
  ['missing proposed cron','delete from cron.job where jobid=1;','EXPIRED_INTAKE_DRAFTS_CONFIG'],
  ['altered cron command',"update cron.job set command='select 1;' where jobid=1;",'EXPIRED_INTAKE_DRAFTS_CONFIG'],
  ['wrong cron database',"update cron.job set database='another_database' where jobid=1;",'EXPIRED_INTAKE_DRAFTS_CONFIG'],
  ['stale cleanup',"update cron.job_run_details set end_time=now()-interval '91 minutes' where jobid=2;",'CLOSED_NO_ORDER_RETENTION_STALE'],
  ['failed cleanup',"insert into cron.job_run_details values(2,'failed',now()-interval '30 seconds');",'CLOSED_NO_ORDER_RETENTION_FAILED'],
  ['recovered cleanup',"insert into cron.job_run_details values(2,'failed',now()-interval '30 seconds'),(2,'succeeded',now()-interval '10 seconds');",null],
  ['RLS disabled','alter table public.cargo_customer_intake_drafts disable row level security;','CUSTOMER_ACCESS_PROTECTION_CHANGED'],
  ['client table grant','grant select on public.cargo_customer_intake_drafts to anon;','CUSTOMER_ACCESS_PROTECTION_CHANGED'],
  ['client column-only grant','grant select(encrypted_payload) on public.cargo_customer_intake_drafts to anon;','CUSTOMER_ACCESS_PROTECTION_CHANGED'],
  ['client function grant','grant execute on function public.cargo_customer_intake_verify_commit(uuid,bytea) to authenticated;','CUSTOMER_ACCESS_PROTECTION_CHANGED'],
  ['definer drift','alter function public.cargo_customer_intake_verify_commit(uuid,bytea) security definer;','CUSTOMER_ACCESS_PROTECTION_CHANGED'],
  ['same-count function replacement',"drop function public.cargo_customer_intake_cleanup(integer); create function public.cargo_customer_fake_cleanup(integer) returns integer language sql security invoker as 'select 1'; revoke all on function public.cargo_customer_fake_cleanup(integer) from public,anon,authenticated;",'CUSTOMER_SCHEMA_DRIFT'],
  ['same-name changed argument',"drop function public.cargo_customer_intake_cleanup(integer); create function public.cargo_customer_intake_cleanup(text) returns integer language sql security invoker as 'select 1'; revoke all on function public.cargo_customer_intake_cleanup(text) from public,anon,authenticated;",'CUSTOMER_SCHEMA_DRIFT'],
  ['expired draft',"insert into public.cargo_customer_intake_drafts values(now()-interval '16 minutes','synthetic-private-payload');",'DRAFT_CLEANUP_BACKLOG'],
  ['eligible closed retention',eligible,'CLOSED_RETENTION_BACKLOG'],
  ['held closed retention',eligible+'update public.cargo_customer_intake_requests set retention_hold=true;','UNEXPECTED_CUSTOMER_DATA','CLOSED_RETENTION_BACKLOG'],
  ['unresolved quote excludes deletion',eligible+"insert into public.cargo_customer_quote_replies values(1,'delivery_unknown',now());",'QUOTE_DELIVERY_UNKNOWN','CLOSED_RETENTION_BACKLOG'],
  ['unclosed followup excludes deletion',eligible+"insert into public.cargo_customer_quote_followups values(1,'contact_pending');",'UNEXPECTED_CUSTOMER_DATA','CLOSED_RETENTION_BACKLOG'],
  ['stalled quote',"insert into public.cargo_customer_quote_replies values(1,'sending',null);",'QUOTE_SEND_STALLED'],
  ['intake unexpectedly enabled','update public.cargo_intake_control set intake_enabled=true;','PRODUCTION_INTAKE_NOT_OFF'],
  ['mail unexpectedly enabled','update public.cargo_customer_mail_budget set enabled=true;','PRODUCTION_MAIL_NOT_DISABLED'],
  ['unexpected attempts','update public.cargo_customer_mail_budget set day_attempts=1;','UNEXPECTED_MAIL_ATTEMPTS']
 ]){
  const output=psql('begin;\n'+mutation+'\n'+sql+'\nrollback;');
  assert(!output.includes('synthetic-private-payload'),'Payload must never leave snapshot');
  const snapshot=JSON.parse(output),result=assess(snapshot);
  if(name==='same-count function replacement'||name==='same-name changed argument'){
   assert.equal(snapshot.customer_security.functions_present,11);
   assert.equal(snapshot.customer_security.functions_missing,1);assert.equal(snapshot.customer_security.functions_unexpected,1);
  }
  if(expected)assert(result.issues.includes(expected),name+': '+JSON.stringify(result));
  else assert.deepEqual(result,{ok:true,issues:[]},name);
  if(absent)assert(!result.issues.includes(absent),name+': '+JSON.stringify(result));
  console.log('PASS production monitor SQL/classifier: '+name+' (rolled back)');
 }
}finally{psql('drop database '+database+';','postgres');}
