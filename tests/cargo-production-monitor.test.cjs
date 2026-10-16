'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{spawnSync}=require('node:child_process');
const {assess}=require('../scripts/check-cargo-production-monitor.cjs');
const now=Date.parse('2026-10-16T16:00:00Z');
const fresh=()=>({schema_version:1,scope:'production-cargo-prelaunch-hold',observed_at:new Date(now).toISOString(),
 control:{intake_enabled:false,captcha_required:true,contact_verification_required:true},
 mail_budget:{enabled:false,hourly_limit:1,daily_limit:1,hour_attempts:0,day_attempts:0},
 counts:{drafts:0,requests:0,quotes:0,followups:0,followup_events:0,retention_runs:0,
  delivery_unknown:0,sending_over_10m:0,drafts_overdue_15m:0,closed_cleanup_overdue_90m:0,held_closed_requests:0},
 customer_security:{tables_present:7,tables_rls_enabled:7,tables_client_access:0,
  functions_present:11,functions_missing:0,functions_unexpected:0,functions_security_definer:0,functions_client_execute:0},
 jobs:[['expired-intake-drafts',1200],['closed-no-order-retention',5400]].map(([name,max_age_seconds])=>({
  name:'cargo-production-'+name,max_age_seconds,present:true,active:true,schedule_matches:true,command_matches:true,
  database_matches:true,last_success:new Date(now-60000).toISOString(),last_failure:null}))});
