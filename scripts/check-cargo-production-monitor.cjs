// Offline classifier for the production prelaunch HOLD, not permission to open intake.
// No network, credentials, database connection, notification, cleanup or repair.
'use strict';
const JOBS=new Map([
 ['cargo-production-expired-intake-drafts',1200],
 ['cargo-production-closed-no-order-retention',5400]
]);
const DATA_COUNTS=['drafts','requests','quotes','followups','followup_events'];
const COUNTS=[...DATA_COUNTS,'retention_runs','delivery_unknown','sending_over_10m',
 'drafts_overdue_15m','closed_cleanup_overdue_90m','held_closed_requests'];
const SECURITY_COUNTS=['tables_present','tables_rls_enabled','tables_client_access',
 'functions_present','functions_missing','functions_unexpected','functions_security_definer','functions_client_execute'];
const natural=value=>Number.isSafeInteger(value)&&value>=0;
const stamp=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))?Date.parse(value):NaN;
function assess(snapshot,now=Date.now()){
 const issues=[];
 if(!snapshot||snapshot.schema_version!==1||snapshot.scope!=='production-cargo-prelaunch-hold')return {ok:false,issues:['INVALID_SNAPSHOT']};
 const observed=stamp(snapshot.observed_at);
 if(!Number.isFinite(now)||!Number.isFinite(observed)||observed>now+60000||observed<now-300000)issues.push('STALE_OR_INVALID_SNAPSHOT');
 const control=snapshot.control,budget=snapshot.mail_budget,counts=snapshot.counts,security=snapshot.customer_security;
 if(!control||['intake_enabled','captcha_required','contact_verification_required'].some(k=>typeof control[k]!=='boolean'))issues.push('INVALID_CONTROL');
 else {
  if(control.intake_enabled)issues.push('PRODUCTION_INTAKE_NOT_OFF');
  if(!control.captcha_required||!control.contact_verification_required)issues.push('REQUIRED_PROTECTION_DISABLED');
 }
 if(!budget||typeof budget.enabled!=='boolean'||!natural(budget.hour_attempts)||!natural(budget.day_attempts)
  ||!Number.isSafeInteger(budget.hourly_limit)||budget.hourly_limit<1||budget.hourly_limit>1000
  ||!Number.isSafeInteger(budget.daily_limit)||budget.daily_limit<budget.hourly_limit||budget.daily_limit>10000)issues.push('INVALID_MAIL_BUDGET');
 else {
  if(budget.enabled)issues.push('PRODUCTION_MAIL_NOT_DISABLED');
  // Do not reset these counters: they are attempt counters, not provider delivery proof.
  if(budget.hour_attempts||budget.day_attempts)issues.push('UNEXPECTED_MAIL_ATTEMPTS');
 }
 if(!counts||COUNTS.some(k=>!natural(counts[k])))issues.push('INVALID_COUNTS');
 else {
  if(DATA_COUNTS.some(k=>counts[k]>0))issues.push('UNEXPECTED_CUSTOMER_DATA');
  for(const [key,code] of Object.entries({delivery_unknown:'QUOTE_DELIVERY_UNKNOWN',sending_over_10m:'QUOTE_SEND_STALLED',
   drafts_overdue_15m:'DRAFT_CLEANUP_BACKLOG',closed_cleanup_overdue_90m:'CLOSED_RETENTION_BACKLOG'}))if(counts[key])issues.push(code);
 }
 if(!security||SECURITY_COUNTS.some(k=>!natural(security[k])))issues.push('INVALID_CUSTOMER_SECURITY');
 else {
  if(security.tables_present!==7||security.functions_present!==11||security.functions_missing||security.functions_unexpected)issues.push('CUSTOMER_SCHEMA_DRIFT');
  if(security.tables_rls_enabled!==7||security.tables_client_access||security.functions_security_definer||security.functions_client_execute)issues.push('CUSTOMER_ACCESS_PROTECTION_CHANGED');
 }
 if(!Array.isArray(snapshot.jobs)||snapshot.jobs.length!==JOBS.size)issues.push('INVALID_JOB_SET');
 else {
  const seen=new Set();
  for(const job of snapshot.jobs){
   if(!job||!JOBS.has(job.name)||seen.has(job.name)){issues.push('INVALID_JOB_SET');continue;}
   seen.add(job.name);
   const prefix=job.name.replace('cargo-production-','').toUpperCase().replaceAll('-','_');
   if(['present','active','schedule_matches','command_matches','database_matches'].some(k=>job[k]!==true)
    ||job.max_age_seconds!==JOBS.get(job.name)){issues.push(prefix+'_CONFIG');continue;}
   const success=stamp(job.last_success),failure=job.last_failure===null?null:stamp(job.last_failure);
   if(!Number.isFinite(success)||success>observed+60000||observed-success>JOBS.get(job.name)*1000)issues.push(prefix+'_STALE');
   if(failure!==null&&(!Number.isFinite(failure)||failure>observed+60000))issues.push(prefix+'_INVALID_HISTORY');
   // Equal timestamps cannot prove which outcome was later; require review.
   else if(failure!==null&&(!Number.isFinite(success)||failure>=success))issues.push(prefix+'_FAILED');
  }
 }
 return {ok:issues.length===0,issues:[...new Set(issues)]};
}
if(require.main===module){
 let input='',tooLarge=false;
 process.stdin.setEncoding('utf8');
 process.stdin.on('data',chunk=>{if(!tooLarge){input+=chunk;if(input.length>65536){tooLarge=true;input='';}}});
 process.stdin.on('end',()=>{
  if(tooLarge){process.stdout.write('{"ok":false,"issues":["INPUT_TOO_LARGE"]}\n');process.exitCode=2;return;}
  try{const result=assess(JSON.parse(input));process.stdout.write(JSON.stringify(result)+'\n');process.exitCode=result.ok?0:1;}
  catch{process.stdout.write('{"ok":false,"issues":["INVALID_JSON"]}\n');process.exitCode=2;}
 });
}
module.exports={assess};
