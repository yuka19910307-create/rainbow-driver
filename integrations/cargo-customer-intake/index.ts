import {createClient} from "npm:@supabase/supabase-js@2.112.3";
// Customer intake + email OTP. Staging tested; production rollout pending.
// Never point this at the existing owner-Gmail test bridge.
// Launch requires explicit user authorization, CAPTCHA/provider configuration,
// a privacy/retention review, a staffed operator-review queue, and intake gate ON.
const APP="https://app.rainbow-driver.com";
const headers={
 "Access-Control-Allow-Origin":APP,
 "Access-Control-Allow-Methods":"POST,OPTIONS",
 "Access-Control-Allow-Headers":"apikey,authorization,content-type,x-client-info",
 "Cache-Control":"no-store","Vary":"Origin",
 "Content-Type":"application/json; charset=utf-8"
};
const reply=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status,headers});
const encoder=new TextEncoder();
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const emailPattern=/^[^\s@]{1,64}@[^\s@]{1,190}$/;
const bytes=(value:string,size:number)=>{
 try{
  if(!value||!/^[A-Za-z0-9+/]+={0,2}$/.test(value)||value.length%4)return null;
  const b=Uint8Array.from(atob(value),c=>c.charCodeAt(0));
  return b.length===size?b:null;
 }catch{return null}
};
const hex=(v:Uint8Array)=>Array.from(v,b=>b.toString(16).padStart(2,"0")).join("");
const dbBytea=(v:Uint8Array)=>"\\x"+hex(v);
function randomCode(){
 const arr=new Uint32Array(1),limit=4294000000; // floor(2^32/1e6)*1e6
 do{crypto.getRandomValues(arr)}while(arr[0]>=limit);
 return String(arr[0]%1000000).padStart(6,"0");
}
function str(v:unknown,max:number,min=0){
 if(typeof v!=="string")throw Error("INVALID_INPUT");
 const s=v.trim();
 if(s.length<min||s.length>max)throw Error("INVALID_INPUT");
 return s;
}
function number(v:unknown,min:number,max:number,int=false){
 if((typeof v!=="number"&&typeof v!=="string")||String(v).trim()==="")throw Error("INVALID_INPUT");
 const n=Number(v);
 if(!Number.isFinite(n)||n<min||n>max||(int&&!Number.isInteger(n)))throw Error("INVALID_INPUT");
 return n;
}
function validateRequest(v:unknown){
 if(!v||typeof v!=="object"||Array.isArray(v))throw Error("INVALID_INPUT");
 const d=v as Record<string,unknown>;
 const accepted=["pickup","delivery","cargo","pieces","weight","length","width",
  "height","handling","readiness","note","clientName","today","reviewConfirm"];
 if(Object.keys(d).some(k=>!accepted.includes(k)))throw Error("UNEXPECTED_INPUT");
 if(d.today!==true||d.reviewConfirm!==true)throw Error("CONSENT_REQUIRED");
 const result={
  pickup:str(d.pickup,250,3),delivery:str(d.delivery,250,3),
  cargo:str(d.cargo,500,2),pieces:number(d.pieces,1,99,true),
  weight:number(d.weight,.01,350),length:number(d.length,.1,500),
  width:number(d.width,.1,500),height:number(d.height,.1,500),
  handling:str(d.handling,20),readiness:str(d.readiness,20),
  note:str(d.note||"",500),clientName:str(d.clientName||"",80)
 };
 if(!["yes","no","unknown"].includes(result.handling)||
    !["ready","preparing","unknown"].includes(result.readiness))
  throw Error("INVALID_INPUT");
 return result;
}
const secret=(key:string)=>Deno.env.get(key)||"";
function runtime(){
 const url=secret("SUPABASE_URL"),role=secret("SUPABASE_SERVICE_ROLE_KEY");
 const hash=bytes(secret("CARGO_INTAKE_HMAC_KEY"),32)||
            bytes(secret("CARGO_INTAKE_HMAC_KEY"),64);
 const aes=bytes(secret("CARGO_CONTACT_AES_256_GCM_KEY"),32);
 const siteKey=secret("CARGO_CUSTOMER_TURNSTILE_SITE_KEY");
 const captchaSecret=secret("CARGO_CUSTOMER_TURNSTILE_SECRET");
 const apiKey=secret("CARGO_CUSTOMER_RESEND_API_KEY");
 const from=secret("CARGO_CUSTOMER_FROM_EMAIL");
 const provider=secret("CARGO_CUSTOMER_EMAIL_PROVIDER");
 const configured=!!(url&&role&&hash&&aes&&siteKey&&captchaSecret&&apiKey&&
   emailPattern.test(from)&&provider==="resend");
 return {url,role,hash,aes,siteKey,captchaSecret,apiKey,from,configured};
}
async function hmacKey(raw:Uint8Array){
 return await crypto.subtle.importKey("raw",raw,{name:"HMAC",hash:"SHA-256"},false,["sign"]);
}
async function digest(key:CryptoKey,s:string){
 return new Uint8Array(await crypto.subtle.sign("HMAC",key,encoder.encode(s)));
}
async function encrypt(raw:Uint8Array,plaintext:string){
 const key=await crypto.subtle.importKey("raw",raw,"AES-GCM",false,["encrypt"]);
 const iv=crypto.getRandomValues(new Uint8Array(12));
 const encrypted=new Uint8Array(await crypto.subtle.encrypt({name:"AES-GCM",iv},
  key,encoder.encode(plaintext)));
 const result=new Uint8Array(1+iv.length+encrypted.length);
 result[0]=1;result.set(iv,1);result.set(encrypted,13);
 return dbBytea(result);
}
async function captchaOK(token:string,secretKey:string){
 const body=new URLSearchParams({secret:secretKey,response:token});
 try{
  const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),8000);
  try{
   const r=await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify",{
    method:"POST",body,signal:controller.signal
   });
   if(!r.ok)return false;
   const j=await r.json();
   return j?.success===true&&j?.hostname==="app.rainbow-driver.com"&&
     j?.action==="cargo_customer_intake";
  }finally{clearTimeout(timeout)}
 }catch{return false}
}
async function sendEmail(address:string,code:string,from:string,key:string){
 const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),10000);
 try{
  const r=await fetch("https://api.resend.com/emails",{
   method:"POST",signal:controller.signal,
   headers:{"Authorization":"Bearer "+key,"Content-Type":"application/json"},
   body:JSON.stringify({
    from,to:[address],subject:"Rainbow Driver 軽貨物｜メール認証コード",
    text:"Rainbow Driver 軽貨物の確認コードは "+code+
      " です。10分以内に入力してください。ご自身で申し込んでいない場合は破棄してください。"
   })
  });
  if(!r.ok)return false;
  // HTTP success alone does not establish provider acceptance.
  // Missing/malformed acknowledgement is uncertain; never auto-retry.
  const result=await r.json();
  return typeof result?.id==='string'&&result.id.trim().length>0&&result.id.length<=200;
 }catch{return false}
 finally{clearTimeout(timeout)}
}
Deno.serve(async(req:Request)=>{
 const origin=req.headers.get("origin");
 if(req.method==="OPTIONS")return origin===APP
  ?new Response(null,{status:204,headers}):reply({error:"ORIGIN_DENIED"},403);
 if(origin!==APP)return reply({error:"ORIGIN_DENIED"},403);
 if(req.method!=="POST")return reply({error:"METHOD_NOT_ALLOWED"},405);
 let body:Record<string,unknown>;
 try{
  const text=await req.text();
  if(text.length>12000)return reply({error:"BODY_TOO_LARGE"},413);
  body=JSON.parse(text);
  if(!body||typeof body!=="object"||Array.isArray(body)||
     !["status","start","verify"].includes(String(body.action)))throw Error();
 }catch{return reply({error:"INVALID_INPUT"},400)}
 const conf=runtime();
 if(!conf.url||!conf.role)return reply({error:"NOT_CONFIGURED"},503);
 try{
  const db=createClient(conf.url,conf.role,{auth:{persistSession:false,autoRefreshToken:false}});
  const {data:gate,error:gateError}=await db.from("cargo_intake_control")
   .select("intake_enabled,captcha_required,contact_verification_required")
   .eq("id",1).maybeSingle();
  const enabled=!gateError&&gate?.intake_enabled===true&&
    gate?.captcha_required===true&&gate?.contact_verification_required===true;
  if(body.action==="status")return reply({
   public_intake_enabled:enabled,
   ready:enabled&&conf.configured,delivery_scope:"CUSTOMER_EMAIL_ONLY",
   captcha_site_key:enabled&&conf.configured?conf.siteKey:null,
   accepts_orders:false,automatic_dispatch:false,payment_enabled:false
  });
  // A false DB switch MUST block all email, draft and order operations.
  if(!enabled)return reply({error:"PUBLIC_INTAKE_DISABLED"},423);
  if(body.action==="start"){
   if(!conf.configured)return reply({error:"NOT_CONFIGURED"},503);
   const keys=Object.keys(body);
   if(keys.some(x=>!["action","attempt_id","email","request","captcha_token"].includes(x))||
      !uuid.test(String(body.attempt_id||"")))
    return reply({error:"INVALID_INPUT"},422);
   let address:string,details:ReturnType<typeof validateRequest>,captcha:string;
   try{
    address=str(body.email,254,3).toLowerCase();
    if(!emailPattern.test(address))throw Error();
    details=validateRequest(body.request);
    captcha=str(body.captcha_token,2048,1);
   }catch{return reply({error:"INVALID_INPUT"},422)}
   const verified=await captchaOK(captcha,conf.captchaSecret);
   if(!verified)return reply({error:"CAPTCHA_FAILED"},422);
   const hkey=await hmacKey(conf.hash!);
   const subject=dbBytea(await digest(hkey,"CARGO_CUSTOMER_EMAIL_V1|"+address));
   // Use existing bounded per-contact rate limiter (3 emails / hour).
   const {data:hit,error:rateError}=await db.rpc("cargo_intake_rate_hit",{
    p_scope:"contact",p_identifier_hmac:subject,p_limit:3,p_window_seconds:3600
   });
   if(rateError||hit?.allowed!==true)return reply({error:"RATE_LIMITED"},429);
   const id=crypto.randomUUID(),code=randomCode();
   const codeHash=dbBytea(await digest(hkey,"CARGO_CUSTOMER_EMAIL_OTP_V1|"+id+"|"+code));
   const payload={...details,email:address,consent_recorded_at:new Date().toISOString()};
   const encrypted=await encrypt(conf.aes!,JSON.stringify(payload));
   const expires=new Date(Date.now()+600000),deleteAfter=new Date(Date.now()+1800000);
   const {error:writeError}=await db.from("cargo_customer_intake_drafts").insert({
    id,attempt_id:body.attempt_id,contact_hmac:subject,encrypted_payload:encrypted,
    code_hmac:codeHash,expires_at:expires.toISOString(),delete_after:deleteAfter.toISOString()
   });
   if(writeError)return reply({error:"DRAFT_CREATE_FAILED"},503);
   // Shared across recipients and quote emails. Missing/failed budget check blocks mail.
   const {data:budget,error:budgetError}=await db.rpc("cargo_customer_mail_budget_claim");
   if(budgetError||budget?.allowed!==true){
    await db.from("cargo_customer_intake_drafts").delete().eq("id",id);
    const exhausted=!budgetError&&budget?.reason==="MAIL_BUDGET_EXHAUSTED";
    return reply({error:exhausted?"MAIL_BUDGET_EXHAUSTED":"MAIL_BUDGET_UNAVAILABLE"},exhausted?429:503);
   }
   // Recheck the live switch after reserving budget and immediately before external mail.
   const {data:gate2,error:gate2Error}=await db.from("cargo_intake_control")
    .select("intake_enabled,captcha_required,contact_verification_required").eq("id",1).maybeSingle();
   if(gate2Error||gate2?.intake_enabled!==true||gate2?.captcha_required!==true||
      gate2?.contact_verification_required!==true){
    await db.from("cargo_customer_intake_drafts").delete().eq("id",id);
    return reply({error:"PUBLIC_INTAKE_DISABLED"},423);
   }
   const delivered=await sendEmail(address,code,conf.from,conf.apiKey);
   if(!delivered){
    await db.from("cargo_customer_intake_drafts").delete().eq("id",id);
    return reply({error:"MAIL_NOT_CONFIRMED"},503);
   }
   return reply({ok:true,challenge_id:id,expires_in_seconds:600,
    state:"AWAITING_EMAIL_CODE",public_intake_enabled:true,request_created:false},202);
  }
  if(body.action==="verify"){
   if(!conf.hash)return reply({error:"NOT_CONFIGURED"},503);
   if(Object.keys(body).some(x=>!["action","challenge_id","code"].includes(x))||
     !uuid.test(String(body.challenge_id||""))||
     typeof body.code!=="string"||!/^[0-9]{6}$/.test(body.code))
     return reply({error:"INVALID_INPUT"},422);
   const hkey=await hmacKey(conf.hash);
   const proof=dbBytea(await digest(hkey,"CARGO_CUSTOMER_EMAIL_OTP_V1|"+body.challenge_id+"|"+body.code));
   const {data:result,error}=await db.rpc("cargo_customer_intake_verify_commit",{
    p_draft_id:body.challenge_id,p_code_hmac:proof
   });
   if(error||!result)return reply({error:"VERIFY_UNAVAILABLE"},503);
   if(result.ok!==true)return reply({ok:false,reason:result.reason||"DENIED"},422);
   return reply({ok:true,reason:"PENDING_OPERATOR_REVIEW",request_id:result.request_id,
    automatic_dispatch:false,payment_enabled:false});
  }
  return reply({error:"INVALID_INPUT"},400);
 }catch{return reply({error:"SERVICE_UNAVAILABLE"},503)}
});
