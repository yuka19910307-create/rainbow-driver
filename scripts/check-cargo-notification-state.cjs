// Offline interpretation of an existing store result only. No files, locks or transport.
// A valid record is never permission to send, retry, reset, unlock or resume a runner.
'use strict';
const {CONFIG,prepare}=require('./prepare-cargo-monitor-notification.cjs');
const MAX_BYTES=65536;
const KEYS=['configuration','dispatches','status','issues','revision','state'];
const STORE_CODES=new Set([
 'INVALID_STORE_DIRECTORY','STORE_DIRECTORY_UNSAFE','STORE_CONTENTS_UNEXPECTED',
 'STORE_STATE_MISSING','STORE_STATE_UNSAFE','STORE_STATE_INVALID','STORE_NEXT_STATE_INVALID',
 'STORE_WRITE_UNCERTAIN','UNSUPPORTED_FILESYSTEM_GUARD','STORE_LOCKED','STORE_LOCK_CHANGED',
 'STORE_LOCK_DURABILITY_UNCERTAIN','STORE_LOCK_RELEASE_UNCERTAIN','STORE_MISSING','STORE_IO_FAILURE',
 'STORE_ALREADY_EXISTS','STORE_INITIALIZATION_UNCERTAIN','INVALID_STORE_OPERATION',
 'STORE_REVISION_CONFLICT','STORE_REVISION_EXHAUSTED','STORE_TRANSITION_REJECTED',
 'ATTEMPT_REVIEW_REQUIRED','STORE_OBSERVATION_REJECTED','ATTEMPT_NOT_CLAIMABLE','ATTEMPT_NOT_SETTLEABLE'
]);
const SUCCESS=new Set(['initialized','ready','observed','claimed','settled']);
const UNRESOLVED=new Set(['attempt_started','unknown','failed']);
const OBSERVATIONS={healthy:'HEALTHY_RECORDED',anomaly:'ANOMALY_RECORDED',
 monitor_read_failed:'MONITOR_READ_FAILED_RECORDED'};
const EVENTS={anomaly:'ANOMALY_EVENT_RECORDED',recovery:'RECOVERY_EVENT_RECORDED',
 monitor_read_failed:'MONITOR_READ_FAILURE_EVENT_RECORDED',
 monitor_read_recovered:'MONITOR_READ_RECOVERY_EVENT_RECORDED'};
const DELIVERIES={prepared:'UNSENT_CANDIDATE_RECORDED',attempt_started:'ATTEMPT_STARTED_RECORDED',
 confirmed:'DELIVERY_CONFIRMATION_RECORDED',failed:'DELIVERY_FAILURE_RECORDED',unknown:'DELIVERY_UNKNOWN_RECORDED'};
const own=(value,keys)=>value!==null&&typeof value==='object'&&!Array.isArray(value)
 &&Reflect.ownKeys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const natural=value=>Number.isSafeInteger(value)&&value>=0;
