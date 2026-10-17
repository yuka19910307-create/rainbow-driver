'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {stripTypeScriptTypes}=require('node:module');
const {webcrypto}=require('node:crypto');

// Exercise only the changed decision path, with no SDK, service or old suite.
const source=fs.readFileSync(path.join(__dirname,'../integrations/cargo-customer-intake/operator.ts'),'utf8');
const code=stripTypeScriptTypes(source.replace(/^import .*;\n/,''),{mode:'strip'});
const owner='11111111-1111-4111-8111-111111111111';
const id='22222222-2222-4222-8222-222222222222';
const otherId='33333333-3333-4333-8333-333333333333';
const origin='https://app.rainbow-driver.com';
const decision={action:'decision',id,expected_status:'operator_reviewing',next_status:'declined'};
const plain=value=>JSON.parse(JSON.stringify(value));

function harness(options={}){
 const calls={client:0,auth:[],membership:[],rpc:[],unexpectedTables:[],fetch:0};
 let handler;
 const env={SUPABASE_URL:'https://synthetic.invalid',SUPABASE_SERVICE_ROLE_KEY:'synthetic-only',
  CARGO_CONTACT_AES_256_GCM_KEY:Buffer.alloc(32,19).toString('base64')};
 const db={
  auth:{getUser:async token=>{
   calls.auth.push(token);
   return {data:{user:options.loggedIn===false?null:{id:owner}},error:options.authError||null};
  }},
  from(table){
   if(table!=='cargo_operator_accounts'){
    calls.unexpectedTables.push(table);
    throw Error('Direct request-table access is forbidden in decision tests');
   }
   const record={table};calls.membership.push(record);
   const query={
    select(columns){record.columns=columns;return query},
    eq(column,value){record.column=column;record.value=value;return query},
    async maybeSingle(){
     return {data:options.operator===false?null:{user_id:owner},error:options.memberError||null};
    }
   };
   return query;
  }
 };
 if(options.rpcMissing!==true)db.rpc=async(name,args)=>{
  calls.rpc.push({name,args:plain(args)});
  if(options.rpcThrows)throw Error('Synthetic RPC failure');
  if(Object.hasOwn(options,'rpcResult'))return options.rpcResult;
  return {data:{ok:true,id,status:decision.next_status},error:null};
 };
 const context={Request,Response,Uint8Array,TextEncoder,TextDecoder,atob,crypto:webcrypto,
  Deno:{serve:f=>{handler=f},env:{get:key=>env[key]}},
  createClient:(url,key,settings)=>{
   calls.client++;
   assert.equal(url,env.SUPABASE_URL);
   assert.equal(key,env.SUPABASE_SERVICE_ROLE_KEY);
   assert.deepEqual(plain(settings),{auth:{persistSession:false,autoRefreshToken:false}});
   return db;
  },
  fetch:async()=>{calls.fetch++;throw Error('Network is forbidden in decision tests')}
 };
 vm.createContext(context);vm.runInContext(code,context);
 return {
  calls,
  async call(body=decision,{authorization='Bearer synthetic-session',requestOrigin=origin}={}){
   const response=await handler(new Request('https://synthetic.invalid/operator',{
    method:'POST',headers:{origin:requestOrigin,authorization},body:JSON.stringify(body)
   }));
   const result={status:response.status,body:await response.json()};
   assert.equal(response.headers.get('cache-control'),'no-store');
   assert.equal(calls.fetch,0,'Decision must not send email or contact external services');
   assert.deepEqual(calls.unexpectedTables,[],'Decision must not fall back to a direct table operation');
   return result;
  }
 };
}

test('decision requires a bearer before creating a client or invoking RPC',async()=>{
 const h=harness();
 assert.deepEqual(await h.call(decision,{authorization:''}),{status:401,body:{error:'LOGIN_REQUIRED'}});
 assert.equal(h.calls.client,0);assert.equal(h.calls.rpc.length,0);
});

test('decision rejects a missing or failed authenticated session',async()=>{
 for(const options of [{loggedIn:false},{authError:{message:'synthetic-auth-error'}}]){
  const h=harness(options);
  assert.deepEqual(await h.call(),{status:401,body:{error:'INVALID_SESSION'}});
  assert.equal(h.calls.membership.length,0);assert.equal(h.calls.rpc.length,0);
 }
});

test('decision requires operator membership and rejects membership read errors',async()=>{
 for(const options of [{operator:false},{memberError:{message:'synthetic-membership-error'}}]){
  const h=harness(options);
  assert.deepEqual(await h.call(),{status:403,body:{error:'OPERATOR_ONLY'}});
  assert.deepEqual(h.calls.membership,[{table:'cargo_operator_accounts',columns:'user_id',column:'user_id',value:owner}]);
  assert.equal(h.calls.rpc.length,0);
 }
});

