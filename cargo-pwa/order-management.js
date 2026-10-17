/* Development candidate: operator records only. No mail, payment or dispatch. */
(()=>{"use strict";
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATES={accepted:"受注済み",preparing:"配送準備中",in_transit:"配送中",completed:"配送完了",cancelled:"中止"};
const METHODS={email:"メール",phone:"電話",in_person:"対面",other:"その他"};
const KINDS={customer_agreement_recorded:"顧客との合意を確認・記録",order_accepted:"管理者が正式受注を記録",agreement_applied:"変更した合意条件を適用",status_changed:"配送状態を変更"};
const EVENT_KIND={record_agreement:"customer_agreement_recorded",accept_order:"order_accepted",apply_agreement:"agreement_applied",change_status:"status_changed"};
const CONFIRM={record_agreement:"RECORD_OBSERVED_CUSTOMER_AGREEMENT",accept_order:"RECORD_OPERATOR_ACCEPTANCE",apply_agreement:"APPLY_RECORDED_AGREEMENT",change_status:"RECORD_DELIVERY_STATE_CHANGE"};
const positive=n=>Number.isSafeInteger(n)&&n>0&&n<=2147483647;
const version=n=>Number.isSafeInteger(n)&&n>=0&&n<=2147483647;
const timestamp=s=>typeof s==="string"&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(s)&&Number.isFinite(Date.parse(s));
const validText=(s,min,max)=>typeof s==="string"&&s.trim().length>=min&&s.length<=max;
const known=(map,key)=>typeof key==="string"&&Object.hasOwn(map,key);
const el=(tag,text,className)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(className)node.className=className;return node};
function japanTime(value){return timestamp(value)?new Intl.DateTimeFormat("ja-JP",{timeZone:"Asia/Tokyo",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit",hour12:false}).format(new Date(value))+"（日本時間）":"未記録"}
// datetime-local is deliberately interpreted as JST, independently of device timezone.
function fromJapan(value){
 const match=typeof value==="string"&&value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
 if(!match)return null;
 const [year,month,day,hour,minute]=match.slice(1).map(Number);
 if(year<1||year>9999||month<1||month>12||day<1||day>31||hour>23||minute>59)return null;
 const d=new Date(0);d.setUTCFullYear(year,month-1,day);d.setUTCHours(hour,minute,0,0);
 if(d.getUTCFullYear()!==year||d.getUTCMonth()!==month-1||d.getUTCDate()!==day)return null;
 const result=new Date(d.getTime()-9*3600000).toISOString();
 return /^\d{4}-/.test(result)&&!result.startsWith("0000-")?result:null;
}
function safeFlags(data){return data?.customer_agreement_source==="operator_observation"&&["legal_contract_determined","customer_notified","payment_created","dispatch_created"].every(k=>data[k]===false)}
function create(options){
 const {item,userId,storageScope,invoke,acquire,release,onAuthFailure,onOrderChange}=options;
 if(!UUID.test(item?.id||"")||!UUID.test(userId||"")||typeof storageScope!=="string"||!storageScope||typeof invoke!=="function")throw Error("INVALID_ORDER_PANEL");
 const requestId=item.id.toLowerCase();
 const key="rd-cargo-order-pending-v1:"+encodeURIComponent(storageScope)+":"+userId.toLowerCase()+":"+requestId;
 const root=el("section",undefined,"cargo-orders");root.dataset.orderPanel=requestId;
 const heading=el("h3","正式受注・配送管理（管理者専用）");
 const message=el("p","受注管理の記録を確認してください。","cargo-orders-message");message.dataset.orderMessage="";message.setAttribute("role","status");
 const toolbar=el("div",undefined,"cargo-orders-actions"),content=el("div");
 root.append(heading,el("p","顧客との合意を管理者が確認した記録です。顧客本人がアプリ上で同意したことや、法的な契約成立時点を示すものではありません。"),message,toolbar,content);
 let disposed=false,loading=false,writing=false,authLost=false,snapshot=null,pending=null,ownedPendingId=null,storageFault=false,readToken=0;
 const locksAvailable=()=>typeof window.navigator?.locks?.request==="function";
 const actor=id=>id===userId?id+"（自分）":id;
 const tell=(text,error=false)=>{if(disposed)return;message.textContent=text;message.dataset.orderTone=error?"error":"info"};
 function button(label,action,run,next){const node=el("button",label);node.type="button";node.dataset.orderAction=action;if(next)node.dataset.nextStatus=next;node.addEventListener("click",run);return node}
 const readButton=button("受注管理を再読込","read",()=>load());
 const reconcileButton=button("結果不明の操作を履歴と照合","reconcile",()=>reconcile());toolbar.append(readButton,reconcileButton);
 function pendingValue(raw){
  if(raw===null)return null;
  const p=JSON.parse(raw),allowed=["v","operation_id","request_id","action","expected_order_version","expected_agreement_version"];
  if(!p||typeof p!=="object"||Array.isArray(p)||Object.keys(p).some(k=>!allowed.includes(k))||p.v!==1||!UUID.test(p.operation_id||"")||p.request_id!==requestId||!known(EVENT_KIND,p.action)||!version(p.expected_order_version)||!version(p.expected_agreement_version))throw Error("INVALID_PENDING");
  return p;
 }
 function stored(){return pendingValue(window.localStorage.getItem(key))}
 function notify(){if(!disposed)onOrderChange?.(snapshot?{...snapshot,pending_operation:!!pending||storageFault}:null)}
 function checkPending(){try{const saved=stored();if(saved||!ownedPendingId)pending=saved;storageFault=false;return saved}catch{storageFault=true;return null}}
 // Called only while the same Web Lock is held. Never remove another operation.
 function clearOwn(operationId){
  try{const current=stored();if(current?.operation_id===operationId)window.localStorage.removeItem(key);const remaining=stored();pending=remaining;if(ownedPendingId===operationId)ownedPendingId=null;storageFault=false;return !remaining}catch{storageFault=true;return false}
 }
 function persist(body){
  const old=stored();if(old){pending=old;return false}
  const record={v:1,operation_id:body.operation_id,request_id:requestId,action:body.action,expected_order_version:body.expected_order_version,expected_agreement_version:body.expected_agreement_version??body.agreement_version??snapshot?.agreements[0]?.version??0};
  window.localStorage.setItem(key,JSON.stringify(record));
  const saved=stored();if(saved?.operation_id!==record.operation_id){pending=saved||record;return false}
  pending=record;ownedPendingId=record.operation_id;return true;
 }
 function updateDisabled(){
  const blocked=disposed||authLost||loading||writing;
  readButton.disabled=blocked;reconcileButton.hidden=!pending&&!storageFault;reconcileButton.disabled=blocked||storageFault||!locksAvailable();
  for(const node of content.querySelectorAll("button,input,textarea,select")){
   const requiresWrite=node.tagName!=="BUTTON"||Object.hasOwn(CONFIRM,node.dataset.orderAction);
   node.disabled=blocked||!!pending||storageFault||node.dataset.orderPermanentDisabled==="true"||requiresWrite&&!locksAvailable();
  }
 }
 // Keep the lock across write + response handling (or history reconciliation).
 // localStorage alone has no atomic compare-and-set across browser tabs.
 async function operationLock(run){
  if(disposed||authLost)return;
  if(!locksAvailable()){tell("このブラウザでは複数タブの安全な操作制御を利用できません。記録は閲覧のみ可能です。対応ブラウザで操作してください。",true);updateDisabled();return}
  try{return await window.navigator.locks.request(key,{mode:"exclusive",ifAvailable:true},async lock=>{
   if(disposed||authLost)return;
   if(!lock){tell("別のタブで同じ相談を操作中です。新しい操作は送信していません。完了後に再読込してください。",true);return}
   return await run();
  })}catch{tell("操作の安全な照合を完了できません。再送せず、保存済みの操作記録を確認してください。",true)}
 }
 function scrub(){snapshot=null;content.replaceChildren();authLost=true;onOrderChange?.(null);updateDisabled()}
 function authFailure(body){
  // A write rejected before authorization has not reached the command RPC.
  // A read failure says nothing about an earlier unknown write, so keep its ID.
  if(Object.hasOwn(CONFIRM,body.action)&&UUID.test(body.operation_id||""))clearOwn(body.operation_id);
  scrub();tell("ログインまたは管理者権限を確認できません。再ログインし、権限を確認してください。",true);onAuthFailure?.();
 }
 async function result(body){
  let response;try{response=await invoke(body)}catch{return {kind:"unknown"}}
  if(disposed)return {kind:"disposed"};
  let data=response?.data,status=response?.error?.context?.status;
  if(response?.error){
   try{const context=response.error.context;data=context?.clone?await context.clone().json():data}catch{/* Never expose server error text. */}
   if(disposed)return {kind:"disposed"};
   if(status===401||status===403){authFailure(body);return {kind:"auth"}}
   if(status===409&&data?.ok===false&&data?.error==="ORDER_CONFLICT"&&["legal_contract_determined","customer_notified","payment_created","dispatch_created"].every(k=>data[k]===false))return {kind:"conflict"};
   return {kind:"unknown"};
  }
  // Some invoke adapters return structured error data without a transport error.
  if(["LOGIN_REQUIRED","INVALID_SESSION","OPERATOR_ONLY","ORIGIN_DENIED"].includes(data?.error)){authFailure(body);return {kind:"auth"}}
  return {kind:"data",data};
 }
 function validSnapshot(data,query){
  if(data?.ok!==true||data.request_id!==requestId||data.snapshot_consistent!==true||!safeFlags(data)||!Array.isArray(data.agreements)||!Array.isArray(data.events)||data.agreements.length>50||data.events.length>50)return false;
  const o=data.order;
  if(o!==null&&(!o||o.request_id!==requestId||!known(STATES,o.status)||!positive(o.version)||!positive(o.active_agreement_version)||!UUID.test(o.accepted_by||"")||!UUID.test(o.updated_by||"")||!timestamp(o.accepted_at)||!timestamp(o.updated_at)||o.retention_policy!=="undetermined_hold"||o.retention_until!==null||!(o.completed_at===null||timestamp(o.completed_at))||!(o.cancelled_at===null||timestamp(o.cancelled_at))))return false;
  let av=query.before_agreement_version??Infinity,es=query.before_event_sequence??Infinity;
  for(const a of data.agreements){if(!a||a.request_id!==requestId||!positive(a.version)||a.version>=av||!Number.isSafeInteger(a.amount_yen)||a.amount_yen<1||a.amount_yen>10000000||!timestamp(a.pickup_at)||!(a.delivery_at===null||timestamp(a.delivery_at)&&Date.parse(a.delivery_at)>=Date.parse(a.pickup_at))||!timestamp(a.customer_confirmed_at)||!known(METHODS,a.confirmation_method)||!UUID.test(a.recorded_by||"")||!timestamp(a.recorded_at)||!validText(a.conditions,30,1200)||!validText(a.confirmation_note,5,600))return false;av=a.version}
  for(const e of data.events){if(!e||e.request_id!==requestId||!positive(e.sequence)||e.sequence>=es||!UUID.test(e.operation_id||"")||!known(KINDS,e.kind)||!version(e.order_version)||!positive(e.agreement_version)||!UUID.test(e.actor_id||"")||!timestamp(e.recorded_at)||!(e.from_status===null||known(STATES,e.from_status))||!(e.to_status===null||known(STATES,e.to_status))||!(e.payload===null||e.kind==="status_changed"&&validText(e.payload?.note,0,600)||e.kind==="customer_agreement_recorded"&&validText(e.payload?.conditions,30,1200)&&validText(e.payload?.confirmation_note,5,600)))return false;es=e.sequence}
  for(const [keyName,rows,column] of [["next_before_agreement_version",data.agreements,"version"],["next_before_event_sequence",data.events,"sequence"]])if(!(data[keyName]===null||positive(data[keyName])&&rows.length===50&&data[keyName]===rows[49][column]))return false;
  return true;
 }
 async function readPage(cursors={}){const query={action:"read",request_id:requestId,...cursors};const r=await result(query);return r.kind==="data"&&validSnapshot(r.data,query)?{kind:"data",data:r.data}:r.kind==="data"?{kind:"unknown"}:r}
 async function withActive(data){
  if(!data.order)return {kind:"data",data};
  let active=data.agreements.find(a=>a.version===data.order.active_agreement_version);
  if(!active){const page=await readPage({before_agreement_version:data.order.active_agreement_version+1});if(page.kind!=="data")return page;
   if(orderStamp(page.data.order)!==orderStamp(data.order))return {kind:"unknown"};
   active=page.data.agreements.find(a=>a.version===data.order.active_agreement_version);
  }
  return active?{kind:"data",data:{...data,activeAgreement:active}}:{kind:"unknown"};
 }
 function initial(data){snapshot={order:data.order,activeAgreement:data.activeAgreement??null,agreements:[...data.agreements],events:[...data.events],nextAgreement:data.next_before_agreement_version,nextEvent:data.next_before_event_sequence};notify();render()}
 async function load(){
  if(disposed||authLost||loading||writing)return;
  loading=true;const token=++readToken;checkPending();onOrderChange?.(null);updateDisabled();tell("受注・合意・変更履歴を確認しています…");
  try{let r=await readPage();if(r.kind==="data")r=await withActive(r.data);if(disposed||token!==readToken)return false;
   if(r.kind!=="data"){if(r.kind!=="auth"){snapshot=null;content.replaceChildren();onOrderChange?.(null);tell("受注管理を確認できません。通信・導入状況を確認してから再読込してください。",true)}return false}
   initial(r.data);tell(pending?"処理結果が未確認の操作があります。新しい操作をせず、履歴と照合してください。":storageFault?"操作記録の保存領域を確認できません。保存領域が使える状態になるまで変更できません。":!locksAvailable()?"このブラウザは複数タブの安全な操作制御に未対応です。記録は閲覧できますが変更できません。":"最新の記録を表示しました。条件の記録だけでは正式受注になりません。");return true;
  }finally{if(!disposed&&token===readToken){loading=false;updateDisabled()}}
 }
 function orderStamp(order){return order?order.version+":"+order.status+":"+order.active_agreement_version:"none"}
 async function more(type){
  if(disposed||authLost||loading||writing||pending||storageFault||!snapshot)return;
  const cursor=type==="agreements"?snapshot.nextAgreement:snapshot.nextEvent;if(cursor===null)return;
  loading=true;updateDisabled();const original=orderStamp(snapshot.order);
  try{const r=await readPage(type==="agreements"?{before_agreement_version:cursor}:{before_event_sequence:cursor});if(disposed)return;
   if(r.kind!=="data"){if(r.kind!=="auth")tell("続きの履歴を取得できませんでした。再読込してください。",true);return}
   if(orderStamp(r.data.order)!==original){tell("別の操作で受注状態が変わりました。再読込して確認してください。",true);return}
   const rows=type==="agreements"?r.data.agreements:r.data.events;
   if(type==="agreements"){snapshot.agreements.push(...rows);snapshot.nextAgreement=r.data.next_before_agreement_version}else{snapshot.events.push(...rows);snapshot.nextEvent=r.data.next_before_event_sequence}
   render();tell("履歴の続きを表示しました。現在の操作前には再読込して確認してください。");
  }finally{loading=false;updateDisabled()}
 }
 function reconcile(){return operationLock(reconcileLocked)}
 async function reconcileLocked(){
  if(disposed||authLost||loading||writing||storageFault)return;
  checkPending();if(!pending||storageFault){updateDisabled();return}
  const target=pending;loading=true;updateDisabled();tell("送信済み操作を履歴全体と照合しています。再送は行いません。 ");
  let first=null,cursor=null,found=false;
  try{do{const r=await readPage(cursor===null?{}:{before_event_sequence:cursor});if(disposed)return;
    if(r.kind!=="data"){if(r.kind!=="auth")tell("照合できませんでした。結果不明のまま停止します。時間をおいて再照合してください。",true);return}
    if(!first)first=r.data;
    if(r.data.events.some(e=>e.operation_id===target.operation_id&&e.kind===EVENT_KIND[target.action])){found=true;break}
    cursor=r.data.next_before_event_sequence;
   }while(cursor!==null);
   if(first){const ready=await withActive(first);if(disposed)return;if(ready.kind!=="data"){if(ready.kind!=="auth")tell("現在適用中の条件を照合できませんでした。結果不明のまま停止します。",true);return}first=ready.data}
   if(found){const cleared=clearOwn(target.operation_id);if(first)initial(first);tell(cleared?"操作が履歴に記録されていることを確認しました。内容を再読込してから次の操作を行ってください。":"操作は記録されていますが、別の未確認操作または保存領域の問題があります。新しい操作を停止しています。",!cleared)}
   else{if(first)initial(first);tell("該当する操作を履歴で確認できません。未処理とは断定できないため、再送せず停止しています。管理者による調査が必要です。",true)}
  }finally{loading=false;updateDisabled()}
 }
 function validSuccess(data,body){
  return data?.ok===true&&data.request_id===requestId&&safeFlags(data)&&data.order_version===body.expected_order_version+(body.action==="record_agreement"?0:1)&&positive(data.agreement_version)&&(data.status===null||known(STATES,data.status))&&
   (body.action!=="record_agreement"||data.agreement_version===body.expected_agreement_version+1)&&
   (!["accept_order","apply_agreement"].includes(body.action)||data.agreement_version===body.agreement_version)&&
   (body.action!=="accept_order"||data.status==="accepted")&&(body.action!=="change_status"||data.status===body.next_status)&&
   (body.action!=="record_agreement"||data.status===(snapshot.order?.status??null))&&(body.action!=="apply_agreement"||data.status===snapshot.order?.status);
 }
 function write(action,extra,confirmationText){return operationLock(()=>writeLocked(action,extra,confirmationText))}
 async function writeLocked(action,extra,confirmationText){
  if(disposed||authLost||loading||writing||!snapshot)return;
  checkPending();if(pending||storageFault){tell("未確認の操作または保存領域の問題があるため、新しい操作を開始できません。",true);updateDisabled();return}
  if(!window.confirm(confirmationText))return;
  if(typeof acquire==="function"&&!acquire()){tell("別の操作中です。完了後に再読込して確認してください。",true);return}
  writing=true;updateDisabled();let saved=false,needsRead=false,started=false;
  try{
   if(!window.crypto?.randomUUID)throw Error("STORAGE_UNAVAILABLE");
   const body={action,request_id:requestId,operation_id:window.crypto.randomUUID(),expected_order_version:snapshot.order?.version??0,confirmation:CONFIRM[action],...extra};
   try{saved=persist(body)}catch{storageFault=true}notify();
   if(!saved){tell("操作照合に必要な記録を安全に保存できません。操作は送信していません。保存領域を確認してください。",true);return}
   started=true;const r=await result(body);if(disposed)return;
   if(r.kind==="data"&&validSuccess(r.data,body)){
    const cleared=clearOwn(body.operation_id);onOrderChange?.(null);tell(cleared?"記録を保存しました。最新の状態を確認しています。":"保存されましたが、別の未確認操作があるため停止しています。",!cleared);needsRead=true;
   }else if(r.kind==="conflict"){
    clearOwn(body.operation_id);onOrderChange?.(null);tell("別の操作または状態の変化により保存されませんでした。最新の内容を再確認してください。",true);needsRead=true;
   }else if(r.kind!=="auth")tell("操作結果を確認できません。二重処理を避けるため再送できません。「履歴と照合」で確認してください。",true);
  }catch{tell(started?"操作結果を確認できません。再送せず、履歴と照合してください。":"安全な操作記録を準備できないため、送信を開始していません。ブラウザの保存領域を確認してください。",true)}
  finally{writing=false;if(typeof release==="function")release();updateDisabled()}
  if(needsRead&&!disposed&&!authLost){const prior=message.textContent;await load();if(!disposed&&!authLost&&snapshot)tell(prior)}
 }
 function checkbox(parent,action,text){const label=el("label",undefined,"cargo-orders-check"),input=el("input");input.type="checkbox";input.dataset.orderConfirm=action;label.append(input,el("span",text));parent.append(label);return input}
 function field(parent,label,name,type,value=""){
  const wrap=el("label",label,"cargo-orders-field"),input=el(type==="textarea"?"textarea":type==="select"?"select":"input");
  if(type!=="textarea"&&type!=="select")input.type=type;
  input.dataset.orderField=name;input.value=value;if(type==="datetime-local"){input.min="0001-01-01T00:00";input.max="9999-12-31T23:59";input.step="60"}
  if(type==="textarea")input.rows=4;wrap.append(input);parent.append(wrap);return input;
 }
 function agreementCard(a,active){
  const card=el("article",undefined,"cargo-orders-record");card.append(el("h5","条件版 "+a.version+(a.version===active?"（現在適用中）":"")));
  const list=el("dl");for(const [label,value] of [["金額",a.amount_yen.toLocaleString("ja-JP")+"円（税・追加費用等は条件欄）"],["集荷",japanTime(a.pickup_at)],["配送",a.delivery_at===null?"未設定（条件を個別確認）":japanTime(a.delivery_at)],["顧客との合意を確認した日時",japanTime(a.customer_confirmed_at)],["確認方法",METHODS[a.confirmation_method]],["合意した配送条件",a.conditions],["確認メモ",a.confirmation_note],["記録担当者",actor(a.recorded_by)],["記録日時",japanTime(a.recorded_at)]])list.append(el("dt",label),el("dd",value));card.append(list);return card;
 }
 function render(){
  if(disposed||!snapshot)return;content.replaceChildren();const order=snapshot.order,latest=snapshot.agreements[0]||null,terminal=order&&["completed","cancelled"].includes(order.status),pendingAgreement=order&&latest&&latest.version!==order.active_agreement_version;
  const overview=el("div",undefined,"cargo-orders-summary");overview.append(el("h4",order?"配送状態："+STATES[order.status]:"正式受注は未記録"));
  if(order)overview.append(el("p","受注版 "+order.version+" ／ 適用条件版 "+order.active_agreement_version),el("p","正式受注を記録："+japanTime(order.accepted_at)+" ／ "+actor(order.accepted_by)),el("p","最終操作："+japanTime(order.updated_at)+" ／ "+actor(order.updated_by)),el("p","受注済みの記録は30日削除から保護されています。完了・中止後も保存期間は未決定のため、自動削除しません。"));
  else overview.append(el("p","顧客の利用希望や合意記録だけでは、正式受注になりません。管理者による別の操作が必要です。"));
  if(order?.completed_at)overview.append(el("p","配送完了の記録："+japanTime(order.completed_at)));
  if(order?.cancelled_at)overview.append(el("p","中止の記録："+japanTime(order.cancelled_at)));
  if(pendingAgreement)overview.append(el("p","変更合意は未適用です。適用するまで配送状態を先へ進められません。中止は記録できます。","cargo-orders-warning"));
  if(terminal)overview.append(el("p","完了・中止は確定済みです。この画面で元に戻したり条件を変更したりできません。"));content.append(overview);
  if(order&&snapshot.activeAgreement&&snapshot.activeAgreement.version!==latest?.version){const active=el("section");active.append(el("h4","現在この受注に適用している合意内容"),agreementCard(snapshot.activeAgreement,order.active_agreement_version));content.append(active)}
  if(latest){const current=el("section");current.append(el("h4","最新の合意内容"),agreementCard(latest,order?.active_agreement_version));content.append(current)}
  if(!terminal){
   const form=el("section",undefined,"cargo-orders-form");form.append(el("h4",latest?"変更した顧客合意を記録":"顧客との合意を確認・記録"),el("p","実際に確認済みの条件だけを記録してください。日本時間で入力します。顧客本人によるアプリ上の同意記録とは異なります。"));
   const amount=field(form,"合意した料金（円・整数）","amount_yen","number",String(latest?.amount_yen??item.quote?.amount_yen??""));amount.min="1";amount.max="10000000";amount.step="1";amount.inputMode="numeric";
   const pickup=field(form,"合意した集荷日時（日本時間）","pickup_at","datetime-local");
   const delivery=field(form,"合意した配送日時（日本時間・任意）","delivery_at","datetime-local");
   const confirmed=field(form,"顧客との合意を実際に確認した日時（日本時間）","customer_confirmed_at","datetime-local");
   const method=field(form,"合意の確認方法","confirmation_method","select");const choose=el("option","選択してください");choose.value="";method.append(choose);for(const [v,t] of Object.entries(METHODS)){const opt=el("option",t);opt.value=v;method.append(opt)}method.value="";
   const conditions=field(form,"合意した配送条件・税・追加費用等（30〜1200文字）","conditions","textarea");conditions.maxLength=1200;
   const memo=field(form,"どのように合意を確認したか（5〜600文字）","confirmation_note","textarea");memo.maxLength=600;
   const check=checkbox(form,"record_agreement","記入した条件について顧客との合意を実際に確認した。本人がアプリ上で同意した記録ではないことを理解した。");
   form.append(button("顧客との合意を記録（受注は別操作）","record_agreement",()=>{
    const yen=/^\d+$/.test(amount.value)?Number(amount.value):NaN,pick=fromJapan(pickup.value),deliver=delivery.value?fromJapan(delivery.value):null,when=fromJapan(confirmed.value);
    if(!check.checked||!Number.isSafeInteger(yen)||yen<1||yen>10000000||!pick||delivery.value&&!deliver||deliver&&Date.parse(deliver)<Date.parse(pick)||!when||Date.parse(when)>Date.now()||!known(METHODS,method.value)||!validText(conditions.value,30,1200)||!validText(memo.value,5,600)){tell("合意確認のチェック、料金、日時（日本時間）、確認方法、条件30文字以上、確認メモ5文字以上を確認してください。",true);return}
    write("record_agreement",{expected_agreement_version:latest?.version??0,amount_yen:yen,pickup_at:pick,delivery_at:deliver,customer_confirmed_at:when,confirmation_method:method.value,conditions:conditions.value.trim(),confirmation_note:memo.value.trim()},"顧客と実際に確認した合意内容を記録します。\n料金："+yen.toLocaleString("ja-JP")+"円\n集荷："+japanTime(pick)+"\n条件："+conditions.value.trim()+"\n\nこの操作だけでは正式受注になりません。記録しますか？");
   }));content.append(form);
   if(!order&&latest){const accept=el("section",undefined,"cargo-orders-form");accept.append(el("h4","管理者の正式受注判断"),el("p","上の最新条件版 "+latest.version+" を確認してください。本人配送の対応可否・日時・荷物条件を管理者が判断してから記録します。顧客への自動通知・決済・配車はありません。"));const checkAccept=checkbox(accept,"accept_order","最新の合意条件と自分の対応可否を確認し、管理者として正式受注を記録する。");accept.append(button("管理者として正式受注を記録","accept_order",()=>{if(!checkAccept.checked){tell("正式受注の確認欄にチェックしてください。",true);return}write("accept_order",{agreement_version:latest.version},"最新の条件版 "+latest.version+"、料金 "+latest.amount_yen.toLocaleString("ja-JP")+"円で、管理者の正式受注判断を記録しますか？\n顧客合意の記録とは別の操作です。配送状態は「受注済み」になります。") }));content.append(accept)}
   if(pendingAgreement){const apply=el("section",undefined,"cargo-orders-form");apply.append(el("h4","変更合意を受注へ適用"),el("p","現在適用中：条件版 "+order.active_agreement_version+" ／ 最新の合意記録：条件版 "+latest.version));const checkApply=checkbox(apply,"apply_agreement","顧客と確認した最新条件を、この受注に適用することを確認した。");apply.append(button("最新の変更合意を適用","apply_agreement",()=>{if(!checkApply.checked){tell("変更条件の適用を確認してください。",true);return}write("apply_agreement",{agreement_version:latest.version},"条件版 "+latest.version+" をこの受注へ適用しますか？前の条件は履歴に残ります。") }));content.append(apply)}
   if(order){const state=el("section",undefined,"cargo-orders-form");state.append(el("h4","配送状態を記録"),el("p","実際の進行を確認して操作してください。配送完了・中止は元に戻せません。"));const note=field(state,"状態変更メモ（600文字以内・中止は理由5文字以上）","state_note","textarea");note.maxLength=600;const checkState=checkbox(state,"change_status","実際の状況と変更先を確認して、管理者として状態変更を記録する。");
    const next=({accepted:"preparing",preparing:"in_transit",in_transit:"completed"})[order.status];
    for(const destination of [next,"cancelled"].filter(Boolean)){const b=button(STATES[destination]+"を記録","change_status",()=>{
     if(!checkState.checked||!validText(note.value,destination==="cancelled"?5:0,600)){tell(destination==="cancelled"?"中止の理由を5文字以上で記入し、確認欄にチェックしてください。":"状態変更の確認欄とメモを確認してください。",true);return}
     write("change_status",{next_status:destination,note:note.value.trim()},"配送状態を「"+STATES[order.status]+"」から「"+STATES[destination]+"」へ変更しますか？"+(["completed","cancelled"].includes(destination)?"\nこの状態は元に戻せません。":"")+"\n自動通知・決済・配車は行いません。");
    },destination);if(pendingAgreement&&destination!=="cancelled")b.dataset.orderPermanentDisabled="true";state.append(b)}content.append(state);
   }
  }
  const history=el("section");history.append(el("h4","合意条件の履歴"));for(const a of snapshot.agreements)history.append(agreementCard(a,order?.active_agreement_version));if(!snapshot.agreements.length)history.append(el("p","合意の記録はありません。"));if(snapshot.nextAgreement!==null)history.append(button("以前の合意条件を50件まで表示","more_agreements",()=>more("agreements")));
  history.append(el("h4","操作・配送状態の履歴"));for(const e of snapshot.events){const row=el("article",undefined,"cargo-orders-record");row.append(el("h5","#"+e.sequence+" "+KINDS[e.kind]),el("p",japanTime(e.recorded_at)+" ／ 担当者："+actor(e.actor_id)),el("p","受注版 "+e.order_version+" ／ 条件版 "+e.agreement_version));if(e.from_status||e.to_status)row.append(el("p",(STATES[e.from_status]||"未受注")+" → "+(STATES[e.to_status]||"未受注")));if(e.payload?.note)row.append(el("p","メモ："+e.payload.note));history.append(row)}if(!snapshot.events.length)history.append(el("p","操作履歴はありません。"));if(snapshot.nextEvent!==null)history.append(button("以前の操作履歴を50件まで表示","more_events",()=>more("events")));content.append(history);updateDisabled();
 }
 function storageChanged(event){
  if(disposed||event.key!==key&&event.key!==null)return;const before=pending;checkPending();
  if(before&&!pending&&!storageFault){onOrderChange?.(null);tell("別のタブで操作結果が確認されました。最新の記録を確認しています。");void load()}
  else{notify();if(pending||storageFault)tell("別の画面に未確認の操作があります。新しい操作をせず履歴と照合してください。",true)}updateDisabled();
 }
 window.addEventListener("storage",storageChanged);checkPending();updateDisabled();
 return {element:root,load,dispose(){disposed=true;readToken++;window.removeEventListener("storage",storageChanged);snapshot=null;content.replaceChildren();message.textContent=""}};
}
window.CargoOrderManagement=Object.freeze({create});
})();
