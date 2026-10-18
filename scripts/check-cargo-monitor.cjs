// Read-only offline classifier. Input is one sanitized staging SQL snapshot.
// No network, credentials, mail, DB connection, retries or automatic repair.
'use strict';
const JOBS=new Map([
 ['cargo-staging-expired-intake-drafts',1200],
 ['cargo-staging-closed-no-order-retention',5400],
 ['cargo-staging-owner-mail-trial-expire',300]
]);
const COUNTS=['delivery_unknown','sending_over_10m','drafts_overdue_15m','expired_trials_enabled_2m','active_owner_trials'];
function assess(snapshot,now=Date.now()){
 const issues=[];
 const issue=(code)=>issues.push(code);
 const stamp=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))?Date.parse(value):NaN;
 if(!snapshot||snapshot.schema_version!==1||snapshot.scope!=='staging-cargo-monitor')return {ok:false,issues:['INVALID_SNAPSHOT']};
 const observed=stamp(snapshot.observed_at);
 if(!Number.isFinite(observed)||observed>now+60000||observed<now-5*60000)issue('STALE_OR_INVALID_SNAPSHOT');
 const control=snapshot.control,counts=snapshot.counts;
 if(!control||['intake_enabled','captcha_required','contact_verification_required'].some(k=>typeof control[k]!=='boolean'))issue('INVALID_CONTROL');
 else if(!control.captcha_required||!control.contact_verification_required)issue('REQUIRED_PROTECTION_DISABLED');
 if(!counts||COUNTS.some(k=>!Number.isSafeInteger(counts[k])||counts[k]<0))issue('INVALID_COUNTS');
 else {
  if(counts.delivery_unknown)issue('QUOTE_DELIVERY_UNKNOWN');
  if(counts.sending_over_10m)issue('QUOTE_SEND_STALLED');
  if(counts.drafts_overdue_15m)issue('DRAFT_CLEANUP_BACKLOG');
  if(counts.expired_trials_enabled_2m)issue('TRIAL_EXPIRY_STALLED');
  if(control?.intake_enabled===true&&counts.active_owner_trials!==1)issue('INTAKE_ON_WITHOUT_SINGLE_ACTIVE_TRIAL');
 }
 if(!Array.isArray(snapshot.jobs)||snapshot.jobs.length!==JOBS.size)issue('INVALID_JOB_SET');
 else {
  const seen=new Set();
  for(const j of snapshot.jobs){
   if(!j||!JOBS.has(j.name)||seen.has(j.name)){issue('INVALID_JOB_SET');continue;}
   seen.add(j.name);
   const prefix=j.name.replace('cargo-staging-','').toUpperCase().replaceAll('-','_');
   if(j.present!==true||j.active!==true||j.schedule_matches!==true||j.max_age_seconds!==JOBS.get(j.name)){issue(prefix+'_CONFIG');continue;}
   const success=stamp(j.last_success),failure=j.last_failure===null?null:stamp(j.last_failure);
   if(!Number.isFinite(success)||success>observed+60000||observed-success>JOBS.get(j.name)*1000)issue(prefix+'_STALE');
   if(failure!==null&&(!Number.isFinite(failure)||failure>observed+60000))issue(prefix+'_INVALID_HISTORY');
   else if(failure!==null&&(!Number.isFinite(success)||failure>success))issue(prefix+'_FAILED');
  }
 }
 return {ok:issues.length===0,issues:[...new Set(issues)]};
}
if(require.main===module){
 let input='';
 process.stdin.setEncoding('utf8');
 process.stdin.on('data',chunk=>{input+=chunk;if(input.length>65536){process.stdout.write('{"ok":false,"issues":["INPUT_TOO_LARGE"]}\n');process.exit(2)}});
 process.stdin.on('end',()=>{
  try{const result=assess(JSON.parse(input));console.log(JSON.stringify(result));process.exitCode=result.ok?0:1;}
  catch{console.log('{"ok":false,"issues":["INVALID_JSON"]}');process.exitCode=2;}
 });
}
module.exports={assess};
