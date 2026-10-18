'use strict';
// Offline tests for the new consultation labels and local operator checklist.
// Every service and browser dependency is synthetic; no customer data or traffic.
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {webcrypto}=require('node:crypto');
const rules=require('../cargo-pwa/request-review-rules.js');
const root=path.join(__dirname,'..');
const future=()=>new Date(Date.now()+3*86400000+9*3600000).toISOString().slice(0,16);
const sample=()=>({pickup:'架空の集荷地',delivery:'架空の配送先',cargo:'検証用の箱',
 pieces:'2',weight:'8.5',length:'40',width:'30',height:'25',handling:'no',readiness:'ready',
 note:'',clientName:'',clientContact:'',today:true,reviewConfirm:true});

function assertUnconfirmed(description,kind){
 assert.equal(description.kind,kind);
 assert.equal(description.bookingConfirmed,false);
 assert.equal(typeof description.label,'string');
 assert.equal(typeof description.requestedPickup,'string');
}
test('delivery description distinguishes spot and scheduled wishes without confirming a booking',()=>{
 const spot=rules.describeDelivery({today:true});
 assertUnconfirmed(spot,'spot');assert.match(spot.label,/スポット配送の相談/);
 // The existing intake validator normalizes omitted/null timestamps to an empty string.
 assertUnconfirmed(rules.describeDelivery({today:true,preferredPickupAt:null}),'spot');
 const date=future(),scheduled=rules.describeDelivery({today:false,preferredPickupAt:date});
 assertUnconfirmed(scheduled,'scheduled');assert.match(scheduled.label,/事前予約配送の相談/);
 assert(scheduled.requestedPickup.includes(date.replace('T',' ')));
 // Stored consultations remain readable after the requested date has passed.
 assertUnconfirmed(rules.describeDelivery({today:false,preferredPickupAt:'2020-01-01T10:00'}),'scheduled');
});
test('missing, contradictory, malformed and impossible delivery details require confirmation',()=>{
 for(const raw of [null,undefined,[],{},'spot',{today:'true'},{today:1},
  {today:true,preferredPickupAt:future()},{today:true,preferredPickupAt:0},
  {today:true,preferredPickupAt:false},{today:true,preferredPickupAt:[]},
  {today:false},{today:false,preferredPickupAt:''},{today:false,preferredPickupAt:42},
  {today:false,preferredPickupAt:'2099-02-30T10:00'},
  {today:false,preferredPickupAt:'2099-01-01T25:00'},
  {today:false,preferredPickupAt:'2099-01-01T10:00Z'},
  {today:false,preferredPickupAt:'2099-01-01T10:00+09:00'}]){
  const d=rules.describeDelivery(raw);assertUnconfirmed(d,'needs_confirmation');assert.match(d.label,/要確認/);
 }
});
test('review adds the consultation description and retains manual review for both choices',()=>{
 for(const request of [sample(),{...sample(),today:false,preferredPickupAt:future()}]){
  const result=rules.review(request);
  assertUnconfirmed(result.deliveryPreference,request.today?'spot':'scheduled');
  for(const flag of ['canSubmit','canBook','priceFinalized','publicIntakeEnabled'])assert.equal(result[flag],false);
  assert.equal(result.requiresOperatorReview,true);
 }
 assert.throws(()=>rules.review({...sample(),today:false,preferredPickupAt:'2020-01-01T10:00'}));
 assert.throws(()=>rules.review({...sample(),preferredPickupAt:future()}));
});

class Element{
 constructor(tag='div'){
  this.tagName=tag.toUpperCase();this.children=[];this.style={};this.dataset={};
  this.listeners={};this.value='';this.textContent='';this.checked=false;this.disabled=false;this.hidden=false;
 }
 append(...nodes){this.children.push(...nodes)}
 appendChild(node){this.append(node);return node}
 replaceChildren(...nodes){this.children=nodes}
 addEventListener(kind,callback){(this.listeners[kind]??=[]).push(callback)}
 dispatch(kind){for(const callback of this.listeners[kind]||[])callback({target:this,type:kind})}
 setAttribute(name,value){this[name]=String(value)}
 getAttribute(name){return this[name]??null}
 reportValidity(){return true}
 scrollIntoView(){}
}
const descendants=node=>[node,...(node.children||[]).filter(x=>x&&typeof x==='object').flatMap(descendants)];
const inlineScript=html=>html.match(/<script>\s*([\s\S]*?)<\/script>/)[1];
const settle=()=>new Promise(resolve=>setImmediate(resolve));
function nodesFor(){
 const nodes=new Map();
 const element=id=>{if(!nodes.has(id))nodes.set(id,new Element());return nodes.get(id)};
 return {nodes,element,document:{getElementById:element,createElement:tag=>new Element(tag),head:new Element('head')}};
}

