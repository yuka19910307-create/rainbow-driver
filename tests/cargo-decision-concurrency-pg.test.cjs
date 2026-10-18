// New decision/send protection only. Uses synthetic data in a disposable local
// PostgreSQL container; never connects to Supabase or invokes an email sender.
'use strict';
const fs=require('node:fs'),assert=require('node:assert/strict');
const {spawn,spawnSync}=require('node:child_process');
const {test,before,after}=require('node:test');
const container='cargo-decision-concurrency-ci-postgres';
const database='cargo_decision_concurrency_ci_'+process.pid;
const operator='11111111-1111-4111-8111-111111111111';
const outsider='33333333-3333-4333-8333-333333333333';
const request='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const source='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const sessions=new Set();
let sessionNumber=0,created=false;
const dockerEnvironment={...process.env};
for(const key of ['DOCKER_HOST','DOCKER_CONTEXT','DOCKER_TLS','DOCKER_TLS_VERIFY','DOCKER_CERT_PATH'])delete dockerEnvironment[key];
const socket='--host=unix:///var/run/docker.sock';
function args(db=database){
 return [socket,'exec','-i',container,'psql','-X','-qAt','-U','postgres','-d',db,
  '-v','ON_ERROR_STOP=1','-v','VERBOSITY=sqlstate'];
}
function psql(sql,db=database){
 const result=spawnSync('docker',args(db),{input:sql,encoding:'utf8',timeout:20000,env:dockerEnvironment});
 assert.ifError(result.error);
 const sqlstate=result.stderr.match(/ERROR:\s+([A-Z0-9]{5})\b/)?.[1]||'unavailable';
 assert.equal(result.status,0,'Disposable decision SQL failed (SQLSTATE '+sqlstate+'); database stderr withheld');
 return result.stdout.trim();
}
const json=sql=>JSON.parse(psql(sql));
const decide=(expected='operator_reviewing',next='declined',who=operator)=>
 `select public.cargo_customer_request_decide('${request}','${who}','${expected}','${next}')::text;`;
const claim=`select public.cargo_customer_quote_claim_send('${request}','${operator}',decode(repeat('ab',32),'hex'))::text;`;
const finalize=(accepted,provider=accepted?'synthetic-provider-id':null)=>
 `select public.cargo_customer_quote_finalize('${request}','${operator}',${accepted},${provider===null?'null':"'"+provider+"'"})::text;`;
const close=`select public.cargo_customer_close_no_order('${request}','${operator}',true)::text;`;
const legacy="update public.cargo_customer_intake_requests set status='declined' where id='"+request+"' and status='operator_reviewing' returning status;";
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

