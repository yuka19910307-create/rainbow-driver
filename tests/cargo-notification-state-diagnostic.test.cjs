'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const fs=require('node:fs');
const {assess}=require('../scripts/check-cargo-notification-state.cjs');
const {CONFIG,initialState,prepare,claimAttempt,settleAttempt}=require('../scripts/prepare-cargo-monitor-notification.cjs');
const script=require.resolve('../scripts/check-cargo-notification-state.cjs');
const base=Date.parse('2026-10-16T16:00:00.000Z');
function snapshot(now=base,abnormal=false){return {
 schema_version:1,scope:'production-cargo-prelaunch-hold',observed_at:new Date(now).toISOString(),
 control:{intake_enabled:false,captcha_required:true,contact_verification_required:true},
 mail_budget:{enabled:false,hour_attempts:0,day_attempts:0,hourly_limit:1,daily_limit:1},
 counts:{drafts:0,requests:0,quotes:0,followups:0,followup_events:0,retention_runs:0,delivery_unknown:abnormal?1:0,
  sending_over_10m:0,drafts_overdue_15m:0,closed_cleanup_overdue_90m:0,held_closed_requests:0},
 customer_security:{tables_present:7,tables_rls_enabled:7,tables_client_access:0,functions_present:11,
  functions_missing:0,functions_unexpected:0,functions_security_definer:0,functions_client_execute:0},
 jobs:[['expired-intake-drafts',1200],['closed-no-order-retention',5400]].map(([name,max_age_seconds])=>({
  name:'cargo-production-'+name,max_age_seconds,present:true,active:true,schedule_matches:true,command_matches:true,
  database_matches:true,last_success:new Date(now-60000).toISOString(),last_failure:null}))
};}
const observed=(state=initialState(),now=base,abnormal=true)=>prepare({state,snapshot:snapshot(now,abnormal),now}).state;
const result=(state=initialState(),revision=0,status='ready')=>({configuration:CONFIG,dispatches:0,
 status,issues:[],revision,state});