async function intakeHarness(file,enabled=true,options={}){
 const helper=Object.hasOwn(options,'helper')?options.helper:rules;
 const html=fs.readFileSync(path.join(root,file),'utf8');
 const dom=nodesFor(),calls=[],unexpected=[];
 dom.element('today').checked=true;
 dom.element('reviewPane').hidden=true;
 dom.element('reviewButton').disabled=true;dom.element('sendEmail').disabled=true;
 let captchaOptions;
 const context={document:dom.document,crypto:webcrypto,Date,confirm:()=>true,
  fetch:()=>{unexpected.push('fetch');throw Error('External traffic forbidden')},
  window:{CargoRequestReview:helper,turnstile:{render:(_target,options)=>{captchaOptions=options;return 1},reset(){}},
   supabase:{createClient:()=>({functions:{invoke:async(_name,{body})=>{
    calls.push(body);
    assert.equal(body.action,'status','Consultation editing must not invoke mail or registration');
    return {data:{public_intake_enabled:enabled,ready:enabled,accepts_orders:false,payment_enabled:false,
     captcha_site_key:enabled?'synthetic-site-key':null}};
   }}})}}};
 dom.document.head.appendChild=node=>{if(node.onload)node.onload();return node};
 vm.createContext(context);vm.runInContext(inlineScript(html),context);await settle();
 Object.entries(sample()).forEach(([key,value])=>{
  if(typeof value==='boolean')dom.element(key).checked=value;else dom.element(key).value=value;
 });
 dom.element('email').value='synthetic@example.invalid';
 return {...dom,html,calls,unexpected,captcha:()=>captchaOptions,
  submit:()=>dom.element('requestForm').onsubmit({preventDefault(){}})};
}
for(const file of ['cargo-customer-intake.html','staging/cargo-customer-intake.html']){
 test(file+': consultation summary changes by choice and edits revoke reviewed content',async()=>{
  const h=await intakeHarness(file);
  assert.match(h.html,/スポット配送の相談/);assert.match(h.html,/事前予約配送の相談/);
  h.submit();assert.equal(h.element('reviewPane').hidden,false);
  assert.match(h.element('summary').textContent,/スポット配送の相談/);
  h.captcha().callback('synthetic-turnstile');assert.equal(h.element('sendEmail').disabled,false);
  h.element('today').checked=false;h.element('today').dispatch('change');
  assert.equal(h.element('reviewPane').hidden,true);assert.equal(h.element('sendEmail').disabled,true);
  assert.equal(h.element('preferredPickupPane').hidden,false);assert.equal(h.element('preferredPickupAt').required,true);
  await h.element('sendEmail').onclick();assert.equal(h.calls.length,1);
  const date=future();h.element('preferredPickupAt').value=date;h.element('preferredPickupAt').dispatch('input');
  h.submit();assert.equal(h.element('reviewPane').hidden,false);
  assert.match(h.element('summary').textContent,/事前予約配送の相談/);
  assert(h.element('summary').textContent.includes(date.replace('T',' ')));
  h.captcha().callback('synthetic-turnstile');
  h.element('preferredPickupAt').value=future().replace(/:\d\d$/,':01');h.element('preferredPickupAt').dispatch('input');
  assert.equal(h.element('reviewPane').hidden,true);assert.equal(h.element('sendEmail').disabled,true);
  await h.element('sendEmail').onclick();assert.equal(h.calls.length,1);
  h.element('today').checked=true;h.element('today').dispatch('change');h.submit();
  assert.equal(h.element('preferredPickupPane').hidden,true);assert.equal(h.element('preferredPickupAt').required,false);
  assert.match(h.element('summary').textContent,/スポット配送の相談/);
  assert.equal(h.calls.length,1);assert.equal(h.unexpected.length,0);
 });
 test(file+': disabled intake remains disabled after consultation fields change',async()=>{
  const h=await intakeHarness(file,false);
  assert.equal(h.element('reviewButton').disabled,true);
  h.element('today').checked=false;h.element('today').dispatch('change');
  h.element('preferredPickupAt').value=future();h.submit();await h.element('sendEmail').onclick();
  assert.equal(h.element('reviewPane').hidden,true);assert.equal(h.element('sendEmail').disabled,true);
  assert.equal(h.calls.length,1);assert.equal(h.unexpected.length,0);
 });
 test(file+': legacy helper shows a confirmation fallback instead of inferring spot delivery',async()=>{
  const helper={review:raw=>({...rules.review(raw),deliveryPreference:undefined})};
  const h=await intakeHarness(file,true,{helper});h.submit();
  assert.equal(h.element('reviewPane').hidden,false);
  assert.match(h.element('summary').textContent,/相談区分： 要確認/);
  assert.match(h.element('summary').textContent,/相談区分・希望日時を担当者が確認してください。/);
  assert.doesNotMatch(h.element('summary').textContent,/スポット配送の相談|事前予約配送の相談/);
  assert.equal(h.calls.length,1);assert.equal(h.unexpected.length,0);
 });
}