// An interactive transaction keeps the winner's locks until another real
// PostgreSQL backend has been observed waiting. No sleep determines the winner.
class Session{
 constructor(){
  this.name='cargo_decision_'+process.pid+'_'+(++sessionNumber);
  this.child=spawn('docker',args(),{stdio:['pipe','pipe','pipe'],env:dockerEnvironment});
  this.queue=[];this.waiters=[];this.buffer='';this.stderr='';this.ended=false;
  this.child.stdout.setEncoding('utf8');this.child.stderr.setEncoding('utf8');
  this.child.stdout.on('data',chunk=>{
   this.buffer+=chunk;
   let end;
   while((end=this.buffer.indexOf('\n'))>=0){
    const line=this.buffer.slice(0,end).replace(/\r$/,'');this.buffer=this.buffer.slice(end+1);
    const waiter=this.waiters.shift();if(waiter)waiter.resolve(line);else this.queue.push(line);
   }
  });
  this.child.stderr.on('data',chunk=>{this.stderr+=chunk;});
  this.child.on('error',error=>{this.failure=error;this.finish();});
  this.child.on('close',code=>{this.code=code;this.finish();});
  sessions.add(this);
 }
 finish(){
  this.ended=true;
  for(const waiter of this.waiters.splice(0))waiter.reject(this.failure||this.sqlError());
 }
 sqlError(){
  const sqlstate=this.stderr.match(/ERROR:\s+([A-Z0-9]{5})\b/)?.[1]||'unavailable';
  return Object.assign(Error('Disposable SQL session ended (SQLSTATE '+sqlstate+'); database stderr withheld'),{sqlstate});
 }
 line(){
  if(this.queue.length)return Promise.resolve(this.queue.shift());
  if(this.ended)return Promise.reject(this.failure||this.sqlError());
  return new Promise((resolve,reject)=>this.waiters.push({resolve,reject}));
 }
 async run(sql){
  const marker='__cargo_marker_'+this.name+'_'+(++this.markerNumber)+'__';
  this.child.stdin.write(sql+"\nselect '"+marker+"';\n");
  const lines=[];
  for(;;){const line=await this.line();if(line===marker)return lines.join('\n');if(line)lines.push(line);}
 }
 start(sql){const result=this.run(sql);result.catch(()=>{});return result;}
 async init(){
  this.markerNumber=0;
  const result=await this.run("set application_name='"+this.name+"';set statement_timeout='15s';set lock_timeout='12s';select pg_backend_pid();set role service_role;");
  this.pid=Number(result);assert(Number.isInteger(this.pid)&&this.pid>0);return this;
 }
 async stop(){
  if(!this.ended){
   try{this.child.stdin.end('rollback;\n');}catch{}
   const exit=new Promise(resolve=>this.child.once('close',resolve));
   const timer=setTimeout(()=>this.child.kill('SIGKILL'),2000);
   await exit;clearTimeout(timer);
  }
  sessions.delete(this);
 }
}
async function session(){return new Session().init();}
async function waitBlocked(waiter,blocker){
 const deadline=Date.now()+8000;
 while(Date.now()<deadline){
  assert(!waiter.ended,'Concurrent session ended before reaching a row lock (database stderr withheld)');
  const blocked=psql("select count(*) from pg_stat_activity where datname=current_database() and pid="+waiter.pid+
   " and state='active' and wait_event_type='Lock' and cardinality(pg_blocking_pids(pid))>0"+
   (blocker?' and '+blocker.pid+'=any(pg_blocking_pids(pid))':'')+';');
  if(blocked==='1')return;
  await sleep(20);
 }
 assert.fail('Expected a real concurrent row-lock wait in '+waiter.name);
}
async function lockRequest(){
 const holder=await session();
 await holder.run("begin;select id from public.cargo_customer_intake_requests where id='"+request+"' for update;");
 return holder;
}
function seed({status='operator_reviewing',delivery='ready_to_send',withQuote=true}={}){
 psql(`truncate public.cargo_customer_quote_followup_events,public.cargo_customer_quote_followups,
  public.cargo_customer_quote_replies,public.cargo_customer_retention_runs,
  public.cargo_customer_intake_requests,public.cargo_customer_intake_drafts;
 update public.cargo_intake_control set intake_enabled=true;
 update public.cargo_customer_mail_budget set enabled=true,hourly_limit=100,daily_limit=100,
  hour_started_at=date_trunc('hour',clock_timestamp()),
  day_started_at=(clock_timestamp() at time zone 'Asia/Tokyo')::date,hour_attempts=0,day_attempts=0;
 insert into public.cargo_customer_intake_requests(id,source_draft_id,contact_hmac,encrypted_payload,status)
 values('${request}','${source}',decode(repeat('11',32),'hex'),decode(repeat('22',40),'hex'),'${status}');
 ${withQuote?`insert into public.cargo_customer_quote_replies
 (request_id,prepared_by,amount_yen,terms,valid_until,delivery_status,delivery_attempted_at,response_token_hmac)
 values('${request}','${operator}',1000,repeat('synthetic terms ',4),clock_timestamp()+interval '1 day','${delivery}',
 ${delivery==='ready_to_send'?'null':'clock_timestamp()'},${delivery==='ready_to_send'?'null':"decode(repeat('ab',32),'hex')"});`:''}`);
}
function stored(){return json(`select jsonb_build_object('status',r.status,'delivery',q.delivery_status,
 'provider',q.provider_message_id,'closed',r.closed_no_order_at is not null,
 'hold',r.retention_hold,'attempts',b.hour_attempts,'daily_attempts',b.day_attempts)
 from public.cargo_customer_intake_requests r left join public.cargo_customer_quote_replies q on q.request_id=r.id
 cross join public.cargo_customer_mail_budget b where r.id='${request}';`);}
const result=async promise=>JSON.parse(await promise);
function refused(value,reason){assert.equal(value.ok,false);assert.equal(value.reason,reason);}
async function ordered(firstSql,secondSql,assertions){
 const first=await session(),second=await session();
 try{
  await first.run('begin;');
  const firstResult=JSON.parse(await first.run(firstSql));
  const waiting=second.start(secondSql);await waitBlocked(second,first);
  await first.run('commit;');
  await assertions(firstResult,await result(waiting));
 }finally{await first.stop();await second.stop();}
}

