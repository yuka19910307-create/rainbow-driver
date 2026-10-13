'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const rules=require('../cargo-pwa/request-review-rules.js');
const html=fs.readFileSync(path.join(__dirname,'../cargo-request-preview.html'),'utf8');
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
