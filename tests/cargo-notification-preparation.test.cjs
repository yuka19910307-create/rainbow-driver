'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{spawnSync}=require('node:child_process');
const {CONFIG,initialState,prepare,claimAttempt,settleAttempt}=require('../scripts/prepare-cargo-monitor-notification.cjs');
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
const step=(state,time=base,abnormal=false)=>prepare({state,snapshot:snapshot(time,abnormal),now:time});
test('notification preparation stays disabled and never opens a transport',()=>{
 const oldFetch=global.fetch;let calls=0;
 global.fetch=()=>{calls++;throw new Error('must not connect');};
 try{
  let state=initialState();
  for(const [offset,abnormal] of [[0,false],[1,true],[2,true],[3,false]]){
   const result=prepare({state,snapshot:snapshot(base+offset,abnormal),now:base+offset,
    enabled:true,destination:'synthetic-secret',transport:()=>calls++});
   assert.deepEqual(result.configuration,{enabled:false,destination:null,automatic_retry:false});
   assert.equal(result.dispatches,0);assert.equal(result.status,'disabled');state=result.state;
  }
  assert.equal(calls,0);assert(Object.isFrozen(CONFIG));
 }finally{global.fetch=oldFetch;}
});
test('initial healthy read establishes a baseline without an unsolicited recovery event',()=>{
 const result=step(initialState());
 assert.equal(result.candidate,null);assert.equal(result.state.sequence,0);
 assert.deepEqual(result.state.last_valid_codes,[]);
 assert.equal(step(result.state,base+1).candidate,null);
});
test('anomaly uses existing classifier and deterministic bounded fields only',()=>{
 const value=snapshot(base,true);value.email='synthetic-secret@example.invalid';value.counts.secret='synthetic-secret';
 value.jobs[0].error='synthetic-secret';
 const result=prepare({snapshot:value,now:base});
 assert.deepEqual(result.candidate,{id:1,scope:'production-cargo-prelaunch-hold',kind:'anomaly',
  checked_at:new Date(base).toISOString(),health:'anomaly',issue_codes:['QUOTE_DELIVERY_UNKNOWN'],
  cleared_issue_codes:[],previous_delivery_confirmed:false});
 assert(!JSON.stringify(result).includes('synthetic-secret'));
 assert(!JSON.stringify(result).includes('counts'));
});
test('unchanged anomaly retains its candidate identity and original timestamp until delivery is confirmed',()=>{
 const first=step(initialState(),base,true),second=step(first.state,base+1,true);
 assert.deepEqual(second.candidate,first.candidate);assert.equal(second.state.sequence,1);
 const claimed=claimAttempt(second.state,1),confirmed=settleAttempt(claimed,1,'confirmed');
 assert.equal(step(confirmed,base+2,true).candidate,null);
 assert.equal(step(confirmed,base+2,true).state.delivery_status,'confirmed');
});
test('changed anomaly and genuine fresh recovery create separate event identities',()=>{
 const first=step(initialState(),base,true),value=snapshot(base+1,true);
 value.counts.sending_over_10m=1;
 const second=prepare({state:first.state,snapshot:value,now:base+1});
 assert.equal(second.candidate.id,2);assert.equal(second.candidate.kind,'anomaly');
 assert.deepEqual(second.candidate.issue_codes,['QUOTE_DELIVERY_UNKNOWN','QUOTE_SEND_STALLED']);
 const recovered=step(second.state,base+2,false);
 assert.equal(recovered.candidate.id,3);assert.equal(recovered.candidate.kind,'recovery');
 assert.deepEqual(recovered.candidate.issue_codes,[]);
 assert.deepEqual(recovered.candidate.cleared_issue_codes,['QUOTE_DELIVERY_UNKNOWN','QUOTE_SEND_STALLED']);
 assert.equal(recovered.candidate.previous_delivery_confirmed,false);
 assert.deepEqual(step(recovered.state,base+3).candidate,recovered.candidate);
});
test('read failure is a distinct event and never declares previous business issues recovered',()=>{
 const first=step(initialState(),base,true);
 const failed=prepare({state:first.state,read_succeeded:false,now:base+1,
  snapshot:{error:'synthetic-secret sql failure'}});
 assert.equal(failed.candidate.kind,'monitor_read_failed');
 assert.deepEqual(failed.candidate.issue_codes,['MONITOR_READ_FAILED']);
 assert.deepEqual(failed.candidate.cleared_issue_codes,[]);
 assert.deepEqual(failed.state.last_valid_codes,['QUOTE_DELIVERY_UNKNOWN']);
 const again=prepare({state:failed.state,read_succeeded:false,now:base+2});
 assert.deepEqual(again.candidate,failed.candidate);
 const restored=step(again.state,base+3,true);
 assert.equal(restored.candidate.kind,'monitor_read_recovered');
 assert.equal(restored.candidate.health,'anomaly');
 assert.deepEqual(restored.candidate.issue_codes,['QUOTE_DELIVERY_UNKNOWN']);
 assert.deepEqual(restored.candidate.cleared_issue_codes,[]);
 assert(!JSON.stringify(failed).includes('synthetic-secret'));
});
test('healthy read after monitoring restoration requires a newer valid snapshot',()=>{
 const first=step(initialState());
 const failed=prepare({state:first.state,read_succeeded:false,now:base+1});
 const replay=prepare({state:failed.state,snapshot:snapshot(base),now:base+2});
 assert.equal(replay.state.last_observation.health,'monitor_read_failed');
 assert.deepEqual(replay.candidate,failed.candidate);
 const restored=step(replay.state,base+3);
 assert.equal(restored.candidate.kind,'monitor_read_recovered');
 assert.equal(restored.candidate.health,'healthy');
});
test('malformed, stale, mismatched and out-of-order snapshots become fixed read failures',()=>{
 const values=[null,{},[snapshot()],{...snapshot(),scope:'staging-cargo-monitor'},
  {...snapshot(),counts:{}},{...snapshot(),observed_at:new Date(base-300001).toISOString()}];
 for(const value of values){
  const result=prepare({snapshot:value,now:base});
  assert.equal(result.candidate.kind,'monitor_read_failed');
  assert.deepEqual(result.candidate.issue_codes,['MONITOR_READ_FAILED']);
 }
 const first=step(initialState(),base+1000,true);
 const older=prepare({state:first.state,snapshot:snapshot(base),now:base+2000});
 assert.equal(older.candidate.kind,'monitor_read_failed');
 const sameTimeChanged=prepare({state:first.state,snapshot:snapshot(base+1000),now:base+2000});
 assert.equal(sameTimeChanged.candidate.kind,'monitor_read_failed');
});
test('attempt is claimed once; failures, ambiguity and unfinished attempts never automatically retry',()=>{
 const first=step(initialState(),base,true);
 assert.equal(settleAttempt(first.state,1,'confirmed'),null);
 assert.equal(claimAttempt(first.state,2),null);
 for(const outcome of ['confirmed','failed','unknown']){
  const claimed=claimAttempt(first.state,1);
  assert.equal(claimAttempt(claimed,1),null);
  assert.equal(step(claimed,base+1,true).candidate,null);
  const settled=settleAttempt(claimed,1,outcome);
  assert.equal(claimAttempt(settled,1),null);
  assert.equal(settleAttempt(settled,1,'confirmed'),null);
  assert.equal(step(settled,base+2,true).candidate,null);
 }
 assert.equal(settleAttempt(claimAttempt(first.state,1),1,'synthetic-secret'),null);
 assert.equal(first.state.delivery_status,'prepared');
});
test('late delivery completion cannot acknowledge a newer candidate and no state is mutated in place',()=>{
 const first=step(initialState(),base,true),claimed=claimAttempt(first.state,1);
 const newer=step(claimed,base+1);
 assert.equal(newer.candidate.id,2);
 assert.equal(settleAttempt(newer.state,1,'confirmed'),null);
 assert.equal(first.state.delivery_status,'prepared');assert.equal(claimed.delivery_status,'attempt_started');
 const confirmed=settleAttempt(claimed,1,'confirmed'),recovered=step(confirmed,base+1);
 assert.equal(recovered.candidate.previous_delivery_confirmed,true);
});
test('untrusted state, arbitrary fields, invalid clocks and invalid read statuses are blocked without echo',()=>{
 const first=step(initialState(),base,true);
 const values=[null,{},[],{...initialState(),secret:'synthetic-secret'},
  {...first.state,delivery_status:'synthetic-secret'},
  {...first.state,event:{...first.state.event,issue_codes:['synthetic-secret']}},
  {...first.state,event:{...first.state.event,kind:'monitor_read_recovered',health:'monitor_read_failed'}},
  {...first.state,last_valid_snapshot_at:new Date(base+60001).toISOString()},
  {...first.state,last_observation:{...first.state.last_observation,checked_at:'synthetic-secret'}}];
 for(const state of values){
  const result=prepare({state,now:base});assert.equal(result.status,'blocked');assert.equal(result.candidate,null);
  assert.equal(result.state,null);assert(!JSON.stringify(result).includes('synthetic-secret'));
 }
 for(const now of [NaN,Infinity,-1,1.1,Number.MAX_SAFE_INTEGER])assert.equal(prepare({now}).status,'blocked');
 assert.deepEqual(prepare({state:first.state,now:base-1}).issues,['OUT_OF_ORDER_CHECK']);
 assert.deepEqual(prepare({read_succeeded:'synthetic-secret'}).issues,['INVALID_READ_STATUS']);
 assert.deepEqual(prepare(null).issues,['NOTIFICATION_INPUT_INVALID']);
});
test('CLI accepts only offline input, limits input, and emits no secret error details',()=>{
 const path=require.resolve('../scripts/prepare-cargo-monitor-notification.cjs');
 for(const input of ['synthetic-secret',JSON.stringify({enabled:true,destination:'synthetic-secret'}),'x'.repeat(65537)]){
  const result=spawnSync(process.execPath,[path],{input,encoding:'utf8'});
  assert.equal(result.status,2);assert.equal(result.stderr,'');assert(!result.stdout.includes('synthetic-secret'));
  assert.equal(JSON.parse(result.stdout).dispatches,0);
 }
 const value=snapshot(Date.now(),true);value.private_value='synthetic-secret';
 const result=spawnSync(process.execPath,[path],{input:JSON.stringify({snapshot:value}),encoding:'utf8'});
 assert.equal(result.status,0);assert.equal(result.stderr,'');assert(!result.stdout.includes('synthetic-secret'));
 const parsed=JSON.parse(result.stdout);assert.equal(parsed.status,'disabled');assert.equal(parsed.dispatches,0);
 assert.equal(parsed.candidate.kind,'anomaly');
});
