import {createClient} from "npm:@supabase/supabase-js@2.112.3";

// REVIEW ONLY: operator-only fictional draft binding. Do not deploy before
// reviewing design/cargo-operator-draft-otp-binding.review.sql.
// Never handles customer contacts, public intake, dispatch, or payment.
const APP="https://app.rainbow-driver.com";
const HEADERS={
 "Access-Control-Allow-Origin":APP,
 "Access-Control-Allow-Headers":"authorization,apikey,content-type,x-client-info",
 "Access-Control-Allow-Methods":"POST,OPTIONS",
 "Cache-Control":"no-store","Vary":"Origin",
 "Content-Type":"application/json; charset=utf-8"
};
const json=(v:unknown,status=200)=>new Response(JSON.stringify(v),{status,headers:HEADERS});
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const enc=new TextEncoder();
const toHex=(v:Uint8Array)=>Array.from(v,x=>x.toString(16).padStart(2,"0")).join("");
const bytea=(v:Uint8Array)=>"\\x"+toHex(v);
const TEST_FIXTURE={
 pickup:"テスト集荷地・さいたま市",
 delivery:"テスト配送先・東京都内",
 cargo:"テスト用・精密機器の箱",
 pieces:2,weight:8.5
};
function getKey():Uint8Array|null{
 const s=Deno.env.get("CARGO_INTAKE_HMAC_KEY");
 if(!s||s.length>512||s.length%4!==0||!/^[A-Za-z0-9+/]+={0,2}$/.test(s))return null;
 try{const b=Uint8Array.from(atob(s),c=>c.charCodeAt(0));return b.length>=32&&b.length<=64?b:null}
 catch{return null}
}
async function mac(key:CryptoKey,message:string){
 return new Uint8Array(await crypto.subtle.sign("HMAC",key,enc.encode(message)));
}
Deno.serve(async(req:Request)=>{
 const origin=req.headers.get("origin");
 if(req.method==="OPTIONS")return origin===APP?new Response(null,{status:204,headers:HEADERS}):json({error:"ORIGIN_DENIED"},403);
 if(req.method!=="POST")return json({error:"METHOD_NOT_ALLOWED"},405);
 if(origin&&origin!==APP)return json({error:"ORIGIN_DENIED"},403);
 const token=(req.headers.get("authorization")||"").match(/^Bearer\s+([^\s]+)$/i)?.[1];
 if(!token)return json({error:"LOGIN_REQUIRED"},401);
 let input:{action:string;challenge_id?:string;draft_id?:string};
 try{
  const raw=await req.text();
  if(raw.length>256)return json({error:"BODY_TOO_LARGE"},413);
  const b=JSON.parse(raw);
  if(!b||typeof b!=="object"||Array.isArray(b))return json({error:"INVALID_BODY"},400);
  if(!["status","bind","claim"].includes(b.action))return json({error:"OPERATOR_PRELAUNCH_ONLY"},400);
  const expected=b.action==="status"?["action"]:b.action==="bind"?["action","challenge_id"]:["action","challenge_id","draft_id"];
  const keys=Object.keys(b).sort();
  if(keys.length!==expected.length||keys.some((x,i)=>x!==expected[i]))
   return json({error:"INVALID_FIELDS"},400);
  if((b.action!=="status"&&(typeof b.challenge_id!=="string"||!UUID.test(b.challenge_id)))
   ||(b.action==="claim"&&(typeof b.draft_id!=="string"||!UUID.test(b.draft_id))))
   return json({error:"INVALID_IDENTIFIERS"},422);
  input=b;
 }catch{return json({error:"INVALID_BODY"},400)}
 const url=Deno.env.get("SUPABASE_URL");
 const service=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
 const secret=getKey();
 if(!url||!service||!secret)return json({error:"SERVER_UNAVAILABLE"},503);
 try{
  const db=createClient(url,service,{auth:{persistSession:false,autoRefreshToken:false}});
  const {data:{user},error:authErr}=await db.auth.getUser(token);
  if(authErr||!user)return json({error:"INVALID_SESSION"},401);
  const {data:operator,error:opErr}=await db.from("cargo_operator_accounts")
   .select("user_id").eq("user_id",user.id).maybeSingle();
  if(opErr||!operator)return json({error:"OPERATOR_ONLY"},403);
  const {data:gate,error:gateErr}=await db.from("cargo_intake_control")
   .select("intake_enabled,captcha_required,contact_verification_required")
   .eq("id",1).maybeSingle();
  if(gateErr||!gate||gate.intake_enabled!==false
   ||gate.captcha_required!==true||gate.contact_verification_required!==true)
   return json({error:"PUBLIC_INTAKE_MUST_BE_DISABLED"},423);
  if(input.action==="status"){
   // Read-only readiness probe: prevent sending Gmail before binding support
   // is actually deployed. The invalid-input RPC performs no writes.
   const {error:tableErr}=await db.from("cargo_operator_draft_otp_bindings")
    .select("draft_id").limit(0);
   if(tableErr)return json({error:"BINDING_NOT_READY"},503);
   const {data:probe,error:rpcErr}=await db.rpc("cargo_operator_draft_otp_claim",{
    p_operator_id:null,p_draft_id:null,p_challenge_id:null,
    p_subject_hmac:null,p_draft_fingerprint_hmac:null
   });
   if(rpcErr||probe?.reason!=="INVALID_INPUT"||probe?.ok!==false)
    return json({error:"BINDING_NOT_READY"},503);
   return json({ok:true,mode:"OPERATOR_SYNTHETIC_DRAFT_ONLY",
    ready:true,public_intake_enabled:false,customer_data_processed:false});
  }
  const key=await crypto.subtle.importKey("raw",secret,{name:"HMAC",hash:"SHA-256"},false,["sign"]);
  // Identical subject derivation to cargo-gmail-otp-test, without leaking its value.
  const subject=bytea(await mac(key,"CARGO_OPERATOR_SELF_TEST|"+user.id));
  // Fixed, immutable, server-computed fictional draft; never trust a client hash.
  const fingerprint=bytea(await mac(key,"CARGO_OPERATOR_DRAFT_V1|"+JSON.stringify(TEST_FIXTURE)));
  if(input.action==="bind"){
   const {data:challenge,error:chErr}=await db.from("cargo_email_verification_challenges")
    .select("id,subject_hmac,created_at,expires_at,delete_after,consumed_at")
    .eq("id",input.challenge_id!).maybeSingle();
   if(chErr||!challenge||String(challenge.subject_hmac).toLowerCase()!==subject
    ||challenge.consumed_at!==null||Date.parse(challenge.expires_at)<=Date.now())
    return json({error:"CHALLENGE_NOT_AVAILABLE"},422);
   const {data:latest,error:latestErr}=await db.from("cargo_email_verification_challenges")
    .select("id").eq("subject_hmac",subject).order("created_at",{ascending:false})
    .limit(1).maybeSingle();
   if(latestErr||latest?.id!==input.challenge_id)return json({error:"OLDER_CHALLENGE"},422);
   const draftId=crypto.randomUUID();
   const {error:saveErr}=await db.from("cargo_operator_draft_otp_bindings").insert({
    draft_id:draftId,operator_id:user.id,challenge_id:input.challenge_id,
    subject_hmac:subject,draft_fingerprint_hmac:fingerprint,
    expires_at:challenge.expires_at,delete_after:challenge.delete_after
   });
   if(saveErr)return json({error:"BINDING_UNAVAILABLE"},503);
   return json({ok:true,mode:"OPERATOR_SYNTHETIC_DRAFT_ONLY",
    draft_id:draftId,challenge_id:input.challenge_id,public_intake_enabled:false,
    customer_data_processed:false,dispatch_created:false},200);
  }
  const {data:claimed,error:claimErr}=await db.rpc("cargo_operator_draft_otp_claim",{
   p_operator_id:user.id,p_draft_id:input.draft_id,
   p_challenge_id:input.challenge_id,p_subject_hmac:subject,
   p_draft_fingerprint_hmac:fingerprint
  });
  if(claimErr||!claimed)return json({error:"CLAIM_UNAVAILABLE"},503);
  const ok=claimed.ok===true&&claimed.reason==="CLAIMED";
  return json({ok,reason:ok?"CLAIMED":String(claimed.reason||"DENIED"),
   public_intake_enabled:false,customer_data_processed:false,dispatch_created:false},ok?200:422);
 }catch{return json({error:"BINDING_SERVICE_UNAVAILABLE"},503)}
});
