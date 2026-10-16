'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {spawn,spawnSync}=require('node:child_process');
const store=require('../scripts/cargo-monitor-notification-store.cjs');
const modulePath=require.resolve('../scripts/cargo-monitor-notification-store.cjs');
const base=Date.parse('2026-10-16T16:00:00.000Z');
function fixture(t){
 // Keep fixtures beneath the trusted checkout. This managed sandbox maps /tmp's
 // owner to nobody, so it correctly fails the production root-owned-parent guard.
 const root=fs.mkdtempSync(path.join(path.dirname(__dirname),'.cargo-notification-persistence-'));
 fs.chmodSync(root,0o700);t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return {root,directory:path.join(root,'store')};
}
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
function start(t){const value=fixture(t);assert.equal(store.initializeStore(value.directory).status,'initialized');return value;}
function observe(directory,revision=0,now=base,abnormal=true){return store.observeStore(directory,
 {expected_revision:revision,snapshot:snapshot(now,abnormal),now});}
function observed(t){const value=start(t);assert.equal(observe(value.directory).status,'observed');return value;}
function bytes(directory){return fs.readFileSync(path.join(directory,'state.json'),'utf8');}
function issue(result,code){assert.equal(result.status,'blocked');assert.deepEqual(result.issues,[code]);
 assert.equal(result.dispatches,0);assert.deepEqual(result.configuration,{enabled:false,destination:null,automatic_retry:false});}
