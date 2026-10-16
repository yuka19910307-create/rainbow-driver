import {createClient} from "npm:@supabase/supabase-js@2.112.3";
// Cargo customer intake OPERATOR queue. Staging-tested; production rollout pending.
// No public listing, no auto-quote, no driver assignment, no payment, no push.
const APP="https://app.rainbow-driver.com";
// BEGIN STAGING OWNER TEST GUARD (keep identical in the three handlers)
const STAGING_PROJECT="https://hvdoqcrnztqmbzgwrovd.supabase.co";
const STAGING_OWNER="5ccbfcd5-bd0f-4a9a-b570-223b3deb2567";
function stagingFixture(){return {
 pickup:"テスト集荷地・伊奈町",delivery:"テスト配送先・さいたま市",
 cargo:"テスト用・精密機器の箱",pieces:2,weight:8.5,length:40,width:30,height:25,
 handling:"unknown",readiness:"ready",note:"管理者限定の架空案件です。",
 clientName:"テスト担当者",today:true,reviewConfirm:true
}}
async function stagingOwnerTest(db:any,projectUrl:string,req:Request,action:string,input:Record<string,unknown>,claim=false){
 if(projectUrl!==STAGING_PROJECT)return {allowed:true,staging:false};
 try{
  const token=(req.headers.get("authorization")||"").match(/^Bearer\s+([^\s]+)$/i)?.[1];
  if(!token)return {allowed:false,staging:true};
  const {data:auth,error}=await db.auth.getUser(token);
  const user=auth?.user;
  if(error||user?.id!==STAGING_OWNER||!user.email_confirmed_at||typeof user.email!=="string")
   return {allowed:false,staging:true};
  if(action==="start"){
   if(typeof input.email!=="string"||input.email.trim().toLowerCase()!==user.email.toLowerCase())
    return {allowed:false,staging:true};
   const incoming=input.request as Record<string,unknown>,fixed=stagingFixture();
   if(!incoming||Object.keys(incoming).sort().join(",")!==Object.keys(fixed).sort().join(",")||
      Object.entries(fixed).some(([k,v])=>incoming[k]!==v))return {allowed:false,staging:true};
  }
  const target=(action==="start"||action==="mail_check")?input.attempt_id:
   action==="verify"?input.challenge_id:input.id;
  const {data:result,error:denied}=await db.rpc("cargo_staging_owner_test_authorize",{
   p_owner_id:user.id,p_action:action,p_target_id:target??null,p_claim:claim
  });
  if(denied||result?.ok!==true)return {allowed:false,staging:true};
  return {allowed:true,staging:true,draft_id:result.draft_id,email:user.email.toLowerCase(),expires_at:result.expires_at};
 }catch{return {allowed:false,staging:true}}
}
// END STAGING OWNER TEST GUARD

// Staging mail must return to the staging-backed page, never the production API.
function quoteReplyPath(projectUrl:string){
 return projectUrl==="https://hvdoqcrnztqmbzgwrovd.supabase.co"
  ?"/staging/cargo-customer-quote-reply.html":"/cargo-customer-quote-reply.html";
}
const headers={"Access-Control-Allow-Origin":APP,
 "Access-Control-Allow-Headers":"authorization,apikey,content-type,x-client-info",
 "Access-Control-Allow-Methods":"POST,OPTIONS","Cache-Control":"no-store",
 "Vary":"Origin","Content-Type":"application/json; charset=utf-8"};
