'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../integrations/cargo-production-readiness/index.ts'),'utf8');
const runtimeSource=source.replace(/^import .*;\n/,'');
const {stripTypeScriptTypes}=require('node:module');
const code=stripTypeScriptTypes(runtimeSource,{mode:'strip'});

async function run(options={}){
 const env={
  SUPABASE_URL:'https://kvoaorzdewwirqryeizq.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY:'synthetic-service-secret',
  CARGO_INTAKE_HMAC_KEY:Buffer.alloc(32,1).toString('base64'),
  CARGO_CONTACT_AES_256_GCM_KEY:Buffer.alloc(32,2).toString('base64'),
  CARGO_CUSTOMER_TURNSTILE_SITE_KEY:'synthetic-site-key',
  CARGO_CUSTOMER_TURNSTILE_SECRET:'synthetic-captcha-secret',
  CARGO_CUSTOMER_EMAIL_PROVIDER:'resend',
  CARGO_CUSTOMER_RESEND_API_KEY:'synthetic-email-secret',
  CARGO_CUSTOMER_FROM_EMAIL:'synthetic-sender@example.invalid',
  ...options.env
 };
 const rows={
  cargo_operator_accounts:{user_id:'synthetic-operator'},
  cargo_intake_control:{intake_enabled:false,captcha_required:true,contact_verification_required:true},
  cargo_customer_mail_budget:{enabled:false,hourly_limit:1,daily_limit:1,
   hour_started_at:'2026-10-16T15:00:00+00:00',day_started_at:'2026-10-17',hour_attempts:0,day_attempts:0},
  ...options.rows
 };
 const envReads=[],reads=[],calls=[];
 let handler;
 const db={
  auth:{getUser:async token=>{
   calls.push(['getUser',token]);
   if(options.throwAuth)throw Error('synthetic provider error contains a secret');
   return options.badAuth?{error:{message:'synthetic-secret'},data:null}:{data:{user:{id:'synthetic-operator'}}};
  }},
  from:table=>{
   assert(Object.hasOwn(rows,table),'unexpected table access');
   const operation={table};reads.push(operation);
   const query={
    select:columns=>{operation.columns=columns;return query;},
    eq:(column,value)=>{operation.filter=[column,value];return query;},
    maybeSingle:async()=>({data:rows[table],error:options.errorTable===table?{message:'synthetic-db-secret'}:null})
   };
   return query;
  }
 };
 vm.runInNewContext(code,{
  createClient:(url,key,config)=>{calls.push(['createClient',url,key,config]);return db;},
  Deno:{serve:fn=>{handler=fn;},env:{get:name=>{envReads.push(name);return env[name];}}},
  Response,Uint8Array,atob,TextDecoder,
  fetch:()=>assert.fail('no direct network, provider or mail requests allowed'),
  console:{log:()=>assert.fail('no logging allowed'),error:()=>assert.fail('no logging allowed')}
 });
 const headers=new Headers({origin:'https://app.rainbow-driver.com',authorization:'Bearer synthetic-session',...options.headers});
 if(options.noAuth)headers.delete('authorization');
 const method=options.method||'POST',streamState={pulls:0,cancelled:false};
 const requestOptions={method,headers};
 if(!['GET','HEAD','OPTIONS'].includes(method)){
  requestOptions.duplex='half';
  requestOptions.body=options.chunks?new ReadableStream({
   pull(controller){
    const index=streamState.pulls++;
    if(index<options.chunks.length)controller.enqueue(options.chunks[index]);
    else controller.close();
   },
   cancel(){streamState.cancelled=true;}
  },{highWaterMark:0}):options.body??'{"action":"status"}';
 }
 const response=await handler(new Request('https://example.invalid/functions/v1/cargo-production-readiness',requestOptions));
 const raw=await response.text();
 return {status:response.status,body:raw?JSON.parse(raw):null,raw,headers:response.headers,envReads,reads,calls,env,streamState};
}

function noCargoSecretsRead(result){
 assert(!result.envReads.some(name=>name.startsWith('CARGO_')),'must not inspect customer secrets before authorization and OFF gates');
}

