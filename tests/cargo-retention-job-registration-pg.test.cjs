// New inventory tests only; disposable local PostgreSQL, no pg_cron extension,
// cleanup functions, Supabase connections, customer fixtures or network clients.
'use strict';
const fs=require('node:fs'),{spawnSync}=require('node:child_process'),assert=require('node:assert/strict');
const {assess}=require('../scripts/check-cargo-retention-job-registration.cjs');
const inventory=fs.readFileSync('integrations/cargo-retention-job-guard/inventory.readonly.sql','utf8');
const container='cargo-registration-guard-ci-postgres',database='cargo_retention_job_registration_ci_'+process.pid;
const reader='cargo_retention_inventory_reader_'+process.pid;
function psql(input,db=database,success=true){
 const r=spawnSync('docker',['exec','-i',container,'psql','-X','-qAt','-U','postgres','-d',db,'-v','ON_ERROR_STOP=1'],{input,encoding:'utf8'});
 assert.ifError(r.error);
 if(success)assert.equal(r.status,0,'Disposable inventory SQL failed; raw error intentionally omitted');
 else assert.notEqual(r.status,0,'Expected unverified inventory failure');
 return r.stdout.trim();
}
const snapshot=()=>JSON.parse(psql('begin read only;\n'+inventory+'\nrollback;'));
function checkBlocked(value){const result=assess(value);assert.equal(result.registration_allowed,false);assert.equal(result.execution_enabled,false);return result;}
function test(name,fn){fn();console.log('PASS retention job inventory SQL: '+name);}
function seed(rows){psql('truncate cron.job;\n'+rows);}
psql('create database '+database+';','postgres');
try{
 psql(`create schema cron;
 create table cron.job(jobid bigint primary key,jobname text,command text,database text,active boolean,schedule text);`);
 test('empty inventory succeeds READ ONLY and keeps every registration gate blocked',()=>{
  const value=snapshot();assert.equal(value.read_only_transaction,true);assert.equal(value.catalog_visibility_complete,true);
  assert.equal(value.visible_job_count,0);assert.equal(checkBlocked(value).inventory_valid,true);
 });
 test('inactive canonical job is detected without exposing command or schedule',()=>{
  seed(`insert into cron.job values(1,'cargo-production-expired-intake-drafts',
   'select public.cargo_customer_intake_cleanup(100);',current_database(),false,'* * * * *');`);
  const value=snapshot();assert.equal(value.related_job_count,1);assert.equal(value.jobs[0].canonical_name,'drafts');
  assert.equal(value.jobs[0].direct_batch_100_target,'drafts');assert.equal(value.jobs[0].active,false);
  assert.equal(value.jobs[0].schedule_kind,'cron_expression');assert(checkBlocked(value).blockers.includes('STOPPED_EXISTING_JOB_REVIEW_REQUIRED'));
  assert(!JSON.stringify(value).includes('select public'));assert(!JSON.stringify(value).includes('* * * * *'));
 });
 test('active alias targeting another database is detected without names or secrets',()=>{
  seed(`insert into cron.job values(1,'synthetic-private-name',
   'select public.cargo_customer_closed_cleanup(100); -- synthetic-private-command',
   'synthetic-private-database',true,'synthetic-private-schedule');`);
  const value=snapshot(),result=checkBlocked(value);assert.equal(value.related_job_count,1);
  for(const code of ['ACTIVE_EXISTING_JOB_REVIEW_REQUIRED','ALIAS_JOB_REVIEW_REQUIRED','OTHER_DATABASE_JOB_REVIEW_REQUIRED','JOB_COMMAND_REVIEW_REQUIRED','UNRECOGNIZED_JOB_SCHEDULE'])assert(result.blockers.includes(code));
  assert(!JSON.stringify(value).includes('synthetic-private'));
 });
 test('same-name entries from different owners cannot permit upsert',()=>{
  seed(`insert into cron.job values
   (1,'cargo-production-expired-intake-drafts','select public.cargo_customer_intake_cleanup(100);',current_database(),false,'* * * * *'),
   (2,'cargo-production-expired-intake-drafts','select public.cargo_customer_intake_cleanup(100);',current_database(),false,'* * * * *');`);
  const value=snapshot(),result=checkBlocked(value);assert(result.blockers.includes('DUPLICATE_CANONICAL_JOB_NAME'));assert(result.blockers.includes('DUPLICATE_CLEANUP_TARGET'));
  assert.equal(value.jobs[0].schedule_equality_group,value.jobs[1].schedule_equality_group);
 });
 test('case variants and aliases with matching commands remain conflicts',()=>{
  seed(`insert into cron.job values
   (1,'CARGO-PRODUCTION-CLOSED-NO-ORDER-RETENTION','select public.cargo_customer_closed_cleanup(100);',current_database(),false,'15 seconds'),
   (2,'synthetic-private-alias','select public.cargo_customer_closed_cleanup(100);',current_database(),false,'* * * * *');`);
  const value=snapshot(),result=checkBlocked(value);assert(result.blockers.includes('CASE_VARIANT_JOB_NAME_REVIEW_REQUIRED'));assert(result.blockers.includes('ALIAS_JOB_REVIEW_REQUIRED'));assert(result.blockers.includes('DUPLICATE_CLEANUP_TARGET'));
  assert(value.jobs.some(j=>j.schedule_kind==='second_interval'));assert.notEqual(value.jobs[0].schedule_equality_group,value.jobs[1].schedule_equality_group);
 });
 test('canonical name with wrong cleanup target requires command review',()=>{
  seed(`insert into cron.job values(1,'cargo-production-expired-intake-drafts',
   'select public.cargo_customer_closed_cleanup(100);',current_database(),false,'* * * * *');`);
  const value=snapshot();assert.deepEqual(value.jobs[0].targets,['closed','drafts']);assert(checkBlocked(value).blockers.includes('JOB_COMMAND_REVIEW_REQUIRED'));
 });
 test('unrelated and indirect-wrapper jobs are not falsely classified as proven safe',()=>{
  seed(`insert into cron.job values(1,'synthetic-private-other-work','select synthetic_wrapper();',current_database(),true,'* * * * *');`);
  const value=snapshot();assert.equal(value.visible_job_count,1);assert.equal(value.related_job_count,0);
  assert(checkBlocked(value).blockers.includes('INDIRECT_JOB_AUDIT_REQUIRED'));assert(!JSON.stringify(value).includes('synthetic-private'));
 });
 test('null job settings are rejected or flagged without outputting raw values',()=>{
  seed(`insert into cron.job values(1,'cargo-production-expired-intake-drafts',null,null,null,null);`);
  const value=snapshot();assert.equal(value.jobs[0].direct_batch_100_target,null);assert.equal(value.jobs[0].same_database,false);assert.equal(value.jobs[0].schedule_kind,'unrecognized');
  assert.equal(checkBlocked(value).inventory_valid,false);
 });
 test('writable transaction snapshot cannot pass preflight',()=>{
  seed('');const value=JSON.parse(psql(inventory));assert.equal(value.read_only_transaction,false);
  assert(checkBlocked(value).issues.includes('READ_ONLY_INVENTORY_REQUIRED'));
 });
 test('detail output is bounded and excess related jobs remain unverified',()=>{
  seed(`insert into cron.job
   select n,'synthetic-private-alias-'||n,'select public.cargo_customer_intake_cleanup(100);',
   current_database(),false,'* * * * *' from generate_series(1,1001) n;`);
  const value=snapshot();assert.equal(value.related_job_count,1001);assert.equal(value.jobs.length,1000);
  assert.equal(checkBlocked(value).inventory_valid,false);assert(checkBlocked(value).issues.includes('INVALID_JOB_INVENTORY_COUNTS'));
  assert(!JSON.stringify(value).includes('synthetic-private'));
 });
 test('RLS-filtered catalog is incomplete even when visible detail is self-consistent',()=>{
  psql(`create role ${reader}; grant usage on schema cron to ${reader}; grant select on cron.job to ${reader};
   alter table cron.job enable row level security; create policy selected_rows on cron.job for select to ${reader} using(jobid=1);`);
  seed(`insert into cron.job values
   (1,'synthetic-visible','select 1;',current_database(),false,'* * * * *'),
   (2,'cargo-production-expired-intake-drafts','select public.cargo_customer_intake_cleanup(100);',current_database(),true,'* * * * *');`);
  const value=JSON.parse(psql('begin read only;\nset local role '+reader+';\n'+inventory+'\nrollback;'));
  assert.equal(value.visible_job_count,1);assert.equal(value.related_job_count,0);assert.equal(value.catalog_visibility_complete,false);
  assert(checkBlocked(value).issues.includes('COMPLETE_CATALOG_VISIBILITY_REQUIRED'));
  psql('alter table cron.job disable row level security;');
 });
 test('missing cron and permission failure remain unverified rather than empty success',()=>{
  psql(`revoke select on cron.job from ${reader};`);
  const denied=psql('begin read only;\nset local role '+reader+';\n'+inventory+'\nrollback;',database,false);
  assert.equal(denied,'');psql('drop table cron.job;');
  const missing=psql('begin read only;\n'+inventory+'\nrollback;',database,false);assert.equal(missing,'');
 });
}finally{
 psql('drop database '+database+';','postgres');
 // An isolated test role may not exist when an earlier assertion failed.
 psql('drop role if exists '+reader+';','postgres');
}