function child(code,args=[]){
 const result=spawnSync(process.execPath,['-e',code,modulePath,...args],{encoding:'utf8'});
 assert.equal(result.error,undefined);assert.equal(result.stderr,'');return result;
}
test('explicit provisioning refuses existing/missing state and survives a new process without reset',t=>{
 const {directory}=fixture(t);issue(store.readStore(directory),'STORE_MISSING');
 const initial=store.initializeStore(directory);assert.equal(initial.status,'initialized');assert.equal(initial.revision,0);
 assert.equal(fs.statSync(directory).mode&0o777,0o700);assert.equal(fs.statSync(path.join(directory,'state.json')).mode&0o777,0o600);
 assert.equal(observe(directory).revision,1);const before=bytes(directory);
 const restarted=child('const s=require(process.argv[1]);process.stdout.write(JSON.stringify(s.readStore(process.argv[2])));',[directory]);
 assert.equal(restarted.status,0);assert.equal(JSON.parse(restarted.stdout).state.event.kind,'anomaly');
 issue(store.initializeStore(directory),'STORE_ALREADY_EXISTS');assert.equal(bytes(directory),before);
 fs.unlinkSync(path.join(directory,'state.json'));
 issue(store.readStore(directory),'STORE_STATE_MISSING');issue(store.initializeStore(directory),'STORE_ALREADY_EXISTS');
 assert.equal(fs.existsSync(path.join(directory,'state.json')),false);
});
test('only sanitized kernel state is persisted; notifications and destinations remain disabled',t=>{
 const {directory}=start(t);const value=snapshot(base,true);value.secret='synthetic-secret@example.invalid';
 value.jobs[0].error='synthetic-secret';let calls=0;const oldFetch=global.fetch;
 global.fetch=()=>{calls++;throw new Error('synthetic-secret');};
 try{
  const saved=store.observeStore(directory,{expected_revision:0,snapshot:value,now:base});
  assert.equal(saved.status,'observed');assert.equal(saved.state.event.kind,'anomaly');assert.equal(calls,0);
  assert.equal(saved.dispatches,0);assert.deepEqual(saved.configuration,{enabled:false,destination:null,automatic_retry:false});
  assert(!bytes(directory).includes('synthetic-secret'));assert(!bytes(directory).includes('counts'));
  assert(!JSON.stringify(saved).includes('synthetic-secret'));
  issue(store.observeStore(directory,{expected_revision:1,snapshot:value,now:base,enabled:true}),'INVALID_STORE_OPERATION');
  assert(Object.isFrozen(store.CONFIG));
 }finally{global.fetch=oldFetch;}
});
test('persisted anomaly, recovery and monitor-read recovery retain event identity and stale revision protection',t=>{
 const {directory}=observed(t),first=store.readStore(directory);assert.equal(first.state.event.id,1);
 const repeated=observe(directory,1,base+1);assert.equal(repeated.state.event.id,1);
 issue(observe(directory,1,base+2),'STORE_REVISION_CONFLICT');assert.equal(store.readStore(directory).revision,2);
 const recovered=observe(directory,2,base+2,false);assert.equal(recovered.state.event.id,2);
 assert.equal(recovered.state.event.kind,'recovery');assert.equal(recovered.state.event.previous_delivery_confirmed,false);
 const failed=store.observeStore(directory,{expected_revision:3,read_succeeded:false,now:base+3});
 assert.equal(failed.state.event.kind,'monitor_read_failed');
 const restored=observe(directory,4,base+4,false);assert.equal(restored.state.event.kind,'monitor_read_recovered');
 assert.equal(restored.state.event.id,4);
});
test('claim and settlement require both exact revision and event; claims are durable before acknowledgement',t=>{
 const {directory}=observed(t);const claimed=store.claimStore(directory,{expected_revision:1,event_id:1});
 assert.equal(claimed.status,'claimed');assert.equal(claimed.revision,2);assert.equal(claimed.state.delivery_status,'attempt_started');
 assert.equal(JSON.parse(bytes(directory)).notification_state.delivery_status,'attempt_started');
 assert.equal(fs.existsSync(path.join(directory,'.lock')),false);
 issue(store.claimStore(directory,{expected_revision:1,event_id:1}),'STORE_REVISION_CONFLICT');
 issue(store.claimStore(directory,{expected_revision:2,event_id:1}),'ATTEMPT_NOT_CLAIMABLE');
 issue(store.settleStore(directory,{expected_revision:2,event_id:2,outcome:'confirmed'}),'ATTEMPT_NOT_SETTLEABLE');
 const confirmed=store.settleStore(directory,{expected_revision:2,event_id:1,outcome:'confirmed'});
 assert.equal(confirmed.status,'settled');assert.equal(confirmed.revision,3);
 const recovered=observe(directory,3,base+1,false);assert.equal(recovered.state.event.previous_delivery_confirmed,true);
 issue(store.settleStore(directory,{expected_revision:4,event_id:1,outcome:'confirmed'}),'ATTEMPT_NOT_SETTLEABLE');
});
test('inflight, unknown and failed evidence survives restart and cannot be erased by a new observation or retry',t=>{
 for(const outcome of [null,'unknown','failed']){
  const {directory}=observed(t);store.claimStore(directory,{expected_revision:1,event_id:1});
  let revision=2;if(outcome){assert.equal(store.settleStore(directory,{expected_revision:revision,event_id:1,outcome}).status,'settled');revision++;}
  const before=bytes(directory);
  const restarted=child('const s=require(process.argv[1]);process.stdout.write(JSON.stringify(s.observeStore(process.argv[2],'+
   '{expected_revision:Number(process.argv[3]),read_succeeded:false,now:1760630400001})));',[directory,String(revision)]);
  assert.equal(restarted.status,0);issue(JSON.parse(restarted.stdout),'ATTEMPT_REVIEW_REQUIRED');
  issue(observe(directory,revision,base+2,false),'ATTEMPT_REVIEW_REQUIRED');
  issue(store.claimStore(directory,{expected_revision:revision,event_id:1}),'ATTEMPT_NOT_CLAIMABLE');
  assert.equal(bytes(directory),before);
 }
});
test('two independent processes cannot both durably claim the same event',{timeout:10000},async t=>{
 const {directory}=observed(t),processes=[];
 t.after(()=>{for(const process of processes)process.kill();});
 const source='const s=require(process.argv[1]);process.send({type:"ready"});process.on("message",()=>{'+
  'process.send({type:"result",value:s.claimStore(process.argv[2],{expected_revision:1,event_id:1})},()=>process.disconnect());});';
 function contender(){
  const process=spawn(global.process.execPath,['-e',source,modulePath,directory],{stdio:['ignore','pipe','pipe','ipc']});processes.push(process);
  let stderr='',stdout='',ready,rejectReady,answer;
  const prepared=new Promise((done,reject)=>{ready=done;rejectReady=reject;});
  const completion=new Promise((resolve,reject)=>{
  process.stderr.on('data',chunk=>{stderr+=chunk;});process.stdout.on('data',chunk=>{stdout+=chunk;});
   process.on('error',error=>{rejectReady(error);reject(error);});
   process.on('message',message=>{if(message.type==='ready')ready();else answer=message.value;});
   process.on('close',code=>{try{assert.equal(code,0);assert.equal(stderr,'');assert.equal(stdout,'');resolve(answer);}
    catch(error){rejectReady(error);reject(error);}});
  });
  return prepared.then(()=>({process,completion}));
 }
 // Both processes are running and have loaded the module before either claims.
 const contenders=await Promise.all([contender(),contender()]);
 for(const item of contenders)item.process.send('go');
 const values=await Promise.all(contenders.map(item=>item.completion));
 assert.equal(values.filter(value=>value.status==='claimed').length,1);
 const loser=values.find(value=>value.status==='blocked');assert(loser);
 assert(['STORE_LOCKED','STORE_REVISION_CONFLICT'].includes(loser.issues[0]));
 const saved=store.readStore(directory);assert.equal(saved.revision,2);assert.equal(saved.state.delivery_status,'attempt_started');
});
test('a residual lock never expires or initializes and a missing state never silently resets',t=>{
 const {directory}=observed(t),before=bytes(directory);fs.mkdirSync(path.join(directory,'.lock'),{mode:0o700});
 fs.utimesSync(path.join(directory,'.lock'),new Date(0),new Date(0));
 issue(store.readStore(directory),'STORE_LOCKED');issue(store.claimStore(directory,{expected_revision:1,event_id:1}),'STORE_LOCKED');
 issue(store.initializeStore(directory),'STORE_ALREADY_EXISTS');assert.equal(bytes(directory),before);
 assert.equal(fs.existsSync(path.join(directory,'.lock')),true);
});
test('corrupt, oversized and unsafe envelopes fail closed without logging their details',t=>{
 for(const value of ['synthetic-secret',JSON.stringify({schema_version:1,revision:0,notification_state:{secret:'synthetic-secret'}}),
  'x'.repeat(65537)]){
  const {directory}=start(t);fs.writeFileSync(path.join(directory,'state.json'),value);
  const answer=store.readStore(directory);issue(answer,'STORE_STATE_INVALID');assert(!JSON.stringify(answer).includes('synthetic-secret'));
  assert.equal(bytes(directory),value);issue(store.initializeStore(directory),'STORE_ALREADY_EXISTS');
 }
});
test('symlink paths, state, lock and staging links plus hardlinked state never overwrite their targets',t=>{
 const {root}=fixture(t),outside=path.join(root,'outside');fs.writeFileSync(outside,'synthetic-secret',{mode:0o600});
 const scenarios=['directory','ancestor','state','lock','next','hardlink'];
 for(const scenario of scenarios){
  const directory=path.join(root,scenario);
  if(scenario==='directory'){
   fs.symlinkSync(root,directory);issue(store.readStore(directory),'STORE_DIRECTORY_UNSAFE');
   issue(store.initializeStore(directory),'STORE_ALREADY_EXISTS');continue;
  }
  if(scenario==='ancestor'){
   fs.symlinkSync(root,directory);issue(store.initializeStore(path.join(directory,'new')),'STORE_DIRECTORY_UNSAFE');continue;
  }
  assert.equal(store.initializeStore(directory).status,'initialized');
  if(scenario==='state'||scenario==='hardlink'){
   fs.unlinkSync(path.join(directory,'state.json'));
   if(scenario==='state')fs.symlinkSync(outside,path.join(directory,'state.json'));
   else fs.linkSync(outside,path.join(directory,'state.json'));
   issue(store.readStore(directory),'STORE_STATE_UNSAFE');
  }else if(scenario==='lock'){
   fs.symlinkSync(root,path.join(directory,'.lock'));issue(store.readStore(directory),'STORE_LOCKED');
  }else{
   fs.symlinkSync(outside,path.join(directory,'state.next'));issue(observe(directory),'STORE_CONTENTS_UNEXPECTED');
  }
  assert.equal(fs.readFileSync(outside,'utf8'),'synthetic-secret');
 }
});
test('unexpected entries and public permissions require explicit repair, never automatic cleanup',t=>{
 const {directory}=start(t);fs.writeFileSync(path.join(directory,'state.next'),'synthetic-secret',{mode:0o600});
 issue(store.readStore(directory),'STORE_CONTENTS_UNEXPECTED');assert.equal(fs.readFileSync(path.join(directory,'state.next'),'utf8'),'synthetic-secret');
 const other=start(t);fs.chmodSync(path.join(other.directory,'state.json'),0o644);issue(store.readStore(other.directory),'STORE_STATE_UNSAFE');
 const third=start(t);fs.chmodSync(third.directory,0o755);issue(store.readStore(third.directory),'STORE_DIRECTORY_UNSAFE');
 const fourth=start(t),before=bytes(fourth.directory),newDirectory=path.join(fourth.root,'another');
 fs.chmodSync(fourth.root,0o777);
 try{
  issue(store.readStore(fourth.directory),'STORE_DIRECTORY_UNSAFE');
  issue(store.initializeStore(newDirectory),'STORE_DIRECTORY_UNSAFE');
  assert.equal(bytes(fourth.directory),before);assert.equal(fs.existsSync(newDirectory),false);
 }finally{fs.chmodSync(fourth.root,0o700);}
 assert.equal(store.readStore(fourth.directory).status,'ready');assert.equal(bytes(fourth.directory),before);
});
test('process interruption before rename retains the original state and evidence and blocks restart',t=>{
 const {directory}=observed(t),before=bytes(directory);
 const crashed=child('const fs=require("node:fs"),s=require(process.argv[1]);'+
  'fs.renameSync=()=>process.exit(71);s.claimStore(process.argv[2],{expected_revision:1,event_id:1});',[directory]);
 assert.equal(crashed.status,71);assert.equal(crashed.stdout,'');assert.equal(bytes(directory),before);
 assert.equal(fs.existsSync(path.join(directory,'state.next')),true);assert.equal(fs.existsSync(path.join(directory,'.lock')),true);
 issue(store.readStore(directory),'STORE_LOCKED');issue(store.initializeStore(directory),'STORE_ALREADY_EXISTS');
});
test('failed write/rename or post-rename fsync never acknowledges a claim and preserves uncertainty',t=>{
 for(const phase of ['write','rename','directory-sync']){
  const {directory}=observed(t),before=bytes(directory);
  const source='const fs=require("node:fs"),s=require(process.argv[1]);let renamed=false;'+
   'const rename=fs.renameSync,sync=fs.fsyncSync;'+
   (phase==='write'?'fs.writeFileSync=()=>{throw new Error("synthetic-secret");};':
    phase==='rename'?'fs.renameSync=()=>{throw new Error("synthetic-secret");};':
     'fs.renameSync=(...args)=>{rename(...args);renamed=true;};fs.fsyncSync=fd=>{if(renamed&&fs.fstatSync(fd).isDirectory())throw new Error("synthetic-secret");sync(fd);};')+
   'process.stdout.write(JSON.stringify(s.claimStore(process.argv[2],{expected_revision:1,event_id:1})));';
  const failed=child(source,[directory]);assert.equal(failed.status,0);assert(!failed.stdout.includes('synthetic-secret'));
  issue(JSON.parse(failed.stdout),'STORE_WRITE_UNCERTAIN');assert.equal(fs.existsSync(path.join(directory,'.lock')),true);
  if(phase==='directory-sync')assert.equal(JSON.parse(bytes(directory)).notification_state.delivery_status,'attempt_started');
  else assert.equal(bytes(directory),before);
  issue(store.readStore(directory),'STORE_LOCKED');
 }
});
test('lock loss during a write prevents rename and does not acknowledge an attempt',t=>{
 const {directory}=observed(t),before=bytes(directory);
 const failed=child('const fs=require("node:fs"),path=require("node:path"),s=require(process.argv[1]);'+
  'const write=fs.writeFileSync;fs.writeFileSync=(...args)=>{fs.rmdirSync(path.join(process.argv[2],".lock"));write(...args);};'+
  'process.stdout.write(JSON.stringify(s.claimStore(process.argv[2],{expected_revision:1,event_id:1})));',[directory]);
 assert.equal(failed.status,0);issue(JSON.parse(failed.stdout),'STORE_WRITE_UNCERTAIN');assert.equal(bytes(directory),before);
 assert.equal(fs.existsSync(path.join(directory,'state.next')),true);issue(store.readStore(directory),'STORE_CONTENTS_UNEXPECTED');
});
test('revision/sequence exhaustion and invalid transitions preserve existing state rather than reset',t=>{
 const {directory}=observed(t);const target=path.join(directory,'state.json');let value=JSON.parse(bytes(directory));
 value.revision=Number.MAX_SAFE_INTEGER;fs.writeFileSync(target,JSON.stringify(value));const before=bytes(directory);
 issue(store.claimStore(directory,{expected_revision:Number.MAX_SAFE_INTEGER,event_id:1}),'STORE_REVISION_EXHAUSTED');assert.equal(bytes(directory),before);
 value.revision=1;value.notification_state.sequence=Number.MAX_SAFE_INTEGER;value.notification_state.event.id=Number.MAX_SAFE_INTEGER;
 fs.writeFileSync(target,JSON.stringify(value));const exhausted=bytes(directory);
 issue(store.readStore(directory),'STORE_STATE_INVALID');assert.equal(bytes(directory),exhausted);
 const other=observed(t),untouched=bytes(other.directory);
 issue(store.settleStore(other.directory,{expected_revision:1,event_id:1,outcome:'synthetic-secret'}),'INVALID_STORE_OPERATION');
 issue(store.observeStore(other.directory,{expected_revision:1,snapshot:null,now:-1}),'STORE_OBSERVATION_REJECTED');
 assert.equal(bytes(other.directory),untouched);
});
