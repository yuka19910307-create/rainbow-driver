const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const source=fs.readFileSync(process.argv[2]||path.join(__dirname,'index.ts'),'utf8').replace(/^import .*;\n/,'');
const flags=['verification_key_configured','encryption_key_configured','captcha_configured','email_provider_configured','schema_configured'];
async function run(overrides={},opts={}){
 const env={SUPABASE_URL:'https://hvdoqcrnztqmbzgwrovd.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'synthetic-server-key',CARGO_INTAKE_HMAC_KEY:Buffer.alloc(32,1).toString('base64'),CARGO_CONTACT_AES_256_GCM_KEY:Buffer.alloc(32,2).toString('base64'),CARGO_CUSTOMER_TURNSTILE_SITE_KEY:'synthetic-site',CARGO_CUSTOMER_TURNSTILE_SECRET:'synthetic-captcha',CARGO_CUSTOMER_EMAIL_PROVIDER:'resend',CARGO_CUSTOMER_RESEND_API_KEY:'synthetic-email-key',CARGO_CUSTOMER_FROM_EMAIL:'test@example.invalid',...overrides};
 let handler;const read=[];
 const db={auth:{getUser:async()=>opts.badAuth?{error:true}:{data:{user:{id:'synthetic-operator'}}}},from:name=>{
  const value=name==='cargo_operator_accounts'?{user_id:'synthetic-operator'}:name==='cargo_intake_control'?{intake_enabled:!!opts.intakeOn,captcha_required:true,contact_verification_required:true}:[];
  const q={select:()=>q,eq:()=>q,maybeSingle:()=>q,limit:()=>q,then:fn=>Promise.resolve({data:value,error:opts.missingSchema&&name==='cargo_customer_quote_replies'?true:null}).then(fn)};return q;
 }};
 vm.runInNewContext(source,{createClient:()=>db,Deno:{serve:f=>handler=f,env:{get:k=>{read.push(k);return env[k]}}},Response,Uint8Array,atob});
 const response=await handler({method:'POST',headers:new Headers({origin:'https://app.rainbow-driver.com',authorization:'Bearer synthetic-token'}),text:async()=>'{"action":"status"}'});
 return {status:response.status,body:await response.json(),read};
}
(async()=>{
 let r=await run();assert.equal(r.status,200);const p=r.body.customer_preparation;assert(flags.every(k=>p[k]===true));assert.equal(p.configuration_recognized,true);assert.equal(p.external_delivery_verified,false);assert.equal(r.body.customer_flow_ready,false);assert.equal(r.body.public_intake_enabled,false);
 assert(!JSON.stringify(r.body).includes('synthetic-'),'no credential values returned');
 for(const [name,flag] of [['CARGO_INTAKE_HMAC_KEY','verification_key_configured'],['CARGO_CONTACT_AES_256_GCM_KEY','encryption_key_configured'],['CARGO_CUSTOMER_TURNSTILE_SECRET','captcha_configured'],['CARGO_CUSTOMER_RESEND_API_KEY','email_provider_configured']]){
  r=await run({[name]:''});assert.equal(r.body.customer_preparation[flag],false);assert.equal(r.body.customer_preparation.configuration_recognized,false);
 }
 r=await run({CARGO_CONTACT_AES_256_GCM_KEY:'not-base64'});assert.equal(r.body.customer_preparation.encryption_key_configured,false);
 r=await run({}, {missingSchema:true});assert.equal(r.body.customer_preparation.schema_configured,false);
 r=await run({}, {badAuth:true});assert.equal(r.status,401);assert(!r.read.some(k=>k.startsWith('CARGO_')),'credentials inspected only after authorization');
 r=await run({}, {intakeOn:true});assert.equal(r.status,423);assert(!r.body.customer_preparation);
 console.log('Configured/missing/invalid settings, schema failure, auth gate, intake OFF and credential non-disclosure checks passed.');
})().catch(e=>{console.error(e);process.exitCode=1});
