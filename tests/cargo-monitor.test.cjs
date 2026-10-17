'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{spawnSync}=require('node:child_process');
const {assess}=require('../scripts/check-cargo-monitor.cjs');
const now=Date.parse('2026-10-16T11:00:00Z');
const fresh=()=>({schema_version:1,scope:'staging-cargo-monitor',observed_at:new Date(now).toISOString(),
 control:{intake_enabled:false,captcha_required:true,contact_verification_required:true},
 counts:{delivery_unknown:0,sending_over_10m:0,drafts_overdue_15m:0,expired_trials_enabled_2m:0,active_owner_trials:0},
 jobs:[['expired-intake-drafts',1200],['closed-no-order-retention',5400],['owner-mail-trial-expire',300]].map(([name,max_age_seconds])=>({name:'cargo-staging-'+name,max_age_seconds,present:true,active:true,schedule_matches:true,last_success:new Date(now-60000).toISOString(),last_failure:null}))});
test('healthy OFF snapshot and exactly one active owner trial are accepted',()=>{
 const s=fresh();assert.deepEqual(assess(s,now),{ok:true,issues:[]});s.control.intake_enabled=true;s.counts.active_owner_trials=1;assert.equal(assess(s,now).ok,true);
});
test('unknown mail, stalled send, overdue drafts and expired trials require review',()=>{
 for(const [field,code] of Object.entries({delivery_unknown:'QUOTE_DELIVERY_UNKNOWN',sending_over_10m:'QUOTE_SEND_STALLED',drafts_overdue_15m:'DRAFT_CLEANUP_BACKLOG',expired_trials_enabled_2m:'TRIAL_EXPIRY_STALLED'})){const s=fresh();s.counts[field]=1;assert(assess(s,now).issues.includes(code));}
 const s=fresh();s.control.intake_enabled=true;assert(assess(s,now).issues.includes('INTAKE_ON_WITHOUT_SINGLE_ACTIVE_TRIAL'));
 s.counts.active_owner_trials=2;assert.equal(assess(s,now).ok,false);
});
test('missing or stale snapshots and malformed counts fail closed',()=>{
 for(const s of [null,{}, {...fresh(),control:null}, {...fresh(),observed_at:'2026-10-15T00:00:00Z'}, {...fresh(),observed_at:new Date(now+120000).toISOString()}, {...fresh(),counts:{}}])assert.equal(assess(s,now).ok,false);
 const s=fresh();s.counts.delivery_unknown=-1;assert.equal(assess(s,now).ok,false);s.counts.delivery_unknown='0';assert.equal(assess(s,now).ok,false);
});
test('missing, stopped, altered, stale or failed cron is detected; later success recovers',()=>{
 for(const edit of [s=>s.jobs.pop(),s=>s.jobs[0].active=false,s=>s.jobs[0].schedule_matches=false,s=>s.jobs[0].last_success=null,s=>s.jobs[0].max_age_seconds=999999,s=>s.jobs[2]=s.jobs[0]]){const s=fresh();edit(s);assert.equal(assess(s,now).ok,false);}
 const s=fresh();s.jobs[2].last_success=new Date(now-301000).toISOString();assert.equal(assess(s,now).ok,false);
 s.jobs[2].last_success=new Date(now-60000).toISOString();s.jobs[2].last_failure=new Date(now-30000).toISOString();assert(assess(s,now).issues.some(x=>x.endsWith('_FAILED')));
 s.jobs[2].last_success=new Date(now-10000).toISOString();assert.equal(assess(s,now).ok,true);
});
test('CLI rejects invalid input without echoing sensitive input or doing repair',()=>{
 const r=spawnSync(process.execPath,[require.resolve('../scripts/check-cargo-monitor.cjs')],{input:'not-json secret-placeholder',encoding:'utf8'});
 assert.equal(r.status,2);assert.deepEqual(JSON.parse(r.stdout),{ok:false,issues:['INVALID_JSON']});assert.equal(r.stderr,'');
 const s=fresh();s.observed_at=new Date().toISOString();s.customer_secret='synthetic-secret';s.counts.delivery_unknown=1;for(const job of s.jobs)job.last_success=s.observed_at;
 const bad=spawnSync(process.execPath,[require.resolve('../scripts/check-cargo-monitor.cjs')],{input:JSON.stringify(s),encoding:'utf8'});assert.equal(bad.status,1);assert(!bad.stdout.includes(s.customer_secret));assert(!bad.stdout.includes('customer_secret'));
});