function output(valid,classification,issues,checks=[],record={}){
 return {schema_version:1,scope:'cargo-notification-state-diagnostic',configuration:CONFIG,
  dispatches:0,dispatch_allowed:false,retry_allowed:false,reset_allowed:false,unlock_allowed:false,
  resume_allowed:false,diagnostic_valid:valid,classification,
  observation:'UNVERIFIED',event:'UNVERIFIED',delivery:'UNVERIFIED',...record,
  issues,required_checks:['CURRENT_RUNTIME_UNVERIFIED','NO_DELIVERY_PERMISSION',...checks]};
}
const invalid=code=>output(false,'INVALID_INPUT',[code],['PRESERVE_EXISTING_EVIDENCE','DO_NOT_REINITIALIZE']);
function validState(state){
 // Reuse the strict kernel validator, as the store does. The hypothetical read
 // failure is discarded; this function neither changes the record nor observes DB.
 const now=state?.last_observation===null?0:Date.parse(state?.last_observation?.checked_at);
 return prepare({state,read_succeeded:false,now}).status==='disabled';
}
function assess(value){
 try{
  if(!own(value,KEYS)||!own(value.configuration,['enabled','destination','automatic_retry'])
   ||value.configuration.enabled!==false||value.configuration.destination!==null
   ||value.configuration.automatic_retry!==false||value.dispatches!==0)return invalid('INVALID_STORE_RESULT');
  if(value.status==='blocked'){
   if(value.revision!==null||value.state!==null||!Array.isArray(value.issues)||value.issues.length!==1
    ||!STORE_CODES.has(value.issues[0]))return invalid('INVALID_STORE_RESULT');
   return output(true,'STORE_REVIEW_REQUIRED',[value.issues[0]],
    ['KEEP_RUNNER_STOPPED','PRESERVE_EXISTING_EVIDENCE','MANUAL_STORE_REVIEW_REQUIRED','DO_NOT_REINITIALIZE']);
  }
  if(!SUCCESS.has(value.status)||!Array.isArray(value.issues)||value.issues.length!==0
   ||!natural(value.revision)||!validState(value.state))return invalid('INVALID_STORE_RESULT');
  const state=value.state,initial=state.last_observation===null;
  // Operation labels must not contradict their state or the initial revision.
  if(state.sequence>value.revision||(value.revision===0&&!initial)||(initial&&value.revision!==0)
   ||(value.status==='initialized'&&(value.revision!==0||!initial))
   ||(value.status==='observed'&&(value.revision<1||initial||UNRESOLVED.has(state.delivery_status)))
   ||(value.status==='claimed'&&(value.revision<2||state.delivery_status!=='attempt_started'))
   ||(value.status==='settled'&&(value.revision<3||!['confirmed','failed','unknown'].includes(state.delivery_status))))
   return invalid('INCONSISTENT_STORE_RESULT');
  const record={observation:initial?'NOT_OBSERVED':OBSERVATIONS[state.last_observation.health],
   event:state.event===null?'NO_EVENT_RECORDED':EVENTS[state.event.kind],
   delivery:state.delivery_status===null?'NO_DELIVERY_RECORDED':DELIVERIES[state.delivery_status]};
  if(UNRESOLVED.has(state.delivery_status))return output(true,'DELIVERY_REVIEW_REQUIRED',
   ['UNRESOLVED_DELIVERY_EVIDENCE'],['KEEP_RUNNER_STOPPED','PRESERVE_EXISTING_EVIDENCE',
    'MANUAL_DELIVERY_RECONCILIATION_REQUIRED','DO_NOT_REINITIALIZE'],record);
  return output(true,initial?'NOT_OBSERVED':'RECORD_ONLY',[],
   initial?['NO_MONITORING_BASELINE_PROVEN']:['RECORDED_HEALTH_IS_NOT_CURRENT_HEALTH_PROOF'],record);
 }catch{return invalid('INVALID_STORE_RESULT');}
}
if(require.main===module){
 let chunks=[],length=0,tooLarge=false,finished=false;
 function finish(result,code){
  if(finished)return;finished=true;process.stdout.write(JSON.stringify(result)+'\n');process.exitCode=code;
 }
 if(process.argv.length!==2)finish(invalid('INVALID_ARGUMENTS'),2);
 else{
  process.stdin.on('data',chunk=>{
   if(finished||tooLarge)return;
   length+=chunk.length;
   if(length>MAX_BYTES){tooLarge=true;chunks=[];}else chunks.push(chunk);
  });
  process.stdin.on('error',()=>finish(invalid('INPUT_READ_FAILED'),2));
  process.stdin.on('end',()=>{
   if(finished)return;
   if(tooLarge){finish(invalid('INPUT_TOO_LARGE'),2);return;}
   let value;
   try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));}
   catch{finish(invalid('INVALID_JSON'),2);return;}
   const result=assess(value);
   // Even an intact healthy record never yields an executable success status.
   finish(result,result.diagnostic_valid?1:2);
  });
 }
}
module.exports={assess};