const quoteFixture=()=>({amount_yen:12500,terms:'架空案件の検証条件です。正式料金や配送契約を定めるための情報ではありません。',
 valid_until:new Date(Date.now()+2*86400000).toISOString(),delivery_status:'ready_to_send'});
async function operatorHarness(file,options={}){
 const {quote=quoteFixture(),details=sample()}=options;
 const helper=Object.hasOwn(options,'helper')?options.helper:rules;
 const html=fs.readFileSync(path.join(root,file),'utf8'),dom=nodesFor(),calls=[],confirmations=[],unexpected=[];
 let item={id:'22222222-2222-4222-8222-222222222222',status:'operator_reviewing',
  created_at:'2026-10-16T00:00:00Z',details,quote,retention_hold:true};
 const db={auth:{getUser:async()=>({data:{user:{id:'11111111-1111-4111-8111-111111111111'}}})},
  from:()=>{throw Error('Browser must use the protected operator API')},
  functions:{invoke:async(_name,{body})=>{
   calls.push(body);
   if(body.action==='list')return {data:{ok:true,items:[item]}};
   if(body.action==='quote_prepare'){
    item={...item,quote:{...body,delivery_status:'ready_to_send'}};
    return {data:{ok:true,reason:'QUOTE_READY_TO_SEND'}};
   }
   if(body.action==='quote_send'){
    item={...item,status:'quoted',quote:{...item.quote,delivery_status:'sent'}};
    return {data:{ok:true,reason:'QUOTE_PROVIDER_ACCEPTED'}};
   }
   throw Error('Unexpected simulated action');
  }}};
 const context={document:dom.document,window:{CargoRequestReview:helper,supabase:{createClient:()=>db}},
  Date,confirm:message=>{confirmations.push(message);return true},
  fetch:()=>{unexpected.push('fetch');throw Error('External traffic forbidden')}};
 vm.createContext(context);vm.runInContext(inlineScript(html),context);await settle();
 const all=()=>descendants(dom.element('requests'));
 const button=fragment=>all().find(e=>e.tagName==='BUTTON'&&e.textContent.includes(fragment));
 const checks=()=>all().filter(e=>e.tagName==='INPUT'&&e.type==='checkbox'&&e.dataset.consultationCheck);
 const checkAll=()=>{assert.equal(checks().length,3);for(const check of checks()){check.checked=true;check.dispatch('change')}};
 return {...dom,html,calls,confirmations,unexpected,all,button,checks,checkAll};
}
for(const file of ['cargo-customer-review.html','staging/cargo-customer-review.html']){
 test(file+': absent or legacy helper keeps the list readable with a confirmation fallback',async()=>{
  for(const helper of [null,undefined,{review:rules.review}]){
   const h=await operatorHarness(file,{helper});
   const text=h.all().map(e=>e.textContent).join('\n');
   assert.match(text,/相談区分： 要確認/);
   assert.match(text,/相談区分・希望日時を担当者が確認してください。/);
   assert.doesNotMatch(text,/スポット配送の相談|事前予約配送の相談/);
   assert(h.button('下書き保存'),'Missing helper must not discard the operator list');
   assert.equal(h.calls.length,1);assert.equal(h.unexpected.length,0);
  }
 });
 test(file+': operator distinguishes both wishes and does not classify missing data as spot',async()=>{
  for(const [details,label] of [[sample(),/スポット配送の相談/],
   [{...sample(),today:false,preferredPickupAt:future()},/事前予約配送の相談/],
   [{},/要確認/],[{today:true,preferredPickupAt:future()},/要確認/]]){
   const h=await operatorHarness(file,{details});
   const text=h.all().map(e=>e.textContent).join('\n');assert.match(text,label);
   if(label.source==='要確認')assert.doesNotMatch(text,/即時・当日（担当者確認後に決定）/);
   assert.equal(h.calls.length,1);assert.equal(h.unexpected.length,0);
  }
 });
 test(file+': checklist blocks save and simulated send even if disabled handlers are called directly',async()=>{
  const h=await operatorHarness(file),save=h.button('下書き保存'),send=h.button('1通送信');
  assert(save&&send);assert.equal(h.checks().length,3);
  assert.deepEqual(new Set(h.checks().map(e=>e.dataset.consultationCheck)),new Set(['schedule','route','vehicle']));
  assert.equal(save.disabled,true);assert.equal(send.disabled,true);
  await save.onclick();await send.onclick();assert.equal(h.calls.length,1);assert.equal(h.confirmations.length,0);
  for(const check of h.checks().slice(0,2)){check.checked=true;check.dispatch('change')}
  await save.onclick();await send.onclick();assert.equal(h.calls.length,1);
  h.checkAll();assert.equal(save.disabled,false);assert.equal(send.disabled,false);
  await send.onclick();assert.equal(h.calls.filter(x=>x.action==='quote_send').length,1);
  assert.equal(h.unexpected.length,0);
 });
 test(file+': any quote edit invalidates all checks; fresh save redraws an unchecked checklist',async()=>{
  for(const type of ['number','textarea','datetime-local']){
   const h=await operatorHarness(file);h.checkAll();
   const field=h.all().find(e=>type==='textarea'?e.tagName==='TEXTAREA':e.tagName==='INPUT'&&e.type===type);
   assert(field,'Missing editable quote field '+type);
   if(type==='number')field.value='13000';
   else if(type==='textarea')field.value+=' 変更内容も担当者が確認します。';
   else field.value=new Date(Date.now()+3*86400000).toISOString().slice(0,16);
   field.dispatch('input');
   assert(h.checks().every(e=>!e.checked));
   assert.equal(h.button('下書き保存').disabled,true);assert.equal(h.button('1通送信').disabled,true);
   await h.button('下書き保存').onclick();await h.button('1通送信').onclick();assert.equal(h.calls.length,1);
   h.checkAll();assert.equal(h.button('下書き保存').disabled,false);
   assert.equal(h.button('1通送信').disabled,true,'An edited quote must be saved before it may be sent');
   await h.button('下書き保存').onclick();
   assert.equal(h.calls.filter(x=>x.action==='quote_prepare').length,1);
   assert.equal(h.calls.filter(x=>x.action==='quote_send').length,0);
   assert.equal(h.checks().length,3);assert(h.checks().every(e=>!e.checked));
   assert.equal(h.button('下書き保存').disabled,true);assert.equal(h.button('1通送信').disabled,true);
   assert.equal(h.unexpected.length,0);
  }
 });
 test(file+': a new quote also requires all three checks before a simulated draft save',async()=>{
  const h=await operatorHarness(file,{quote:null});
  assert.equal(h.button('1通送信'),undefined);
  const amount=h.all().find(e=>e.tagName==='INPUT'&&e.type==='number');amount.value='12500';amount.dispatch('input');
  const terms=h.all().find(e=>e.tagName==='TEXTAREA');terms.value=quoteFixture().terms;terms.dispatch('input');
  await h.button('下書き保存').onclick();assert.equal(h.calls.length,1);
  h.checkAll();await h.button('下書き保存').onclick();
  assert.equal(h.calls.filter(x=>x.action==='quote_prepare').length,1);
  assert.equal(h.calls.filter(x=>x.action==='quote_send').length,0);
  assert(h.checks().every(e=>!e.checked));assert.equal(h.unexpected.length,0);
 });
}