const respond=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers});
// Keep each deployment self-contained. Bound bytes before decoding or JSON parsing.
// UTF-8 needs at most 3 bytes per UTF-16 code unit, preserving the character cap.
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
  const source=await boundedBody(req,12000*3);
  if(source.length>12000)return respond({error:"BODY_TOO_LARGE"},413);
  data=JSON.parse(source);
  if(!data||typeof data!=="object"||Array.isArray(data))throw Error();
  if(!["list","list_retention","decision","quote_prepare","quote_send","followup","close_no_order","retention_hold"].includes(String(data.action)))throw Error();
  const expected=(data.action==="list"||data.action==="list_retention")?["action"]:
   data.action==="close_no_order"?["action","id","confirmation"]:
   data.action==="retention_hold"?["action","id","hold","confirmation"]:
   data.action==="decision"?["action","id","expected_status","next_status"]:
   data.action==="quote_prepare"?["action","id","amount_yen","terms","valid_until"]:
   data.action==="followup"?["action","id","expected_stage","next_stage","note"]:
   ["action","id","confirmation"];
  const actual=Object.keys(data).sort();
  if(actual.length!==expected.length||
    actual.some((k,i)=>k!==[...expected].sort()[i]))throw Error();
  if(data.action==="decision"&&(!canonical.test(String(data.id||""))||
      !["pending_operator_review","operator_reviewing"].includes(String(data.expected_status))||
      !["operator_reviewing","declined"].includes(String(data.next_status))))
    throw Error();
  if(data.action==="close_no_order"&&(!canonical.test(String(data.id||""))||
     data.confirmation!=="CLOSE_WITHOUT_ORDER_OR_RETENTION_NEED"))throw Error();
  if(data.action==="retention_hold"&&(!canonical.test(String(data.id||""))||
     typeof data.hold!=="boolean"||
     data.confirmation!==(data.hold?"KEEP_REQUIRED_RECORD":"RELEASE_WITHOUT_RETENTION_NEED")))throw Error();
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
  if(data.action==="followup"&&(
     !canonical.test(String(data.id||""))||
     !(data.expected_stage===null||["contact_attempted","awaiting_reply","handled_offline","closed_no_order"].includes(String(data.expected_stage)))||
     !["contact_attempted","awaiting_reply","handled_offline","closed_no_order"].includes(String(data.next_stage))||
     typeof data.note!=="string"||data.note.trim().length<5||data.note.trim().length>600))
    throw Error();
 }catch(error){
  if(error instanceof Error&&error.message==="BODY_TOO_LARGE")return respond({error:"BODY_TOO_LARGE"},413);
  return respond({error:"INVALID_INPUT"},422);
 }
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
  if(data.action==="close_no_order"||data.action==="retention_hold"){
   const closing=data.action==="close_no_order";
   const {data:saved,error:saveError}=await db.rpc(
    closing?"cargo_customer_close_no_order":"cargo_customer_retention_set_hold",
    closing?{p_request_id:data.id,p_operator_id:auth.user.id,p_no_order_confirmed:true}:
     {p_request_id:data.id,p_operator_id:auth.user.id,p_hold:data.hold}
   );
   if(saveError||!saved)return respond({error:"RETENTION_UNAVAILABLE"},503);
   if(saved.ok!==true)return respond({ok:false,reason:saved.reason||"DENIED"},422);
   return respond({ok:true,reason:saved.reason,delete_after:saved.delete_after||null,
    customer_notified:false,payment_created:false,dispatch_created:false});
  }
  if(data.action==="followup"){
   const {data:saved,error:saveError}=await db.rpc("cargo_customer_followup_save",{
    p_request_id:data.id,p_operator_id:auth.user.id,
    p_expected_stage:data.expected_stage,p_next_stage:data.next_stage,
    p_note:data.note.trim()
   });
   if(saveError||!saved)return respond({error:"FOLLOWUP_UNAVAILABLE"},503);
   if(saved.ok!==true)return respond({ok:false,reason:saved.reason||"DENIED"},422);
   return respond({ok:true,reason:"FOLLOWUP_RECORDED",stage:saved.stage,
    booking_confirmed:false,dispatch_created:false,
    payment_created:false,customer_notified:false});
  }
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
   if(!sendKey||provider!=="resend"||!/^\S+@\S+\.\S+$/.test(from))
    return respond({error:"QUOTE_EMAIL_NOT_CONFIGURED"},503);
   // Generate a unique opaque 256-bit response token. Only its keyed HMAC is stored.
   // The one-time secret appears in the email link fragment (never in URL query).
   const rawHmac=Deno.env.get("CARGO_INTAKE_HMAC_KEY")||"";
   let hmacBytes:Uint8Array;
   try{
    if(!/^[A-Za-z0-9+/]+={0,2}$/.test(rawHmac)||rawHmac.length%4)throw Error();
    hmacBytes=Uint8Array.from(atob(rawHmac),c=>c.charCodeAt(0));
    if(hmacBytes.length<32||hmacBytes.length>64)throw Error();
   }catch{return respond({error:"QUOTE_TOKEN_SECRET_NOT_CONFIGURED"},503)}
   const rawToken=crypto.getRandomValues(new Uint8Array(32));
   const hex=Array.from(rawToken,b=>b.toString(16).padStart(2,"0")).join("");
   const secretKey=await crypto.subtle.importKey("raw",hmacBytes,
    {name:"HMAC",hash:"SHA-256"},false,["sign"]);
   const signed=new Uint8Array(await crypto.subtle.sign("HMAC",secretKey,
    new TextEncoder().encode("CARGO_CUSTOMER_QUOTE_REPLY_V1|"+data.id+"|"+hex)));
   const fingerprint="\\x"+Array.from(signed,b=>b.toString(16).padStart(2,"0")).join("");
   if(!(await stagingOwnerTest(db,url,req,"quote_send",data,true)).allowed)
    return respond({error:"OWNER_TEST_DENIED"},403);
   const {data:claimed,error:claimError}=await db.rpc("cargo_customer_quote_claim_send",{
    p_request_id:data.id,p_operator_id:auth.user.id,
    p_response_token_hmac:fingerprint
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
    if(email.length>254||!(/^[^\s@]{1,64}@[^\s@]{1,190}$/.test(email)))throw Error("INVALID_RECIPIENT");
    const amount=Number(claimed.amount_yen);
    const until=new Date(String(claimed.valid_until));
    if(!Number.isSafeInteger(amount)||amount<1||amount>10000000||
      !Number.isFinite(until.valueOf())||
      typeof claimed.terms!=="string"||claimed.terms.length<30||
      claimed.terms.length>1200)throw Error("INVALID_QUOTE_CONTENT");
    const body="Rainbow Driver 軽貨物のお見積もり案内\n\n"+
     "受付ID: "+data.id+"\n"+
     "お見積もり金額（管理者確認済み）: "+amount.toLocaleString("ja-JP")+"円\n"+
     "有効期限: "+until.toLocaleString("ja-JP",{timeZone:"Asia/Tokyo"})+"\n\n"+
     "適用条件・消費税・高速道路料金等の取扱い:\n"+
     claimed.terms+"\n\n"+
     "このご案内だけでは配送の受諾・出動・予約・決済は確定しません。"+
     "ご利用をご希望の場合は下記のページで「利用を希望する」を選んでください。"+
     "ご希望を確認後、担当者から別途ご連絡します。\n\n"+
     "お見積もりへのご回答（有効期限まで）：\n"+
     APP+quoteReplyPath(url)+"#r="+encodeURIComponent(String(data.id))+
       "&t="+hex+"\n\n"+
     "回答は一度のみ有効です。URLは第三者に共有しないでください。";
    // Check intake mode a second time immediately before contacting the
    // external mail provider. The earlier transactional claim is also gated.
    const {data:sendGate,error:sendGateError}=await db.from("cargo_intake_control")
     .select("intake_enabled,captcha_required,contact_verification_required")
     .eq("id",1).maybeSingle();
    if(sendGateError||sendGate?.intake_enabled!==true||
       sendGate?.captcha_required!==true||
       sendGate?.contact_verification_required!==true)
     throw Error("PUBLIC_INTAKE_DISABLED");
    if(!(await stagingOwnerTest(db,url,req,"quote_mail_check",data)).allowed)
     throw Error("OWNER_TEST_DENIED");
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
   .select("id,status,created_at,encrypted_payload,closed_no_order_at,retention_hold,delete_after")
   .in("status",data.action==="list_retention"?["closed","declined"]:["pending_operator_review","operator_reviewing","quoted"])
   .order("created_at",{ascending:false}).limit(20);
  if(readError)return respond({error:"QUEUE_UNAVAILABLE"},503);
  const ids=(rows||[]).map(r=>r.id);
  let quotes=new Map<string,unknown>();
  if(ids.length){
   const {data:quoteRows,error:quoteError}=await db.from("cargo_customer_quote_replies")
    .select("request_id,amount_yen,terms,valid_until,delivery_status,updated_at,response_state,responded_at")
    .in("request_id",ids);
   if(quoteError)return respond({error:"QUOTE_QUEUE_UNAVAILABLE"},503);
   quotes=new Map((quoteRows||[]).map(q=>[q.request_id,q]));
  }
  const followups=new Map<string,unknown>();
  if(ids.length){
   const {data:followupRows,error:followupError}=await db
    .from("cargo_customer_quote_followups")
    .select("request_id,stage,operator_note,updated_at")
    .in("request_id",ids);
   if(followupError)return respond({error:"FOLLOWUP_QUEUE_UNAVAILABLE"},503);
   for(const row of followupRows||[])followups.set(row.request_id,row);
  }
  const key=await crypto.subtle.importKey("raw",aes,"AES-GCM",false,["decrypt"]);
  const items=[];
  for(const row of rows||[]){
   const info=await decrypt(key,String(row.encrypted_payload||""));
   items.push({id:row.id,status:row.status,created_at:row.created_at,
    closed_no_order_at:row.closed_no_order_at,retention_hold:row.retention_hold,
    delete_after:row.delete_after,
    details:info,quote:quotes.get(row.id)||null,
    followup:followups.get(row.id)||null});
  }
  return respond({ok:true,items,customer_notified:false,
   automatic_dispatch:false,automatic_quote:false});
 }catch{return respond({error:"QUEUE_UNAVAILABLE"},503)}
});

