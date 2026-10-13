'use strict';
// Offline tests of the actual draft-binding Edge handler. No network or secrets.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {webcrypto}=require('node:crypto');
let code=fs.readFileSync(path.join(__dirname,'../integrations/cargo-draft-otp-binding/index.ts'),'utf8');
for(const [from,to] of [
 ['import {createClient} from "npm:@supabase/supabase-js@2.112.3";',''],
 ['v:unknown','v'],['v:Uint8Array','v'],[':Uint8Array|null',''],
 ['key:CryptoKey,message:string','key,message'],
 ['req:Request','req'],
 ['let input:{action:string;challenge_id?:string;draft_id?:string};','let input;'],
 ['input.challenge_id!','input.challenge_id']
]){assert.ok(code.includes(from),'Source changed: '+from);code=code.replaceAll(from,to)}
const user='11111111-1111-4111-8111-111111111111';
const challengeId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa';
const key=Buffer.alloc(32,7),base64=key.toString('base64');
const mac=async()=>{
 const imported=await webcrypto.subtle.importKey('raw',key,{name:'HMAC',hash:'SHA-256'},false,['sign']);
 return '\\x'+Buffer.from(await webcrypto.subtle.sign('HMAC',imported,new TextEncoder().encode('CARGO_OPERATOR_SELF_TEST|'+user))).toString('hex');
};
async function setup(options={}){
 const calls=[],subject=await mac();
 const challenge={id:challengeId,subject_hmac:options.badSubject?'\\x'+('00'.repeat(32)):subject,
  created_at:new Date(Date.now()-30000).toISOString(),
  expires_at:new Date(Date.now()+600000).toISOString(),
  delete_after:new Date(Date.now()+1800000).toISOString(),consumed_at:null};
 const db={
  auth:{getUser:async()=>({data:{user:options.badJwt?null:{id:user}},error:options.badJwt?{}:null})},
  from(table){
   calls.push(table);
   const query={
    select(){return query},eq(){return query},order(){return query},limit(){return query},
    async maybeSingle(){
     if(table==='cargo_operator_accounts')return {data:options.notOperator?null:{user_id:user},error:null};
     if(table==='cargo_intake_control')return {data:{intake_enabled:!!options.intakeOn,captcha_required:true,contact_verification_required:true},error:null};
     if(table==='cargo_email_verification_challenges')return {data:challenge,error:null};
     return {data:null,error:{message:'unexpected table'}};
    },
    async insert(){calls.push('insert');return {error:null}}
   };
   return query;
  },
  async rpc(_,args){
   calls.push('rpc');
   return {data:args.p_operator_id===null?{ok:false,reason:'INVALID_INPUT'}:
    options.claimDenied?{ok:false,reason:'ALREADY_CLAIMED'}:{ok:true,reason:'CLAIMED'},error:null};
  }
 };
 let handler;
 const context={createClient:()=>db,crypto:webcrypto,TextEncoder,Uint8Array,Response,atob,
  Deno:{env:{get:k=>({SUPABASE_URL:'https://fake.invalid',SUPABASE_SERVICE_ROLE_KEY:'fake',CARGO_INTAKE_HMAC_KEY:base64})[k]},serve:fn=>{handler=fn}}};
 vm.runInNewContext(code,context,{timeout:1500});
 async function invoke(action='status',extra={}){
  const headers={authorization:'Bearer fake-jwt',origin:'https://app.rainbow-driver.com'};
  if(extra.noToken)delete headers.authorization;
  if(extra.badOrigin)headers.origin='https://evil.invalid';
  const body=extra.body??{action,...(action==='bind'||action==='claim'?{challenge_id:challengeId}:{}),
   ...(action==='claim'?{draft_id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'}:{})};
  const response=await handler({method:'POST',headers:{get:k=>headers[k.toLowerCase()]??null},
   text:async()=>JSON.stringify(body)});
  return {status:response.status,body:await response.json()};
 }
 return {invoke,calls};
}
test('missing JWT and disallowed origin fail before DB access',async()=>{
 for(const extra of [{noToken:true},{badOrigin:true}]){
  const x=await setup();const r=await x.invoke('status',extra);
  assert.equal(r.status,extra.noToken?401:403);assert.deepEqual(x.calls,[]);
 }
});
test('JWT and cargo operator membership are required',async()=>{
 for(const [opts,status] of [[{badJwt:true},401],[{notOperator:true},403]]){
  const x=await setup(opts);assert.equal((await x.invoke()).status,status);
  assert.ok(!x.calls.includes('insert'));
 }
});
test('intake enabled fails closed',async()=>{
 const x=await setup({intakeOn:true});const r=await x.invoke();
 assert.equal(r.status,423);assert.equal(r.body.error,'PUBLIC_INTAKE_MUST_BE_DISABLED');
});
test('status checks binding RPC without creating any draft',async()=>{
 const x=await setup();const r=await x.invoke();
 assert.equal(r.status,200);assert.equal(r.body.ready,true);
 assert.equal(r.body.public_intake_enabled,false);
 assert.ok(x.calls.includes('rpc'));assert.ok(!x.calls.includes('insert'));
});
test('bind refuses mismatched subject and accepts fixed fictional challenge',async()=>{
 const denied=await setup({badSubject:true});assert.equal((await denied.invoke('bind')).status,422);
 assert.ok(!denied.calls.includes('insert'));
 const x=await setup();const r=await x.invoke('bind');
 assert.equal(r.status,200);assert.equal(r.body.challenge_id,challengeId);
 assert.equal(r.body.dispatch_created,false);assert.ok(x.calls.includes('insert'));
});
test('claim returns success or denial without creating a dispatch',async()=>{
 const x=await setup();const good=await x.invoke('claim');
 assert.equal(good.status,200);assert.equal(good.body.reason,'CLAIMED');
 const denied=await setup({claimDenied:true});const bad=await denied.invoke('claim');
 assert.equal(bad.status,422);assert.equal(bad.body.reason,'ALREADY_CLAIMED');
 assert.equal(bad.body.dispatch_created,false);
});
test('malformed identifiers rejected before database access',async()=>{
 const x=await setup();const r=await x.invoke('bind',{body:{action:'bind',challenge_id:'bad'}});
 assert.equal(r.status,422);assert.deepEqual(x.calls,[]);
});
