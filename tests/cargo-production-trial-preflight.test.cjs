'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{spawnSync}=require('node:child_process');
const {assess}=require('../scripts/check-cargo-production-trial-preflight.cjs');
const template=require('../integrations/cargo-safety-preparation/production-trial-policy.disabled.json');
const now=Date.parse('2026-10-16T16:00:00Z');
const policy=()=>structuredClone(template);
const snapshot=()=>({schema_version:1,scope:'production-cargo-prelaunch-hold',observed_at:new Date(now).toISOString(),
 control:{intake_enabled:false,captcha_required:true,contact_verification_required:true},
 mail_budget:{enabled:false,hour_attempts:0,day_attempts:0}});
const IMPLEMENTATION_BLOCKERS=['TRIAL_SERVER_AUTH_NOT_IMPLEMENTED','TRIAL_LIFECYCLE_GUARDS_NOT_IMPLEMENTED',
 'TRIAL_SEND_GUARDS_NOT_IMPLEMENTED','TRIAL_API_RPC_PATH_NOT_IMPLEMENTED','TRIAL_EXECUTION_NOT_AUTHORIZED'];
test('shipped trial preparation has no operator decision defaults or permission to execute',()=>{
 const p=policy();assert.equal(p.enabled,false);
 for(const key of Object.keys(p).filter(k=>!['schema_version','scope','enabled'].includes(k)))assert.equal(p[key],null,key);
 assert.deepEqual(assess(snapshot(),p,now),{execution_allowed:false,
  issues:['TRIAL_POLICY_DISABLED','TRIAL_DECISIONS_UNSET',...IMPLEMENTATION_BLOCKERS]});
});
test('intake, required protection, mail stop and observed attempts are independent blockers',()=>{
 for(const [mutate,code] of [
  [s=>s.control.intake_enabled=true,'PRODUCTION_INTAKE_NOT_OFF'],
  [s=>s.control.captcha_required=false,'REQUIRED_PROTECTION_DISABLED'],
  [s=>s.control.contact_verification_required=false,'REQUIRED_PROTECTION_DISABLED'],
  [s=>s.mail_budget.enabled=true,'PRODUCTION_MAIL_NOT_DISABLED'],
  [s=>s.mail_budget.hour_attempts=1,'UNEXPECTED_MAIL_ATTEMPTS'],
  [s=>s.mail_budget.day_attempts=1,'UNEXPECTED_MAIL_ATTEMPTS']]){
  const s=snapshot();mutate(s);const result=assess(s,policy(),now);
  assert.equal(result.execution_allowed,false);assert(result.issues.includes(code),code);
 }
});
test('stale, future, staging and malformed snapshots cannot establish stopped production',()=>{
 for(const s of [null,[],{}, {cargo_production_monitor_snapshot:snapshot()},
  {...snapshot(),schema_version:2},{...snapshot(),scope:'staging-cargo-monitor'}])
  assert(assess(s,policy(),now).issues.includes('INVALID_SNAPSHOT'));
 for(const time of [null,'invalid',new Date(now-300001).toISOString(),new Date(now+60001).toISOString()])
  assert(assess({...snapshot(),observed_at:time},policy(),now).issues.includes('STALE_OR_INVALID_SNAPSHOT'));
 assert(assess(snapshot(),policy(),NaN).issues.includes('STALE_OR_INVALID_SNAPSHOT'));
 for(const control of [null,[],{}, {...snapshot().control,intake_enabled:'false'}])
  assert(assess({...snapshot(),control},policy(),now).issues.includes('INVALID_CONTROL'));
 for(const mail_budget of [null,[],{}, {enabled:'false',hour_attempts:0,day_attempts:0},
  {enabled:false,hour_attempts:-1,day_attempts:0},{enabled:false,hour_attempts:0.5,day_attempts:0}])
  assert(assess({...snapshot(),mail_budget},policy(),now).issues.includes('INVALID_MAIL_BUDGET'));
});
test('no policy field or invented implementation assertion can authorize execution',()=>{
 const decisionKeys=Object.keys(template).filter(k=>!['schema_version','scope','enabled'].includes(k));
 for(const key of decisionKeys){
  const p=policy();p[key]='synthetic-unapproved-value';const result=assess(snapshot(),p,now);
  assert.equal(result.execution_allowed,false);assert(result.issues.includes('TRIAL_POLICY_UNAPPROVED_VALUES'),key);
  for(const code of IMPLEMENTATION_BLOCKERS)assert(result.issues.includes(code),code);
 }
 const p=policy();p.enabled=true;
 assert(assess(snapshot(),p,now).issues.includes('TRIAL_POLICY_NOT_DISABLED'));
 p.execution_approval=true;p.window_seconds=123;p.total_mail_attempt_limit=7;
 const s=snapshot();s.implementation_complete=true;s.execution_allowed=true;
 const result=assess(s,p,now);assert.equal(result.execution_allowed,false);
 for(const code of IMPLEMENTATION_BLOCKERS)assert(result.issues.includes(code),code);
});
test('unknown policy fields, absent keys and wrong types fail with fixed codes only',()=>{
 const missing=policy();delete missing.owner_account_id;
 for(const p of [null,[],{},missing,{...policy(),schema_version:2},{...policy(),scope:'other'},
  {...policy(),enabled:'false'},{...policy(),unexpected_private_field:'synthetic-secret'}]){
  const result=assess(snapshot(),p,now);assert.equal(result.execution_allowed,false);
  assert(result.issues.includes('INVALID_TRIAL_POLICY'));assert(!JSON.stringify(result).includes('synthetic-secret'));
 }
});
test('diagnostic does not mutate its supplied snapshot or disabled policy',()=>{
 const s=snapshot(),p=policy(),before=JSON.stringify({s,p});
 assess(s,p,now);assert.equal(JSON.stringify({s,p}),before);
});
test('CLI reads only local preparation and emits fixed blockers without echoing input',()=>{
 const cli=require.resolve('../scripts/check-cargo-production-trial-preflight.cjs');
 for(const [input,code] of [['synthetic-secret invalid JSON','INVALID_JSON'],['x'.repeat(65537),'INPUT_TOO_LARGE']]){
  const result=spawnSync(process.execPath,[cli],{input,encoding:'utf8'});
  assert.equal(result.status,2);assert.equal(result.stderr,'');
  assert.deepEqual(JSON.parse(result.stdout),{execution_allowed:false,issues:[code]});
 }
 const s=snapshot();s.observed_at=new Date().toISOString();s.private_value='synthetic-secret';
 const result=spawnSync(process.execPath,[cli],{input:JSON.stringify(s),encoding:'utf8'});
 assert.equal(result.status,1);assert.equal(result.stderr,'');
 assert.deepEqual(JSON.parse(result.stdout),{execution_allowed:false,
  issues:['TRIAL_POLICY_DISABLED','TRIAL_DECISIONS_UNSET',...IMPLEMENTATION_BLOCKERS]});
});
