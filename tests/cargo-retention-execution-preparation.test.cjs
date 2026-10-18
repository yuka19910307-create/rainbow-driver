'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {assess,reviewText,exitCodeFor}=require('../scripts/check-cargo-retention-execution-preparation.cjs');
const now=Date.parse('2026-10-17T00:00:00Z'),observed_at=new Date(now).toISOString();
function fixture(){return {
 schema_version:1,scope:'cargo-retention-execution-preparation-input',
 inventory:{schema_version:1,scope:'cargo-retention-job-registration-inventory',observed_at,
  read_only_transaction:true,catalog_visibility_complete:true,visible_job_count:0,related_job_count:0,jobs:[]},
 preview:{schema_version:1,scope:'production-cargo-retention-preview',observed_at,batch_limit:100,
  drafts:{eligible:0,batch:0},closed:{eligible:0,batch:{requests:0,quotes:0,followups:0,events:0,consumed_source_drafts:0},
   protected:{held:0,unclosed_followup:0,unresolved_delivery:0}},
  existing_cleanup_jobs:{related:0,active:0,other_database:0},history:{application_runs:0,related_cron_runs:0}},
 monitor:{schema_version:1,scope:'production-cargo-prelaunch-hold',observed_at,
  control:{intake_enabled:false,captcha_required:true,contact_verification_required:true},
  mail_budget:{enabled:false,hour_attempts:0,day_attempts:0,hourly_limit:1,daily_limit:1},
  counts:{drafts:0,requests:0,quotes:0,followups:0,followup_events:0,retention_runs:0,
   delivery_unknown:0,sending_over_10m:0,drafts_overdue_15m:0,closed_cleanup_overdue_90m:0,held_closed_requests:0},
  customer_security:{tables_present:7,tables_rls_enabled:7,tables_client_access:0,
   functions_present:11,functions_missing:0,functions_unexpected:0,functions_security_definer:0,functions_client_execute:0},
  jobs:['cargo-production-expired-intake-drafts','cargo-production-closed-no-order-retention'].map(name=>({name,present:false}))}
};}
function job(overrides={}){return {jobid:1,canonical_name:'drafts',case_variant_name:false,targets:['drafts'],
 active:false,same_database:true,direct_batch_100_target:'drafts',schedule_kind:'cron_expression',schedule_equality_group:1,...overrides};}
