// Offline preparation only. This does not authenticate a user or grant any trial permission.
// Reads a supplied monitoring snapshot; never connects, writes, starts a trial or sends mail.
'use strict';
const DECISIONS=Object.freeze(['owner_account_id','planned_start_at','window_seconds',
 'total_mail_attempt_limit','otp_mail_attempt_limit','quote_mail_attempt_limit',
 'fixture_request','quote_amount_yen','quote_terms','execution_approval']);
const POLICY_KEYS=Object.freeze(['schema_version','scope','enabled',...DECISIONS]);
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const natural=value=>Number.isSafeInteger(value)&&value>=0;
const blocked=issues=>({execution_allowed:false,issues:[...new Set(issues)]});
function assess(snapshot,policy,now=Date.now()){
 const issues=[];
 if(!object(snapshot)||snapshot.schema_version!==1||snapshot.scope!=='production-cargo-prelaunch-hold'){
  issues.push('INVALID_SNAPSHOT');
 }else{
  const observed=typeof snapshot.observed_at==='string'?Date.parse(snapshot.observed_at):NaN;
  if(!Number.isFinite(now)||!Number.isFinite(observed)||observed>now+60000||observed<now-300000)
   issues.push('STALE_OR_INVALID_SNAPSHOT');
  const control=snapshot.control,budget=snapshot.mail_budget;
  if(!object(control)||['intake_enabled','captcha_required','contact_verification_required'].some(k=>typeof control[k]!=='boolean'))
   issues.push('INVALID_CONTROL');
  else{
   if(control.intake_enabled!==false)issues.push('PRODUCTION_INTAKE_NOT_OFF');
   if(control.captcha_required!==true||control.contact_verification_required!==true)
    issues.push('REQUIRED_PROTECTION_DISABLED');
  }
  if(!object(budget)||typeof budget.enabled!=='boolean'||!natural(budget.hour_attempts)||!natural(budget.day_attempts))
   issues.push('INVALID_MAIL_BUDGET');
  else{
   if(budget.enabled!==false)issues.push('PRODUCTION_MAIL_NOT_DISABLED');
   if(budget.hour_attempts!==0||budget.day_attempts!==0)issues.push('UNEXPECTED_MAIL_ATTEMPTS');
  }
 }
 if(!object(policy)||Object.keys(policy).length!==POLICY_KEYS.length||
    POLICY_KEYS.some(key=>!Object.hasOwn(policy,key))||policy.schema_version!==1||
    policy.scope!=='production-cargo-owner-trial-preparation'||typeof policy.enabled!=='boolean'){
  issues.push('INVALID_TRIAL_POLICY');
 }else{
  issues.push(policy.enabled===false?'TRIAL_POLICY_DISABLED':'TRIAL_POLICY_NOT_DISABLED');
  // Any value here is outside this disabled preparation contract. It is never an approval.
  issues.push(DECISIONS.every(key=>policy[key]===null)?'TRIAL_DECISIONS_UNSET':'TRIAL_POLICY_UNAPPROVED_VALUES');
 }
 // Unconditional blockers: even a plausible snapshot and filled-in policy cannot permit execution.
 issues.push('TRIAL_SERVER_AUTH_NOT_IMPLEMENTED','TRIAL_LIFECYCLE_GUARDS_NOT_IMPLEMENTED',
  'TRIAL_SEND_GUARDS_NOT_IMPLEMENTED','TRIAL_API_RPC_PATH_NOT_IMPLEMENTED','TRIAL_EXECUTION_NOT_AUTHORIZED');
 return blocked(issues);
}
if(require.main===module){
 let input='',tooLarge=false;
 process.stdin.setEncoding('utf8');
 process.stdin.on('data',chunk=>{if(!tooLarge){input+=chunk;if(input.length>65536){tooLarge=true;input='';}}});
 const fail=code=>{process.stdout.write(JSON.stringify(blocked([code]))+'\n');process.exitCode=2;};
 process.stdin.on('error',()=>{fail('INPUT_READ_FAILED');});
 process.stdin.on('end',()=>{
  if(tooLarge){fail('INPUT_TOO_LARGE');return;}
  let snapshot,policy;
  try{snapshot=JSON.parse(input);}catch{fail('INVALID_JSON');return;}
  try{policy=JSON.parse(require('node:fs').readFileSync(require('node:path').join(__dirname,
   '../integrations/cargo-safety-preparation/production-trial-policy.disabled.json'),'utf8'));}
  catch{fail('DISABLED_POLICY_UNAVAILABLE');return;}
  process.stdout.write(JSON.stringify(assess(snapshot,policy))+'\n');
  // A valid local diagnostic remains blocked; exit 0 must never suggest launch readiness.
  process.exitCode=1;
 });
}
module.exports={assess};
