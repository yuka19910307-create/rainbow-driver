import {createClient} from "npm:@supabase/supabase-js@2.112.3";
// Development candidate only. JWT verification must remain enabled at deployment.
// Operator-observed agreement is not authenticated customer consent or a legal finding.
// No mail, notifications, payment, driver assignment, or public-intake switch changes.
const APP="https://app.rainbow-driver.com";
const headers={"Access-Control-Allow-Origin":APP,
 "Access-Control-Allow-Headers":"authorization,apikey,content-type,x-client-info",
 "Access-Control-Allow-Methods":"POST,OPTIONS","Cache-Control":"no-store",
 "Vary":"Origin","Content-Type":"application/json; charset=utf-8"};
const respond=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers});
const flags={legal_contract_determined:false,customer_notified:false,
 payment_created:false,dispatch_created:false};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const statuses=["accepted","preparing","in_transit","completed","cancelled"];
const actions=["record_agreement","accept_order","apply_agreement","change_status"];
const eventKinds=["customer_agreement_recorded","order_accepted","agreement_applied","status_changed"];
const confirmations:Record<string,string>={record_agreement:"RECORD_OBSERVED_CUSTOMER_AGREEMENT",
 accept_order:"RECORD_OPERATOR_ACCEPTANCE",apply_agreement:"APPLY_RECORDED_AGREEMENT",
 change_status:"RECORD_DELIVERY_STATE_CHANGE"};
const validUuid=(v:unknown)=>typeof v==="string"&&uuid.test(v);
const integer=(v:unknown,min=0)=>Number.isSafeInteger(v)&&Number(v)>=min&&Number(v)<=2147483647;
const iso=(v:unknown)=>typeof v==="string"&&/^(?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v)&&
 Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;
