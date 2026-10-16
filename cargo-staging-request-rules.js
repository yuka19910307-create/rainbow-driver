/* Rainbow Driver Cargo — customer-facing draft review rules.
 * Browser/Node pure module: no network, no storage, no payment, no booking.
 * All valid inputs still require an operator decision; public intake is OFF.
 */
(function(root,factory){
  var api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  if(root)root.CargoRequestReview=api;
})(typeof window!=='undefined'?window:null,function(){
  'use strict';
  var MAX={pickup:250,delivery:250,cargo:500,note:500,clientName:80,clientContact:120};
  function string(v,max,label,min){
    if(typeof v!=='string')throw Error(label+'を入力してください。');
    var s=v.trim();
    if(s.length<(min||0)||s.length>max)throw Error(label+'の文字数を確認してください。');
    return s;
  }
  function number(v,label,min,max,integer){
    if(v===null||v===undefined||typeof v==='boolean'||typeof v==='object'||String(v).trim()==='')
      throw Error(label+'を入力してください。');
    var n=Number(v);
    if(!Number.isFinite(n)||n<min||n>max||(integer&&!Number.isInteger(n)))
      throw Error(label+'の数値が範囲外です。');
    return n;
  }
  function review(raw){
    if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('申込内容がありません。');
    var pickup=string(raw.pickup,MAX.pickup,'集荷地',3);
    var delivery=string(raw.delivery,MAX.delivery,'配送先',3);
    var cargo=string(raw.cargo,MAX.cargo,'荷物内容',2);
    string(raw.note||'',MAX.note,'補足',0);
    string(raw.clientName||'',MAX.clientName,'ご担当者名',0);
    string(raw.clientContact||'',MAX.clientContact,'連絡先',0);
    var pieces=number(raw.pieces,'個数',1,99,true);
    var weight=number(raw.weight,'総重量',0.01,350,false);
    var length=number(raw.length,'長さ',0.1,500,false);
    var width=number(raw.width,'幅',0.1,500,false);
    var height=number(raw.height,'高さ',0.1,500,false);
    if(raw.today!==true)throw Error('即時・当日集荷の確認が必要です。');
    if(raw.reviewConfirm!==true)throw Error('未送信であることの確認が必要です。');
    if(!['ready','preparing','unknown'].includes(raw.readiness))
      throw Error('荷物の準備状況を選択してください。');
    if(!['no','yes','unknown'].includes(raw.handling))
      throw Error('積み降ろし補助を選択してください。');
    var reasons=[];
    if(raw.readiness==='preparing')reasons.push('荷物が準備中のため集荷可能時刻の確認が必要です。');
    if(raw.readiness==='unknown')reasons.push('集荷準備状況の確認が必要です。');
    if(raw.handling==='yes')reasons.push('積み降ろし補助の可否・条件確認が必要です。');
    if(raw.handling==='unknown')reasons.push('積み降ろし条件の確認が必要です。');
    // Physical constraints are not capacity approval, even within input bounds.
    reasons.push('車両の積載可否・経路・対応可否・料金は担当者による確認が必要です。');
    return Object.freeze({
      status:'manual_review_only',
      canSubmit:false,
      canBook:false,
      priceFinalized:false,
      publicIntakeEnabled:false,
      requiresOperatorReview:true,
      reviewReasons:Object.freeze(reasons),
      checked:{pickup:pickup,delivery:delivery,cargo:cargo,
        pieces:pieces,weightKg:weight,lengthCm:length,widthCm:width,heightCm:height}
    });
  }
  return Object.freeze({review:review});
});

