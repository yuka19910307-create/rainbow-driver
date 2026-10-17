import {createClient} from "npm:@supabase/supabase-js@2.112.3";
// Review-only operator diagnostics. No writes, RPCs or mail-provider requests.
// Deploy separately as cargo-production-readiness with verify_jwt=true.
const TARGET="https://kvoaorzdewwirqryeizq.supabase.co";
const APP="https://app.rainbow-driver.com";
const headers={
 "Access-Control-Allow-Origin":APP,
 "Access-Control-Allow-Headers":"authorization,apikey,content-type,x-client-info",
 "Access-Control-Allow-Methods":"POST,OPTIONS",
 "Vary":"Origin","Cache-Control":"no-store",
 "Content-Type":"application/json; charset=utf-8"
};
const reply=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers});

// Bound received bytes before decoding or parsing, even without Content-Length.
// UTF-8 needs at most 3 bytes per UTF-16 code unit, preserving the 128-character cap.
async function boundedBody(req:Request,maxBytes:number){
 const declared=req.headers.get("content-length");
 if(declared&&/^\d+$/.test(declared)&&Number(declared)>maxBytes){
  void req.body?.cancel().catch(()=>{});
  throw Error("BODY_TOO_LARGE");
 }
 if(!req.body)return "";
 const reader=req.body.getReader(),decoder=new TextDecoder("utf-8",{fatal:true});
 let total=0,text="",complete=false;
 try{
  while(true){
   const {done,value}=await reader.read();
   if(done)break;
   total+=value.byteLength;
   if(total>maxBytes)throw Error("BODY_TOO_LARGE");
   text+=decoder.decode(value,{stream:true});
  }
  text+=decoder.decode();
  complete=true;
  return text;
 }finally{
  if(!complete)void reader.cancel().catch(()=>{});
  reader.releaseLock();
 }
}

function base64KeyConfigured(name:string,sizes:number[]){
 const value=Deno.env.get(name)||"";
 try{
  if(!/^[A-Za-z0-9+/]+={0,2}$/.test(value)||value.length%4)return false;
  return sizes.includes(Uint8Array.from(atob(value),c=>c.charCodeAt(0)).length);
 }catch{return false}
}

function configuration(){
 const env=(name:string)=>Deno.env.get(name)||"";
 const from=env("CARGO_CUSTOMER_FROM_EMAIL");
 const checks={
  verification_key_configured:base64KeyConfigured("CARGO_INTAKE_HMAC_KEY",[32,64]),
  encryption_key_configured:base64KeyConfigured("CARGO_CONTACT_AES_256_GCM_KEY",[32]),
  captcha_site_key_present:!!env("CARGO_CUSTOMER_TURNSTILE_SITE_KEY"),
  captcha_secret_present:!!env("CARGO_CUSTOMER_TURNSTILE_SECRET"),
  email_provider_configured:env("CARGO_CUSTOMER_EMAIL_PROVIDER")==="resend",
  email_api_key_present:!!env("CARGO_CUSTOMER_RESEND_API_KEY"),
  // Both existing intake and quote-sender validators must accept the sender.
  sender_address_format_valid:/^[^\s@]{1,64}@[^\s@]{1,190}$/.test(from)&&/^\S+@\S+\.\S+$/.test(from)
 };
 return {...checks,configuration_recognized:Object.values(checks).every(value=>value===true)};
}

function budgetValid(row:Record<string,unknown>|null){
 if(!row||typeof row.enabled!=="boolean")return false;
 const integer=(name:string,min:number,max:number)=>Number.isSafeInteger(row[name])&&
  Number(row[name])>=min&&Number(row[name])<=max;
 return integer("hourly_limit",1,1000)&&integer("daily_limit",1,10000)&&
  Number(row.daily_limit)>=Number(row.hourly_limit)&&
  integer("hour_attempts",0,2147483647)&&integer("day_attempts",0,2147483647)&&
  typeof row.hour_started_at==="string"&&Number.isFinite(Date.parse(row.hour_started_at))&&
  typeof row.day_started_at==="string"&&/^\d{4}-\d{2}-\d{2}$/.test(row.day_started_at);
}

