'use strict';
// New order API only: VM-executed handler, fake Auth/DB, no network or real secrets.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {stripTypeScriptTypes}=require('node:module'),{webcrypto}=require('node:crypto');
const source=fs.readFileSync(path.join(__dirname,'../integrations/cargo-customer-orders/index.ts'),'utf8');
assert.match(source,/^import \{createClient\} from "npm:@supabase\/supabase-js@2\.112\.3";/);
const code=stripTypeScriptTypes(source.replace(/^import .*;\n/,''));
const APP='https://app.rainbow-driver.com';
const USER='11111111-1111-4111-8111-111111111111',REQUEST='22222222-2222-4222-8222-222222222222';
const OPERATION='33333333-3333-4333-8333-333333333333';
const RAW_KEY=Buffer.alloc(32,17),NOW=new Date(Date.now()-60000).toISOString();
const CONDITIONS='架空の配送条件です。管理者が確認した条件を記録するためのテストです。';
const NOTE='架空の電話確認メモ';
async function cipher(payload){
 const key=await webcrypto.subtle.importKey('raw',RAW_KEY,'AES-GCM',false,['encrypt']);
 const iv=webcrypto.getRandomValues(new Uint8Array(12));
 const data=await webcrypto.subtle.encrypt({name:'AES-GCM',iv},key,new TextEncoder().encode(JSON.stringify(payload)));
 return '\\x'+Buffer.concat([Buffer.from([1]),iv,Buffer.from(data)]).toString('hex');
}
async function plain(source){
 const bytes=Buffer.from(source.slice(2),'hex'),key=await webcrypto.subtle.importKey('raw',RAW_KEY,'AES-GCM',false,['decrypt']);
 assert.equal(bytes[0],1);
 return JSON.parse(new TextDecoder().decode(await webcrypto.subtle.decrypt({name:'AES-GCM',iv:bytes.subarray(1,13)},key,bytes.subarray(13))));
}
function body(action='record_agreement',changes={}){
 const common={action,request_id:REQUEST,operation_id:OPERATION,expected_order_version:0};
 if(action==='read')return {action,request_id:REQUEST,...changes};
 if(action==='record_agreement')return {...common,expected_agreement_version:0,amount_yen:12345,
  pickup_at:'2030-01-01T01:00:00.000Z',delivery_at:'2030-01-01T02:00:00.000Z',
  customer_confirmed_at:NOW,confirmation_method:'phone',conditions:CONDITIONS,confirmation_note:NOTE,
  confirmation:'RECORD_OBSERVED_CUSTOMER_AGREEMENT',...changes};
 if(action==='accept_order'||action==='apply_agreement')return {...common,
  expected_order_version:action==='accept_order'?0:1,agreement_version:1,
  confirmation:action==='accept_order'?'RECORD_OPERATOR_ACCEPTANCE':'APPLY_RECORDED_AGREEMENT',...changes};
 return {...common,expected_order_version:1,next_status:'preparing',note:'',
  confirmation:'RECORD_DELIVERY_STATE_CHANGE',...changes};
}
function order(changes={}){return {request_id:REQUEST,status:'accepted',version:1,active_agreement_version:1,
 accepted_by:USER,accepted_at:NOW,updated_by:USER,updated_at:NOW,completed_at:null,cancelled_at:null,
 retention_policy:'undetermined_hold',retention_until:null,...changes}}
async function agreement(version=1,changes={}){return {request_id:REQUEST,version,amount_yen:12345,
 pickup_at:'2030-01-01T01:00:00.000Z',delivery_at:null,customer_confirmed_at:NOW,
 confirmation_method:'phone',recorded_by:USER,recorded_at:NOW,
 encrypted_payload:await cipher({conditions:CONDITIONS,confirmation_note:NOTE}),...changes}}
async function event(sequence=1,changes={}){return {request_id:REQUEST,sequence,operation_id:OPERATION,kind:'customer_agreement_recorded',
 from_status:null,to_status:null,order_version:0,agreement_version:1,actor_id:USER,recorded_at:NOW,
 encrypted_payload:await cipher({conditions:CONDITIONS,confirmation_note:NOTE}),...changes}}