test('authenticated protected-OFF status returns booleans and the shared disabled cap only',async()=>{
 const result=await run();
 assert.equal(result.status,200);
 assert.equal(result.headers.get('cache-control'),'no-store');
 assert.equal(result.body.public_intake_enabled,false);
 assert.equal(result.body.runtime_scope,'THIS_DIAGNOSTIC_FUNCTION_ONLY');
 assert.equal(result.body.customer_configuration.configuration_recognized,true);
 assert.equal(result.body.customer_mail_budget.enabled,false);
 assert.equal(result.body.customer_mail_budget.hourly_limit,1);
 assert.equal(result.body.customer_mail_budget.limits_approved_for_production,false);
 assert.equal(result.body.launch_ready,false);
 assert.equal(result.body.email_sent,false);
 assert.equal(result.body.data_changed,false);
 assert(Object.values(result.body.external_checks).every(value=>value==='not_checked'));
 assert.deepEqual(result.reads.map(read=>read.table),['cargo_operator_accounts','cargo_intake_control','cargo_customer_mail_budget']);
 assert.deepEqual(result.reads[0].filter,['user_id','synthetic-operator']);
 assert(result.reads.every(read=>!read.columns.includes('*')));
 for(const [name,value] of Object.entries(result.env)){
  if(name==='SUPABASE_URL'||name==='CARGO_CUSTOMER_EMAIL_PROVIDER')continue;
  assert(!result.raw.includes(value),`${name} value must not be returned`);
 }
 assert(!result.raw.includes('synthetic-session'));
});

test('origin, method, login and strict status-only input gates run before inspecting settings',async()=>{
 for(const [options,status] of [
  [{headers:{origin:'https://untrusted.invalid'}},403],
  [{method:'GET'},405],[{noAuth:true},401],
  [{body:'[]'},400],[{body:'null'},400],[{body:'not json'},400],
  [{body:'{"action":"send"}'},400],
  [{body:'{"action":"status","email":"synthetic@example.invalid"}'},400],
  [{body:' '.repeat(129)},400]
 ]){
  const result=await run(options);assert.equal(result.status,status);
  assert.equal(result.envReads.length,0);assert.equal(result.calls.length,0);
 }
 const preflight=await run({method:'OPTIONS'});
 assert.equal(preflight.status,204);assert.equal(preflight.envReads.length,0);
});

test('body size and UTF-8 failures stop before auth or settings, including chunked or misleading lengths',async()=>{
 const bytes=value=>new TextEncoder().encode(value);
 const rejected=[
  {options:{headers:{'content-length':'385'},chunks:[bytes('{"action":"status"}')]},status:413,pulls:0},
  {options:{body:'x'.repeat(385)},status:413},
  {options:{headers:{'content-length':'18'},chunks:[bytes('x'.repeat(384)),bytes('x'),bytes('unread tail')]},status:413,pulls:2},
  {options:{chunks:[bytes('x'.repeat(384)),bytes('x'),bytes('unread tail')]},status:413,pulls:2},
  {options:{body:' '.repeat(129)},status:400},
  {options:{chunks:[new Uint8Array([0xff]),bytes('unread tail')]},status:400,pulls:1}
 ];
 for(const {options,status,pulls} of rejected){
  const result=await run(options);
  assert.equal(result.status,status);
  assert.equal(result.envReads.length,0);
  assert.equal(result.calls.length,0);
  assert.equal(result.reads.length,0);
  if(pulls!==undefined){
   assert.equal(result.streamState.pulls,pulls);
   assert.equal(result.streamState.cancelled,true);
  }
 }
 const atCharacterLimit=await run({body:'{"action":"status"}'.padEnd(128,' ')});
 assert.equal(atCharacterLimit.status,200);
 const splitUtf8=await run({chunks:[new Uint8Array([0xe3]),new Uint8Array([0x81,0x82])]});
 assert.equal(splitUtf8.status,400);
 assert.equal(splitUtf8.streamState.cancelled,false,'a valid split UTF-8 sequence reaches JSON validation');
 assert.equal(splitUtf8.envReads.length,0);
});

