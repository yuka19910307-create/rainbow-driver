// Pure, offline preflight. No connection, registration, enable or cleanup path.
'use strict';
const {isDeepStrictEqual}=require('node:util');
const plan=require('../integrations/cargo-retention-job-guard/plan.disabled.json');
// This independent contract detects an edited plan, including default values.
const disabledContract={schema_version:1,scope:'cargo-retention-job-registration-plan',
 enabled:false,registration_allowed:false,schedule:null,
 history_retention:{application_days:null,cron_days:null},jobs:[
  {target:'drafts',name:'cargo-production-expired-intake-drafts',batch_limit:100},
  {target:'closed',name:'cargo-production-closed-no-order-retention',batch_limit:100}]};
const natural=v=>Number.isSafeInteger(v)&&v>=0;
const target=v=>v==='drafts'||v==='closed';
function assess(snapshot,now=Date.now(),candidatePlan=plan){
 const result={review_only:true,registration_allowed:false,execution_enabled:false,
  inventory_valid:false,issues:[],blockers:[]};
 const add=code=>{if(!result.blockers.includes(code))result.blockers.push(code);};
 // Even a valid snapshot and untouched plan can never grant permission.
 ['REGISTRATION_DISABLED','REGISTRATION_IMPLEMENTATION_ABSENT',
  'SCHEDULE_UNDECIDED','HISTORY_RETENTION_UNDECIDED',
  'INDEPENDENT_PROJECT_CONFIRMATION_REQUIRED','INDIRECT_JOB_AUDIT_REQUIRED'].forEach(add);
 if(!isDeepStrictEqual(candidatePlan,disabledContract))result.issues.push('DISABLED_PLAN_MISMATCH');
 if(!snapshot||snapshot.schema_version!==1||snapshot.scope!=='cargo-retention-job-registration-inventory'){
  result.issues.push('INVALID_JOB_INVENTORY');return result;
 }
 const stamp=typeof snapshot.observed_at==='string'?Date.parse(snapshot.observed_at):NaN;
 if(!Number.isFinite(now)||!Number.isFinite(stamp)||stamp>now+60000||stamp<now-300000)result.issues.push('STALE_OR_INVALID_JOB_INVENTORY');
 if(snapshot.read_only_transaction!==true)result.issues.push('READ_ONLY_INVENTORY_REQUIRED');
 if(snapshot.catalog_visibility_complete!==true)result.issues.push('COMPLETE_CATALOG_VISIBILITY_REQUIRED');
 if(!natural(snapshot.visible_job_count)||!natural(snapshot.related_job_count)
  ||snapshot.related_job_count>snapshot.visible_job_count||!Array.isArray(snapshot.jobs)
  ||snapshot.jobs.length!==snapshot.related_job_count||snapshot.jobs.length>1000){
  result.issues.push('INVALID_JOB_INVENTORY_COUNTS');return result;
 }
 const ids=new Set(),names={drafts:0,closed:0},targets={drafts:0,closed:0};
 for(const job of snapshot.jobs){
  if(!job||!natural(job.jobid)||ids.has(job.jobid)
   ||!(job.canonical_name===null||target(job.canonical_name))
   ||typeof job.case_variant_name!=='boolean'||typeof job.active!=='boolean'
   ||typeof job.same_database!=='boolean'
   ||!(job.direct_batch_100_target===null||target(job.direct_batch_100_target))
   ||!Array.isArray(job.targets)||job.targets.length<1||job.targets.length>2
   ||job.targets.some(v=>!target(v))||new Set(job.targets).size!==job.targets.length
   ||!['second_interval','cron_expression','unrecognized'].includes(job.schedule_kind)
   ||!Number.isSafeInteger(job.schedule_equality_group)||job.schedule_equality_group<1
   ||job.schedule_equality_group>snapshot.related_job_count
   ||(job.canonical_name!==null&&!job.targets.includes(job.canonical_name))
   ||(job.direct_batch_100_target!==null&&!job.targets.includes(job.direct_batch_100_target))
   ||(job.canonical_name!==null&&job.case_variant_name)){
   result.issues.push('INVALID_JOB_INVENTORY_DETAIL');continue;
  }
  ids.add(job.jobid);
  if(job.canonical_name!==null)names[job.canonical_name]++;
  for(const name of job.targets)targets[name]++;
  add('EXISTING_CLEANUP_JOB_REVIEW_REQUIRED');
  add(job.active?'ACTIVE_EXISTING_JOB_REVIEW_REQUIRED':'STOPPED_EXISTING_JOB_REVIEW_REQUIRED');
  if(!job.same_database)add('OTHER_DATABASE_JOB_REVIEW_REQUIRED');
  if(job.canonical_name===null)add(job.case_variant_name?'CASE_VARIANT_JOB_NAME_REVIEW_REQUIRED':'ALIAS_JOB_REVIEW_REQUIRED');
  if(job.direct_batch_100_target===null
   ||(job.canonical_name!==null&&job.direct_batch_100_target!==job.canonical_name))add('JOB_COMMAND_REVIEW_REQUIRED');
  if(job.schedule_kind==='unrecognized')add('UNRECOGNIZED_JOB_SCHEDULE');
  add('EXISTING_SCHEDULE_VALUE_REVIEW_REQUIRED');
 }
 if(Object.values(names).some(n=>n>1))add('DUPLICATE_CANONICAL_JOB_NAME');
 if(Object.values(targets).some(n=>n>1))add('DUPLICATE_CLEANUP_TARGET');
 result.issues=[...new Set(result.issues)];
 result.inventory_valid=result.issues.length===0;
 return result;
}
function failure(code){return {review_only:true,registration_allowed:false,execution_enabled:false,inventory_valid:false,issues:[code],blockers:['REGISTRATION_DISABLED']};}
if(require.main===module){
 let input='',tooLarge=false;
 process.stdin.setEncoding('utf8');
 process.stdin.on('data',chunk=>{if(!tooLarge){input+=chunk;if(input.length>262144){tooLarge=true;input='';}}});
 process.stdin.on('end',()=>{
  let result;
  if(tooLarge)result=failure('INPUT_TOO_LARGE');
  else {try{result=assess(JSON.parse(input));}catch{result=failure('INVALID_JSON');}}
  process.stdout.write(JSON.stringify(result)+'\n');
  // A successful review remains blocked: a caller cannot use exit 0 to register.
  process.exitCode=tooLarge||result.issues.includes('INVALID_JSON')?2:1;
 });
 process.stdin.on('error',()=>{process.stdout.write(JSON.stringify(failure('INPUT_READ_FAILED'))+'\n');process.exitCode=2;});
}
module.exports={assess};
