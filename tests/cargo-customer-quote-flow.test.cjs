const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const {stripTypeScriptTypes}=require('node:module'),crypto=require('node:crypto').webcrypto;
const id='11111111-1111-4111-8111-111111111111',aes=Buffer.alloc(32,7);
const env={SUPABASE_URL:'https://synthetic.invalid',SUPABASE_SERVICE_ROLE_KEY:'fake',CARGO_CONTACT_AES_256_GCM_KEY:aes.toString('base64'),CARGO_INTAKE_HMAC_KEY:Buffer.alloc(32,9).toString('base64'),CARGO_CUSTOMER_RESEND_API_KEY:'fake',CARGO_CUSTOMER_FROM_EMAIL:'sender@example.invalid',CARGO_CUSTOMER_EMAIL_PROVIDER:'resend'};
let enabled=true,member=true,cipher,claimed=false,fingerprint,mail,mailCount=0,replied=false,replyCalls=0;
const quote={amount_yen:12345,terms:'これは架空の検証条件です。実際の配送や料金の確定には使用しません。',valid_until:new Date(Date.now()+86400000).toISOString()};
const db={auth:{getUser:async()=>({data:{user:{id:'synthetic-operator'}}})},
from(table){const q={select(){return q},eq(){return q},async maybeSingle(){
 if(table==='cargo_operator_accounts')return{data:member?{user_id:'synthetic-operator'}:null};
 if(table==='cargo_intake_control')return{data:{intake_enabled:enabled,captcha_required:true,contact_verification_required:true}};
 assert.equal(table,'cargo_customer_intake_requests');return{data:{encrypted_payload:cipher}};
}};return q},
async rpc(name,args){
 if(name==='cargo_customer_quote_claim_send'){if(claimed)return{data:{ok:false,reason:'ALREADY_CLAIMED'}};claimed=true;fingerprint=args.p_response_token_hmac;return{data:{ok:true,...quote}}}
 if(name==='cargo_customer_quote_finalize'){assert.equal(args.p_provider_accepted,true);return{data:{ok:true}}}
 assert.equal(name,'cargo_customer_quote_reply');replyCalls++;
 if(args.p_request_id!==id||args.p_response_token_hmac!==fingerprint)return{data:{ok:false,reason:'INVALID_LINK'}};
 if(args.p_choice===null)return{data:{ok:true,...quote,reply_state:replied?'interested':null}};
 if(replied)return{data:{ok:false,reason:'ALREADY_REPLIED'}};
 replied=true;return{data:{ok:true,reason:'INTEREST_RECORDED'}};
}};
function load(file){let handler;const ctx={createClient:()=>db,Deno:{serve:f=>handler=f,env:{get:k=>env[k]}},TextEncoder,TextDecoder,Uint8Array,URL,Response,Request,AbortController,atob,crypto,setTimeout,clearTimeout,fetch:async(url,opt)=>{assert.equal(url,'https://api.resend.com/emails');mailCount++;mail=JSON.parse(opt.body);return Response.json({id:'synthetic-provider-id'})}};vm.createContext(ctx);vm.runInContext(stripTypeScriptTypes(fs.readFileSync('integrations/cargo-customer-intake/'+file,'utf8').replace(/^import .*;\n/,'')),ctx);return handler}
async function call(handler,body,auth=false,origin='https://app.rainbow-driver.com'){const r=await handler(new Request('https://synthetic.invalid',{method:'POST',headers:{origin,'content-type':'application/json',...(auth?{authorization:'Bearer synthetic-session'}:{})},body:JSON.stringify(body)}));return{status:r.status,body:await r.json()}}
(async()=>{
 const key=await crypto.subtle.importKey('raw',aes,'AES-GCM',false,['encrypt']),iv=crypto.getRandomValues(new Uint8Array(12));
 const encrypted=await crypto.subtle.encrypt({name:'AES-GCM',iv},key,new TextEncoder().encode(JSON.stringify({email:'synthetic@example.invalid'})));
 cipher='\\x'+Buffer.concat([Buffer.from([1]),iv,Buffer.from(encrypted)]).toString('hex');
 const sender=load('operator.ts'),reply=load('quote-reply.ts'),send={action:'quote_send',id,confirmation:'SEND_APPROVED_QUOTE'};
 assert.equal((await call(sender,send)).status,401);assert.equal(mailCount,0);
 member=false;assert.equal((await call(sender,send,true)).status,403);assert.equal(mailCount,0);member=true;
 const sent=await call(sender,send,true);assert.equal(sent.status,200);assert.equal(mailCount,1);
 assert.deepEqual(mail.to,['synthetic@example.invalid']);assert(mail.text.includes('12,345'));
 const link=new URL(mail.text.match(/https:\/\/app\.rainbow-driver\.com\/cargo-customer-quote-reply\.html#[^\s]+/)[0]);
 assert.equal(link.search,'');const params=new URLSearchParams(link.hash.slice(1)),token=params.get('t');assert.match(token,/^[a-f0-9]{64}$/);assert.equal(params.get('r'),id);assert(!JSON.stringify(sent.body).includes(token));
 const view={action:'view',id,token};
 let r=await call(reply,view);assert.equal(r.status,200);assert.equal(r.body.amount_yen,quote.amount_yen);assert.equal(r.body.terms,quote.terms);assert.equal(r.body.valid_until,quote.valid_until);
 for(const k of ['booking_confirmed','payment_created','driver_assigned'])assert.equal(r.body[k],false);
 const wrong=token.slice(0,-1)+(token.endsWith('0')?'1':'0');
 assert.equal((await call(reply,{...view,token:wrong})).status,422);
 assert.equal((await call(reply,view,false,'https://untrusted.invalid')).status,403);
 const before=replyCalls;enabled=false;assert.equal((await call(reply,view)).status,423);assert.equal(replyCalls,before);enabled=true;
 r=await call(reply,{...view,action:'reply',choice:'interested'});assert.equal(r.status,200);assert.equal(r.body.operator_review_required,true);assert.equal(r.body.booking_confirmed,false);assert.equal(r.body.payment_created,false);assert.equal(r.body.driver_assigned,false);
 assert.equal((await call(reply,{...view,action:'reply',choice:'interested'})).status,422);
 assert.equal((await call(sender,send,true)).status,422);assert.equal(mailCount,1);
 console.log('PASS: exact quote sender -> simulated provider mail -> fragment link -> exact reply handler; HMAC agreement, tampering, OFF, membership, duplicate guards. No external requests. Database state/locking is mocked; separate PostgreSQL tests and live delivery remain necessary.');
})().catch(e=>{console.error(e);process.exitCode=1});
