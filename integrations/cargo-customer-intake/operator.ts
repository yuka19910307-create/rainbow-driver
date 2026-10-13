import {createClient} from "npm:@supabase/supabase-js@2.112.3";
// REVIEW ONLY — cargo customer intake OPERATOR queue. Do not deploy yet.
// No public listing, no auto-quote, no driver assignment, no payment, no push.
const APP="https://app.rainbow-driver.com";
const headers={"Access-Control-Allow-Origin":APP,
 "Access-Control-Allow-Headers":"authorization,apikey,content-type,x-client-info",
 "Access-Control-Allow-Methods":"POST,OPTIONS","Cache-Control":"no-store",
 "Vary":"Origin","Content-Type":"application/json; charset=utf-8"};
const respond=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers});
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// Full canonical UUID (no version requirement for externally generated ids).
const canonical=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function aesSecret(){
 const s=Deno.env.get("CARGO_CONTACT_AES_256_GCM_KEY")||"";
 try{
  if(!/^[A-Za-z0-9+/]+={0,2}$/.test(s)||s.length%4)return null;
  const raw=Uint8Array.from(atob(s),c=>c.charCodeAt(0));
  return raw.length===32?raw:null;
 }catch{return null}
}
function ciphertext(raw:string){
 if(!/^\\x[0-9a-f]+$/i.test(raw))throw Error("INVALID_ENCRYPTION");
 const h=raw.slice(2);
 if(h.length%2||h.length<58||h.length>30000)throw Error("INVALID_ENCRYPTION");
 return Uint8Array.from({length:h.length/2},(_,i)=>parseInt(h.slice(i*2,i*2+2),16));
}
async function decrypt(key:CryptoKey,source:string){
 const bytes=ciphertext(source);
 if(bytes[0]!==1)throw Error("UNSUPPORTED_ENCRYPTION");
 const plaintext=await crypto.subtle.decrypt({name:"AES-GCM",iv:bytes.slice(1,13)},
  key,bytes.slice(13));
 const data=JSON.parse(new TextDecoder().decode(plaintext));
 if(!data||typeof data!=="object"||typeof data.email!=="string")throw Error("INVALID_PAYLOAD");
 return data;
}
Deno.serve(async(req:Request)=>{
 const origin=req.headers.get("origin");
 if(req.method==="OPTIONS")return origin===APP
  ?new Response(null,{status:204,headers}):respond({error:"ORIGIN_DENIED"},403);
 if(req.method!=="POST")return respond({error:"METHOD_NOT_ALLOWED"},405);
 if(origin!==APP)return respond({error:"ORIGIN_DENIED"},403);
 const bearer=(req.headers.get("authorization")||"").match(/^Bearer\s+([^\s]+)$/i)?.[1];
 if(!bearer)return respond({error:"LOGIN_REQUIRED"},401);
 let data:Record<string,unknown>;
 try{
  const source=await req.text();
  if(source.length>1024)return respond({error:"BODY_TOO_LARGE"},413);
  data=JSON.parse(source);
  if(!data||typeof data!=="object"||Array.isArray(data))throw Error();
  if(data.action!=="list"&&data.action!=="decision")throw Error();
  const expected=data.action==="list"?["action"]:["action","id","expected_status","next_status"];
  const actual=Object.keys(data).sort();
  if(actual.length!==expected.length||
    actual.some((k,i)=>k!==[...expected].sort()[i]))throw Error();
  if(data.action==="decision"&&(!canonical.test(String(data.id||""))||
      !["pending_operator_review","operator_reviewing"].includes(String(data.expected_status))||
      !["operator_reviewing","declined","closed"].includes(String(data.next_status))))
    throw Error();
 }catch{return respond({error:"INVALID_INPUT"},422)}
 const url=Deno.env.get("SUPABASE_URL"),role=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
 const aes=aesSecret();
 if(!url||!role||!aes)return respond({error:"NOT_CONFIGURED"},503);
 try{
  const db=createClient(url,role,{auth:{persistSession:false,autoRefreshToken:false}});
  const {data:auth,error:authError}=await db.auth.getUser(bearer);
  if(authError||!auth?.user)return respond({error:"INVALID_SESSION"},401);
  const {data:operator,error:memberError}=await db.from("cargo_operator_accounts")
   .select("user_id").eq("user_id",auth.user.id).maybeSingle();
  if(memberError||!operator)return respond({error:"OPERATOR_ONLY"},403);
  if(data.action==="decision"){
   // Optimistic state comparison: no prices, no notifications, no dispatch.
   const {data:updated,error:changeError}=await db.from("cargo_customer_intake_requests")
    .update({status:data.next_status})
    .eq("id",data.id).eq("status",data.expected_status).select("id,status").maybeSingle();
   if(changeError)return respond({error:"SAVE_FAILED"},503);
   if(!updated)return respond({error:"STATUS_CHANGED"},409);
   return respond({ok:true,id:updated.id,status:updated.status,
    payment_created:false,driver_assigned:false,customer_notified:false});
  }
  const {data:rows,error:readError}=await db.from("cargo_customer_intake_requests")
   .select("id,status,created_at,encrypted_payload")
   .in("status",["pending_operator_review","operator_reviewing"])
   .order("created_at",{ascending:false}).limit(20);
  if(readError)return respond({error:"QUEUE_UNAVAILABLE"},503);
  const key=await crypto.subtle.importKey("raw",aes,"AES-GCM",false,["decrypt"]);
  const items=[];
  for(const row of rows||[]){
   const info=await decrypt(key,String(row.encrypted_payload||""));
   items.push({id:row.id,status:row.status,created_at:row.created_at,
    details:info});
  }
  return respond({ok:true,items,customer_notified:false,
   automatic_dispatch:false,automatic_quote:false});
 }catch{return respond({error:"QUEUE_UNAVAILABLE"},503)}
});
