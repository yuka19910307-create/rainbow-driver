'use strict';
// Execute the actual TypeScript handler with synthetic DB/auth/mail only.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {stripTypeScriptTypes}=require('node:module');
const {webcrypto}=require('node:crypto');
const source=fs.readFileSync(path.join(__dirname,'../integrations/cargo-customer-intake/operator.ts'),'utf8');
const code=stripTypeScriptTypes(source.replace(/^import .*;\n/,''));
const id='11111111-1111-4111-8111-111111111111';
async function setup(opts={}){
 const raw=Buffer.alloc(32,7),key=await webcrypto.subtle.importKey('raw',raw,'AES-GCM',false,['encrypt']);
 const iv=Buffer.alloc(12,3),email=opts.email||'test.user@example.invalid';
 const encrypted=await webcrypto.subtle.encrypt({name:'AES-GCM',iv},key,new TextEncoder().encode(JSON.stringify({email,clientName:'Synthetic'})));
 const payload='\\x'+Buffer.concat([Buffer.from([1]),iv,Buffer.from(encrypted)]).toString('hex');
 const calls=[],mail=[],followup={request_id:id,stage:'awaiting_reply',operator_note:'synthetic note'};
 const result=table=>{
  if(table==='cargo_operator_accounts')return {data:opts.nonOperator?null:{user_id:id}};
  if(table==='cargo_intake_control')return {data:{intake_enabled:!opts.intakeOff,captcha_required:true,contact_verification_required:true}};
  if(table==='cargo_customer_intake_requests')return {data:[{id,status:'operator_reviewing',encrypted_payload:payload}]};
  if(table==='cargo_customer_quote_replies')return {data:[]};
  if(table==='cargo_customer_quote_followups')return opts.followupFail?{error:{message:'synthetic failure'}}:{data:[followup]};
  throw Error('Unexpected table '+table);
 };
 const db={auth:{getUser:async()=>({data:{user:opts.invalidJwt?null:{id}}})},from(table){
  calls.push(table);const q={select(){return q},eq(){return q},in(){return q},order(){return q},limit(){return q},
   then(a,b){return Promise.resolve(result(table)).then(a,b)},
   async maybeSingle(){const r=result(table);return {...r,data:Array.isArray(r.data)?r.data[0]:r.data}}};return q;
 },async rpc(name,args){calls.push({name,args});
  if(name==='cargo_customer_quote_claim_send')return {data:{ok:true,amount_yen:1000,terms:'Synthetic quote conditions '.repeat(3),valid_until:new Date(Date.now()+600000).toISOString()}};
  if(name==='cargo_customer_quote_finalize'||name==='cargo_customer_quote_prepare')return {data:{ok:true}};
  throw Error('Unexpected RPC '+name);
 }};
 let handler;
 vm.runInNewContext(code,{createClient:()=>db,crypto:webcrypto,TextEncoder,TextDecoder,Uint8Array,Response,atob,AbortController,setTimeout,clearTimeout,
  Deno:{serve:f=>handler=f,env:{get:n=>({SUPABASE_URL:'https://synthetic.invalid',SUPABASE_SERVICE_ROLE_KEY:'fake',CARGO_CONTACT_AES_256_GCM_KEY:raw.toString('base64'),CARGO_INTAKE_HMAC_KEY:raw.toString('base64'),CARGO_CUSTOMER_EMAIL_PROVIDER:'resend',CARGO_CUSTOMER_RESEND_API_KEY:'fake',CARGO_CUSTOMER_FROM_EMAIL:opts.from||'sender@example.invalid'})[n]}},
  fetch:async(url,options)=>{assert.equal(url,'https://api.resend.com/emails');mail.push(JSON.parse(options.body));return new Response(JSON.stringify({id:'synthetic-provider-id'}),{status:200})}
 });
 return {calls,mail,followup,async invoke(body){const r=await handler(new Request('https://synthetic.invalid',{method:'POST',headers:{origin:'https://app.rainbow-driver.com',authorization:'Bearer synthetic'},body:JSON.stringify(body)}));return {status:r.status,body:await r.json()}}};
}
test('operator list decrypts requests and includes follow-up record',async()=>{
 const x=await setup(),r=await x.invoke({action:'list'});assert.equal(r.status,200);assert.equal(r.body.items[0].followup.stage,'awaiting_reply');assert.equal(x.mail.length,0);
});
test('follow-up read failure fails closed without sending',async()=>{
 const x=await setup({followupFail:true}),r=await x.invoke({action:'list'});assert.equal(r.status,503);assert.equal(r.body.error,'FOLLOWUP_QUEUE_UNAVAILABLE');assert.equal(x.mail.length,0);
});
test('approved quote reaches mock provider once and finalizes accepted delivery',async()=>{
 const x=await setup(),r=await x.invoke({action:'quote_send',id,confirmation:'SEND_APPROVED_QUOTE'});
 assert.equal(r.status,200);assert.equal(r.body.provider_accepted,true);assert.equal(x.mail.length,1);assert.deepEqual(x.mail[0].to,['test.user@example.invalid']);
 assert.ok(!x.calls.includes('cargo_customer_quote_followups'));
 const final=x.calls.find(c=>c.name==='cargo_customer_quote_finalize');assert.equal(final.args.p_provider_accepted,true);
});
test('invalid sender is rejected before irreversible send claim',async()=>{
 for(const from of ['bad address@example.invalid','not-an-email']){const x=await setup({from}),r=await x.invoke({action:'quote_send',id,confirmation:'SEND_APPROVED_QUOTE'});assert.equal(r.status,503);assert.ok(!x.calls.some(c=>c.name==='cargo_customer_quote_claim_send'));assert.equal(x.mail.length,0)}
});
test('recipient whitespace is rejected before provider call',async()=>{
 const x=await setup({email:'bad name@example.invalid'}),r=await x.invoke({action:'quote_send',id,confirmation:'SEND_APPROVED_QUOTE'});assert.equal(r.status,503);assert.equal(x.mail.length,0);
});
test('intake OFF immediately before provider call prevents send',async()=>{
 const x=await setup({intakeOff:true}),r=await x.invoke({action:'quote_send',id,confirmation:'SEND_APPROVED_QUOTE'});assert.equal(r.status,503);assert.equal(x.mail.length,0);
});
test('maximum supported quote terms can reach validation RPC',async()=>{
 const x=await setup(),r=await x.invoke({action:'quote_prepare',id,amount_yen:1000,terms:'条'.repeat(1200),valid_until:new Date(Date.now()+600000).toISOString()});assert.equal(r.status,200);assert.ok(x.calls.some(c=>c.name==='cargo_customer_quote_prepare'));assert.equal(x.mail.length,0);
});
test('invalid session and non-operator cannot read the queue',async()=>{
 for(const [opts,status] of [[{invalidJwt:true},401],[{nonOperator:true},403]]){const x=await setup(opts),r=await x.invoke({action:'list'});assert.equal(r.status,status);assert.ok(!x.calls.includes('cargo_customer_intake_requests'));assert.equal(x.mail.length,0)}
});