before(()=>{
 const inspected=spawnSync('docker',[socket,'inspect',container,'--format','{{json .}}'],{encoding:'utf8',env:dockerEnvironment,timeout:10000});
 assert.ifError(inspected.error);assert.equal(inspected.status,0,'Disposable local PostgreSQL container is required');
 const isolated=JSON.parse(inspected.stdout);
 assert.equal(isolated.HostConfig.NetworkMode,'none','Test container must have no external network');
 assert.equal((isolated.HostConfig.Binds||[]).length,0,'Test container must not bind host files');
 assert.equal((isolated.HostConfig.Mounts||[]).length,0,'Test container must not attach existing volumes');
 assert.equal(isolated.HostConfig.AutoRemove,true,'Disposable container must remove its anonymous volume on exit');
 // The official PostgreSQL image declares PGDATA as a VOLUME. With no explicit
 // mount/bind and --rm, Docker creates and later removes this anonymous volume.
 assert((isolated.Mounts||[]).every(m=>m.Type==='volume'&&m.Destination==='/var/lib/postgresql/data'&&/^[a-f0-9]{64}$/.test(m.Name)),
  'Only the image-created, disposable PostgreSQL data volume is allowed');
 assert.equal(Object.keys(isolated.HostConfig.PortBindings||{}).length,0,'Test container must not expose ports');
 psql('create database '+database+';','postgres');created=true;
 // Install schemas/functions as fixtures only, without invoking any old suite.
 psql(`create schema auth;create table auth.users(id uuid primary key);
 do $$ begin
  if not exists(select 1 from pg_roles where rolname='anon') then create role anon nologin;end if;
  if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin;end if;
  if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role nologin bypassrls;end if;
 end $$;
 create table public.cargo_intake_control(id integer primary key,intake_enabled boolean not null,
  captcha_required boolean not null,contact_verification_required boolean not null);
 create table public.cargo_operator_accounts(user_id uuid primary key references auth.users(id));
 insert into auth.users values('${operator}');insert into public.cargo_operator_accounts values('${operator}');
 insert into public.cargo_intake_control values(1,false,true,true);
 grant usage on schema public to service_role;
 grant select,update on public.cargo_intake_control to service_role;
 grant select on public.cargo_operator_accounts to service_role;`);
 for(const file of ['schema.review.sql','quotes.review.sql','mail-budget.review.sql','followup.review.sql',
  'closed-no-order-retention.review.sql','active-consultation-expiry.review.sql','decision-concurrency.review.sql'])
  psql(fs.readFileSync('integrations/cargo-customer-intake/'+file,'utf8'));
});
after(async()=>{
 for(const item of [...sessions])await item.stop();
 if(created)psql('drop database '+database+';','postgres');
});

test('decision RPC enforces exact transitions, operator membership and stale-state rejection',async()=>{
 for(const [status,next] of [['pending_operator_review','operator_reviewing'],['pending_operator_review','declined'],['operator_reviewing','declined']]){
  seed({status,withQuote:false});const s=await session();
  try{const value=JSON.parse(await s.run(decide(status,next)));assert.equal(value.ok,true);assert.equal(value.id,request);assert.equal(value.status,next);assert.equal(stored().status,next);}
  finally{await s.stop();}
 }
 for(const [status,next] of [['operator_reviewing','operator_reviewing'],['quoted','declined'],['declined','operator_reviewing']]){
  seed({status,withQuote:false});const s=await session();
  try{const value=JSON.parse(await s.run(decide(status,next)));assert.equal(value.ok,false);assert.equal(stored().status,status);}
  finally{await s.stop();}
 }
 seed({withQuote:false});const s=await session();
 try{
  refused(JSON.parse(await s.run(decide('pending_operator_review'))),'STATUS_CHANGED');
  refused(JSON.parse(await s.run(decide('operator_reviewing','declined',outsider))),'OPERATOR_ONLY');
  assert.equal(stored().status,'operator_reviewing');
 }finally{await s.stop();}
});