const blocked=code=>({configuration:CONFIG,dispatches:0,status:'blocked',issues:[code],revision:null,state:null});
function safe(value){
 assert.deepEqual(value.configuration,{enabled:false,destination:null,automatic_retry:false});
 assert.equal(value.dispatches,0);
 for(const key of ['dispatch_allowed','retry_allowed','reset_allowed','unlock_allowed','resume_allowed'])assert.equal(value[key],false);
 assert(value.required_checks.includes('CURRENT_RUNTIME_UNVERIFIED'));
 assert(value.required_checks.includes('NO_DELIVERY_PERMISSION'));
 const text=JSON.stringify(value);assert(!text.includes('synthetic-secret'));assert(!text.includes('2026-10-16'));
 assert(!Object.hasOwn(value,'state'));assert(!Object.hasOwn(value,'revision'));return value;
}
function frozen(value){if(value&&typeof value==='object'){Object.values(value).forEach(frozen);Object.freeze(value);}return value;}
function cli(input,args=[]){
 const value=spawnSync(process.execPath,[script,...args],{input,encoding:'utf8'});
 assert.equal(value.error,undefined);assert.equal(value.stderr,'');assert(value.stdout.endsWith('\n'));
 assert.equal(value.stdout.trim().split('\n').length,1);
 const parsed=safe(JSON.parse(value.stdout));return {...value,parsed};
}
test('initial and healthy records describe stored evidence without proving runtime or permitting any action',()=>{
 const initial=safe(assess(result()));assert.equal(initial.diagnostic_valid,true);
 assert.equal(initial.classification,'NOT_OBSERVED');assert.equal(initial.observation,'NOT_OBSERVED');
 assert(initial.required_checks.includes('NO_MONITORING_BASELINE_PROVEN'));
 const healthy=safe(assess(result(observed(initialState(),base,false),1,'observed')));
 assert.equal(healthy.classification,'RECORD_ONLY');assert.equal(healthy.observation,'HEALTHY_RECORDED');
 assert.equal(healthy.event,'NO_EVENT_RECORDED');assert.equal(healthy.delivery,'NO_DELIVERY_RECORDED');
 assert(healthy.required_checks.includes('RECORDED_HEALTH_IS_NOT_CURRENT_HEALTH_PROOF'));
 assert.equal(safe(assess(result(initialState(),0,'initialized'))).diagnostic_valid,true);
});
test('anomaly, recovery, read failure and read recovery remain distinct fixed record codes',()=>{
 const abnormal=observed();let value=safe(assess(result(abnormal,1)));
 assert.equal(value.observation,'ANOMALY_RECORDED');assert.equal(value.event,'ANOMALY_EVENT_RECORDED');
 assert.equal(value.delivery,'UNSENT_CANDIDATE_RECORDED');
 const recovery=observed(abnormal,base+1,false);value=safe(assess(result(recovery,2)));
 assert.equal(value.observation,'HEALTHY_RECORDED');assert.equal(value.event,'RECOVERY_EVENT_RECORDED');
 const failed=prepare({state:abnormal,read_succeeded:false,now:base+1}).state;
 value=safe(assess(result(failed,2)));assert.equal(value.observation,'MONITOR_READ_FAILED_RECORDED');
 assert.equal(value.event,'MONITOR_READ_FAILURE_EVENT_RECORDED');
 for(const stillAbnormal of [false,true]){
  value=safe(assess(result(observed(failed,base+2,stillAbnormal),3)));
  assert.equal(value.event,'MONITOR_READ_RECOVERY_EVENT_RECORDED');
  assert.equal(value.observation,stillAbnormal?'ANOMALY_RECORDED':'HEALTHY_RECORDED');
 }
});
test('started, unknown and failed deliveries require preserving evidence and human reconciliation',()=>{
 const claimed=claimAttempt(observed(),1);
 for(const outcome of [null,'unknown','failed']){
  const state=outcome===null?claimed:settleAttempt(claimed,1,outcome);
  const status=outcome===null?'claimed':'settled',revision=outcome===null?2:3;
  for(const operation of ['ready',status]){
   const value=safe(assess(result(state,revision,operation)));
   assert.equal(value.diagnostic_valid,true);assert.equal(value.classification,'DELIVERY_REVIEW_REQUIRED');
   assert.deepEqual(value.issues,['UNRESOLVED_DELIVERY_EVIDENCE']);
   for(const code of ['KEEP_RUNNER_STOPPED','PRESERVE_EXISTING_EVIDENCE',
    'MANUAL_DELIVERY_RECONCILIATION_REQUIRED','DO_NOT_REINITIALIZE'])assert(value.required_checks.includes(code));
  }
 }
 const confirmed=settleAttempt(claimed,1,'confirmed'),value=safe(assess(result(confirmed,3,'settled')));
 assert.equal(value.classification,'RECORD_ONLY');assert.equal(value.delivery,'DELIVERY_CONFIRMATION_RECORDED');
 // This is a recorded confirmation, not an independently verified delivery.
 assert.equal(value.resume_allowed,false);
});
test('known store lock, corruption, missing state and concurrency failures remain blocked without repair instructions',()=>{
 for(const code of ['STORE_LOCKED','STORE_WRITE_UNCERTAIN','STORE_LOCK_RELEASE_UNCERTAIN','STORE_MISSING',
  'STORE_STATE_MISSING','STORE_STATE_INVALID','STORE_CONTENTS_UNEXPECTED','STORE_DIRECTORY_UNSAFE',
  'STORE_REVISION_CONFLICT','ATTEMPT_REVIEW_REQUIRED','ATTEMPT_NOT_CLAIMABLE','ATTEMPT_NOT_SETTLEABLE']){
  const value=safe(assess(blocked(code)));assert.equal(value.diagnostic_valid,true);
  assert.equal(value.classification,'STORE_REVIEW_REQUIRED');assert.deepEqual(value.issues,[code]);
  for(const check of ['KEEP_RUNNER_STOPPED','PRESERVE_EXISTING_EVIDENCE','MANUAL_STORE_REVIEW_REQUIRED',
   'DO_NOT_REINITIALIZE'])assert(value.required_checks.includes(check));
 }
});
test('missing, unknown schema, added secret fields and unknown error codes fail closed without echo',()=>{
 const input=result(observed(),1);
 for(const value of [undefined,null,{},[],{...input,schema_version:2},
  {...input,state:{...input.state,schema_version:2}},
  {...input,state:{...input.state,secret:'synthetic-secret'}},
  {...input,secret:'synthetic-secret'},blocked('synthetic-secret'),
  {...blocked('STORE_LOCKED'),issues:['STORE_LOCKED','synthetic-secret']},
  {...input,state:{...input.state,event:{...input.state.event,issue_codes:['synthetic-secret']}}}]){
  const answer=safe(assess(value));assert.equal(answer.diagnostic_valid,false);
  assert.equal(answer.classification,'INVALID_INPUT');assert.deepEqual(answer.issues,['INVALID_STORE_RESULT']);
 }
});
test('attempts to enable sends, name destinations, retry or inject body are rejected',()=>{
 const input=result(observed(),1);
 for(const value of [
  {...input,dispatches:1},{...input,configuration:{...CONFIG,enabled:true}},
  {...input,configuration:{...CONFIG,destination:'synthetic-secret@example.invalid'}},
  {...input,configuration:{...CONFIG,automatic_retry:true}},
  {...input,configuration:{...CONFIG,body:'synthetic-secret'}},
  {...input,dispatch_allowed:true},{...input,unlock_allowed:true}
 ])assert.equal(safe(assess(value)).diagnostic_valid,false);
});
test('operation labels, revisions and delivery states must agree and integer limits never reset',()=>{
 const abnormal=observed(),claimed=claimAttempt(abnormal,1);
 for(const value of [result(initialState(),1),result(abnormal,0),result(abnormal,1,'initialized'),
  result(initialState(),1,'observed'),result(abnormal,2,'claimed'),result(claimed,1,'claimed'),
  result(claimed,2,'observed'),result(abnormal,3,'settled'),result(claimed,3,'settled'),
  result(abnormal,-1),result(abnormal,0.5),result(abnormal,Number.MAX_SAFE_INTEGER+1)]){
  assert.equal(safe(assess(value)).diagnostic_valid,false);
 }
 const exhausted=structuredClone(abnormal);exhausted.sequence=Number.MAX_SAFE_INTEGER;exhausted.event.id=exhausted.sequence;
 assert.equal(safe(assess(result(exhausted,Number.MAX_SAFE_INTEGER))).diagnostic_valid,false);
});
test('diagnosis neither changes supplied evidence nor reads files, manipulates locks or opens a transport',()=>{
 const input=frozen(result(observed(),1)),before=JSON.stringify(input),oldFetch=global.fetch;
 const functions=['readFileSync','writeFileSync','mkdirSync','rmdirSync','openSync','readdirSync','renameSync','unlinkSync'];
 const originals=new Map(functions.map(name=>[name,fs[name]]));let calls=0;
 try{
  global.fetch=()=>{calls++;throw new Error('synthetic-secret');};
  for(const name of functions)fs[name]=()=>{calls++;throw new Error('synthetic-secret');};
  assert.equal(safe(assess(input)).diagnostic_valid,true);assert.equal(calls,0);
 }finally{
  for(const [name,value] of originals)fs[name]=value;global.fetch=oldFetch;
 }
 assert.equal(JSON.stringify(input),before);
 const malicious={...result()};Object.defineProperty(malicious,'state',{get(){throw new Error('synthetic-secret');}});
 assert.equal(safe(assess(malicious)).diagnostic_valid,false);
});
test('CLI returns review-only exit 1 for intact records and blocked stores without filenames or secrets',()=>{
 for(const input of [result(),result(observed(),1),blocked('STORE_LOCKED')]){
  const value=cli(JSON.stringify(input));assert.equal(value.status,1);assert.equal(value.parsed.diagnostic_valid,true);
 }
});
test('CLI rejects invalid JSON, fields, UTF-8, arguments and inputs over the byte limit with exit 2',()=>{
 for(const input of ['synthetic-secret',JSON.stringify({secret:'synthetic-secret'}),Buffer.from([0xff]),
  'x'.repeat(65537),'あ'.repeat(22000)]){
  const value=cli(input);assert.equal(value.status,2);assert.equal(value.parsed.diagnostic_valid,false);
 }
 const value=cli(JSON.stringify(result()),['synthetic-secret']);assert.equal(value.status,2);
 assert.deepEqual(value.parsed.issues,['INVALID_ARGUMENTS']);
 // A valid document exactly at the byte limit is accepted; no guessed retention/time limit is added.
 const document=JSON.stringify(result());assert.equal(cli(document+' '.repeat(65536-Buffer.byteLength(document))).status,1);
});