// PostgreSQL JSON timestamps may use +00:00 and microseconds; request timestamps remain canonical ISO.
const dbIso=(v:unknown)=>typeof v==="string"&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(v)&&Number.isFinite(Date.parse(v));
const text=(v:unknown,min:number,max:number)=>typeof v==="string"&&v.trim().length>=min&&v.length<=max;
function keys(value:Record<string,unknown>,allowed:string[],optional:string[]=[]){
 const actual=Object.keys(value);
 return allowed.every(k=>Object.hasOwn(value,k))&&actual.every(k=>allowed.includes(k)||optional.includes(k));
}
async function boundedBody(req:Request){
 const maximum=36000,declared=req.headers.get("content-length");
 if(declared&&/^\d+$/.test(declared)&&Number(declared)>maximum){
  void req.body?.cancel().catch(()=>{});throw Error("BODY_TOO_LARGE");
 }
 if(!req.body)return "";
 const reader=req.body.getReader(),decoder=new TextDecoder("utf-8",{fatal:true});
 let size=0,result="",complete=false;
 try{
  while(true){const {done,value}=await reader.read();if(done)break;
   size+=value.byteLength;if(size>maximum)throw Error("BODY_TOO_LARGE");
   result+=decoder.decode(value,{stream:true});
  }
  result+=decoder.decode();complete=true;
  if(result.length>12000)throw Error("BODY_TOO_LARGE");
  return result;
 }finally{if(!complete)void reader.cancel().catch(()=>{});reader.releaseLock()}
}
function secret(){
 const value=Deno.env.get("CARGO_CONTACT_AES_256_GCM_KEY")||"";
 try{
  if(!/^[A-Za-z0-9+/]+={0,2}$/.test(value)||value.length%4)return null;
  const bytes=Uint8Array.from(atob(value),c=>c.charCodeAt(0));
  return bytes.length===32?bytes:null;
 }catch{return null}
}
async function encrypt(key:CryptoKey,payload:Record<string,unknown>){
 const iv=crypto.getRandomValues(new Uint8Array(12));
 const cipher=new Uint8Array(await crypto.subtle.encrypt({name:"AES-GCM",iv},key,
  new TextEncoder().encode(JSON.stringify(payload))));
 const bytes=new Uint8Array(13+cipher.length);bytes[0]=1;bytes.set(iv,1);bytes.set(cipher,13);
 return "\\x"+Array.from(bytes,b=>b.toString(16).padStart(2,"0")).join("");
}
async function decrypt(key:CryptoKey,source:unknown,kind:string){
 if(typeof source!=="string"||!/^\\x[0-9a-f]+$/i.test(source)||source.length%2||
    source.length<60||source.length>30002)throw Error("INVALID_CIPHERTEXT");
 const bytes=Uint8Array.from({length:(source.length-2)/2},(_,i)=>parseInt(source.slice(i*2+2,i*2+4),16));
 if(bytes[0]!==1)throw Error("INVALID_CIPHERTEXT");
 const plain=await crypto.subtle.decrypt({name:"AES-GCM",iv:bytes.slice(1,13)},key,bytes.slice(13));
 const payload=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(plain));
 if(!payload||typeof payload!=="object"||Array.isArray(payload))throw Error("INVALID_PAYLOAD");
 if(kind==="record_agreement"){
  if(!keys(payload,["conditions","confirmation_note"])||!text(payload.conditions,30,1200)||
     !text(payload.confirmation_note,5,600))throw Error("INVALID_PAYLOAD");
 }else if(kind==="change_status"){
  if(!keys(payload,["note"])||!text(payload.note,0,600))throw Error("INVALID_PAYLOAD");
 }else throw Error("INVALID_PAYLOAD");
 return payload;
}
function validInput(input:Record<string,unknown>){
 if(!validUuid(input.request_id))return false;
 if(input.action==="read")return keys(input,["action","request_id"],
  ["before_event_sequence","before_agreement_version"])&&
  (input.before_event_sequence===undefined||integer(input.before_event_sequence,1))&&
  (input.before_agreement_version===undefined||integer(input.before_agreement_version,1));
 if(!actions.includes(String(input.action))||!validUuid(input.operation_id)||
    !integer(input.expected_order_version)||input.confirmation!==confirmations[String(input.action)])return false;
 const common=["action","request_id","operation_id","expected_order_version","confirmation"];
 if(input.action==="record_agreement")return keys(input,[...common,"expected_agreement_version",
  "amount_yen","pickup_at","delivery_at","customer_confirmed_at","confirmation_method","conditions","confirmation_note"])&&
  integer(input.expected_agreement_version)&&integer(input.amount_yen,1)&&Number(input.amount_yen)<=10000000&&
  iso(input.pickup_at)&&(input.delivery_at===null||iso(input.delivery_at)&&
   Date.parse(String(input.delivery_at))>=Date.parse(String(input.pickup_at)))&&
  iso(input.customer_confirmed_at)&&Date.parse(String(input.customer_confirmed_at))<=Date.now()&&
  ["email","phone","in_person","other"].includes(String(input.confirmation_method))&&
  text(input.conditions,30,1200)&&text(input.confirmation_note,5,600);
 if(input.action==="accept_order"||input.action==="apply_agreement")return keys(input,[...common,"agreement_version"])&&
  integer(input.agreement_version,1)&&(input.action!=="accept_order"||input.expected_order_version===0)&&
  (input.action!=="apply_agreement"||integer(input.expected_order_version,1));
 return keys(input,[...common,"next_status","note"])&&integer(input.expected_order_version,1)&&
  statuses.slice(1).includes(String(input.next_status))&&text(input.note,input.next_status==="cancelled"?5:0,600);
}
function validOrder(row:any,requestId:string){
 return row&&row.request_id===requestId&&statuses.includes(row.status)&&integer(row.version,1)&&
  integer(row.active_agreement_version,1)&&validUuid(row.accepted_by)&&dbIso(row.accepted_at)&&
  validUuid(row.updated_by)&&dbIso(row.updated_at)&&
  (row.completed_at===null||dbIso(row.completed_at))&&(row.cancelled_at===null||dbIso(row.cancelled_at))&&
  row.retention_policy==="undetermined_hold"&&row.retention_until===null;
}
function validAgreement(row:any,requestId:string){
 return row&&row.request_id===requestId&&integer(row.version,1)&&integer(row.amount_yen,1)&&row.amount_yen<=10000000&&
  dbIso(row.pickup_at)&&(row.delivery_at===null||dbIso(row.delivery_at)&&Date.parse(row.delivery_at)>=Date.parse(row.pickup_at))&&
  dbIso(row.customer_confirmed_at)&&["email","phone","in_person","other"].includes(row.confirmation_method)&&
  validUuid(row.recorded_by)&&dbIso(row.recorded_at);
}
function validEvent(row:any,requestId:string){
 return row&&row.request_id===requestId&&integer(row.sequence,1)&&validUuid(row.operation_id)&&eventKinds.includes(row.kind)&&
  (row.from_status===null||statuses.includes(row.from_status))&&(row.to_status===null||statuses.includes(row.to_status))&&
  integer(row.order_version)&&integer(row.agreement_version,1)&&validUuid(row.actor_id)&&dbIso(row.recorded_at);
}
Deno.serve(async(req:Request)=>{
 const origin=req.headers.get("origin");
 if(req.method==="OPTIONS")return origin===APP?new Response(null,{status:204,headers}):respond({error:"ORIGIN_DENIED"},403);
 if(req.method!=="POST")return respond({error:"METHOD_NOT_ALLOWED"},405);
 if(origin!==APP)return respond({error:"ORIGIN_DENIED"},403);
 const bearer=(req.headers.get("authorization")||"").match(/^Bearer\s+([^\s]+)$/i)?.[1];
 if(!bearer)return respond({error:"LOGIN_REQUIRED"},401);
 let input:Record<string,unknown>;
 try{
  input=JSON.parse(await boundedBody(req));
  if(!input||typeof input!=="object"||Array.isArray(input)||!validInput(input))throw Error("INVALID_INPUT");
 }catch(error){return respond({error:error instanceof Error&&error.message==="BODY_TOO_LARGE"?"BODY_TOO_LARGE":"INVALID_INPUT"},
  error instanceof Error&&error.message==="BODY_TOO_LARGE"?413:422)}
 const url=Deno.env.get("SUPABASE_URL"),role=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"),aes=secret();
 if(!url||!role||!aes)return respond({error:"NOT_CONFIGURED"},503);
 try{
  const db=createClient(url,role,{auth:{persistSession:false,autoRefreshToken:false}});
  const {data:auth,error:authError}=await db.auth.getUser(bearer);
  if(authError||!validUuid(auth?.user?.id))return respond({error:"INVALID_SESSION"},401);
  const {data:operator,error:memberError}=await db.from("cargo_operator_accounts")
   .select("user_id").eq("user_id",auth.user.id).maybeSingle();
  if(memberError)return respond({error:"ORDER_UNAVAILABLE"},503);
  if(operator?.user_id!==auth.user.id)return respond({error:"OPERATOR_ONLY"},403);
  const requestId=String(input.request_id).toLowerCase();
  const key=await crypto.subtle.importKey("raw",aes,"AES-GCM",false,["encrypt","decrypt"]);
  if(input.action==="read"){
   // One locked DB snapshot; no direct-table read fallback when this RPC is absent.
   const {data:snapshot,error:readError}=await db.rpc("cargo_customer_order_read",{
    p_request_id:requestId,p_operator_id:auth.user.id,
    p_before_event_sequence:input.before_event_sequence??null,
    p_before_agreement_version:input.before_agreement_version??null
   });
   if(readError||!snapshot||typeof snapshot!=="object"||Array.isArray(snapshot))throw Error("READ_UNAVAILABLE");
   if(snapshot.ok===false){
    if(snapshot.reason==="OPERATOR_ONLY")return respond({error:"OPERATOR_ONLY"},403);
    if(snapshot.reason==="NOT_FOUND")return respond({error:"REQUEST_NOT_FOUND"},404);
    throw Error("READ_UNAVAILABLE");
   }
   if(snapshot.ok!==true||snapshot.request_id!==requestId)throw Error("INVALID_SNAPSHOT");
   const {order,agreements,events}=snapshot;
   const orderColumns="request_id,status,version,active_agreement_version,accepted_by,accepted_at,updated_by,updated_at,completed_at,cancelled_at,retention_policy,retention_until";
   if(order!==null&&!validOrder(order,requestId))throw Error("INVALID_ORDER");
   if(!Array.isArray(agreements)||!Array.isArray(events)||agreements.length>51||events.length>51)
    throw Error("INVALID_HISTORY");
   let previousAgreement=Number.MAX_SAFE_INTEGER,previousEvent=Number.MAX_SAFE_INTEGER;
   for(const row of agreements){if(!validAgreement(row,requestId)||row.version>=previousAgreement||
    input.before_agreement_version!==undefined&&row.version>=Number(input.before_agreement_version))throw Error("INVALID_HISTORY");previousAgreement=row.version}
   for(const row of events){if(!validEvent(row,requestId)||row.sequence>=previousEvent||
    input.before_event_sequence!==undefined&&row.sequence>=Number(input.before_event_sequence))throw Error("INVALID_HISTORY");previousEvent=row.sequence}
   const decodedAgreements=[];
   for(const row of agreements.slice(0,50))decodedAgreements.push({request_id:requestId,version:row.version,
    amount_yen:row.amount_yen,pickup_at:row.pickup_at,delivery_at:row.delivery_at,customer_confirmed_at:row.customer_confirmed_at,
    confirmation_method:row.confirmation_method,recorded_by:row.recorded_by,recorded_at:row.recorded_at,
    ...await decrypt(key,row.encrypted_payload,"record_agreement")});
   const decodedEvents=[];
   for(const row of events.slice(0,50))decodedEvents.push({request_id:requestId,sequence:row.sequence,operation_id:row.operation_id,kind:row.kind,
    from_status:row.from_status,to_status:row.to_status,order_version:row.order_version,agreement_version:row.agreement_version,
    actor_id:row.actor_id,recorded_at:row.recorded_at,payload:row.encrypted_payload===null?null:await decrypt(key,row.encrypted_payload,row.kind==="customer_agreement_recorded"?"record_agreement":row.kind==="status_changed"?"change_status":"unexpected")});
   // The read RPC takes the same consultation lock; mutation version checks still apply.
   const visibleOrder=order?Object.fromEntries(orderColumns.split(",").map(k=>[k,order[k]])):null;
   return respond({ok:true,request_id:requestId,order:visibleOrder,agreements:decodedAgreements,events:decodedEvents,
    next_before_agreement_version:agreements.length>50?agreements[49].version:null,
    next_before_event_sequence:events.length>50?events[49].sequence:null,
    customer_agreement_source:"operator_observation",snapshot_consistent:true,...flags});
  }
  let payload:null|string=null;
  if(input.action==="record_agreement")payload=await encrypt(key,{conditions:String(input.conditions).trim(),confirmation_note:String(input.confirmation_note).trim()});
  if(input.action==="change_status")payload=await encrypt(key,{note:String(input.note).trim()});
  const {data:saved,error:saveError}=await db.rpc("cargo_customer_order_command",{
   p_request_id:requestId,p_operator_id:auth.user.id,p_operation_id:String(input.operation_id).toLowerCase(),
   p_action:input.action,p_expected_order_version:input.expected_order_version,
   p_expected_agreement_version:input.action==="record_agreement"?input.expected_agreement_version:null,
   p_agreement_version:input.action==="accept_order"||input.action==="apply_agreement"?input.agreement_version:null,
   p_amount_yen:input.action==="record_agreement"?input.amount_yen:null,
   p_pickup_at:input.action==="record_agreement"?input.pickup_at:null,
   p_delivery_at:input.action==="record_agreement"?input.delivery_at:null,
   p_customer_confirmed_at:input.action==="record_agreement"?input.customer_confirmed_at:null,
   p_confirmation_method:input.action==="record_agreement"?input.confirmation_method:null,
   p_encrypted_payload:payload,p_next_status:input.action==="change_status"?input.next_status:null,
   p_confirmation:input.confirmation
  });
  if(saveError||!saved||typeof saved!=="object"||Array.isArray(saved))return respond({error:"ORDER_UNAVAILABLE"},503);
  if(saved.ok===false)return respond({ok:false,error:"ORDER_CONFLICT",...flags},409);
  if(saved.ok!==true||saved.request_id!==requestId||!integer(saved.order_version)||!integer(saved.agreement_version,1)||
    !(saved.status===null||statuses.includes(saved.status)))return respond({error:"ORDER_UNAVAILABLE"},503);
  const expectedVersion=Number(input.expected_order_version)+(input.action==="record_agreement"?0:1);
  if(saved.order_version!==expectedVersion||
    input.action==="record_agreement"&&saved.agreement_version!==Number(input.expected_agreement_version)+1||
    (input.action==="accept_order"||input.action==="apply_agreement")&&saved.agreement_version!==input.agreement_version||
    input.action==="accept_order"&&saved.status!=="accepted"||
    input.action==="change_status"&&saved.status!==input.next_status)
   return respond({error:"ORDER_UNAVAILABLE"},503);
  return respond({ok:true,request_id:requestId,order_version:saved.order_version,
   agreement_version:saved.agreement_version,status:saved.status,customer_agreement_source:"operator_observation",...flags});
 }catch{return respond({error:"ORDER_UNAVAILABLE"},503)}
});
