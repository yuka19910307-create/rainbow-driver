import {createClient} from "npm:@supabase/supabase-js@2.112.3";
// STAGING ONLY: manages an owner-only window. This function has no mail provider call.
const STAGE="https://hvdoqcrnztqmbzgwrovd.supabase.co",APP="https://app.rainbow-driver.com";
const OWNER="5ccbfcd5-bd0f-4a9a-b570-223b3deb2567";
const headers={"Access-Control-Allow-Origin":APP,"Access-Control-Allow-Headers":"apikey,authorization,content-type,x-client-info","Access-Control-Allow-Methods":"POST,OPTIONS","Cache-Control":"no-store","Vary":"Origin","Content-Type":"application/json; charset=utf-8"};
const send=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers});
const fixture={pickup:"テスト集荷地・伊奈町",delivery:"テスト配送先・さいたま市",cargo:"テスト用・精密機器の箱",pieces:2,weight:8.5,length:40,width:30,height:25,handling:"unknown",readiness:"ready",note:"管理者限定の架空案件です。",clientName:"テスト担当者",today:true,reviewConfirm:true};
function configured(){
 const s=(k:string)=>Deno.env.get(k)||"";
 const valid=(raw:string,lengths:number[])=>{try{return /^[A-Za-z0-9+/]+={0,2}$/.test(raw)&&raw.length%4===0&&lengths.includes(atob(raw).length)}catch{return false}};
 return valid(s("CARGO_INTAKE_HMAC_KEY"),[32,64])&&valid(s("CARGO_CONTACT_AES_256_GCM_KEY"),[32])&&
  !!s("CARGO_CUSTOMER_TURNSTILE_SITE_KEY")&&!!s("CARGO_CUSTOMER_TURNSTILE_SECRET")&&
  !!s("CARGO_CUSTOMER_RESEND_API_KEY")&&/^\S+@\S+\.\S+$/.test(s("CARGO_CUSTOMER_FROM_EMAIL"))&&s("CARGO_CUSTOMER_EMAIL_PROVIDER")==="resend";
}
Deno.serve(async(req:Request)=>{
 const origin=req.headers.get("origin");
 if(req.method==="OPTIONS")return origin===APP?new Response(null,{status:204,headers}):send({error:"ORIGIN_DENIED"},403);
 if(origin!==APP)return send({error:"ORIGIN_DENIED"},403);
 if(req.method!=="POST")return send({error:"METHOD_NOT_ALLOWED"},405);
 const url=Deno.env.get("SUPABASE_URL"),role=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
 if(url!==STAGE||!role)return send({error:"STAGING_ONLY"},403);
 const bearer=(req.headers.get("authorization")||"").match(/^Bearer\s+([^\s]+)$/i)?.[1];
 if(!bearer)return send({error:"LOGIN_REQUIRED"},401);
 try{
  const raw=await req.text();if(raw.length>300)return send({error:"INVALID_INPUT"},422);
  const body=JSON.parse(raw);
  if(!body||typeof body!=="object"||Array.isArray(body)||!["status","begin","finish"].includes(body.action))return send({error:"INVALID_INPUT"},422);
  const expected=body.action==="begin"?["action","confirmation"]:["action"];
  if(Object.keys(body).sort().join(",")!==expected.sort().join(",")||(body.action==="begin"&&body.confirmation!=="BEGIN_OWNER_ONLY_MAIL_TRIAL"))return send({error:"INVALID_INPUT"},422);
  const db=createClient(url,role,{auth:{persistSession:false,autoRefreshToken:false}});
  const {data,error}=await db.auth.getUser(bearer);const user=data?.user;
  if(error||user?.id!==OWNER||!user.email_confirmed_at||typeof user.email!=="string")return send({error:"OWNER_ONLY"},403);
  if(body.action==="begin"&&!configured())return send({error:"NOT_CONFIGURED"},503);
  const result=await db.rpc("cargo_staging_owner_test_session",{p_owner_id:user.id,p_action:body.action});
  if(result.error||result.data?.ok!==true)return send({error:"TRIAL_UNAVAILABLE"},503);
  return send({...result.data,email:user.email.toLowerCase(),fixture,environment:"CARGO_FREE_STAGING",owner_only:true,public_intake_enabled:false,email_sent:false,payment_created:false,dispatch_created:false});
 }catch{return send({error:"TRIAL_UNAVAILABLE"},503)}
});
