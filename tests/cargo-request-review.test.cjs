'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const rules=require('../cargo-pwa/request-review-rules.js');
const html=fs.readFileSync(path.join(__dirname,'../cargo-request-preview.html'),'utf8');
const fictional=require('../cargo-pwa/fictional-flow.js');
const vm=require('node:vm');
function sample(){return {pickup:'テスト集荷地・さいたま市',delivery:'テスト配送先・東京都内',cargo:'テスト用・箱',
 pieces:'2',weight:'8.5',length:'40',width:'30',height:'25',readiness:'ready',handling:'no',
 note:'',clientName:'',clientContact:'',today:true,reviewConfirm:true};}
test('preview uses the shared draft review rules',()=>{
 assert.match(html,/cargo-pwa\/request-review-rules\.js/);
 assert.match(html,/CargoRequestReview\.review/);
 assert.match(html,/一般受付OFF/);
});
test('valid draft always requires human review and cannot book or quote',()=>{
 const result=rules.review(sample());
 assert.equal(result.status,'manual_review_only');
 for(const key of ['canSubmit','canBook','priceFinalized','publicIntakeEnabled'])assert.equal(result[key],false);
 assert.equal(result.requiresOperatorReview,true);
 assert.equal(result.checked.weightKg,8.5);
 assert.ok(result.reviewReasons.length>0);
});
test('missing confirmations and invalid readiness reject',()=>{
 for(const patch of [{today:false},{reviewConfirm:false},{readiness:'scheduled'},{handling:'automatic'}]){
  assert.throws(()=>rules.review({...sample(),...patch}));
 }
});
test('numeric boundaries are enforced for every measurement',()=>{
 for(const [field,bad] of [['pieces','0'],['pieces','100'],['pieces','1.5'],['pieces','NaN'],
  ['weight','0'],['weight','351'],['weight','Infinity'],['length','0'],['length','501'],
  ['width','0'],['width','501'],['height','0'],['height','501']]){
  assert.throws(()=>rules.review({...sample(),[field]:bad}),field+'='+bad);
 }
});
test('missing values, non-finite values and boolean numbers fail',()=>{
 for(const v of ['',null,undefined,'Infinity','-1',false,true,{}]){
  assert.throws(()=>rules.review({...sample(),weight:v}),String(v));
 }
});
test('text field lengths and required values enforced',()=>{
 for(const [field,bad] of [['pickup','a'],['delivery',''],['cargo','x'],
  ['pickup','x'.repeat(251)],['delivery','x'.repeat(251)],
  ['cargo','x'.repeat(501)],['note','x'.repeat(501)],
  ['clientName','x'.repeat(81)],['clientContact','x'.repeat(121)]]){
  assert.throws(()=>rules.review({...sample(),[field]:bad}),field);
 }
});
test('loading, handling and unknown statuses are flagged for operator review',()=>{
 for(const patch of [{readiness:'preparing'},{readiness:'unknown'},{handling:'yes'},{handling:'unknown'}]){
  const result=rules.review({...sample(),...patch});
  assert.equal(result.canSubmit,false);
  assert.ok(result.reviewReasons.length>1);
 }
});
test('module performs no network or storage and never creates dispatches',()=>{
 const source=fs.readFileSync(path.join(__dirname,'../cargo-pwa/request-review-rules.js'),'utf8');
 assert.doesNotMatch(source,/fetch\s*\(|XMLHttpRequest|\.insert\s*\(|localStorage|sessionStorage|functions\.invoke/);
 assert.equal(typeof rules.review,'function');
});

test('fictional handoff is exact and carries no private request fields',()=>{
 const base=fictional.sample();
 assert.equal(fictional.matches(base),true);
 assert.deepEqual(fictional.otpSample(),{
  pickup:base.pickup,delivery:base.delivery,cargo:base.cargo,pieces:2,weight:8.5
 });
 assert.equal(fictional.matches({...base,clientContact:'customer@example.com'}),false);
 assert.equal(fictional.matches({...base,pickup:'東京都中央区の実住所'}),false);
 assert.equal(fictional.matches({...base,note:'異なる備考'}),false);
 assert.equal(fictional.matches({...base,weight:'9'}),false);
 assert.equal(fictional.matches({...base,today:false}),false);
 assert.equal(fictional.matches({...base,reviewConfirm:false}),false);
 assert.equal(fictional.matches(null),false);
 assert.equal(fictional.matches({...base,clientName:'実名'}),false);
});
test('handoff links only to the fixed operator page, without user data in URLs',()=>{
 const link=html.match(/<a id="otpHandoff" href="([^"]+)" hidden>/);
 assert.ok(link,'operator-only hidden handoff link is missing');
 assert.equal(link[1],'./cargo-request-otp-integration-preview.html');
 assert.doesNotMatch(link[1],/[?#]/);
 assert.match(html,/!!operator&&!!verified/);
 assert.match(html,/CargoFictionalFlow\?\.matches\?/);
 assert.match(html,/updateOtpHandoff\(\)/);
 const otpHtml=fs.readFileSync(path.join(__dirname,'../cargo-request-otp-integration-preview.html'),'utf8');
 assert.match(otpHtml,/CargoFictionalFlow\.otpSample\(\)/);
 assert.match(otpHtml,/href="\.\/cargo-request-preview\.html"/);
});
function previewHarness(hasOperator=true){
 const nodes=new Map(),calls=[];
 const element=id=>{
  if(!nodes.has(id))nodes.set(id,{
   hidden:['otpHandoff','operatorTest','reviewPane'].includes(id),value:'',
   checked:false,disabled:false,textContent:'',
   listeners:{},addEventListener(kind,fn){this.listeners[kind]=fn},
   reportValidity(){return true},replaceChildren(){},append(){},
   scrollIntoView(){}
  });
  return nodes.get(id);
 };
 const db={
  auth:{getUser:async()=>({data:{user:hasOperator?{id:'operator'}:null},error:null})},
  from(table){
   calls.push('from:'+table);
   return {select(){return this},eq(){return this},
    maybeSingle:async()=>({data:{user_id:'operator'},error:null})};
  },
  functions:{invoke:async()=>{throw Error('No Edge call expected in preview navigation')}}
 };
 const scripts=[...html.matchAll(/<script(?:[^>]*)>([\s\S]*?)<\/script>/g)]
  .map(x=>x[1]).filter(Boolean);
 assert.equal(scripts.length,1);
 vm.runInNewContext(scripts[0],{
  document:{getElementById:element,createElement:()=>({textContent:'',append(){}})},
  window:{CargoRequestReview:rules,CargoFictionalFlow:fictional,
   supabase:{createClient:()=>db}},
  crypto:{randomUUID:()=> 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'},
  console:{warn(){}}
 },{timeout:1200});
 const tick=()=>new Promise(resolve=>setImmediate(resolve));
 return {element,calls,tick};
}
test('real preview UI shows handoff only after operator login and exact demo review',async()=>{
 const s=previewHarness();
 await s.tick();
 assert.equal(s.element('otpHandoff').hidden,true);
 s.element('fillDemo').onclick();
 assert.equal(s.element('otpHandoff').hidden,true);
 s.element('requestForm').onsubmit({preventDefault(){}});
 assert.equal(s.element('otpHandoff').hidden,false);
 assert.equal(s.element('otpHandoff').textContent,'');
 assert.deepEqual(s.calls,['from:cargo_operator_accounts']);
 s.element('clientContact').value='customer@example.com';
 s.element('clientContact').listeners.input();
 assert.equal(s.element('otpHandoff').hidden,true);
 s.element('requestForm').onsubmit({preventDefault(){}});
 assert.equal(s.element('otpHandoff').hidden,true);
 assert.equal(s.calls.filter(x=>x.startsWith('from:')).length,1);
});
test('unauthenticated users and edited drafts never see OTP handoff',async()=>{
 const guest=previewHarness(false);
 await guest.tick();
 guest.element('fillDemo').onclick();
 guest.element('requestForm').onsubmit({preventDefault(){}});
 assert.equal(guest.element('otpHandoff').hidden,true);
 const s=previewHarness();
 await s.tick();
 s.element('fillDemo').onclick();
 s.element('pickup').value='テスト集荷地・川口市';
 s.element('requestForm').onsubmit({preventDefault(){}});
 assert.equal(s.element('otpHandoff').hidden,true);
 s.element('fillDemo').onclick();
 s.element('requestForm').onsubmit({preventDefault(){}});
 assert.equal(s.element('otpHandoff').hidden,false);
 s.element('edit').onclick();
 assert.equal(s.element('otpHandoff').hidden,true);
});

test('future Japan-time collection is a request, not a booking',()=>{
 const preferredPickupAt=new Date(Date.now()+2*86400000+9*3600000).toISOString().slice(0,16);
 const result=rules.review({...sample(),today:false,preferredPickupAt});
 assert.equal(result.canBook,false);assert.equal(result.requiresOperatorReview,true);
 for(const value of ['', '2020-01-01T10:00','2099-02-30T10:00','2099-01-01T25:00','2099-01-01T10:00Z'])assert.throws(()=>rules.review({...sample(),today:false,preferredPickupAt:value}));
 assert.throws(()=>rules.review({...sample(),preferredPickupAt}));
});