function setup(options={}){
 const calls=[],rpcCalls=[],envReads=[];let fetchCalls=0,handler;
 const db={auth:{getUser:async token=>{calls.push({auth:token});if(options.authThrows)throw Error('private token');
  return {data:{user:options.invalidSession?null:{id:USER}},error:options.authError?{message:'private JWT'}:null}}},
  from(table){
   const query={table,selected:null,filters:[],orderBy:null,maximum:null};calls.push(query);
   const q={select(columns){query.selected=columns;return q},eq(k,v){query.filters.push(['eq',k,v]);return q},
    lt(k,v){query.filters.push(['lt',k,v]);return q},order(k,v){query.orderBy=[k,v];return q},
    limit(n){query.maximum=n;return q},
    async maybeSingle(){
     if(table==='cargo_operator_accounts')return {data:options.notOperator?null:{user_id:options.wrongMember?'44444444-4444-4444-8444-444444444444':USER},error:options.memberError?{message:'private member error'}:null};
     if(table==='cargo_customer_intake_requests')return {data:options.noRequest?null:{id:REQUEST},error:options.requestError?{message:'private request'}:null};
     if(table==='cargo_customer_orders')return {data:options.order===undefined?null:options.order,error:options.orderError?{message:'private order'}:null};
     throw Error('unexpected table');
    },then(resolve,reject){
     const records=table==='cargo_customer_order_agreements'?options.agreements??[]:table==='cargo_customer_order_events'?options.events??[]:null;
     return Promise.resolve({data:records,error:options.historyError?{message:'private history'}:null}).then(resolve,reject);
    }};return q;
  },async rpc(name,args){rpcCalls.push({name,args});if(options.rpcThrows)throw Error('private backend');
   if(name==='cargo_customer_order_read'){
    if(options.readResult!==undefined)return options.readResult;
    if(options.noRequest)return {data:{ok:false,reason:'NOT_FOUND'},error:null};
    if(options.requestError||options.orderError||options.historyError)return {data:null,error:{message:'private read error'}};
    return {data:{ok:true,request_id:REQUEST,order:options.order===undefined?null:options.order,
     agreements:options.agreements??[],events:options.events??[]},error:null};
   }
   if(options.rpcResult!==undefined)return options.rpcResult;
   const version=args.p_action==='record_agreement'?args.p_expected_order_version:args.p_expected_order_version+1;
   return {data:{ok:true,request_id:REQUEST,order_version:version,
    agreement_version:args.p_action==='record_agreement'?args.p_expected_agreement_version+1:args.p_agreement_version??1,
    status:args.p_action==='record_agreement'?null:args.p_action==='change_status'?args.p_next_status:'accepted'},error:null};
  }};
 const env={SUPABASE_URL:'https://fake.invalid',SUPABASE_SERVICE_ROLE_KEY:'fake-service-role',
  CARGO_CONTACT_AES_256_GCM_KEY:RAW_KEY.toString('base64'),...options.env};
 vm.runInNewContext(code,{createClient:(url,role,config)=>{calls.push({createClient:[url,role,config]});return db},
  crypto:webcrypto,Uint8Array,TextEncoder,TextDecoder,Response,Request,atob,
  fetch:()=>{fetchCalls++;throw Error('external calls forbidden')},
  Deno:{env:{get:k=>{envReads.push(k);return env[k]}},serve:f=>handler=f}});
 async function invoke(input=body(),extra={}){
  const headers={origin:APP,authorization:'Bearer fake-jwt','content-type':'application/json',...extra.headers};
  if(extra.noToken)delete headers.authorization;if(extra.noOrigin)delete headers.origin;
  const method=extra.method??'POST';
  const req=extra.request??new Request(APP,{method,headers,...(method==='POST'?{body:extra.raw??JSON.stringify(input)}:{})});
  const response=await handler(req);return {status:response.status,headers:response.headers,
   data:response.status===204?null:await response.json()};
 }
 return {invoke,calls,rpcCalls,envReads,get fetchCalls(){return fetchCalls}};
}
test('origin, method, login and preflight checks run before DB access',async()=>{
 for(const [extra,status] of [[{noOrigin:true},403],[{headers:{origin:'https://evil.invalid'}},403],
  [{noToken:true},401],[{method:'GET'},405],[{method:'OPTIONS'},204]]){
  const x=setup(),result=await x.invoke(body(),extra);assert.equal(result.status,status);assert.deepEqual(x.calls,[]);
 }
});
test('server-verified JWT and exact operator membership are required',async()=>{
 for(const [options,status] of [[{invalidSession:true},401],[{authError:true},401],
  [{notOperator:true},403],[{wrongMember:true},403],[{memberError:true},503],[{authThrows:true},503]]){
  const x=setup(options),r=await x.invoke();assert.equal(r.status,status);assert.equal(x.rpcCalls.length,0);
  assert.doesNotMatch(JSON.stringify(r.data),/private|fake-jwt/);
 }
});
test('unknown keys, malformed JSON and action names are rejected without DB access',async()=>{
 for(const input of [[],null,body('unknown'),body('record_agreement',{unexpected:'secret'}),
  body('read',{operation_id:OPERATION})]){
  const x=setup(),r=await x.invoke(input);assert.equal(r.status,422);assert.deepEqual(x.calls,[]);
 }
 const x=setup();assert.equal((await x.invoke(body(),{raw:'{"bad":'})).status,422);
});
test('identifier, confirmation and version inputs are strict',async()=>{
 for(const changes of [{request_id:'bad'},{operation_id:'bad'},{expected_order_version:-1},
  {expected_order_version:1.5},{expected_agreement_version:-1},{confirmation:'YES'},
  {expected_order_version:'0'},{expected_agreement_version:Number.MAX_SAFE_INTEGER+1}]){
  const x=setup();assert.equal((await x.invoke(body('record_agreement',changes))).status,422);assert.equal(x.calls.length,0);
 }
});
test('agreement validates amounts, canonical timestamps, bounds and explicit observed method',async()=>{
 for(const changes of [{amount_yen:0},{amount_yen:10000001},{amount_yen:1.1},
  {pickup_at:'2030-01-01'},{delivery_at:'2029-01-01T00:00:00.000Z'},
  {customer_confirmed_at:'2099-01-01T00:00:00.000Z'},{confirmation_method:'customer_authenticated'},
  {conditions:'short'},{conditions:'a'.repeat(1201)},{confirmation_note:'x'},{confirmation_note:'a'.repeat(601)}]){
  const x=setup();assert.equal((await x.invoke(body('record_agreement',changes))).status,422);assert.equal(x.rpcCalls.length,0);
 }
});
test('input timestamps reject expanded years and year zero while retaining years 0001 through 9999',async()=>{
 for(const field of ['pickup_at','delivery_at','customer_confirmed_at']){
  for(const value of ['+010000-01-01T00:00:00.000Z','0000-01-01T00:00:00.000Z']){
   const x=setup(),r=await x.invoke(body('record_agreement',{[field]:value}));
   assert.equal(r.status,422);assert.equal(x.rpcCalls.length,0);
  }
 }
 for(const pickup_at of ['0001-01-01T00:00:00.000Z','9999-12-31T23:59:59.999Z']){
  const x=setup(),r=await x.invoke(body('record_agreement',{pickup_at,delivery_at:null}));
  assert.equal(r.status,200);assert.equal(x.rpcCalls[0].args.p_pickup_at,pickup_at);
 }
});
test('malformed and missing AES configuration fails closed',async()=>{
 for(const value of ['',Buffer.alloc(31).toString('base64'),'not-base64','YWJj']){
  const x=setup({env:{CARGO_CONTACT_AES_256_GCM_KEY:value}});assert.equal((await x.invoke()).status,503);assert.equal(x.rpcCalls.length,0);
 }
 const x=setup({env:{SUPABASE_SERVICE_ROLE_KEY:''}});assert.equal((await x.invoke()).status,503);
});
test('agreement encrypts conditions and observation note using compatible randomized version-1 AES-GCM',async()=>{
 const x=setup();const a=await x.invoke(),b=await x.invoke();assert.equal(a.status,200);assert.equal(b.status,200);
 const first=x.rpcCalls[0],second=x.rpcCalls[1];assert.equal(first.name,'cargo_customer_order_command');
 assert.deepEqual(await plain(first.args.p_encrypted_payload),{conditions:CONDITIONS,confirmation_note:NOTE});
 assert.notEqual(first.args.p_encrypted_payload,second.args.p_encrypted_payload);
 assert.doesNotMatch(JSON.stringify(first.args),new RegExp(NOTE));
 assert.equal(first.args.p_operator_id,USER);assert.equal(first.args.p_agreement_version,null);assert.equal(first.args.p_next_status,null);
 assert.equal(a.data.customer_agreement_source,'operator_observation');
});
test('intake switch and mail settings are neither queried nor changed for existing-work commands',async()=>{
 const x=setup(),r=await x.invoke();assert.equal(r.status,200);assert.equal(x.fetchCalls,0);
 assert.ok(x.calls.every(q=>!['cargo_intake_control','cargo_email_send_budget'].includes(q.table)));
 assert.deepEqual(x.envReads,['SUPABASE_URL','SUPABASE_SERVICE_ROLE_KEY','CARGO_CONTACT_AES_256_GCM_KEY']);
 for(const flag of ['legal_contract_determined','customer_notified','payment_created','dispatch_created'])assert.equal(r.data[flag],false);
});
test('accept and apply agreement use distinct explicit confirmations and RPC arguments',async()=>{
 for(const action of ['accept_order','apply_agreement']){
  const x=setup(),r=await x.invoke(body(action));assert.equal(r.status,200);const a=x.rpcCalls[0].args;
  assert.equal(a.p_action,action);assert.equal(a.p_agreement_version,1);
  for(const key of ['p_expected_agreement_version','p_amount_yen','p_pickup_at','p_delivery_at','p_customer_confirmed_at','p_confirmation_method','p_encrypted_payload','p_next_status'])assert.equal(a[key],null);
 }
 for(const input of [body('accept_order',{expected_order_version:1}),body('apply_agreement',{expected_order_version:0}),
  body('accept_order',{agreement_version:0}),body('accept_order',{confirmation:'APPLY_RECORDED_AGREEMENT'})]){
  const x=setup();assert.equal((await x.invoke(input)).status,422);assert.equal(x.rpcCalls.length,0);
 }
});
test('status updates require explicit manual action; cancellation requires a note',async()=>{
 for(const next_status of ['preparing','in_transit','completed','cancelled']){
  const x=setup(),r=await x.invoke(body('change_status',{next_status,note:next_status==='cancelled'?'架空の中止理由':''}));
  assert.equal(r.status,200);assert.equal(r.data.status,next_status);
  assert.deepEqual(await plain(x.rpcCalls[0].args.p_encrypted_payload),{note:next_status==='cancelled'?'架空の中止理由':''});
 }
 for(const changes of [{next_status:'accepted'},{next_status:'automatic'},{next_status:'cancelled',note:''},
  {note:'a'.repeat(601)},{expected_order_version:0}]){
  const x=setup();assert.equal((await x.invoke(body('change_status',changes))).status,422);
 }
});
test('conflicting or duplicate DB commands return one fixed 409 response without fallback',async()=>{
 for(const reason of ['STALE_VERSION','OPERATION_ALREADY_USED','private customer details']){
  const x=setup({rpcResult:{data:{ok:false,reason},error:null}}),r=await x.invoke();
  assert.equal(r.status,409);assert.equal(r.data.error,'ORDER_CONFLICT');assert.equal(x.rpcCalls.length,1);
  assert.doesNotMatch(JSON.stringify(r.data),/STALE|OPERATION_ALREADY|private/);
  assert.equal(x.calls.filter(q=>q.table&&q.table!=='cargo_operator_accounts').length,0);
 }
});
test('RPC errors, exceptions and malformed success cannot report a saved operation',async()=>{
 for(const options of [{rpcResult:{data:null,error:null}},{rpcResult:{data:{ok:true},error:null}},
  {rpcResult:{data:{ok:true,request_id:REQUEST,order_version:0,agreement_version:1,status:null},error:{message:'private failure'}}},
  {rpcThrows:true},{rpcResult:{data:{ok:true,request_id:USER,order_version:0,agreement_version:1,status:null},error:null}}]){
  const x=setup(options),r=await x.invoke();assert.equal(r.status,503);assert.equal(x.rpcCalls.length,1);
  assert.deepEqual(r.data,{error:'ORDER_UNAVAILABLE'});assert.equal(x.fetchCalls,0);
 }
});
test('body size is bounded before JSON decode including streaming and declared lengths',async()=>{
 const x=setup(),r=await x.invoke(body(),{raw:' '.repeat(36001)});assert.equal(r.status,413);assert.equal(x.calls.length,0);
 const y=setup();assert.equal((await y.invoke(body(),{headers:{'content-length':'36001'}})).status,413);
 let cancelled=false;
 const stream=new ReadableStream({pull(c){c.enqueue(new Uint8Array(20000));},cancel(){cancelled=true}});
 const z=setup(),request=new Request(APP,{method:'POST',headers:{origin:APP,authorization:'Bearer fake'},body:stream,duplex:'half'});
 assert.equal((await z.invoke(body(),{request})).status,413);assert.equal(cancelled,true);assert.equal(z.calls.length,0);
});
test('invalid UTF-8 and character overrun are rejected without DB access',async()=>{
 for(const raw of [new Uint8Array([0xff]),' '.repeat(12001)]){
  const x=setup(),r=await x.invoke(body(),{raw});assert.ok([413,422].includes(r.status));assert.equal(x.calls.length,0);
 }
});
test('read requires an existing request and reports backend failures without data',async()=>{
 for(const [options,status] of [[{noRequest:true},404],[{requestError:true},503],[{orderError:true},503],[{historyError:true},503]]){
  const x=setup(options),r=await x.invoke(body('read'));assert.equal(r.status,status);assert.equal(x.rpcCalls.length,1);
  assert.doesNotMatch(JSON.stringify(r.data),/private|encrypted_payload/);
 }
});
test('read decrypts whitelisted agreement/history fields and returns no contact payload',async()=>{
 const a=await agreement(),e=await event(),x=setup({order:order({private:'do not return'}),
  agreements:[{...a,private:'do not return'}],events:[{...e,private:'do not return'}]});
 const r=await x.invoke(body('read'));assert.equal(r.status,200);assert.equal(r.data.agreements[0].conditions,CONDITIONS);
 assert.equal(r.data.events[0].payload.confirmation_note,NOTE);assert.equal(r.data.snapshot_consistent,true);
 assert.equal(r.data.order.retention_until,null);assert.equal(r.data.order.retention_policy,'undetermined_hold');
 assert.doesNotMatch(JSON.stringify(r.data),/encrypted_payload|do not return|fake-service-role|fake-jwt/);
 assert.equal(x.rpcCalls.length,1);assert.equal(x.fetchCalls,0);
 assert.equal(x.rpcCalls[0].name,'cargo_customer_order_read');
 assert.ok(x.calls.every(q=>!q.table||q.table==='cargo_operator_accounts'));
 assert.equal(r.headers.get('cache-control'),'no-store');
});
test('read supports absent order and encrypted delivery-state note',async()=>{
 const e=await event(1,{kind:'status_changed',from_status:'accepted',to_status:'cancelled',order_version:2,
  encrypted_payload:await cipher({note:'架空の中止理由'})});
 const x=setup({events:[e]}),r=await x.invoke(body('read'));assert.equal(r.status,200);assert.equal(r.data.order,null);
 assert.deepEqual(r.data.events[0].payload,{note:'架空の中止理由'});
});
test('operator read includes the operation ID for response-loss reconciliation and rejects invalid IDs',async()=>{
 const e=await event(1,{encrypted_payload:null}),x=setup({events:[e]}),r=await x.invoke(body('read'));
 assert.equal(r.status,200);assert.equal(r.data.events[0].operation_id,OPERATION);
 assert.equal(r.data.events[0].payload,null);
 const denied=setup({notOperator:true,events:[e]});assert.equal((await denied.invoke(body('read'))).status,403);
 assert.equal(denied.rpcCalls.length,0);
 const corrupt=setup({events:[{...e,operation_id:'not-a-uuid'}]});
 assert.equal((await corrupt.invoke(body('read'))).status,503);
});
test('read keyset pagination limits each history and exposes cursors without skipping row 51',async()=>{
 const agreements=await Promise.all(Array.from({length:51},(_,i)=>agreement(60-i)));
 const events=await Promise.all(Array.from({length:51},(_,i)=>event(100-i)));
 const x=setup({agreements,events}),r=await x.invoke(body('read',{before_agreement_version:61,before_event_sequence:101}));
 assert.equal(r.status,200);assert.equal(r.data.agreements.length,50);assert.equal(r.data.events.length,50);
 assert.equal(r.data.next_before_agreement_version,11);assert.equal(r.data.next_before_event_sequence,51);
 assert.equal(x.rpcCalls.length,1);
 assert.deepEqual(JSON.parse(JSON.stringify(x.rpcCalls[0].args)),{p_request_id:REQUEST,p_operator_id:USER,p_before_event_sequence:101,p_before_agreement_version:61});
});
test('read accepts PostgreSQL offset/microsecond timestamps without weakening input timestamp rules',async()=>{
 const timestamp='2026-10-17T02:00:00.123456+00:00';
 const a=await agreement(1,{recorded_at:timestamp,customer_confirmed_at:timestamp,pickup_at:'2030-01-01T01:00:00+00:00'});
 const e=await event(1,{recorded_at:timestamp});
 const x=setup({order:order({accepted_at:timestamp,updated_at:timestamp}),agreements:[a],events:[e]});
 const r=await x.invoke(body('read'));assert.equal(r.status,200);assert.equal(r.data.events[0].recorded_at,timestamp);
 const y=setup();assert.equal((await y.invoke(body('record_agreement',{customer_confirmed_at:timestamp}))).status,422);
});
test('read RPC missing, denied or malformed stops without a direct-table fallback',async()=>{
 for(const [readResult,status] of [[{data:null,error:null},503],[{data:null,error:{message:'private rpc missing'}},503],
  [{data:{ok:false,reason:'OPERATOR_ONLY'},error:null},403],[{data:{ok:false,reason:'private denial'},error:null},503],
  [{data:{ok:true,request_id:USER,order:null,agreements:[],events:[]},error:null},503]]){
  const x=setup({readResult}),r=await x.invoke(body('read'));assert.equal(r.status,status);
  assert.equal(x.rpcCalls.length,1);assert.ok(x.calls.every(q=>!q.table||q.table==='cargo_operator_accounts'));
  assert.doesNotMatch(JSON.stringify(r.data),/private/);
 }
});
test('a mismatched successful RPC version or status cannot claim the requested operation succeeded',async()=>{
 for(const changes of [{order_version:3},{agreement_version:2},{status:'cancelled'}]){
  const x=setup({rpcResult:{data:{ok:true,request_id:REQUEST,order_version:1,agreement_version:1,status:'accepted',...changes},error:null}});
  assert.equal((await x.invoke(body('accept_order'))).status,503);
 }
});
test('read rejects bad cursors and corrupt, cross-request or unordered stored history',async()=>{
 for(const input of [body('read',{before_event_sequence:0}),body('read',{before_agreement_version:'1'})]){
  const x=setup();assert.equal((await x.invoke(input)).status,422);assert.equal(x.calls.length,0);
 }
 for(const options of [{order:order({retention_policy:'30_days'})},{agreements:[await agreement(1,{request_id:USER})]},
  {agreements:[await agreement(1,{encrypted_payload:'\\x010000'})]},
  {agreements:[await agreement(1,{encrypted_payload:await cipher({conditions:CONDITIONS,confirmation_note:NOTE,unexpected:'private'})})]},
  {events:[await event(1),await event(2)]},{events:[await event(1,{kind:'unknown'})]}]){
  const x=setup(options),r=await x.invoke(body('read'));assert.equal(r.status,503);assert.deepEqual(r.data,{error:'ORDER_UNAVAILABLE'});
 }
});