Deno.serve(async(req:Request)=>{
 const origin=req.headers.get("origin");
 if(req.method==="OPTIONS")return origin===APP
  ?new Response(null,{status:204,headers}):reply({error:"ORIGIN_DENIED"},403);
 if(origin!==APP)return reply({error:"ORIGIN_DENIED"},403);
 if(req.method!=="POST")return reply({error:"METHOD_NOT_ALLOWED"},405);
 const token=(req.headers.get("authorization")||"").match(/^Bearer\s+(\S+)$/i)?.[1];
 if(!token)return reply({error:"LOGIN_REQUIRED"},401);
 try{
  const text=await boundedBody(req,128*3);
  if(text.length>128)return reply({error:"INVALID_INPUT"},400);
  const body=JSON.parse(text);
  if(!body||typeof body!=="object"||Array.isArray(body)||
   Object.keys(body).length!==1||body.action!=="status")return reply({error:"STATUS_ONLY"},400);
 }catch(error){
  if(error instanceof Error&&error.message==="BODY_TOO_LARGE")return reply({error:"BODY_TOO_LARGE"},413);
  return reply({error:"INVALID_INPUT"},400);
 }
 const url=Deno.env.get("SUPABASE_URL"),key=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
 if(url!==TARGET||!key)return reply({error:"PRODUCTION_ONLY"},503);
 try{
  const db=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}});
  const auth=await db.auth.getUser(token);
  if(auth.error||!auth.data?.user)return reply({error:"INVALID_SESSION"},401);
  const member=await db.from("cargo_operator_accounts").select("user_id")
   .eq("user_id",auth.data.user.id).maybeSingle();
  if(member.error||!member.data||member.data.user_id!==auth.data.user.id)
   return reply({error:"OPERATOR_ONLY"},403);
  const gate=await db.from("cargo_intake_control")
   .select("intake_enabled,captcha_required,contact_verification_required").eq("id",1).maybeSingle();
  if(gate.error||gate.data?.intake_enabled!==false||gate.data?.captcha_required!==true||
   gate.data?.contact_verification_required!==true)return reply({error:"PROTECTED_INTAKE_OFF_REQUIRED"},423);
  const budget=await db.from("cargo_customer_mail_budget")
   .select("enabled,hourly_limit,daily_limit,hour_started_at,day_started_at,hour_attempts,day_attempts")
   .eq("id",1).maybeSingle();
  if(budget.error||!budgetValid(budget.data))return reply({error:"MAIL_BUDGET_UNAVAILABLE"},503);
  if(budget.data.enabled!==false)return reply({error:"MAIL_BUDGET_MUST_BE_DISABLED"},423);
  // Read project secrets only after authenticating the operator and OFF gates.
  // Never return their values, lengths, hashes, prefixes or provider error bodies.
  return reply({
   ok:true,environment:"CARGO_PRODUCTION",checked_at:new Date().toISOString(),
   runtime_scope:"THIS_DIAGNOSTIC_FUNCTION_ONLY",
   operator_verified:true,public_intake_enabled:false,
   customer_configuration:configuration(),
   customer_mail_budget:{
    enabled:false,hourly_limit:budget.data.hourly_limit,daily_limit:budget.data.daily_limit,
    hour_started_at:budget.data.hour_started_at,day_started_at:budget.data.day_started_at,
    hour_attempts:budget.data.hour_attempts,day_attempts:budget.data.day_attempts,
    counter_scope:"CUSTOMER_OTP_AND_QUOTE_ATTEMPTS_ONLY",
    limits_approved_for_production:false
   },
   external_checks:{
    provider_key_validity:"not_checked",provider_key_scope:"not_checked",
    sender_domain:"not_checked",provider_quota:"not_checked",
    captcha_validity:"not_checked",email_delivery:"not_checked"
   },
   launch_ready:false,email_sent:false,data_changed:false
  });
 }catch{return reply({error:"READINESS_UNAVAILABLE"},503)}
});
