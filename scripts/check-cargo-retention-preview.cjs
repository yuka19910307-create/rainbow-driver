// Offline review of aggregate counts only. Never connects, schedules or deletes.
'use strict';
const natural=value=>Number.isSafeInteger(value)&&value>=0;
function assess(snapshot,now=Date.now()){
 const result={ok:false,review_only:true,execution_enabled:false,issues:[]};
 if(!snapshot||snapshot.schema_version!==1||snapshot.scope!=='production-cargo-retention-preview'
  ||snapshot.batch_limit!==100){result.issues.push('INVALID_RETENTION_PREVIEW');return result;}
 const stamp=typeof snapshot.observed_at==='string'?Date.parse(snapshot.observed_at):NaN;
 if(!Number.isFinite(now)||!Number.isFinite(stamp)||stamp>now+60000||stamp<now-300000)result.issues.push('STALE_OR_INVALID_RETENTION_PREVIEW');
 const drafts=snapshot.drafts,closed=snapshot.closed,jobs=snapshot.existing_cleanup_jobs,history=snapshot.history;
 if(!drafts||!natural(drafts.eligible)||!natural(drafts.batch)||drafts.batch!==Math.min(100,drafts.eligible))result.issues.push('INVALID_DRAFT_COUNTS');
 if(!closed||!natural(closed.eligible)||!closed.batch
  ||['requests','quotes','followups','events','consumed_source_drafts'].some(k=>!natural(closed.batch[k]))
  ||closed.batch.requests!==Math.min(100,closed.eligible)
  ||['quotes','followups','consumed_source_drafts'].some(k=>closed.batch[k]>closed.batch.requests)
  ||!closed.protected||['held','unclosed_followup','unresolved_delivery'].some(k=>!natural(closed.protected[k])))result.issues.push('INVALID_CLOSED_COUNTS');
 if(!jobs||['related','active','other_database'].some(k=>!natural(jobs[k]))
  ||jobs.active>jobs.related||jobs.other_database>jobs.related)result.issues.push('INVALID_CLEANUP_JOB_COUNTS');
 else if(jobs.related>0)result.issues.push('EXISTING_CLEANUP_JOB_REVIEW_REQUIRED');
 if(!history||['application_runs','related_cron_runs'].some(k=>!natural(history[k])))result.issues.push('INVALID_RETENTION_HISTORY_COUNTS');
 result.ok=result.issues.length===0;
 return result;
}
if(require.main===module){
 let input='',tooLarge=false;
 process.stdin.setEncoding('utf8');
 process.stdin.on('data',chunk=>{if(!tooLarge){input+=chunk;if(input.length>65536){tooLarge=true;input='';}}});
 process.stdin.on('end',()=>{
  let result;
  if(tooLarge)result={ok:false,review_only:true,execution_enabled:false,issues:['INPUT_TOO_LARGE']};
  else {try{result=assess(JSON.parse(input));}catch{result={ok:false,review_only:true,execution_enabled:false,issues:['INVALID_JSON']};}}
  process.stdout.write(JSON.stringify(result)+'\n');
  process.exitCode=tooLarge||result.issues.includes('INVALID_JSON')?2:result.ok?0:1;
 });
}
module.exports={assess};
