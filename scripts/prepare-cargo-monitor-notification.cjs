// Offline preparation only. No transport, credentials, destination, DB or file writes.
// A future authorized runner must durably serialize/claim state before any delivery.
'use strict';
const {assess}=require('./check-cargo-production-monitor.cjs');
const CONFIG=Object.freeze({enabled:false,destination:null,automatic_retry:false});
const SCOPE='production-cargo-prelaunch-hold';
const BUSINESS_CODES=new Set([
 'PRODUCTION_INTAKE_NOT_OFF','REQUIRED_PROTECTION_DISABLED','PRODUCTION_MAIL_NOT_DISABLED',
 'UNEXPECTED_MAIL_ATTEMPTS','UNEXPECTED_CUSTOMER_DATA','QUOTE_DELIVERY_UNKNOWN','QUOTE_SEND_STALLED',
 'DRAFT_CLEANUP_BACKLOG','CLOSED_RETENTION_BACKLOG','CUSTOMER_SCHEMA_DRIFT','CUSTOMER_ACCESS_PROTECTION_CHANGED',
 ...['EXPIRED_INTAKE_DRAFTS','CLOSED_NO_ORDER_RETENTION'].flatMap(prefix=>
  ['CONFIG','STALE','INVALID_HISTORY','FAILED'].map(suffix=>prefix+'_'+suffix))
]);
const READ_CODES=new Set(['INVALID_SNAPSHOT','STALE_OR_INVALID_SNAPSHOT','INVALID_CONTROL','INVALID_MAIL_BUDGET',
 'INVALID_COUNTS','INVALID_CUSTOMER_SECURITY','INVALID_JOB_SET']);
const KINDS=new Set(['healthy','anomaly','monitor_read_failed']);
const EVENTS=new Set(['anomaly','recovery','monitor_read_failed','monitor_read_recovered']);
const STATUSES=new Set(['prepared','attempt_started','confirmed','failed','unknown']);
const own=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)
 &&Object.keys(value).sort().join(',')===[...keys].sort().join(',');
const iso=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))
 &&new Date(Date.parse(value)).toISOString()===value;
const codes=value=>Array.isArray(value)&&value.every(code=>BUSINESS_CODES.has(code))
 &&JSON.stringify(value)===JSON.stringify([...new Set(value)].sort());
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const copy=value=>JSON.parse(JSON.stringify(value));
function initialState(){return {schema_version:1,sequence:0,last_observation:null,last_valid_codes:null,
 last_valid_snapshot_at:null,event:null,delivery_status:null};}
