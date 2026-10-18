// Stage 1 only: synthetic order lifecycle and retention protection in a
// disposable offline PostgreSQL database. No Supabase, emails, or old suites.
'use strict';
const fs=require('node:fs'),assert=require('node:assert/strict');
const {spawn,spawnSync}=require('node:child_process');
const {test,before,after}=require('node:test');
const container='cargo-orders-stage1-ci-postgres';
const database='cargo_orders_stage1_ci_'+process.pid;
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
 assert.equal(result.status,0,'Disposable order SQL failed (SQLSTATE '+sqlstate+', source line '+(result.stderr.match(/LINE ([0-9]+):/)?.[1]||'unavailable')+'); database stderr withheld');
 return result.stdout.trim();
}
const json=sql=>JSON.parse(psql(sql));
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

// An interactive transaction keeps the winner's locks until another real
// PostgreSQL backend has been observed waiting. No sleep determines the winner.
class Session{
 constructor(){
  this.name='cargo_order_'+process.pid+'_'+(++sessionNumber);
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
const quote=s=>"'"+s.replaceAll("'","''")+"'";
const payload="decode('01'||repeat('ab',40),'hex')";
let operationNumber=0;
const operation=()=>`90000000-0000-4000-8000-${String(++operationNumber).padStart(12,'0')}`;
const signature='public.cargo_customer_order_command(uuid,uuid,uuid,text,integer,integer,integer,integer,timestamp with time zone,timestamp with time zone,timestamp with time zone,text,bytea,text,text)';
function command(action,options={}){
 const values={p_request_id:quote(request),p_operator_id:quote(operator),p_operation_id:quote(operation()),
  p_action:quote(action),p_expected_order_version:'0',...options};
 return 'select public.cargo_customer_order_command('+Object.entries(values).map(([key,value])=>key+'=>'+value).join(',')+')::text;';
}
function agreement(options={}){
 return command('record_agreement',{p_expected_agreement_version:'0',p_amount_yen:'10000',
  p_pickup_at:"clock_timestamp()+interval '1 day'",p_delivery_at:"clock_timestamp()+interval '2 days'",
  p_customer_confirmed_at:"clock_timestamp()-interval '1 hour'",p_confirmation_method:"'phone'",
  p_encrypted_payload:payload,p_confirmation:"'RECORD_OBSERVED_CUSTOMER_AGREEMENT'",...options});
}
function accept(options={}){
 return command('accept_order',{p_agreement_version:'1',p_confirmation:"'RECORD_OPERATOR_ACCEPTANCE'",...options});
}
function change(next='preparing',version=1,options={}){
 return command('change_status',{p_expected_order_version:String(version),p_next_status:quote(next),
  p_encrypted_payload:payload,p_confirmation:"'RECORD_DELIVERY_STATE_CHANGE'",...options});
}
function apply(version=1,agreementVersion=2,options={}){
 return command('apply_agreement',{p_expected_order_version:String(version),p_agreement_version:String(agreementVersion),
  p_confirmation:"'APPLY_RECORDED_AGREEMENT'",...options});
}
const close=`select public.cargo_customer_close_no_order('${request}','${operator}',true)::text;`;
function seed({status='quoted',delivery='sent',response='interested'}={}){
 psql(`truncate public.cargo_customer_order_events,public.cargo_customer_orders,
  public.cargo_customer_order_agreements,public.cargo_customer_quote_followup_events,
  public.cargo_customer_quote_followups,public.cargo_customer_quote_replies,
  public.cargo_customer_retention_runs,public.cargo_customer_intake_requests,
  public.cargo_customer_intake_drafts;
 update public.cargo_intake_control set intake_enabled=false;
 update public.cargo_customer_mail_budget set enabled=false;
 insert into public.cargo_customer_intake_requests(id,source_draft_id,contact_hmac,encrypted_payload,status)
 values('${request}','${source}',decode(repeat('11',32),'hex'),decode(repeat('22',40),'hex'),'${status}');
 insert into public.cargo_customer_quote_replies
 (request_id,prepared_by,amount_yen,terms,valid_until,delivery_status,delivery_attempted_at,response_token_hmac,response_state,responded_at)
 values('${request}','${operator}',10000,repeat('synthetic quote terms ',4),clock_timestamp()+interval '3 days',
 '${delivery}',${delivery==='ready_to_send'?'null':'clock_timestamp()'},
 ${delivery==='ready_to_send'?'null':"decode(repeat('ab',32),'hex')"},${response===null?'null':quote(response)},${response===null?'null':'clock_timestamp()'});`);
}
function stored(){
 return json(`select jsonb_build_object('request_status',r.status,'hold',r.retention_hold,
  'closed',r.closed_no_order_at is not null,'order_status',o.status,'version',o.version,
  'active_agreement_version',o.active_agreement_version,
  'agreement_count',(select count(*) from public.cargo_customer_order_agreements where request_id=r.id),
  'event_count',(select count(*) from public.cargo_customer_order_events where request_id=r.id),
  'retention_policy',o.retention_policy,'retention_until',o.retention_until,
  'completed',o.completed_at is not null,'cancelled',o.cancelled_at is not null)
 from public.cargo_customer_intake_requests r left join public.cargo_customer_orders o on o.request_id=r.id
 where r.id='${request}';`);
}
const result=async promise=>JSON.parse(await promise);
function refused(value,reason){assert.equal(value.ok,false);if(reason)assert.equal(value.reason,reason);}
async function call(sql){const s=await session();try{return await result(s.run(sql));}finally{await s.stop();}}
async function recordAndAccept(){assert.equal((await call(agreement())).ok,true);assert.equal((await call(accept())).ok,true);}
async function ordered(firstSql,secondSql,assertions){
 const first=await session(),second=await session();
 try{
  await first.run('begin;');const firstResult=JSON.parse(await first.run(firstSql));
  const waiting=second.start(secondSql);await waitBlocked(second,first);
  await first.run('commit;');await assertions(firstResult,await result(waiting));
 }finally{await first.stop();await second.stop();}
}
async function forbidden(sql,sqlstates=['42501','23514','23503','55000']){
 const s=await session();try{await assert.rejects(s.run(sql),error=>sqlstates.includes(error.sqlstate));}
 finally{await s.stop();}
}

before(()=>{
 const inspected=spawnSync('docker',[socket,'inspect',container,'--format','{{json .}}'],
  {encoding:'utf8',env:dockerEnvironment,timeout:10000});
 assert.ifError(inspected.error);assert.equal(inspected.status,0,'Disposable local PostgreSQL container is required');
 const isolated=JSON.parse(inspected.stdout);
 assert.equal(isolated.HostConfig.NetworkMode,'none','Test container must have no external network');
 assert.equal((isolated.HostConfig.Binds||[]).length,0,'Test container must not bind host files');
 assert.equal((isolated.HostConfig.Mounts||[]).length,0,'Test container must not attach existing volumes');
 assert.equal(isolated.HostConfig.AutoRemove,true,'Disposable PostgreSQL volume must be removed on exit');
 assert((isolated.Mounts||[]).every(m=>m.Type==='volume'&&m.Destination==='/var/lib/postgresql/data'&&/^[a-f0-9]{64}$/.test(m.Name)),
  'Only the image-created disposable PostgreSQL data volume is allowed');
 assert.equal(Object.keys(isolated.HostConfig.PortBindings||{}).length,0,'Test container must not expose ports');
 psql('create database '+database+';','postgres');created=true;
 psql(`create schema auth;create table auth.users(id uuid primary key);
 do $$ begin
  if not exists(select 1 from pg_roles where rolname='anon') then create role anon nologin;end if;
  if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin;end if;
  if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role nologin bypassrls;end if;
 end $$;
 create table public.cargo_intake_control(id integer primary key,intake_enabled boolean not null,
  captcha_required boolean not null,contact_verification_required boolean not null);
 create table public.cargo_operator_accounts(user_id uuid primary key references auth.users(id));
 insert into auth.users values('${operator}'),('${outsider}');
 insert into public.cargo_operator_accounts values('${operator}');
 insert into public.cargo_intake_control values(1,false,true,true);
 grant usage on schema public to service_role;
 grant select,update on public.cargo_intake_control to service_role;
 grant select on public.cargo_operator_accounts to service_role;`);
 for(const file of ['schema.review.sql','quotes.review.sql','mail-budget.review.sql','followup.review.sql',
  'closed-no-order-retention.review.sql','active-consultation-expiry.review.sql','decision-concurrency.review.sql'])
  psql(fs.readFileSync('integrations/cargo-customer-intake/'+file,'utf8'));
 psql(fs.readFileSync('integrations/cargo-customer-orders/foundation.review.sql','utf8'));
});
after(async()=>{
 for(const item of [...sessions])await item.stop();
 if(created)psql('drop database '+database+';','postgres');
});

test('customer interest alone creates no agreement or formal order; acceptance requires an observed agreement',async()=>{
 seed();refused(await call(accept()));const value=stored();
 assert.equal(value.order_status,null);assert.equal(value.agreement_count,0);assert.equal(value.event_count,0);
});

test('observed customer agreement is separate from an explicit operator acceptance while intake remains OFF',async()=>{
 seed();const agreementResult=await call(agreement());assert.equal(agreementResult.ok,true);
 assert.equal(agreementResult.agreement_version,1);assert.equal(stored().order_status,null);
 const accepted=await call(accept());assert.equal(accepted.ok,true);assert.equal(accepted.order_version,1);
 assert.equal(accepted.status,'accepted');assert.equal(stored().agreement_count,1);assert.equal(stored().event_count,2);
 assert.equal(psql('select intake_enabled from public.cargo_intake_control where id=1;'),'f');
 assert.equal(psql('select not enabled and hour_attempts=0 and day_attempts=0 from public.cargo_customer_mail_budget where id=1;'),'t');
 assert.equal(psql(`select accepted_by='${operator}'::uuid and updated_by='${operator}'::uuid and
  accepted_at is not null and updated_at>=accepted_at from public.cargo_customer_orders where request_id='${request}';`),'t');
 assert.equal(psql(`select count(*) from public.cargo_customer_order_events where actor_id<>'${operator}';`),'0');
});

test('agreement validation rejects future confirmations, malformed ciphertext, invalid amounts/dates and missing explicit confirmation atomically',async()=>{
 seed();
 for(const options of [
  {p_customer_confirmed_at:"clock_timestamp()+interval '1 day'"},
  {p_customer_confirmed_at:'null'},{p_confirmation_method:"'unverified'"},
  {p_amount_yen:'0'},{p_amount_yen:'10000001'},{p_pickup_at:'null'},
  {p_delivery_at:"clock_timestamp()-interval '1 day'"},
  {p_pickup_at:"'10000-01-01 00:00:00+00'::timestamptz"},
  {p_pickup_at:"'0001-01-01 00:00:00+00 BC'::timestamptz"},
  {p_delivery_at:"'10000-01-01 00:00:00+00'::timestamptz"},
  {p_customer_confirmed_at:"'0001-01-01 00:00:00+00 BC'::timestamptz"},
  {p_encrypted_payload:"decode('02'||repeat('ab',40),'hex')"},
  {p_encrypted_payload:"decode('01'||repeat('ab',10),'hex')"},
  {p_encrypted_payload:"decode('01'||repeat('ab',20000),'hex')"},
  {p_confirmation:"'RECORD_OPERATOR_ACCEPTANCE'"},
 ]){
  refused(await call(agreement(options)));
  assert.equal(stored().agreement_count,0);assert.equal(stored().event_count,0);assert.equal(stored().order_status,null);
 }
});

test('unquoted, unsent, delivery-unknown and explicitly closed consultations cannot acquire an agreement',async()=>{
 for(const options of [
  {status:'operator_reviewing',delivery:'ready_to_send',response:null},
  {status:'quoted',delivery:'delivery_unknown'},
  {status:'operator_reviewing',delivery:'sending'},
 ]){seed(options);refused(await call(agreement()));assert.equal(stored().agreement_count,0);}
 seed();assert.equal((await call(close)).ok,true);refused(await call(agreement()));
 assert.equal(stored().agreement_count,0);
});

test('unknown operators and malformed command inputs cannot change the order ledger',async()=>{
 seed();
 for(const sql of [agreement({p_operator_id:quote(outsider)}),
  agreement({p_action:"'unknown_action'"}),agreement({p_operation_id:'null'}),
  agreement({p_expected_order_version:'-1'}),agreement({p_expected_agreement_version:'null'})]){
  refused(await call(sql));assert.equal(stored().agreement_count,0);assert.equal(stored().event_count,0);
 }
});

test('stale agreement versions and reused operation identifiers are rejected without duplicate evidence',async()=>{
 seed();const id=operation();assert.equal((await call(agreement({p_operation_id:quote(id)}))).ok,true);
 refused(await call(agreement()),'AGREEMENT_VERSION_CONFLICT');
 refused(await call(agreement({p_operation_id:quote(id),p_expected_agreement_version:'1'})),'OPERATION_ALREADY_RECORDED');
 assert.equal(stored().agreement_count,1);assert.equal(stored().event_count,1);
 assert.equal((await call(agreement({p_expected_agreement_version:'1',p_amount_yen:'12000'}))).ok,true);
 refused(await call(accept()),'AGREEMENT_VERSION_CONFLICT');
 assert.equal(stored().order_status,null);assert.equal(stored().agreement_count,2);
 assert.equal((await call(accept({p_agreement_version:'2'}))).ok,true);
 assert.equal(stored().active_agreement_version,2);
});

test('delivery completion requires all explicit operator transitions and records exact versioned history',async()=>{
 seed();await recordAndAccept();
 for(const [status,version] of [['preparing',1],['in_transit',2],['completed',3]]){
  const value=await call(change(status,version));assert.equal(value.ok,true);assert.equal(value.status,status);
  assert.equal(value.order_version,version+1);
 }
 const value=stored();assert.equal(value.version,4);assert.equal(value.completed,true);assert.equal(value.cancelled,false);
 assert.equal(value.retention_policy,'undetermined_hold');assert.equal(value.retention_until,null);
 assert.equal(value.hold,true);assert.equal(value.closed,false);
 const events=json(`select jsonb_agg(jsonb_build_object('sequence',sequence,'from',from_status,'to',to_status,'version',order_version)
  order by sequence) from public.cargo_customer_order_events where request_id='${request}';`);
 assert.deepEqual(events.map(x=>x.sequence),[1,2,3,4,5]);
 assert.deepEqual(events.slice(-3).map(x=>[x.from,x.to,x.version]),
  [['accepted','preparing',2],['preparing','in_transit',3],['in_transit','completed',4]]);
 refused(await call(change('cancelled',4)));assert.equal(stored().version,4);
});

test('skipped, stale and unsupported delivery transitions cannot mutate accepted order state',async()=>{
 seed();await recordAndAccept();
 for(const sql of [change('completed',1),change('in_transit',1),change('accepted',1),
  change('preparing',0),change('preparing',1,{p_confirmation:"'wrong'"})]){
  refused(await call(sql));assert.equal(stored().order_status,'accepted');assert.equal(stored().version,1);assert.equal(stored().event_count,2);
 }
});

test('cancellation is explicit and terminal from each active state, preserving indefinite retention hold',async()=>{
 for(const stage of ['accepted','preparing','in_transit']){
  seed();await recordAndAccept();let version=1;
  if(stage!=='accepted'){assert.equal((await call(change('preparing',version++))).ok,true);}
  if(stage==='in_transit'){assert.equal((await call(change('in_transit',version++))).ok,true);}
  assert.equal((await call(change('cancelled',version))).ok,true);const value=stored();
  assert.equal(value.cancelled,true);assert.equal(value.completed,false);assert.equal(value.retention_until,null);
  assert.equal(value.hold,true);refused(await call(change('preparing',version+1)));
 }
});

test('condition amendment is immutable evidence and requires explicit application before progress',async()=>{
 seed();await recordAndAccept();
 assert.equal((await call(agreement({p_expected_order_version:'1',p_expected_agreement_version:'1',p_amount_yen:'12000'}))).ok,true);
 assert.equal(stored().version,1);assert.equal(stored().active_agreement_version,1);assert.equal(stored().agreement_count,2);
 refused(await call(change('preparing',1)));assert.equal(stored().order_status,'accepted');
 assert.equal((await call(apply())).ok,true);assert.equal(stored().version,2);assert.equal(stored().active_agreement_version,2);
 assert.equal((await call(change('preparing',2))).ok,true);
 assert.equal(psql(`select string_agg(amount_yen::text,',' order by version) from public.cargo_customer_order_agreements where request_id='${request}';`),'10000,12000');
});

test('pending amended conditions do not prevent an explicit cancellation',async()=>{
 seed();await recordAndAccept();
 assert.equal((await call(agreement({p_expected_order_version:'1',p_expected_agreement_version:'1'}))).ok,true);
 assert.equal((await call(change('cancelled',1))).ok,true);assert.equal(stored().active_agreement_version,1);
});

test('two real concurrent acceptance calls create one order and one acceptance event',async()=>{
 seed();assert.equal((await call(agreement())).ok,true);
 const holder=await lockRequest(),a=await session(),b=await session();
 try{
  const one=a.start(accept());await waitBlocked(a,holder);const two=b.start(accept());await waitBlocked(b);
  await holder.run('commit;');const values=await Promise.all([result(one),result(two)]);
  assert.equal(values.filter(x=>x.ok===true).length,1);assert.equal(values.filter(x=>x.reason==='ORDER_VERSION_CONFLICT').length,1);
  assert.equal(stored().version,1);assert.equal(stored().event_count,2);
 }finally{await holder.stop();await a.stop();await b.stop();}
});

test('two real concurrent state changes commit exactly one version and one event',async()=>{
 seed();await recordAndAccept();const holder=await lockRequest(),a=await session(),b=await session();
 try{
  const one=a.start(change('preparing',1));await waitBlocked(a,holder);const two=b.start(change('cancelled',1));await waitBlocked(b);
  await holder.run('commit;');const values=await Promise.all([result(one),result(two)]);
  assert.equal(values.filter(x=>x.ok===true).length,1);assert.equal(values.filter(x=>x.reason==='ORDER_VERSION_CONFLICT').length,1);
  assert.equal(stored().version,2);assert.equal(stored().event_count,3);
 }finally{await holder.stop();await a.stop();await b.stop();}
});

test('amendment wins against simultaneous progress; pending agreement cannot be silently bypassed',async()=>{
 seed();await recordAndAccept();
 await ordered(agreement({p_expected_order_version:'1',p_expected_agreement_version:'1'}),change('preparing',1),async(a,b)=>{
  assert.equal(a.ok,true);refused(b);
 });
 assert.equal(stored().order_status,'accepted');assert.equal(stored().version,1);assert.equal(stored().agreement_count,2);
});

test('progress wins against simultaneous amendment, requiring amendment to re-read the current order version',async()=>{
 seed();await recordAndAccept();
 await ordered(change('preparing',1),agreement({p_expected_order_version:'1',p_expected_agreement_version:'1'}),async(a,b)=>{
  assert.equal(a.ok,true);refused(b,'ORDER_VERSION_CONFLICT');
 });
 assert.equal(stored().order_status,'preparing');assert.equal(stored().agreement_count,1);
});

test('acceptance wins against no-order closure, keeping the request and quote intact',async()=>{
 seed();assert.equal((await call(agreement())).ok,true);
 await ordered(accept(),close,async(a,b)=>{assert.equal(a.ok,true);refused(b);});
 assert.equal(stored().order_status,'accepted');assert.equal(stored().closed,false);assert.equal(stored().hold,true);
});

test('no-order closure wins against acceptance, preserving the existing thirty-day interval',async()=>{
 seed();assert.equal((await call(agreement())).ok,true);
 await ordered(close,accept(),async(a,b)=>{assert.equal(a.ok,true);refused(b);});
 assert.equal(stored().order_status,null);assert.equal(stored().closed,true);
 assert.equal(psql(`select delete_after=closed_no_order_at+interval '30 days' from public.cargo_customer_intake_requests where id='${request}';`),'t');
});

test('order command locks request before quote and does not hold the quote while waiting on request',async()=>{
 seed();assert.equal((await call(agreement())).ok,true);
 const holder=await lockRequest(),caller=await session(),probe=await session();
 try{
  const pending=caller.start(accept());await waitBlocked(caller,holder);
  await probe.run(`begin;select request_id from public.cargo_customer_quote_replies where request_id='${request}' for update nowait;commit;`);
  await holder.run('commit;');assert.equal((await result(pending)).ok,true);
 }finally{await holder.stop();await caller.stop();await probe.stop();}
});

test('accepted, completed and cancelled orders never enter the old no-contract cleanup path',async()=>{
 for(const status of ['accepted','completed','cancelled']){
  seed();await recordAndAccept();
  if(status==='completed'){
   assert.equal((await call(change('preparing',1))).ok,true);
   assert.equal((await call(change('in_transit',2))).ok,true);
   assert.equal((await call(change('completed',3))).ok,true);
  }else if(status==='cancelled')assert.equal((await call(change('cancelled',1))).ok,true);
  refused(await call(close));
  refused(await call(`select public.cargo_customer_retention_set_hold('${request}','${operator}',false)::text;`));
  const cleaned=await call('select public.cargo_customer_closed_cleanup(100)::text;');
  assert.equal(cleaned.ok,true);assert.equal(cleaned.requests_deleted,0);assert.equal(stored().order_status,status);
  assert.equal(stored().retention_until,null);assert.equal(stored().event_count,status==='completed'?5:status==='cancelled'?3:2);
 }
});

test('legacy direct closure, retention release and parent deletion cannot bypass accepted-order protection',async()=>{
 seed();await recordAndAccept();
 for(const sql of [
  `update public.cargo_customer_intake_requests set status='closed',closed_no_order_at=clock_timestamp(),retention_hold=false,delete_after=clock_timestamp()-interval '1 day' where id='${request}';`,
  `update public.cargo_customer_intake_requests set retention_hold=false where id='${request}';`,
  `delete from public.cargo_customer_intake_requests where id='${request}';`,
 ]){await forbidden(sql);assert.equal(stored().order_status,'accepted');assert.equal(stored().closed,false);assert.equal(stored().hold,true);}
});

test('unaccepted consultation agreements retain the existing thirty-day cleanup rule and cascade only after eligibility',async()=>{
 seed();assert.equal((await call(agreement())).ok,true);assert.equal((await call(close)).ok,true);
 const early=await call('select public.cargo_customer_closed_cleanup(100)::text;');assert.equal(early.requests_deleted,0);
 psql(`update public.cargo_customer_intake_requests set closed_no_order_at=clock_timestamp()-interval '31 days',
  delete_after=clock_timestamp()-interval '1 day' where id='${request}';`);
 const cleaned=await call('select public.cargo_customer_closed_cleanup(100)::text;');assert.equal(cleaned.requests_deleted,1);
 assert.equal(psql(`select count(*) from public.cargo_customer_order_agreements where request_id='${request}';`),'0');
 assert.equal(psql(`select count(*) from public.cargo_customer_order_events where request_id='${request}';`),'0');
});

test('order, agreement and operation history cannot be rewritten or removed by the service client',async()=>{
 seed();await recordAndAccept();
 for(const sql of [
  `update public.cargo_customer_orders set status='completed',version=version+1 where request_id='${request}';`,
  `delete from public.cargo_customer_orders where request_id='${request}';`,
  `update public.cargo_customer_order_agreements set amount_yen=1 where request_id='${request}';`,
  `delete from public.cargo_customer_order_agreements where request_id='${request}';`,
  `update public.cargo_customer_order_events set actor_id='${outsider}' where request_id='${request}';`,
  `delete from public.cargo_customer_order_events where request_id='${request}';`,
 ]){await forbidden(sql);assert.equal(stored().order_status,'accepted');assert.equal(stored().agreement_count,1);assert.equal(stored().event_count,2);}
});

test('new tables enable RLS and deny public client reads/writes and direct RPC execution',async()=>{
 const tables=['cargo_customer_orders','cargo_customer_order_agreements','cargo_customer_order_events'];
 for(const table of tables){
  assert.equal(psql(`select relrowsecurity from pg_class where oid='public.${table}'::regclass;`),'t');
  for(const role of ['anon','authenticated']){
   for(const privilege of ['select','insert','update','delete'])
    assert.equal(psql(`select has_table_privilege('${role}','public.${table}','${privilege}');`),'f');
   await forbidden(`set role ${role};select * from public.${table};`,['42501']);
  }
 }
 const value=json(`select jsonb_build_object('anon',has_function_privilege('anon','${signature}','execute'),
  'authenticated',has_function_privilege('authenticated','${signature}','execute'),
  'service',has_function_privilege('service_role','${signature}','execute'),
  'definer',(select prosecdef from pg_proc where oid='${signature}'::regprocedure));`);
 assert.deepEqual(value,{anon:false,authenticated:false,service:true,definer:false});
 // Only the protected backend can invoke this identity-checked, invoker RPC.
 for(const role of ['anon','authenticated'])await forbidden('set role '+role+';'+agreement(),['42501']);
});

test('two real concurrent agreement observations cannot consume the same expected agreement version',async()=>{
 seed();const holder=await lockRequest(),a=await session(),b=await session();
 try{
  const one=a.start(agreement());await waitBlocked(a,holder);const two=b.start(agreement());await waitBlocked(b);
  await holder.run('commit;');const values=await Promise.all([result(one),result(two)]);
  assert.equal(values.filter(x=>x.ok===true).length,1);assert.equal(values.filter(x=>x.reason==='AGREEMENT_VERSION_CONFLICT').length,1);
  assert.equal(stored().agreement_count,1);assert.equal(stored().event_count,1);assert.equal(stored().order_status,null);
 }finally{await holder.stop();await a.stop();await b.stop();}
});

test('accepted-order cleanup exclusion survives an inconsistent legacy retention marker; legacy cleanup rolls back child deletions',async()=>{
 seed();await recordAndAccept();
 // Synthetic corruption models an old/missing retention marker. Superuser-only
 // trigger suppression is confined to this disposable fixture, never an API.
 psql(`set session_replication_role='replica';
  update public.cargo_customer_intake_requests set status='closed',closed_no_order_at=clock_timestamp()-interval '31 days',
   delete_after=clock_timestamp()-interval '1 day',retention_hold=false where id='${request}';
  set session_replication_role='origin';`);
 const cleaned=await call('select public.cargo_customer_closed_cleanup(100)::text;');
 assert.equal(cleaned.requests_deleted,0);assert.equal(stored().order_status,'accepted');
 const oldSource=fs.readFileSync('integrations/cargo-customer-intake/closed-no-order-retention.review.sql','utf8');
 const oldCleanup=oldSource.match(/create or replace function public\.cargo_customer_closed_cleanup\([\s\S]*?\$body\$;/)?.[0];
 assert(oldCleanup,'Legacy cleanup fixture must be present');
 const legacy=await session();
 try{
  await assert.rejects(legacy.run('begin;reset role;'+oldCleanup+'set role service_role;select public.cargo_customer_closed_cleanup(100)::text;'),
   error=>['23503','23514','55000'].includes(error.sqlstate));
 }finally{await legacy.stop();}
 assert.equal(psql(`select count(*) from public.cargo_customer_quote_replies where request_id='${request}';`),'1');
 assert.equal(stored().agreement_count,1);assert.equal(stored().event_count,2);
 assert.equal((await call('select public.cargo_customer_closed_cleanup(100)::text;')).requests_deleted,0);
});

test('late event-write failure rolls back acceptance and retention mutation atomically',async()=>{
 seed();assert.equal((await call(agreement())).ok,true);const before=stored();
 psql(`create function public.synthetic_order_event_failure() returns trigger language plpgsql as $$
  begin raise exception using errcode='23514',message='SYNTHETIC_EVENT_FAILURE';end;$$;
  create trigger synthetic_order_event_failure before insert on public.cargo_customer_order_events
   for each row execute function public.synthetic_order_event_failure();`);
 try{
  await forbidden(accept(),['23514']);assert.deepEqual(stored(),before);
 }finally{
  psql('drop trigger synthetic_order_event_failure on public.cargo_customer_order_events;drop function public.synthetic_order_event_failure();');
 }
 assert.equal((await call(accept())).ok,true);assert.equal(stored().event_count,2);
});

test('operator acceptance requires its own explicit confirmation and cannot reuse an agreement operation',async()=>{
 seed();const agreementOperation=operation();
 assert.equal((await call(agreement({p_operation_id:quote(agreementOperation)}))).ok,true);
 for(const sql of [accept({p_confirmation:'null'}),accept({p_confirmation:"'RECORD_OBSERVED_CUSTOMER_AGREEMENT'"}),
  accept({p_operator_id:quote(outsider)}),accept({p_operation_id:quote(agreementOperation)})]){
  refused(await call(sql));assert.equal(stored().order_status,null);assert.equal(stored().event_count,1);
 }
 assert.equal((await call(accept())).ok,true);
});

test('terminal orders reject amendments and do not silently reopen after delivery completion or cancellation',async()=>{
 for(const terminal of ['completed','cancelled']){
  seed();await recordAndAccept();let version=1;
  if(terminal==='completed'){
   assert.equal((await call(change('preparing',version++))).ok,true);
   assert.equal((await call(change('in_transit',version++))).ok,true);
  }
  assert.equal((await call(change(terminal,version++))).ok,true);const before=stored();
  refused(await call(agreement({p_expected_order_version:String(version),p_expected_agreement_version:'1'})));
  refused(await call(apply(version,1)));assert.deepEqual(stored(),before);
 }
});

test('observed agreement may be recorded independently of the interest-link button, with supported evidence methods',async()=>{
 for(const method of ['email','phone','in_person','other']){
  seed({response:null});
  const value=await call(agreement({p_confirmation_method:quote(method),p_delivery_at:'null'}));
  assert.equal(value.ok,true);assert.equal(stored().order_status,null);
  assert.equal((await call(accept())).ok,true);
 }
});

test('even an otherwise valid direct state update must include its matching audit event or roll back',async()=>{
 seed();await recordAndAccept();const before=stored();
 await forbidden(`update public.cargo_customer_orders set status='preparing',version=2,
  updated_by='${operator}',updated_at=clock_timestamp() where request_id='${request}';`);
 assert.deepEqual(stored(),before);
});

function read(options={}){
 const values={p_request_id:quote(request),p_operator_id:quote(operator),...options};
 return 'select public.cargo_customer_order_read('+Object.entries(values).map(([key,value])=>key+'=>'+value).join(',')+')::text;';
}

test('order snapshot rejects unauthorized/malformed reads and is unavailable to public client roles',async()=>{
 seed();const empty=await call(read());assert.equal(empty.ok,true);assert.equal(empty.order,null);
 assert.deepEqual(empty.agreements,[]);assert.deepEqual(empty.events,[]);
 refused(await call(read({p_operator_id:quote(outsider)})),'OPERATOR_ONLY');
 for(const options of [{p_before_event_sequence:'0'},{p_before_agreement_version:'0'},{p_request_id:'null'}])
  refused(await call(read(options)),'INVALID_INPUT');
 const readSignature='public.cargo_customer_order_read(uuid,uuid,integer,integer)';
 for(const role of ['anon','authenticated']){
  assert.equal(psql(`select has_function_privilege('${role}','${readSignature}','execute');`),'f');
  await forbidden('set role '+role+';'+read(),['42501']);
 }
 assert.equal(psql(`select prosecdef from pg_proc where oid='${readSignature}'::regprocedure;`),'f');
});

test('snapshot waits for an in-flight acceptance and returns matching order/agreement/event versions after commit',async()=>{
 seed();assert.equal((await call(agreement())).ok,true);
 const writer=await session(),reader=await session();
 try{
  await writer.run('begin;');assert.equal((await result(writer.run(accept()))).ok,true);
  const pending=reader.start(read());await waitBlocked(reader,writer);
  await writer.run('commit;');const snapshot=await result(pending);
  assert.equal(snapshot.order.version,1);assert.equal(snapshot.order.active_agreement_version,1);
  assert.equal(snapshot.agreements.length,1);assert.equal(snapshot.events.length,2);
  assert.equal(snapshot.events[0].kind,'order_accepted');assert.equal(snapshot.events[0].order_version,1);
 }finally{await writer.stop();await reader.stop();}
});

test('snapshot SHARE lock prevents a concurrent writer from producing a torn read',async()=>{
 seed();await recordAndAccept();const reader=await session(),writer=await session();
 try{
  await reader.run('begin;');const first=await result(reader.run(read()));
  const pending=writer.start(change('preparing',1));await waitBlocked(writer,reader);
  const second=await result(reader.run(read()));assert.deepEqual(second,first);
  await reader.run('commit;');assert.equal((await result(pending)).ok,true);
  const current=await call(read());assert.equal(current.order.status,'preparing');assert.equal(current.order.version,2);
  assert.equal(current.events[0].to_status,'preparing');assert.equal(current.events[0].order_version,2);
 }finally{await reader.stop();await writer.stop();}
});

test('agreement and event snapshot pages are descending, bounded and cursor-exclusive without truncating old evidence',async()=>{
 seed();const commands=[];
 for(let version=0;version<55;version++)commands.push(agreement({p_expected_agreement_version:String(version)}));
 psql('set role service_role;'+commands.join('\n'));
 const first=await call(read());assert.equal(first.agreements.length,51);assert.equal(first.events.length,51);
 assert.deepEqual(first.agreements.map(x=>x.version),Array.from({length:51},(_,i)=>55-i));
 assert.deepEqual(first.events.map(x=>x.sequence),Array.from({length:51},(_,i)=>55-i));
 const rest=await call(read({p_before_agreement_version:String(first.agreements[49].version),
  p_before_event_sequence:String(first.events[49].sequence)}));
 assert.deepEqual(rest.agreements.map(x=>x.version),[5,4,3,2,1]);
 assert.deepEqual(rest.events.map(x=>x.sequence),[5,4,3,2,1]);
 assert.equal(rest.order,null);
});

const followupClose=`select public.cargo_customer_followup_save('${request}','${operator}',null,'closed_no_order','Synthetic no-order closure observation')::text;`;

test('accepted order rejects a legacy follow-up no-order terminal without blocking later delivery progress',async()=>{
 seed();await recordAndAccept();psql('update public.cargo_intake_control set intake_enabled=true;');
 try{
  await forbidden(followupClose,['23514']);
  assert.equal(psql(`select count(*) from public.cargo_customer_quote_followups where request_id='${request}';`),'0');
  assert.equal((await call(change('preparing',1))).ok,true);
 }finally{psql('update public.cargo_intake_control set intake_enabled=false;');}
});

test('acceptance wins against a real concurrent legacy follow-up closure and its failing write rolls back',async()=>{
 seed();assert.equal((await call(agreement())).ok,true);psql('update public.cargo_intake_control set intake_enabled=true;');
 const accepter=await session(),legacy=await session();
 try{
  await accepter.run('begin;');assert.equal((await result(accepter.run(accept()))).ok,true);
  const pending=legacy.start(followupClose);await waitBlocked(legacy,accepter);await accepter.run('commit;');
  await assert.rejects(pending,error=>error.sqlstate==='23514');
  assert.equal(stored().order_status,'accepted');
  assert.equal(psql(`select count(*) from public.cargo_customer_quote_followups where request_id='${request}';`),'0');
  assert.equal((await call(change('preparing',1))).ok,true);
 }finally{
  await accepter.stop();await legacy.stop();psql('update public.cargo_intake_control set intake_enabled=false;');
 }
});

test('legacy follow-up closure wins against acceptance and prevents contradictory formal acceptance',async()=>{
 seed();assert.equal((await call(agreement())).ok,true);psql('update public.cargo_intake_control set intake_enabled=true;');
 try{
  await ordered(followupClose,accept(),async(a,b)=>{assert.equal(a.ok,true);refused(b,'REQUEST_NOT_ORDERABLE');});
  assert.equal(stored().order_status,null);assert.equal(stored().agreement_count,1);
  assert.equal(psql(`select stage from public.cargo_customer_quote_followups where request_id='${request}';`),'closed_no_order');
 }finally{psql('update public.cargo_intake_control set intake_enabled=false;');}
});

const otherRequest='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
function seedOtherRequest(){
 psql(`insert into public.cargo_customer_intake_requests(id,source_draft_id,contact_hmac,encrypted_payload,status,retention_hold)
  values('${otherRequest}','dddddddd-dddd-4ddd-8ddd-dddddddddddd',decode(repeat('33',32),'hex'),decode(repeat('44',40),'hex'),'quoted',false);
  insert into public.cargo_customer_quote_replies(request_id,prepared_by,amount_yen,terms,valid_until,delivery_status,
   delivery_attempted_at,response_token_hmac,response_state,responded_at)
  values('${otherRequest}','${operator}',10000,repeat('synthetic other quote terms ',4),clock_timestamp()+interval '3 days','sent',
   clock_timestamp(),decode(repeat('cd',32),'hex'),'interested',clock_timestamp());`);
}

test('global operation collision across different consultations rolls back the losing newly inserted agreement',async()=>{
 seed();seedOtherRequest();const id=operation();
 const first=await session(),second=await session();
 try{
  await first.run('begin;');assert.equal((await result(first.run(agreement({p_operation_id:quote(id)})))).ok,true);
  const pending=second.start(agreement({p_request_id:quote(otherRequest),p_operation_id:quote(id)}));
  await waitBlocked(second,first);await first.run('commit;');
  refused(await result(pending),'OPERATION_ALREADY_RECORDED');
  assert.equal(psql(`select count(*) from public.cargo_customer_order_agreements where request_id='${otherRequest}';`),'0');
  assert.equal(psql(`select count(*) from public.cargo_customer_order_events where request_id='${otherRequest}';`),'0');
  assert.equal(stored().agreement_count,1);assert.equal(stored().event_count,1);
 }finally{await first.stop();await second.stop();}
});

test('global operation collision late in acceptance rolls back its order and retention-hold change together',async()=>{
 seed();seedOtherRequest();assert.equal((await call(agreement({p_request_id:quote(otherRequest)}))).ok,true);
 const id=operation(),first=await session(),second=await session();
 try{
  await first.run('begin;');assert.equal((await result(first.run(agreement({p_operation_id:quote(id)})))).ok,true);
  const pending=second.start(accept({p_request_id:quote(otherRequest),p_operation_id:quote(id)}));
  await waitBlocked(second,first);await first.run('commit;');
  refused(await result(pending),'OPERATION_ALREADY_RECORDED');
  assert.equal(psql(`select count(*) from public.cargo_customer_orders where request_id='${otherRequest}';`),'0');
  assert.equal(psql(`select retention_hold from public.cargo_customer_intake_requests where id='${otherRequest}';`),'f');
  assert.equal(psql(`select count(*) from public.cargo_customer_order_agreements where request_id='${otherRequest}';`),'1');
  assert.equal(psql(`select count(*) from public.cargo_customer_order_events where request_id='${otherRequest}';`),'1');
 }finally{await first.stop();await second.stop();}
});
