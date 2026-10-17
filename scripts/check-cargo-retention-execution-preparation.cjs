// Offline evidence bundle only. No SQL generator, connection, cron or cleanup.
'use strict';
const {assess:assessInventory}=require('./check-cargo-retention-job-registration.cjs');
const {assess:assessPreview}=require('./check-cargo-retention-preview.cjs');
const {assess:assessMonitor}=require('./check-cargo-production-monitor.cjs');
const MAX_INPUT_BYTES=393216;
const blockers=[
 'REGISTRATION_DISABLED','EXECUTION_DISABLED','SQL_GENERATION_DISABLED',
 'INDEPENDENT_PROJECT_CONFIRMATION_REQUIRED','SAME_READ_ONLY_SNAPSHOT_CONFIRMATION_REQUIRED',
 'CLEANUP_DEPENDENCIES_REVIEW_REQUIRED','INDIRECT_JOB_AUDIT_REQUIRED',
 'ATOMIC_REGISTRATION_UNIMPLEMENTED','SCHEDULE_APPROVAL_REQUIRED',
 'APPLICATION_HISTORY_RETENTION_APPROVAL_REQUIRED','CRON_HISTORY_RETENTION_APPROVAL_REQUIRED',
 'EXECUTION_OPERATOR_APPROVAL_REQUIRED','INITIAL_RUN_AND_BACKLOG_REVIEW_REQUIRED',
 'REPEATED_BATCHES_UNAPPROVED','CRON_HISTORY_MAINTENANCE_UNIMPLEMENTED'
];
function blank(){return {
 schema_version:1,scope:'cargo-retention-execution-preparation-review',review_only:true,
 preparation_complete:false,registration_allowed:false,execution_enabled:false,
 sql_generation_allowed:false,project_identity_verified:false,shared_snapshot_verified:false,
 reviews:null,cross_evidence_issues:[],blockers:[...blockers]
};}
function fail(code){const result=blank();result.cross_evidence_issues.push(code);return result;}
function assess(bundle,now=Date.now()){
 if(!bundle||bundle.schema_version!==1||bundle.scope!=='cargo-retention-execution-preparation-input')return fail('INVALID_PREPARATION_INPUT');
 const result=blank();
 // Reuse all existing freshness, OFF, permissions, 100-row and catalog checks.
 // In particular, the existing disabled plan is loaded by assessInventory.
 let inventory,preview,monitor;
 try {
  inventory=assessInventory(bundle.inventory,now);
  preview=assessPreview(bundle.preview,now);
  monitor=assessMonitor(bundle.monitor,now);
 } catch {return fail('EVIDENCE_REVIEW_FAILED');}
 result.reviews={
  inventory:{input_review_ok:inventory.inventory_valid,issues:inventory.issues,blockers:inventory.blockers},
  preview:{input_review_ok:preview.ok,issues:preview.issues},
  monitor:{input_review_ok:monitor.ok,issues:monitor.issues}
 };
 // An existing job is a preview review blocker, not a malformed count set.
 const previewCountsReviewed=preview.ok||preview.issues.length===1
  &&preview.issues[0]==='EXISTING_CLEANUP_JOB_REVIEW_REQUIRED';
 if(inventory.inventory_valid&&previewCountsReviewed){
  const jobs=bundle.inventory.jobs,counts=bundle.preview.existing_cleanup_jobs;
  if(counts.related!==bundle.inventory.related_job_count
   ||counts.active!==jobs.filter(job=>job.active).length
   ||counts.other_database!==jobs.filter(job=>!job.same_database).length){
   result.cross_evidence_issues.push('JOB_EVIDENCE_COUNTS_MISMATCH');
  }
 }
 const monitorCountsReviewed=!monitor.issues.some(code=>code==='INVALID_SNAPSHOT'||code==='INVALID_COUNTS');
 if(previewCountsReviewed&&monitorCountsReviewed){
  if(bundle.preview.drafts.eligible>bundle.monitor.counts.drafts
   ||bundle.preview.closed.eligible>bundle.monitor.counts.requests){
   result.cross_evidence_issues.push('PREVIEW_EXCEEDS_MONITORED_DATA');
  }
  if(bundle.preview.history.application_runs!==bundle.monitor.counts.retention_runs){
   result.cross_evidence_issues.push('RETENTION_HISTORY_EVIDENCE_MISMATCH');
  }
 }
 if(!inventory.inventory_valid||!preview.ok||!monitor.ok||result.cross_evidence_issues.length){
  result.blockers.push('INPUT_EVIDENCE_REVIEW_REQUIRED');
 }
 // Even matching, fresh observations cannot prove their source or authorize work.
 return result;
}
function reviewText(input,now=Date.now()){
 if(typeof input!=='string')return fail('INVALID_JSON');
 if(Buffer.byteLength(input,'utf8')>MAX_INPUT_BYTES)return fail('INPUT_TOO_LARGE');
 try{return assess(JSON.parse(input),now);}catch{return fail('INVALID_JSON');}
}
function exitCodeFor(result){
 return result.cross_evidence_issues.some(code=>[
  'INVALID_JSON','INPUT_TOO_LARGE','INPUT_READ_FAILED','EVIDENCE_REVIEW_FAILED'
 ].includes(code))?2:1;
}
if(require.main===module){
 let input='',bytes=0,tooLarge=false,finished=false;
 const finish=result=>{if(finished)return;finished=true;process.stdout.write(JSON.stringify(result)+'\n');process.exitCode=exitCodeFor(result);};
 process.stdin.setEncoding('utf8');
 process.stdin.on('data',chunk=>{
  if(tooLarge)return;
  bytes+=Buffer.byteLength(chunk,'utf8');
  if(bytes>MAX_INPUT_BYTES){tooLarge=true;input='';}else input+=chunk;
 });
 process.stdin.on('end',()=>finish(tooLarge?fail('INPUT_TOO_LARGE'):reviewText(input)));
 process.stdin.on('error',()=>finish(fail('INPUT_READ_FAILED')));
}
module.exports={assess,reviewText,exitCodeFor};
