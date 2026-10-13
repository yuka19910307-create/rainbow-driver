'use strict';
// Offline browser-flow tests. No network, Gmail, database, secrets, or dispatch.
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const html=fs.readFileSync(path.resolve(__dirname,'../cargo-request-otp-integration-preview.html'),'utf8');
const script=html.match(/<script>\s*([\s\S]*?)\s*<\/script>/)?.[1];
assert.ok(script,'Inline script must exist');
const tick=()=>new Promise(resolve=>setImmediate(resolve));

async function setup(opts={}){
 const elements=new Map(),calls=[];
 const el=id=>{
  if(!elements.has(id))elements.set(id,{disabled:true,textContent:'',className:'',value:'',addEventListener(){}});
  return elements.get(id);
 };
 const db={
  auth:{getUser:async()=>({data:{user:opts.noAuth?null:{id:'operator'}}})},
  from:()=>({select:()=>({eq:()=>({maybeSingle:async()=>({data:opts.noRole?null:{user_id:'operator'}})})})}),
  functions:{invoke:async(name,{body})=>{
   calls.push(name+':'+body.action);
   let data;
   if(name==='cargo-intake-readiness'){
    data=body.action==='diagnose'
     ?{mode:'PRELAUNCH_OPERATOR_DIAGNOSTIC',public_intake_enabled:false,
       database_switch_enabled:!!opts.gateFail,customer_submission_supported:false,
       captcha_required:true,contact_verification_required:true}
     :{valid:true,stores_data:false,sends_push:false,accepts_customers:false};
   }else if(name==='cargo-gmail-otp-test'){
    data=body.action==='status'
     ?{mode:'OPERATOR_OWN_GMAIL_PRELAUNCH',bridge_configured:!opts.statusFail,
       verification_hmac_configured:true,delivery_scope:'SCRIPT_OWNER_GMAIL_ONLY',public_intake_enabled:false}
     :body.action==='send_test'
      ?{ok:true,mode:'OPERATOR_OWN_GMAIL_TEST',
        challenge_id:'11111111-1111-4111-8111-111111111111',
        expires_in_seconds:600,public_intake_enabled:false}
      :{verified:body.code==='123456',reason:body.code==='123456'?'VERIFIED':'INVALID_CODE'};
   }else if(name==='cargo-draft-otp-binding'){
    data=body.action==='bind'
     ?{ok:!opts.bindFail,mode:'OPERATOR_SYNTHETIC_DRAFT_ONLY',
       draft_id:'22222222-2222-4222-8222-222222222222',
       challenge_id:body.challenge_id,public_intake_enabled:false}
     :{ok:!opts.claimFail,reason:opts.claimFail?'DENIED':'CLAIMED',public_intake_enabled:false};
   }else throw Error('Unexpected Edge Function '+name);
   return {data,error:null};
  }}
 };
 vm.runInNewContext(script,{
  window:{supabase:{createClient:()=>db}},
  document:{getElementById:el},
  confirm:()=>opts.confirm!==false,
  console:{warn(){}}
 },{timeout:1500});
 await tick();
 const press=async id=>{if(!el(id).disabled)await el(id).onclick()};
 return {el,press,calls};
}
async function flow(opts={}){
 const s=await setup(opts);
 await s.press('check');await s.press('send');
 s.el('code').value=opts.code??'123456';
 await s.press('verify');
 return s;
}
test('correct OTP binds and claims exactly once',async()=>{
 const s=await flow();
 assert.match(s.el('finalResult').textContent,/完了：/);
 assert.equal(s.calls.filter(x=>x==='cargo-draft-otp-binding:claim').length,1);
 assert.equal(s.calls.filter(x=>x==='cargo-gmail-otp-test:send_test').length,1);
 await s.press('verify');
 assert.equal(s.calls.filter(x=>x==='cargo-draft-otp-binding:claim').length,1);
});
test('binding failure prevents OTP verification',async()=>{
 const s=await flow({bindFail:true});
 assert.equal(s.calls.includes('cargo-gmail-otp-test:verify'),false);
 assert.equal(s.calls.includes('cargo-draft-otp-binding:claim'),false);
 assert.doesNotMatch(s.el('finalResult').textContent,/完了：/);
});
test('claim failure cannot show completed',async()=>{
 const s=await flow({claimFail:true});
 assert.equal(s.calls.includes('cargo-draft-otp-binding:claim'),true);
 assert.doesNotMatch(s.el('finalResult').textContent,/完了：/);
 assert.match(s.el('verifyResult').textContent,/失敗/);
});
test('wrong OTP never claims a draft',async()=>{
 const s=await flow({code:'000000'});
 assert.equal(s.calls.includes('cargo-draft-otp-binding:claim'),false);
 assert.doesNotMatch(s.el('finalResult').textContent,/完了：/);
});
test('intake switch failure blocks send',async()=>{
 const s=await flow({gateFail:true});
 assert.deepEqual(s.calls,['cargo-intake-readiness:diagnose']);
});
test('send confirmation cancellation blocks email',async()=>{
 const s=await flow({confirm:false});
 assert.equal(s.calls.includes('cargo-gmail-otp-test:send_test'),false);
});
test('unauthenticated and non-operator users cannot invoke Edge Functions',async()=>{
 for(const opts of [{noAuth:true},{noRole:true}]){
  const s=await flow(opts);
  assert.deepEqual(s.calls,[]);
 }
});
