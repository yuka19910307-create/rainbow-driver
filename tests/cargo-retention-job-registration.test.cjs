'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{spawnSync}=require('node:child_process');
const {assess}=require('../scripts/check-cargo-retention-job-registration.cjs');
const plan=require('../integrations/cargo-retention-job-guard/plan.disabled.json');
const now=Date.parse('2026-10-17T00:00:00Z');
function fixture(jobs=[]){return {schema_version:1,scope:'cargo-retention-job-registration-inventory',observed_at:new Date(now).toISOString(),read_only_transaction:true,catalog_visibility_complete:true,visible_job_count:jobs.length,related_job_count:jobs.length,jobs};}
function job(overrides={}){return {jobid:1,canonical_name:'drafts',case_variant_name:false,targets:['drafts'],active:false,same_database:true,direct_batch_100_target:'drafts',schedule_kind:'cron_expression',schedule_equality_group:1,...overrides};}
function blocked(result){assert.equal(result.registration_allowed,false);assert.equal(result.execution_enabled,false);assert.equal(result.review_only,true);assert(result.blockers.includes('REGISTRATION_DISABLED'));}
test('valid empty inventory and disabled plan never authorize registration',()=>{
 const result=assess(fixture(),now);blocked(result);assert.equal(result.inventory_valid,true);
 for(const code of ['SCHEDULE_UNDECIDED','HISTORY_RETENTION_UNDECIDED','INDEPENDENT_PROJECT_CONFIRMATION_REQUIRED','INDIRECT_JOB_AUDIT_REQUIRED'])assert(result.blockers.includes(code));
 assert.equal(plan.schedule,null);assert.deepEqual(plan.history_retention,{application_days:null,cron_days:null});
});
test('any change to disabled plan fails closed without echoing values',()=>{
 for(const mutate of [p=>p.enabled=true,p=>p.schedule='synthetic-private-secret',p=>p.history_retention.cron_days=1,p=>p.jobs[0].batch_limit=101,p=>p.extra='synthetic-private-secret']){
  const changed=structuredClone(plan);mutate(changed);const result=assess(fixture(),now,changed);
  blocked(result);assert.equal(result.inventory_valid,false);assert(result.issues.includes('DISABLED_PLAN_MISMATCH'));assert(!JSON.stringify(result).includes('synthetic-private-secret'));
 }
});
test('stopped and active existing jobs both block; matching settings cannot authorize overwrite',()=>{
 for(const active of [false,true]){
  const result=assess(fixture([job({active})]),now);blocked(result);assert.equal(result.inventory_valid,true);
  assert(result.blockers.includes(active?'ACTIVE_EXISTING_JOB_REVIEW_REQUIRED':'STOPPED_EXISTING_JOB_REVIEW_REQUIRED'));
  assert(result.blockers.includes('EXISTING_CLEANUP_JOB_REVIEW_REQUIRED'));
 }
});
test('aliases, case variants and other databases are independently visible as fixed codes',()=>{
 for(const [overrides,code] of [[{canonical_name:null},'ALIAS_JOB_REVIEW_REQUIRED'],[{canonical_name:null,case_variant_name:true},'CASE_VARIANT_JOB_NAME_REVIEW_REQUIRED'],[{same_database:false},'OTHER_DATABASE_JOB_REVIEW_REQUIRED']]){
  const result=assess(fixture([job(overrides)]),now);blocked(result);assert.equal(result.inventory_valid,true);assert(result.blockers.includes(code));
 }
});
test('canonical and differently named duplicate targets are detected, even inactive',()=>{
 for(const second of [job({jobid:2}),job({jobid:2,canonical_name:null})]){
  const result=assess(fixture([job(),second]),now);blocked(result);assert(result.blockers.includes('DUPLICATE_CLEANUP_TARGET'));
  assert.equal(result.blockers.includes('DUPLICATE_CANONICAL_JOB_NAME'),second.canonical_name==='drafts');
 }
});
test('mismatched, indirect commands and unrecognized schedules require review',()=>{
 for(const [overrides,code] of [[{direct_batch_100_target:null},'JOB_COMMAND_REVIEW_REQUIRED'],[{direct_batch_100_target:'closed',targets:['closed','drafts']},'JOB_COMMAND_REVIEW_REQUIRED'],[{schedule_kind:'unrecognized'},'UNRECOGNIZED_JOB_SCHEDULE']]){
  const result=assess(fixture([job(overrides)]),now);assert.equal(result.inventory_valid,true);assert(result.blockers.includes(code));blocked(result);
 }
});
test('incomplete visibility and writable transaction are rejected',()=>{
 for(const [key,code] of [['read_only_transaction','READ_ONLY_INVENTORY_REQUIRED'],['catalog_visibility_complete','COMPLETE_CATALOG_VISIBILITY_REQUIRED']]){
  const input=fixture();input[key]=false;const result=assess(input,now);assert.equal(result.inventory_valid,false);assert(result.issues.includes(code));blocked(result);
 }
});
test('stale, future, invalid snapshots are rejected without reporting raw data',()=>{
 for(const stamp of [now-300001,now+60001,NaN]){
  const input=fixture();input.observed_at=Number.isNaN(stamp)?'synthetic-private-secret':new Date(stamp).toISOString();
  const result=assess(input,now);assert.equal(result.inventory_valid,false);assert(result.issues.includes('STALE_OR_INVALID_JOB_INVENTORY'));assert(!JSON.stringify(result).includes('synthetic-private-secret'));
 }
 blocked(assess(null,now));assert.equal(assess(null,now).inventory_valid,false);
});
test('missing, truncated, contradictory and excessive detail counts fail closed',()=>{
 for(const mutate of [p=>p.jobs=null,p=>p.related_job_count=1,p=>p.visible_job_count=-1,p=>p.related_job_count=Number.MAX_SAFE_INTEGER+1,p=>{p.jobs=Array(1001).fill(job());p.related_job_count=1001;p.visible_job_count=1001;}]){
  const input=fixture();mutate(input);const result=assess(input,now);assert.equal(result.inventory_valid,false);assert(result.issues.includes('INVALID_JOB_INVENTORY_COUNTS'));blocked(result);
 }
});
test('unsafe identifiers, duplicated ids and malformed metadata fail closed',()=>{
 for(const mutate of [p=>p.jobid=Number.MAX_SAFE_INTEGER+1,p=>p.active=null,p=>p.targets=[],p=>p.targets=['drafts','drafts'],p=>p.targets=['closed'],p=>p.canonical_name='synthetic-private-secret',p=>p.schedule_equality_group=2,p=>p.direct_batch_100_target='private',p=>p.case_variant_name=true]){
  const input=job();mutate(input);const result=assess(fixture([input]),now);assert.equal(result.inventory_valid,false);assert(result.issues.includes('INVALID_JOB_INVENTORY_DETAIL'));blocked(result);
 }
 assert.equal(assess(fixture([job(),job()]),now).inventory_valid,false);
});
test('extra source fields, arbitrary names, commands and errors are never emitted',()=>{
 const input=fixture([job()]);Object.assign(input.jobs[0],{jobname:'synthetic-private-secret',command:'synthetic-private-secret',database:'synthetic-private-secret',error:'synthetic-private-secret'});
 const result=assess(input,now);assert(!JSON.stringify(result).includes('synthetic-private-secret'));blocked(result);
});
test('CLI valid review always exits blocked and emits no source values',()=>{
 const input=fixture();input.observed_at=new Date().toISOString();input.command='synthetic-private-secret';
 const r=spawnSync(process.execPath,['scripts/check-cargo-retention-job-registration.cjs'],{input:JSON.stringify(input),encoding:'utf8'});
 assert.ifError(r.error);assert.equal(r.status,1);const result=JSON.parse(r.stdout);assert.equal(result.inventory_valid,true);blocked(result);assert(!r.stdout.includes('synthetic-private-secret'));assert.equal(r.stderr,'');
});
test('CLI malformed or oversized input emits fixed errors only',()=>{
 for(const [input,code] of [['{"secret":"synthetic-private-secret"','INVALID_JSON'],['synthetic-private-secret'.repeat(20000),'INPUT_TOO_LARGE']]){
  const r=spawnSync(process.execPath,['scripts/check-cargo-retention-job-registration.cjs'],{input,encoding:'utf8'});
  assert.ifError(r.error);assert.equal(r.status,2);assert(JSON.parse(r.stdout).issues.includes(code));assert(!r.stdout.includes('synthetic-private-secret'));assert.equal(r.stderr,'');
 }
});