test('decision maps the authenticated operator and expected state into exactly one RPC',async()=>{
 const h=harness();
 assert.equal((await h.call()).status,200);
 assert.deepEqual(h.calls.auth,['synthetic-session']);
 assert.deepEqual(h.calls.rpc,[{name:'cargo_customer_request_decide',args:{
  p_request_id:id,p_operator_id:owner,p_expected_status:'operator_reviewing',p_next_status:'declined'
 }}]);
 assert.equal(h.calls.membership.length,1);
});

test('begin-review decision preserves its distinct expected and next states',async()=>{
 const h=harness({rpcResult:{data:{ok:true,id,status:'operator_reviewing'},error:null}});
 const body={...decision,expected_status:'pending_operator_review',next_status:'operator_reviewing'};
 assert.equal((await h.call(body)).status,200);
 assert.deepEqual(h.calls.rpc[0].args,{p_request_id:id,p_operator_id:owner,
  p_expected_status:'pending_operator_review',p_next_status:'operator_reviewing'});
});

test('an RPC error cannot expose details or fall back to a direct table update',async()=>{
 const h=harness({rpcResult:{data:{ok:true,id,status:'declined'},error:{message:'synthetic-private-reason'}}});
 assert.deepEqual(await h.call(),{status:503,body:{error:'DECISION_UNAVAILABLE'}});
 assert.equal(h.calls.rpc.length,1);
});

test('a missing RPC or thrown RPC stops without attempting a legacy update',async()=>{
 for(const options of [{rpcMissing:true},{rpcThrows:true}]){
  const h=harness(options),result=await h.call();
  assert.equal(result.status,503);
  assert.deepEqual(result.body,{error:'QUEUE_UNAVAILABLE'});
  assert.equal(h.calls.rpc.length,options.rpcMissing?0:1);
 }
});

test('null or missing RPC data is unavailable and never triggers a fallback',async()=>{
 for(const rpcResult of [{data:null,error:null},{error:null}]){
  const h=harness({rpcResult});
  assert.deepEqual(await h.call(),{status:503,body:{error:'DECISION_UNAVAILABLE'}});
  assert.equal(h.calls.rpc.length,1);
 }
});

test('a rejected or non-success RPC result produces a fixed conflict without its raw reason',async()=>{
 for(const data of [{ok:false,reason:'synthetic-private-reason'},{ok:false},{ok:'true',id,status:'declined'},{}]){
  const h=harness({rpcResult:{data,error:null}});
  assert.deepEqual(await h.call(),{status:409,body:{error:'DECISION_CONFLICT'}});
  assert.equal(h.calls.rpc.length,1);
 }
});

test('success with a mismatched or missing request identity is uncertain',async()=>{
 for(const data of [{ok:true,id:otherId,status:'declined'},{ok:true,status:'declined'}]){
  const h=harness({rpcResult:{data,error:null}});
  assert.deepEqual(await h.call(),{status:503,body:{error:'DECISION_RESULT_UNCERTAIN'}});
  assert.equal(h.calls.rpc.length,1);
 }
});

test('success with a mismatched or missing resulting status is uncertain',async()=>{
 for(const data of [{ok:true,id,status:'quoted'},{ok:true,id}]){
  const h=harness({rpcResult:{data,error:null}});
  assert.deepEqual(await h.call(),{status:503,body:{error:'DECISION_RESULT_UNCERTAIN'}});
  assert.equal(h.calls.rpc.length,1);
 }
});

test('successful decision returns fixed no-payment, no-driver and no-notification flags',async()=>{
 const h=harness({rpcResult:{data:{ok:true,id,status:'declined',reason:'synthetic-private-reason',
  payment_created:true,driver_assigned:true,customer_notified:true},error:null}});
 assert.deepEqual(await h.call(),{status:200,body:{ok:true,id,status:'declined',
  payment_created:false,driver_assigned:false,customer_notified:false}});
 assert.equal(h.calls.rpc.length,1);
});

test('unknown or missing decision keys are rejected before auth or RPC',async()=>{
 const {expected_status:omitted,...missing}=decision;
 for(const body of [{...decision,operator_id:otherId},{...decision,force:true},missing]){
  const h=harness();
  assert.deepEqual(await h.call(body),{status:422,body:{error:'INVALID_INPUT'}});
  assert.equal(h.calls.client,0);assert.equal(h.calls.rpc.length,0);
 }
});

test('invalid identifiers and non-decision states are rejected before RPC',async()=>{
 for(const body of [{...decision,id:'not-a-uuid'},
  {...decision,expected_status:'quoted'},{...decision,expected_status:null},
  {...decision,next_status:'closed'},{...decision,next_status:'quoted'},
  {...decision,next_status:null}]){
  const h=harness();
  assert.deepEqual(await h.call(body),{status:422,body:{error:'INVALID_INPUT'}});
  assert.equal(h.calls.client,0);assert.equal(h.calls.rpc.length,0);
 }
});

test('a foreign origin cannot authenticate, mutate state or contact a service',async()=>{
 const h=harness();
 assert.deepEqual(await h.call(decision,{requestOrigin:'https://foreign.invalid'}),
  {status:403,body:{error:'ORIGIN_DENIED'}});
 assert.equal(h.calls.client,0);assert.equal(h.calls.rpc.length,0);
});