test('claim wins: competing decline is refused and only one mail-budget attempt is reserved',async()=>{
 seed();await ordered(claim,decide(),async(a,b)=>{assert.equal(a.ok,true);refused(b,'DELIVERY_RECONCILIATION_REQUIRED');});
 assert.deepEqual(stored(),{status:'operator_reviewing',delivery:'sending',provider:null,closed:false,hold:true,attempts:1,daily_attempts:1});
});
test('decline wins: competing claim cannot consume a mail-budget attempt',async()=>{
 seed();await ordered(decide(),claim,async(a,b)=>{assert.equal(a.ok,true);refused(b,'REQUEST_NOT_REVIEWABLE');});
 assert.equal(stored().status,'declined');assert.equal(stored().delivery,'ready_to_send');assert.equal(stored().attempts,0);
});
test('two actual concurrent claims reserve exactly one attempt',async()=>{
 seed();const holder=await lockRequest(),a=await session(),b=await session();
 try{
  const one=a.start(claim);await waitBlocked(a,holder);const two=b.start(claim);await waitBlocked(b);
  await holder.run('commit;');const values=await Promise.all([result(one),result(two)]);
  assert.equal(values.filter(x=>x.ok===true).length,1);assert.equal(values.filter(x=>x.reason==='DELIVERY_ALREADY_ATTEMPTED').length,1);
  assert.equal(stored().attempts,1);assert.equal(stored().daily_attempts,1);
 }finally{await holder.stop();await a.stop();await b.stop();}
});
test('two actual concurrent declines perform one state transition',async()=>{
 seed();const holder=await lockRequest(),a=await session(),b=await session();
 try{
  const one=a.start(decide());await waitBlocked(a,holder);const two=b.start(decide());await waitBlocked(b);
  await holder.run('commit;');const values=await Promise.all([result(one),result(two)]);
  assert.equal(values.filter(x=>x.ok===true).length,1);assert.equal(values.filter(x=>x.reason==='STATUS_CHANGED').length,1);
  assert.equal(stored().status,'declined');assert.equal(stored().attempts,0);
 }finally{await holder.stop();await a.stop();await b.stop();}
});
for(const [accepted,delivery] of [[true,'sent'],[false,'delivery_unknown']]){
 test('finalize '+delivery+' wins: competing decline cannot contradict its result',async()=>{
  seed({delivery:'sending'});await ordered(finalize(accepted),decide(),async(a,b)=>{
   assert.equal(a.ok,true);refused(b,accepted?'STATUS_CHANGED':'DELIVERY_RECONCILIATION_REQUIRED');
  });
  assert.equal(stored().status,accepted?'quoted':'operator_reviewing');assert.equal(stored().delivery,delivery);
 });
 test('duplicate finalize cannot overwrite the first '+delivery+' result',async()=>{
  seed({delivery:'sending'});await ordered(finalize(accepted),finalize(!accepted),async(a,b)=>{
   assert.equal(a.ok,true);refused(b,accepted?'REQUEST_NOT_REVIEWABLE':'NOT_SENDING');
  });
  assert.equal(stored().delivery,delivery);assert.equal(stored().provider,accepted?'synthetic-provider-id':null);
 });
}
test('decline sees the committed send claim before a waiting finalize',async()=>{
 seed({delivery:'sending'});await ordered(decide(),finalize(true),async(a,b)=>{
  refused(a,'DELIVERY_RECONCILIATION_REQUIRED');assert.equal(b.ok,true);
 });
 assert.equal(stored().status,'quoted');assert.equal(stored().delivery,'sent');
});
test('finalize locks request before quote and never holds quote while waiting on request',async()=>{
 seed({delivery:'sending'});const holder=await lockRequest(),sender=await session(),probe=await session();
 try{
  const pending=sender.start(finalize(true));await waitBlocked(sender,holder);
  // This NOWAIT fails with the old quote->request lock order.
  await probe.run("begin;select request_id from public.cargo_customer_quote_replies where request_id='"+request+"' for update nowait;commit;");
  await holder.run('commit;');assert.equal((await result(pending)).ok,true);
 }finally{await holder.stop();await sender.stop();await probe.stop();}
});
test('finalize rejects an unexpected request status without partially changing the quote',async()=>{
 seed({status:'closed',delivery:'sending'});const s=await session();
 try{refused(JSON.parse(await s.run(finalize(true))),'REQUEST_NOT_REVIEWABLE');}
 finally{await s.stop();}
 assert.equal(stored().delivery,'sending');assert.equal(stored().provider,null);assert.equal(stored().status,'closed');
});
test('finalize requires a nonblank bounded provider identifier without changing a claimed delivery',async()=>{
 seed({delivery:'sending'});const s=await session();
 try{
  for(const provider of [null,'','   ','x'.repeat(201)]){
   refused(JSON.parse(await s.run(finalize(true,provider))),'INVALID_INPUT');
   assert.equal(stored().delivery,'sending');assert.equal(stored().status,'operator_reviewing');assert.equal(stored().provider,null);
  }
 }finally{await s.stop();}
});
test('intake gate OFF blocks new claims but allows the outcome of an already claimed send to be preserved',async()=>{
 seed({delivery:'sending'});psql('update public.cargo_intake_control set intake_enabled=false;');
 const s=await session();
 try{
  refused(JSON.parse(await s.run(claim)),'PUBLIC_INTAKE_DISABLED');
  assert.equal(JSON.parse(await s.run(finalize(false))).ok,true);
 }finally{await s.stop();}
 assert.equal(stored().delivery,'delivery_unknown');assert.equal(stored().attempts,0);
});
test('all attempted delivery states block decision and the legacy direct status update',async()=>{
 for(const delivery of ['sending','sent','delivery_unknown']){
  seed({delivery});const s=await session();
  try{refused(JSON.parse(await s.run(decide())),'DELIVERY_RECONCILIATION_REQUIRED');}
  finally{await s.stop();}
  const direct=await session();
  try{await assert.rejects(direct.run(legacy),error=>error.sqlstate==='23514');}
  finally{await direct.stop();}
  assert.equal(stored().status,'operator_reviewing');assert.equal(stored().delivery,delivery);
 }
});
test('claim wins against a concurrent legacy direct update',async()=>{
 seed();const sender=await session(),old=await session();
 try{
  await sender.run('begin;');assert.equal(JSON.parse(await sender.run(claim)).ok,true);
  const pending=old.start(legacy);await waitBlocked(old,sender);await sender.run('commit;');
  await assert.rejects(pending,error=>error.sqlstate==='23514');
  assert.equal(stored().status,'operator_reviewing');assert.equal(stored().delivery,'sending');assert.equal(stored().attempts,1);
 }finally{await sender.stop();await old.stop();}
});
test('legacy direct decline wins against a concurrent claim without spending a mail attempt',async()=>{
 seed();const old=await session(),sender=await session();
 try{
  await old.run('begin;');assert.equal(await old.run(legacy),'declined');
  const pending=sender.start(claim);await waitBlocked(sender,old);await old.run('commit;');
  refused(await result(pending),'REQUEST_NOT_REVIEWABLE');assert.equal(stored().status,'declined');assert.equal(stored().attempts,0);
 }finally{await old.stop();await sender.stop();}
});
test('claim wins against no-order closure, retaining unresolved-delivery evidence',async()=>{
 seed();await ordered(claim,close,async(a,b)=>{assert.equal(a.ok,true);refused(b,'DELIVERY_RECONCILIATION_REQUIRED');});
 assert.equal(stored().closed,false);assert.equal(stored().hold,true);assert.equal(stored().delivery,'sending');
});
test('no-order closure wins against claim and preserves the thirty-day interval',async()=>{
 seed();await ordered(close,claim,async(a,b)=>{assert.equal(a.ok,true);refused(b,'REQUEST_NOT_REVIEWABLE');});
 assert.equal(stored().status,'closed');assert.equal(stored().attempts,0);
 assert.equal(psql(`select delete_after=closed_no_order_at+interval '30 days' from public.cargo_customer_intake_requests where id='${request}';`),'t');
});
test('closure timestamp is measured after lock waiting, never shortening thirty-day retention',async()=>{
 seed();const holder=await lockRequest(),closer=await session();
 try{
  const pending=closer.start(close);await waitBlocked(closer,holder);
  const releaseTime=psql('select clock_timestamp()::text;');
  await holder.run('commit;');assert.equal((await result(pending)).ok,true);
  assert.equal(psql(`select closed_no_order_at>='${releaseTime}'::timestamptz and
   delete_after=closed_no_order_at+interval '30 days' from public.cargo_customer_intake_requests where id='${request}';`),'t');
 }finally{await holder.stop();await closer.stop();}
});
test('new RPC stays invoker-only and unavailable to public client roles',async()=>{
 const value=json(`select jsonb_build_object('anon',has_function_privilege('anon',
  'public.cargo_customer_request_decide(uuid,uuid,text,text)','execute'),
  'authenticated',has_function_privilege('authenticated','public.cargo_customer_request_decide(uuid,uuid,text,text)','execute'),
  'service',has_function_privilege('service_role','public.cargo_customer_request_decide(uuid,uuid,text,text)','execute'),
  'trigger_direct_execute',has_function_privilege('service_role','public.cargo_customer_decline_guard()','execute'),
  'definer',(select prosecdef from pg_proc where oid='public.cargo_customer_request_decide(uuid,uuid,text,text)'::regprocedure));`);
 assert.deepEqual(value,{anon:false,authenticated:false,service:true,trigger_direct_execute:false,definer:false});
 for(const role of ['anon','authenticated']){
  const s=await session();
  try{await assert.rejects(s.run('set role '+role+';'+decide()),error=>error.sqlstate==='42501');}
  finally{await s.stop();}
 }
});
