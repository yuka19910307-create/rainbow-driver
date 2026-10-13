import {createClient} from "npm:@supabase/supabase-js@2.112.3";
// REVIEW ONLY — cargo customer intake OPERATOR queue. Do not deploy yet.
// No public listing, no auto-quote, no driver assignment, no payment, no push.
const APP="https://app.rainbow-driver.com";
const headers={"Access-Control-Allow-Origin":APP,
 "Access-Control-Allow-Headers":"authorization,apikey,content-type,x-client-info",
 "Access-Control-Allow-Methods":"POST,OPTIONS","Cache-Control":"no-store",
 "Vary":"Origin","Content-Type":"application/json; charset=utf-8"};
const respond=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers});
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
  if(!["list","decision","quote_prepare","quote_send"].includes(String(data.action)))throw Error();
  const expected=data.action==="list"?["action"]:
   data.action==="decision"?["action","id","expected_status","next_status"]:
   data.action==="quote_prepare"?["action","id","amount_yen","terms","valid_until"]:
   ["action","id","confirmation"];
  const actual=Object.keys(data).sort();
  if(actual.length!==expected.length||
    actual.some((k,i)=>k!==[...expected].sort()[i]))throw Error();
  if(data.action==="decision"&&(!canonical.test(String(data.id||""))||
      !["pending_operator_review","operator_reviewing"].includes(String(data.expected_status))||
      !["operator_reviewing","declined","closed"].includes(String(data.next_status))))
    throw Error();
  if(data.action==="quote_prepare"&&(!canonical.test(String(data.id||""))||
      !Number.isSafeInteger(data.amount_yen)||Number(data.amount_yen)<1||
      Number(data.amount_yen)>10000000||typeof data.terms!=="string"||
      data.terms.trim().length<30||data.terms.length>1200||
      typeof data.valid_until!=="string"||Number.isNaN(Date.parse(data.valid_until))||
      new Date(data.valid_until).toISOString()!==data.valid_until))
    throw Error();
  if(data.action==="quote_send"&&(!canonical.test(String(data.id||""))||
     data.confirmation!=="SEND_APPROVED_QUOTE"))
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
  if(data.action==="quote_prepare"){
   const {data:prepared,error:prepareError}=await db.rpc("cargo_customer_quote_prepare",{
    p_request_id:data.id,p_operator_id:auth.user.id,
    p_amount_yen:data.amount_yen,p_terms:data.terms.trim(),p_valid_until:data.valid_until
   });
   if(prepareError||!prepared)return respond({error:"QUOTE_PREPARE_UNAVAILABLE"},503);
   if(prepared.ok!==true)return respond({ok:false,reason:prepared.reason||"DENIED"},422);
   return respond({ok:true,reason:"QUOTE_READY_TO_SEND",id:data.id,
    payment_created:false,customer_notified:false,driver_assigned:false});
  }
  if(data.action==="quote_send"){
   // Never claim a delivery attempt until sender config is complete.
   const sendKey=Deno.env.get("CARGO_CUSTOMER_RESEND_API_KEY")||"";
   const from=Deno.env.get("CARGO_CUSTOMER_FROM_EMAIL")||"";
   const provider=Deno.env.get("CARGO_CUSTOMER_EMAIL_PROVIDER")||"";
   if(!sendKey||provider!=="resend"||!/^\\S+@\\S+\\.\\S+$/.test(from))
    return respond({error:"QUOTE_EMAIL_NOT_CONFIGURED"},503);
   const {data:claimed,error:claimError}=await db.rpc("cargo_customer_quote_claim_send",{
    p_request_id:data.id,p_operator_id:auth.user.id
   });
   if(claimError||!claimed)return respond({error:"QUOTE_CLAIM_UNAVAILABLE"},503);
   if(claimed.ok!==true)return respond({ok:false,reason:claimed.reason||"DENIED"},422);
   // The claimed attempt is irreversible: ambiguous failures MUST NOT resend.
   let providerAccepted=false,providerId:null|string=null;
   try{
    const {data:reqRow,error:reqError}=await db.from("cargo_customer_intake_requests")
     .select("encrypted_payload").eq("id",data.id).eq("status","operator_reviewing").maybeSingle();
    if(reqError||!reqRow)throw Error("QUOTE_REQUEST_UNAVAILABLE");
    const key=await crypto.subtle.importKey("raw",aes,"AES-GCM",false,["decrypt"]);
    const details=await decrypt(key,String(reqRow.encrypted_payload||""));
    const email=String(details.email).toLowerCase();
    if(email.length>254||!(/^[^\\s@]{1,64}@[^\\s@]{1,190}$/.test(email)))throw Error("INVALID_RECIPIENT");
    const amount=Number(claimed.amount_yen);
    const until=new Date(String(claimed.valid_until));
    if(!Number.isSafeInteger(amount)||amount<1||amount>10000000||
      !Number.isFinite(until.valueOf())||
      typeof claimed.terms!=="string"||claimed.terms.length<30||
      claimed.terms.length>1200)throw Error("INVALID_QUOTE_CONTENT");
    const body="Rainbow Driver 軽貨物のお見積もり案内\\n\\n"+
     "受付ID: "+data.id+"\\n"+
     "お見積もり金額（管理者確認済み）: "+amount.toLocaleString("ja-JP")+"円\\n"+
     "有効期限: "+until.toLocaleString("ja-JP",{timeZone:"Asia/Tokyo"})+"\\n\\n"+
     "適用条件・消費税・高速道路料金等の取扱い:\\n"+
     claimed.terms+"\\n\\n"+
     "このご案内だけでは配送の受諾・出動・予約・決済は確定しません。"+
     "ご利用の場合は担当者からの別途確認をお待ちください。";
    // Check intake mode a second time immediately before contacting the
    // external mail provider. The earlier transactional claim is also gated.
    const {data:sendGate,error:sendGateError}=await db.from("cargo_intake_control")
     .select("intake_enabled,captcha_required,contact_verification_required")
     .eq("id",1).maybeSingle();
    if(sendGateError||sendGate?.intake_enabled!==true||
       sendGate?.captcha_required!==true||
       sendGate?.contact_verification_required!==true)
     throw Error("PUBLIC_INTAKE_DISABLED");
    const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),10000);
    try{
     const sent=await fetch("https://api.resend.com/emails",{
      method:"POST",signal:controller.signal,
      headers:{"Authorization":"Bearer "+sendKey,"Content-Type":"application/json"},
      body:JSON.stringify({
       from,to:[email],
       subject:"Rainbow Driver 軽貨物｜お見積もりのご案内",
       text:body
      })
     });
     if(sent.ok){
      const response=await sent.json();
      if(typeof response?.id==="string"&&response.id.length>0&&response.id.length<=200){
       providerAccepted=true;providerId=response.id;
      }
     }
    }finally{clearTimeout(timeout)}
   }catch{/* Unknown delivery — do not retry. */}
   const {data:finalized,error:finalizeError}=await db.rpc("cargo_customer_quote_finalize",{
    p_request_id:data.id,p_operator_id:auth.user.id,
    p_provider_accepted:providerAccepted,p_provider_message_id:providerId
   });
   if(finalizeError||finalized?.ok!==true)
    return respond({error:"QUOTE_DELIVERY_STATUS_UNCERTAIN",do_not_retry:true},503);
   return respond({ok:providerAccepted,reason:providerAccepted?"QUOTE_PROVIDER_ACCEPTED":"DELIVERY_UNKNOWN",
    provider_accepted:providerAccepted,do_not_retry:true,
    payment_created:false,driver_assigned:false},providerAccepted?200:503);
  }
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
  const ids=(rows||[]).map(r=>r.id);
  let quotes=new Map<string,unknown>();
  if(ids.length){
   const {data:quoteRows,error:quoteError}=await db.from("cargo_customer_quote_replies")
    .select("request_id,amount_yen,terms,valid_until,delivery_status,updated_at")
    .in("request_id",ids);
   if(quoteError)return respond({error:"QUOTE_QUEUE_UNAVAILABLE"},503);
   quotes=new Map((quoteRows||[]).map(q=>[q.request_id,q]));
  }
  const key=await crypto.subtle.importKey("raw",aes,"AES-GCM",false,["decrypt"]);
  const items=[];
  for(const row of rows||[]){
   const info=await decrypt(key,String(row.encrypted_payload||""));
   items.push({id:row.id,status:row.status,created_at:row.created_at,
    details:info,quote:quotes.get(row.id)||null});
  }
  return respond({ok:true,items,customer_notified:false,
   automatic_dispatch:false,automatic_quote:false});
 }catch{return respond({error:"QUEUE_UNAVAILABLE"},503)}
});