test('staging/missing server credentials and invalid/non-operator sessions cannot read cargo settings',async()=>{
 for(const [options,status] of [
  [{env:{SUPABASE_URL:'https://hvdoqcrnztqmbzgwrovd.supabase.co'}},503],
  [{env:{SUPABASE_SERVICE_ROLE_KEY:''}},503],
  [{badAuth:true},401],[{throwAuth:true},503],
  [{rows:{cargo_operator_accounts:null}},403],
  [{rows:{cargo_operator_accounts:{user_id:'other-operator'}}},403],
  [{errorTable:'cargo_operator_accounts'},403]
 ]){
  const result=await run(options);assert.equal(result.status,status);noCargoSecretsRead(result);
  assert(!result.raw.includes('synthetic-'));
 }
});

test('protected intake OFF and disabled valid mail budget are required before reading cargo secrets',async()=>{
 for(const gate of [null,{intake_enabled:true,captcha_required:true,contact_verification_required:true},
  {intake_enabled:false,captcha_required:false,contact_verification_required:true},
  {intake_enabled:false,captcha_required:true,contact_verification_required:false},
  {intake_enabled:0,captcha_required:true,contact_verification_required:true}]){
  const result=await run({rows:{cargo_intake_control:gate}});
  assert.equal(result.status,423);noCargoSecretsRead(result);
 }
 const base={enabled:false,hourly_limit:1,daily_limit:1,hour_started_at:'2026-10-16T15:00:00Z',
  day_started_at:'2026-10-17',hour_attempts:0,day_attempts:0};
 for(const budget of [null,{...base,enabled:true},{...base,enabled:'false'},
  {...base,hourly_limit:0},{...base,hourly_limit:2},{...base,daily_limit:10001},
  {...base,hour_attempts:-1},{...base,day_attempts:0.5},{...base,hour_started_at:'invalid'}]){
  const result=await run({rows:{cargo_customer_mail_budget:budget}});
  assert([423,503].includes(result.status));noCargoSecretsRead(result);
 }
 for(const errorTable of ['cargo_intake_control','cargo_customer_mail_budget']){
  const result=await run({errorTable});assert([423,503].includes(result.status));
  noCargoSecretsRead(result);assert(!result.raw.includes('synthetic-db-secret'));
 }
});

test('missing and malformed settings are visible as checks, without disclosure or provider verification',async()=>{
 const flags={
  CARGO_INTAKE_HMAC_KEY:'verification_key_configured',
  CARGO_CONTACT_AES_256_GCM_KEY:'encryption_key_configured',
  CARGO_CUSTOMER_TURNSTILE_SITE_KEY:'captcha_site_key_present',
  CARGO_CUSTOMER_TURNSTILE_SECRET:'captcha_secret_present',
  CARGO_CUSTOMER_EMAIL_PROVIDER:'email_provider_configured',
  CARGO_CUSTOMER_RESEND_API_KEY:'email_api_key_present',
  CARGO_CUSTOMER_FROM_EMAIL:'sender_address_format_valid'
 };
 for(const [name,flag] of Object.entries(flags)){
  const result=await run({env:{[name]:''}});
  assert.equal(result.status,200);assert.equal(result.body.customer_configuration[flag],false);
  assert.equal(result.body.customer_configuration.configuration_recognized,false);
 }
 for(const length of [31,33,48,63,65]){
  const result=await run({env:{CARGO_INTAKE_HMAC_KEY:Buffer.alloc(length,3).toString('base64')}});
  assert.equal(result.body.customer_configuration.verification_key_configured,false);
 }
 for(const length of [32,64]){
  const result=await run({env:{CARGO_INTAKE_HMAC_KEY:Buffer.alloc(length,3).toString('base64')}});
  assert.equal(result.body.customer_configuration.verification_key_configured,true);
 }
 for(const malformed of ['not-base64','AAAA=',Buffer.alloc(31,4).toString('base64')]){
  const result=await run({env:{CARGO_CONTACT_AES_256_GCM_KEY:malformed}});
  assert.equal(result.body.customer_configuration.encryption_key_configured,false);
 }
 for(const invalid of ['Name <sender@example.invalid>','sender@localhost','sender@example.invalid\n']){
  const result=await run({env:{CARGO_CUSTOMER_FROM_EMAIL:invalid}});
  assert.equal(result.body.customer_configuration.sender_address_format_valid,false);
 }
});
