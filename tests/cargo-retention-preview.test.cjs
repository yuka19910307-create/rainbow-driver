'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{spawnSync}=require('node:child_process');
const {assess}=require('../scripts/check-cargo-retention-preview.cjs');
const now=Date.parse('2026-10-17T00:00:00Z');
function fixture(){return {schema_version:1,scope:'production-cargo-retention-preview',observed_at:new Date(now).toISOString(),batch_limit:100,
 drafts:{eligible:101,batch:100},closed:{eligible:2,batch:{requests:2,quotes:1,followups:1,events:4,consumed_source_drafts:1},protected:{held:3,unclosed_followup:1,unresolved_delivery:1}},
 existing_cleanup_jobs:{related:0,active:0,other_database:0},history:{application_runs:0,related_cron_runs:0}};}
test('valid counts never authorize execution and expose no input fields',()=>{
 const value=fixture();value.private='synthetic-private-secret';
 assert.deepEqual(assess(value,now),{ok:true,review_only:true,execution_enabled:false,issues:[]});
});
test('stale, future and invalid time are rejected',()=>{
 for(const stamp of [now-300001,now+60001,NaN]){
  const value=fixture();value.observed_at=Number.isNaN(stamp)?'bad':new Date(stamp).toISOString();
  assert(assess(value,now).issues.includes('STALE_OR_INVALID_RETENTION_PREVIEW'));
 }
});
test('invalid schema, batch size, related counts and unsafe integers fail closed',()=>{
 for(const mutate of [v=>v.batch_limit=101,v=>v.drafts.batch=101,v=>v.closed.batch.requests=1,
  v=>v.closed.batch.quotes=3,v=>v.closed.batch.events=-1,v=>v.closed.protected.held=null,
  v=>v.history.application_runs=Number.MAX_SAFE_INTEGER+1,v=>v.existing_cleanup_jobs.active=1]){
  const value=fixture();mutate(value);assert.equal(assess(value,now).ok,false);
 }
});
test('existing jobs, including inactive or other database, require review',()=>{
 for(const jobs of [{related:1,active:0,other_database:0},{related:3,active:2,other_database:1}]){
  const value=fixture();value.existing_cleanup_jobs=jobs;
  assert(assess(value,now).issues.includes('EXISTING_CLEANUP_JOB_REVIEW_REQUIRED'));
 }
});
test('CLI reports only fixed results, bounds input and never echoes secrets',()=>{
 for(const [input,status,code] of [['{"private":"synthetic-private-secret"',2,'INVALID_JSON'],['synthetic-private-secret'.repeat(5000),2,'INPUT_TOO_LARGE']]){
  const r=spawnSync(process.execPath,['scripts/check-cargo-retention-preview.cjs'],{input,encoding:'utf8'});
  assert.ifError(r.error);
  assert.equal(r.status,status);assert(JSON.parse(r.stdout).issues.includes(code));
  assert(!r.stdout.includes('synthetic-private-secret'));assert.equal(r.stderr,'');
 }
});