function validState(state){
 if(!own(state,['schema_version','sequence','last_observation','last_valid_codes','last_valid_snapshot_at','event','delivery_status'])
  ||state.schema_version!==1||!Number.isSafeInteger(state.sequence)||state.sequence<0)return false;
 const observed=state.last_observation,event=state.event;
 if(observed===null)return same(state,initialState());
 if(!own(observed,['health','issue_codes','checked_at'])||!KINDS.has(observed.health)||!iso(observed.checked_at))return false;
 if(observed.health==='monitor_read_failed'){
  if(!same(observed.issue_codes,['MONITOR_READ_FAILED']))return false;
 }else if(!codes(observed.issue_codes)||(observed.health==='healthy')!==(observed.issue_codes.length===0))return false;
 if(state.last_valid_codes===null){if(state.last_valid_snapshot_at!==null||observed.health!=='monitor_read_failed')return false;}
 else if(!codes(state.last_valid_codes)||!iso(state.last_valid_snapshot_at)
  ||Date.parse(state.last_valid_snapshot_at)>Date.parse(observed.checked_at)+60000
  ||(observed.health!=='monitor_read_failed'&&!same(state.last_valid_codes,observed.issue_codes)))return false;
 if(event===null)return state.sequence===0&&state.delivery_status===null&&observed.health==='healthy';
 return own(event,['id','scope','kind','checked_at','health','issue_codes','cleared_issue_codes','previous_delivery_confirmed'])
  &&event.id===state.sequence&&event.id>0&&event.scope===SCOPE&&EVENTS.has(event.kind)&&iso(event.checked_at)
  &&Date.parse(event.checked_at)<=Date.parse(observed.checked_at)&&event.health===observed.health
  &&same(event.issue_codes,observed.issue_codes)&&codes(event.cleared_issue_codes)
  &&typeof event.previous_delivery_confirmed==='boolean'&&STATUSES.has(state.delivery_status)
  &&(event.kind==='monitor_read_failed')===(event.health==='monitor_read_failed')
  &&(event.kind!=='recovery'||event.health==='healthy')
  &&(event.kind!=='anomaly'||event.health==='anomaly');
}
function blocked(code){return {configuration:CONFIG,dispatches:0,status:'blocked',issues:[code],candidate:null,state:null};}
function observation(snapshot,readSucceeded,now){
 if(!readSucceeded)return {health:'monitor_read_failed',issue_codes:['MONITOR_READ_FAILED']};
 try{
  const result=assess(snapshot,now);
  if(!Array.isArray(result.issues)||result.issues.some(code=>READ_CODES.has(code)||!BUSINESS_CODES.has(code)))
   return {health:'monitor_read_failed',issue_codes:['MONITOR_READ_FAILED']};
  return {health:result.ok?'healthy':'anomaly',issue_codes:[...new Set(result.issues)].sort()};
 }catch{return {health:'monitor_read_failed',issue_codes:['MONITOR_READ_FAILED']};}
}
function prepare(options={}){
 try{
  const {snapshot=null,read_succeeded=true,state=initialState(),now=Date.now()}=options;
  if(!Number.isSafeInteger(now)||now<0||!Number.isFinite(new Date(now).getTime()))return blocked('INVALID_CHECK_TIME');
  if(typeof read_succeeded!=='boolean')return blocked('INVALID_READ_STATUS');
  if(!validState(state))return blocked('NOTIFICATION_STATE_INVALID');
  if(state.last_observation&&now<Date.parse(state.last_observation.checked_at))return blocked('OUT_OF_ORDER_CHECK');
  const next=copy(state),observed=observation(snapshot,read_succeeded,now),checked_at=new Date(now).toISOString();
  // A stale or repeated pre-failure snapshot cannot prove that monitoring recovered.
  if(observed.health!=='monitor_read_failed'&&state.last_valid_snapshot_at!==null){
   const at=Date.parse(snapshot.observed_at),previous=Date.parse(state.last_valid_snapshot_at);
   if(at<previous||(at===previous&&(state.last_observation.health==='monitor_read_failed'
    ||!same(observed.issue_codes,state.last_valid_codes)))){
    observed.health='monitor_read_failed';observed.issue_codes=['MONITOR_READ_FAILED'];
   }
  }
  const previous=state.last_observation;
  const changed=!previous||previous.health!==observed.health||!same(previous.issue_codes,observed.issue_codes);
  if(changed&&!(previous===null&&observed.health==='healthy')){
   if(state.sequence===Number.MAX_SAFE_INTEGER)return blocked('NOTIFICATION_SEQUENCE_EXHAUSTED');
   let kind=observed.health==='monitor_read_failed'?'monitor_read_failed'
    :previous?.health==='monitor_read_failed'?'monitor_read_recovered'
    :observed.health==='healthy'?'recovery':'anomaly';
   next.sequence++;
   next.event={id:next.sequence,scope:SCOPE,kind,checked_at,health:observed.health,issue_codes:observed.issue_codes,
    cleared_issue_codes:observed.health==='monitor_read_failed'?[]:
     (state.last_valid_codes||[]).filter(code=>!observed.issue_codes.includes(code)),
    previous_delivery_confirmed:state.event!==null&&state.delivery_status==='confirmed'};
   next.delivery_status='prepared';
  }
  next.last_observation={...observed,checked_at};
  if(observed.health!=='monitor_read_failed'){
   next.last_valid_codes=observed.issue_codes;next.last_valid_snapshot_at=new Date(Date.parse(snapshot.observed_at)).toISOString();
  }
  return {configuration:CONFIG,dispatches:0,status:'disabled',issues:[],
   candidate:next.delivery_status==='prepared'?copy(next.event):null,state:next};
 }catch{return blocked('NOTIFICATION_INPUT_INVALID');}
}
// Bookkeeping primitives, not delivery. A claim must be durably stored before sending.
// Unfinished, failed and ambiguous attempts cannot be claimed again automatically.
function claimAttempt(state,eventId){
 try{
  if(!validState(state)||state.event?.id!==eventId||state.delivery_status!=='prepared')return null;
  return {...copy(state),delivery_status:'attempt_started'};
 }catch{return null;}
}
function settleAttempt(state,eventId,outcome){
 try{
  if(!validState(state)||state.event?.id!==eventId||state.delivery_status!=='attempt_started'
   ||!['confirmed','failed','unknown'].includes(outcome))return null;
  return {...copy(state),delivery_status:outcome};
 }catch{return null;}
}
if(require.main===module){
 let input='',tooLarge=false;
 process.stdin.setEncoding('utf8');
 process.stdin.on('data',chunk=>{if(!tooLarge){input+=chunk;if(input.length>65536){tooLarge=true;input='';}}});
 process.stdin.on('end',()=>{
  let result;
  if(tooLarge)result=blocked('INPUT_TOO_LARGE');
  else {
   try{
    const parsed=JSON.parse(input);
    // Options cannot enable dispatch, name a destination or control the runner's clock.
    if(!parsed||typeof parsed!=='object'||Array.isArray(parsed)
     ||Object.keys(parsed).some(key=>!['snapshot','state','read_succeeded'].includes(key)))result=blocked('INVALID_INPUT_FIELDS');
    else result=prepare(parsed);
   }catch{result=blocked('INVALID_JSON');}
  }
  process.stdout.write(JSON.stringify(result)+'\n');process.exitCode=result.status==='blocked'?2:0;
 });
}
module.exports={CONFIG,initialState,prepare,claimAttempt,settleAttempt};