test('closed production baseline passes only with current successful proposed jobs',()=>{
 assert.deepEqual(assess(fresh(),now),{ok:true,issues:[]});
 const s=fresh();for(const job of s.jobs){job.present=false;job.active=false;job.last_success=null;}
 assert.deepEqual(assess(s,now),{ok:false,issues:['EXPIRED_INTAKE_DRAFTS_CONFIG','CLOSED_NO_ORDER_RETENTION_CONFIG']});
});
test('production intake, shared budget, attempts and new customer data are separate stop conditions',()=>{
 const cases=[
  [s=>s.control.intake_enabled=true,'PRODUCTION_INTAKE_NOT_OFF'],
  [s=>s.control.captcha_required=false,'REQUIRED_PROTECTION_DISABLED'],
  [s=>s.control.contact_verification_required=false,'REQUIRED_PROTECTION_DISABLED'],
  [s=>s.mail_budget.enabled=true,'PRODUCTION_MAIL_NOT_DISABLED'],
  [s=>s.mail_budget.hour_attempts=1,'UNEXPECTED_MAIL_ATTEMPTS'],
  [s=>s.mail_budget.day_attempts=1,'UNEXPECTED_MAIL_ATTEMPTS']
 ];
 for(const field of ['drafts','requests','quotes','followups','followup_events'])cases.push([s=>s.counts[field]=1,'UNEXPECTED_CUSTOMER_DATA']);
 for(const [mutate,code] of cases){const s=fresh();mutate(s);assert(assess(s,now).issues.includes(code),code);}
 const s=fresh();s.counts.retention_runs=10;assert.equal(assess(s,now).ok,true);
});
test('delivery ambiguity and overdue eligible cleanup require manual review',()=>{
 for(const [field,code] of Object.entries({delivery_unknown:'QUOTE_DELIVERY_UNKNOWN',sending_over_10m:'QUOTE_SEND_STALLED',
  drafts_overdue_15m:'DRAFT_CLEANUP_BACKLOG',closed_cleanup_overdue_90m:'CLOSED_RETENTION_BACKLOG'})){
  const s=fresh();s.counts[field]=1;assert(assess(s,now).issues.includes(code));
 }
});
test('staging, wrappers, stale snapshots and malformed fields fail closed',()=>{
 for(const s of [null,{},[fresh()],{cargo_production_monitor_snapshot:fresh()},
  {...fresh(),scope:'staging-cargo-monitor'}, {...fresh(),schema_version:2},
  {...fresh(),observed_at:new Date(now-300001).toISOString()},
  {...fresh(),observed_at:new Date(now+60001).toISOString()},
  {...fresh(),control:null},{...fresh(),counts:{}},{...fresh(),mail_budget:{}},{...fresh(),customer_security:{}}])assert.equal(assess(s,now).ok,false);
 for(const [area,key] of [['control','intake_enabled'],['mail_budget','enabled'],['mail_budget','hour_attempts'],['counts','drafts'],['customer_security','tables_present']]){
  const s=fresh();s[area][key]='0';assert.equal(assess(s,now).ok,false);
 }
 for(const [key,value] of [['hourly_limit',0],['hourly_limit',1001],['daily_limit',10001],['daily_limit',0],['day_attempts',-1],['hour_attempts',1.2]]){
  const s=fresh();s.mail_budget[key]=value;assert(assess(s,now).issues.includes('INVALID_MAIL_BUDGET'));
 }
 assert.equal(assess(fresh(),NaN).ok,false);
});
test('table, RLS and routine permission drift cannot be classified as healthy',()=>{
 for(const [key,value,code] of [
  ['tables_present',6,'CUSTOMER_SCHEMA_DRIFT'],['functions_present',12,'CUSTOMER_SCHEMA_DRIFT'],
  ['functions_missing',1,'CUSTOMER_SCHEMA_DRIFT'],['functions_unexpected',1,'CUSTOMER_SCHEMA_DRIFT'],
  ['tables_rls_enabled',6,'CUSTOMER_ACCESS_PROTECTION_CHANGED'],['tables_client_access',1,'CUSTOMER_ACCESS_PROTECTION_CHANGED'],
  ['functions_security_definer',1,'CUSTOMER_ACCESS_PROTECTION_CHANGED'],['functions_client_execute',1,'CUSTOMER_ACCESS_PROTECTION_CHANGED']]){
  const s=fresh();s.customer_security[key]=value;assert(assess(s,now).issues.includes(code));
 }
 const replaced=fresh();replaced.customer_security.functions_missing=1;replaced.customer_security.functions_unexpected=1;
 assert.equal(replaced.customer_security.functions_present,11);
 assert(assess(replaced,now).issues.includes('CUSTOMER_SCHEMA_DRIFT'));
});
test('job identity, schedule, command, database, age, failure and later recovery are checked',()=>{
 for(const mutate of [s=>s.jobs.pop(),s=>s.jobs.push(s.jobs[0]),s=>s.jobs[1]=s.jobs[0],s=>s.jobs[0].name='other',
  s=>s.jobs[0].max_age_seconds=999999,s=>s.jobs[0].last_success=null]){
  const s=fresh();mutate(s);assert.equal(assess(s,now).ok,false);
 }
 for(const key of ['present','active','schedule_matches','command_matches','database_matches']){
  const s=fresh();s.jobs[0][key]=false;assert(assess(s,now).issues.includes('EXPIRED_INTAKE_DRAFTS_CONFIG'));
 }
 const s=fresh();s.jobs[1].last_success=new Date(now-5400001).toISOString();assert(assess(s,now).issues.includes('CLOSED_NO_ORDER_RETENTION_STALE'));
 s.jobs[1].last_success=new Date(now+60001).toISOString();assert(assess(s,now).issues.includes('CLOSED_NO_ORDER_RETENTION_STALE'));
 s.jobs[1].last_success=new Date(now-60000).toISOString();
 for(const failure of ['invalid',new Date(now+60001).toISOString()]){
  s.jobs[1].last_failure=failure;assert(assess(s,now).issues.includes('CLOSED_NO_ORDER_RETENTION_INVALID_HISTORY'));
 }
 s.jobs[1].last_failure=s.jobs[1].last_success;assert(assess(s,now).issues.includes('CLOSED_NO_ORDER_RETENTION_FAILED'));
 s.jobs[1].last_success=new Date(now-10000).toISOString();assert.equal(assess(s,now).ok,true);
});
test('CLI emits only fixed issue codes, limits input and does not echo arbitrary text',()=>{
 const path=require.resolve('../scripts/check-cargo-production-monitor.cjs');
 for(const [input,code] of [['not-json synthetic-secret','INVALID_JSON'],['x'.repeat(65537),'INPUT_TOO_LARGE']]){
  const r=spawnSync(process.execPath,[path],{input,encoding:'utf8'});
  assert.equal(r.status,2);assert.deepEqual(JSON.parse(r.stdout),{ok:false,issues:[code]});assert.equal(r.stderr,'');
 }
 const s=fresh();s.observed_at=new Date().toISOString();s.private_value='synthetic-secret';s.counts.delivery_unknown=1;
 for(const job of s.jobs)job.last_success=s.observed_at;
 const r=spawnSync(process.execPath,[path],{input:JSON.stringify(s),encoding:'utf8'});
 assert.equal(r.status,1);assert.deepEqual(JSON.parse(r.stdout),{ok:false,issues:['QUOTE_DELIVERY_UNKNOWN']});assert.equal(r.stderr,'');
});
