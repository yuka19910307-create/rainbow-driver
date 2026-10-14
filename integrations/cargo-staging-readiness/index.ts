import {createClient} from "npm:@supabase/supabase-js@2.112.3";
// Isolated staging readiness only: no email, orders, pricing or payments.
const TARGET="https://hvdoqcrnztqmbzgwrovd.supabase.co";
const APP="https://app.rainbow-driver.com";
const headers={"Access-Control-Allow-Origin":APP,"Access-Control-Allow-Headers":"authorization,apikey,content-type,x-client-info","Access-Control-Allow-Methods":"POST,OPTIONS","Vary":"Origin","Cache-Control":"no-store","Content-Type":"application/json"};
const reply=(body,status=200)=>new Response(JSON.stringify(body),{status,headers});
// Return existence/format checks only; never expose credentials or key digests.
function base64KeyConfigured(name,sizes){
 const s=Deno.env.get(name)||'';
 try{
  if(!s||!/^[A-Za-z0-9+/]+={0,2}$/.test(s)||s.length%4)return false;
  return sizes.includes(Uint8Array.from(atob(s),c=>c.charCodeAt(0)).length);
 }catch{return false}
}
function customerConfiguration(schemaReady){
 const env=name=>Deno.env.get(name)||'';
 const result={
  verification_key_configured:base64KeyConfigured('CARGO_INTAKE_HMAC_KEY',[32,64]),
  encryption_key_configured:base64KeyConfigured('CARGO_CONTACT_AES_256_GCM_KEY',[32]),
  captcha_configured:!!(env('CARGO_CUSTOMER_TURNSTILE_SITE_KEY')&&env('CARGO_CUSTOMER_TURNSTILE_SECRET')),
  email_provider_configured:env('CARGO_CUSTOMER_EMAIL_PROVIDER')==='resend'&&!!env('CARGO_CUSTOMER_RESEND_API_KEY')&&/^[^\\s@]{1,64}@[^\\s@]{1,190}$/.test(env('CARGO_CUSTOMER_FROM_EMAIL')),
  schema_configured:schemaReady
 };
 return {...result,configuration_recognized:Object.values(result).every(v=>v===true),
  external_delivery_verified:false,public_intake_enabled:false};
}
Deno.serve(async req=>{
 const origin=req.headers.get("origin");
 if(req.method==="OPTIONS")return origin===APP?new Response(null,{status:204,headers}):reply({error:"ORIGIN_DENIED"},403);
 if(req.method!=="POST")return reply({error:"METHOD_NOT_ALLOWED"},405);
 if(origin!==APP)return reply({error:"ORIGIN_DENIED"},403);
 const token=(req.headers.get("authorization")||"").match(/^Bearer\s+(\S+)$/i)?.[1];
 if(!token)return reply({error:"LOGIN_REQUIRED"},401);
 try{
  const text=await req.text();
  if(text.length>128)return reply({error:"INVALID_INPUT"},400);
  const body=JSON.parse(text);
  if(!body||typeof body!=="object"||Array.isArray(body)||Object.keys(body).length!==1||body.action!=="status")return reply({error:"STATUS_ONLY"},400);
 }catch{return reply({error:"INVALID_INPUT"},400)}
 const url=Deno.env.get("SUPABASE_URL"),key=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
 if(url!==TARGET||!key)return reply({error:"STAGING_ONLY"},503);
 try{
  const db=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}});
  const {data,error}=await db.auth.getUser(token);
  if(error||!data?.user)return reply({error:"INVALID_SESSION"},401);
  const member=await db.from("cargo_operator_accounts").select("user_id").eq("user_id",data.user.id).maybeSingle();
  if(member.error||!member.data)return reply({error:"OPERATOR_ONLY"},403);
  const gate=await db.from("cargo_intake_control").select("intake_enabled,captcha_required,contact_verification_required").eq("id",1).maybeSingle();
  if(gate.error||gate.data?.intake_enabled!==false||gate.data?.captcha_required!==true||gate.data?.contact_verification_required!==true)return reply({error:"INTAKE_MUST_BE_OFF"},423);
  for(const table of ["cargo_customer_intake_drafts","cargo_customer_intake_requests"]){
   const r=await db.from(table).select("id").limit(0);
   if(r.error)return reply({error:"SCHEMA_NOT_READY"},503);
  }
  let customerSchemaReady=true;
  for(const table of ['cargo_customer_quote_replies','cargo_customer_quote_followups','cargo_customer_quote_followup_events']){
   const r=await db.from(table).select('*').limit(0);
   if(r.error)customerSchemaReady=false;
  }
  return reply({ok:true,environment:"CARGO_FREE_STAGING",operator_verified:true,database_ready:true,public_intake_enabled:false,email_sent:false,request_created:false,payment_created:false,customer_flow_ready:false,customer_preparation:customerConfiguration(customerSchemaReady)});
 }catch{return reply({error:"READINESS_UNAVAILABLE"},503)}
});