function blocked(result){
 for(const key of ['preparation_complete','registration_allowed','execution_enabled','sql_generation_allowed',
  'project_identity_verified','shared_snapshot_verified'])assert.equal(result[key],false,key);
 assert.equal(result.review_only,true);assert.equal(exitCodeFor(result)===0,false);
}
test('empty registration-stage inventory preserves missing-job monitoring findings and all approval boundaries',()=>{
 const result=assess(fixture(),now);blocked(result);
 assert.equal(result.reviews.inventory.input_review_ok,true);assert.equal(result.reviews.preview.input_review_ok,true);
 assert.equal(result.reviews.monitor.input_review_ok,false);assert.equal(result.reviews.monitor.issues.length,2);
 assert.deepEqual(result.cross_evidence_issues,[]);
 for(const code of ['SCHEDULE_UNDECIDED','HISTORY_RETENTION_UNDECIDED'])assert(result.reviews.inventory.blockers.includes(code));
 for(const code of ['CLEANUP_DEPENDENCIES_REVIEW_REQUIRED','ATOMIC_REGISTRATION_UNIMPLEMENTED',
  'INITIAL_RUN_AND_BACKLOG_REVIEW_REQUIRED','REPEATED_BATCHES_UNAPPROVED','CRON_HISTORY_MAINTENANCE_UNIMPLEMENTED'])assert(result.blockers.includes(code));
});
test('matching stopped jobs remain blocked and are not interpreted as registration permission',()=>{
 const input=fixture();input.inventory.jobs=[job()];input.inventory.visible_job_count=1;input.inventory.related_job_count=1;
 input.preview.existing_cleanup_jobs.related=1;
 const result=assess(input,now);blocked(result);assert.deepEqual(result.cross_evidence_issues,[]);
 assert(result.reviews.inventory.blockers.includes('STOPPED_EXISTING_JOB_REVIEW_REQUIRED'));
 assert(result.reviews.preview.issues.includes('EXISTING_CLEANUP_JOB_REVIEW_REQUIRED'));
});
test('different related, active and database counts between individually valid sources stop review',()=>{
 for(const counts of [{related:2,active:0,other_database:0},
  {related:1,active:1,other_database:0},{related:1,active:0,other_database:1}]){
  const input=fixture();input.inventory.jobs=[job()];input.inventory.related_job_count=1;input.inventory.visible_job_count=1;
  input.preview.existing_cleanup_jobs=counts;
  const result=assess(input,now);blocked(result);
  assert(result.cross_evidence_issues.includes('JOB_EVIDENCE_COUNTS_MISMATCH'));
 }
});
test('preview counts cannot exceed monitor totals even if both inputs pass their own structural checks',()=>{
 for(const target of ['drafts','closed']){
  const input=fixture();input.preview[target].eligible=1;
  if(target==='drafts')input.preview.drafts.batch=1;else input.preview.closed.batch.requests=1;
  const result=assess(input,now);blocked(result);assert(result.cross_evidence_issues.includes('PREVIEW_EXCEEDS_MONITORED_DATA'));
 }
});
test('application retention-history discrepancies are distinct from consultation retention policy',()=>{
 const input=fixture();input.preview.history.application_runs=1;
 const result=assess(input,now);blocked(result);assert(result.cross_evidence_issues.includes('RETENTION_HISTORY_EVIDENCE_MISMATCH'));
});
test('freshness, catalog visibility and readonly failures are delegated without rewriting evidence',()=>{
 for(const [section,mutate,code] of [
  ['inventory',p=>p.read_only_transaction=false,'READ_ONLY_INVENTORY_REQUIRED'],
  ['inventory',p=>p.catalog_visibility_complete=false,'COMPLETE_CATALOG_VISIBILITY_REQUIRED'],
  ['inventory',p=>p.observed_at=new Date(now-300001).toISOString(),'STALE_OR_INVALID_JOB_INVENTORY'],
  ['preview',p=>p.observed_at=new Date(now-300001).toISOString(),'STALE_OR_INVALID_RETENTION_PREVIEW'],
  ['monitor',p=>p.observed_at=new Date(now+60001).toISOString(),'STALE_OR_INVALID_SNAPSHOT']]){
  const input=fixture();mutate(input[section]);const result=assess(input,now);blocked(result);
  assert(result.reviews[section].issues.includes(code));assert(result.blockers.includes('INPUT_EVIDENCE_REVIEW_REQUIRED'));
 }
});
test('intake, mail and permission warnings stay visible rather than being normalized for cleanup',()=>{
 for(const [mutate,code] of [
  [input=>input.monitor.control.intake_enabled=true,'PRODUCTION_INTAKE_NOT_OFF'],
  [input=>input.monitor.mail_budget.enabled=true,'PRODUCTION_MAIL_NOT_DISABLED'],
  [input=>input.monitor.customer_security.tables_client_access=1,'CUSTOMER_ACCESS_PROTECTION_CHANGED']]){
  const input=fixture();mutate(input);const result=assess(input,now);blocked(result);assert(result.reviews.monitor.issues.includes(code));
 }
});
test('source claims never prove common project, snapshot or additional execution settings',()=>{
 const input=fixture();input.project_independently_confirmed=true;input.same_snapshot=true;
 input.registration_allowed=true;input.execution_enabled=true;input.schedule='synthetic-private-secret';input.history_days=1;
 const result=assess(input,now);blocked(result);assert(!JSON.stringify(result).includes('synthetic-private-secret'));
 assert(result.blockers.includes('INDEPENDENT_PROJECT_CONFIRMATION_REQUIRED'));
 assert(result.blockers.includes('SAME_READ_ONLY_SNAPSHOT_CONFIRMATION_REQUIRED'));
});
test('missing, malformed or non-object sources fail closed without raw source values',()=>{
 for(const input of [null,{},7,'synthetic-private-secret',...['inventory','preview','monitor'].map(section=>{
  const input=fixture();input[section]=null;return input;
 })]){
  const result=assess(input,now);blocked(result);assert(!JSON.stringify(result).includes('synthetic-private-secret'));
 }
});
test('text boundary rejects malformed and excessive multibyte input using fixed errors',()=>{
 for(const [input,code] of [['{"secret":"synthetic-private-secret"','INVALID_JSON'],
  [JSON.stringify({secret:'あ'.repeat(140000)}),'INPUT_TOO_LARGE']]){
  const result=reviewText(input,now);blocked(result);assert(result.cross_evidence_issues.includes(code));
  assert.equal(exitCodeFor(result),2);assert(!JSON.stringify(result).includes('synthetic-private-secret'));
 }
 const result=reviewText(JSON.stringify(fixture()),now);blocked(result);assert.equal(exitCodeFor(result),1);
});
