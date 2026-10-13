import {createClient} from "npm:@supabase/supabase-js@2.112.3";
// REVIEW ONLY — customer quote response. Public Edge Function must verify_jwt=false.
// Despite public invocation, only a one-time 256-bit email link grants viewing
// and a non-binding "interested"/"declined" response. No payment or dispatch.
const APP="https://app.rainbow-driver.com";
const HEADERS={"Access-Control-Allow-Origin":APP,
 "Access-Control-Allow-Headers":"apikey,authorization,content-type,x-client-info",
 "Access-Control-Allow-Methods":"POST,OPTIONS",
 "Cache-Control":"no-store","Vary":"Origin",
 "Content-Type":"application/json; charset=utf-8",
 "Referrer-Policy":"no-referrer"};
const response=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:HEADERS});
const idPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const secretPattern=/^[0-9a-f]{64}$/i;
const encoder=new TextEncoder();
async function proof(rawKey:string,id:string,token:string){
 if(!/^[A-Za-z0-9+/]+={0,2}$/.test(rawKey)||rawKey.length%4!==0)
  return null;
 try{
  const secret=Uint8Array.from(atob(rawKey),c=>c.charCodeAt(0));
  if(secret.length<32||secret.length>64)return null;
  const key=await crypto.subtle.importKey("raw",secret,
   {name:"HMAC",hash:"SHA-256"},false,["sign"]);
  const digest=new Uint8Array(await crypto.subtle.sign("HMAC",key,
   encoder.encode("CARGO_CUSTOMER_QUOTE_REPLY_V1|"+id+"|"+token)));
  return "\\x"+Array.from(digest,b=>b.toString(16).padStart(2,"0")).join("");
 }catch{return null}
}
Deno.serve(async(req:Request)=>{
 const origin=req.headers.get("origin");
 if(req.method==="OPTIONS")return origin===APP
  ?new Response(null,{status:204,headers:HEADERS}):response({error:"ORIGIN_DENIED"},403);
 if(req.method!=="POST")return response({error:"METHOD_NOT_ALLOWED"},405);
 if(origin!==APP)return response({error:"ORIGIN_DENIED"},403);
 let input:Record<string,unknown>;
 try{
  const body=await req.text();
  if(body.length>350)return response({error:"BODY_TOO_LARGE"},413);
  input=JSON.parse(body);
  if(!input||typeof input!=="object"||Array.isArray(input))throw Error();
  if(!["view","reply"].includes(String(input.action)))throw Error();
  const allowed=input.action==="view"?["action","id","token"]:["action","id","token","choice"];
  const keys=Object.keys(input).sort();
  if(keys.length!==allowed.length||keys.some((k,i)=>k!==allowed.sort()[i]))
   throw Error();
  if(typeof input.id!=="string"||!idPattern.test(input.id)
   ||typeof input.token!=="string"||!secretPattern.test(input.token)
   ||(input.action==="reply"&&!["interested","declined"].includes(String(input.choice))))
   throw Error();
 }catch{return response({error:"INVALID_LINK"},422)}
 const url=Deno.env.get("SUPABASE_URL")||"";
 const role=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")||"";
 const key=Deno.env.get("CARGO_INTAKE_HMAC_KEY")||"";
 if(!url||!role||!key)return response({error:"NOT_CONFIGURED"},503);
 const tokenProof=await proof(key,String(input.id),String(input.token).toLowerCase());
 if(!tokenProof)return response({error:"NOT_CONFIGURED"},503);
 try{
  const db=createClient(url,role,{auth:{persistSession:false,autoRefreshToken:false}});
  const {data:gate,error:gateError}=await db.from("cargo_intake_control")
   .select("intake_enabled,captcha_required,contact_verification_required")
   .eq("id",1).maybeSingle();
  if(gateError||gate?.intake_enabled!==true||
     gate?.captcha_required!==true||gate?.contact_verification_required!==true)
   return response({error:"PUBLIC_INTAKE_DISABLED"},423);
  const {data:result,error}=await db.rpc("cargo_customer_quote_reply",{
   p_request_id:input.id,
   p_response_token_hmac:tokenProof,
   p_choice:input.action==="reply"?input.choice:null
  });
  if(error||!result)return response({error:"RESPONSE_UNAVAILABLE"},503);
  if(result.ok!==true)return response({error:String(result.reason||"LINK_UNAVAILABLE")},422);
  if(input.action==="view")return response({
   ok:true,amount_yen:result.amount_yen,terms:result.terms,
   valid_until:result.valid_until,reply_state:result.reply_state||null,
   booking_confirmed:false,payment_created:false,driver_assigned:false
  });
  return response({
   ok:true,reason:result.reason,
   operator_review_required:true,booking_confirmed:false,
   payment_created:false,driver_assigned:false
  });
 }catch{return response({error:"RESPONSE_UNAVAILABLE"},503)}
});
