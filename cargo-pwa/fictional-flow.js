/* Rainbow Driver cargo: fixed FICTIONAL operator-only test scenario.
 * No customer fields, storage, network calls or dynamic URLs may cross pages.
 * This is not an authorization token. OTP API rechecks operator JWT + intake OFF.
 */
(function(root,factory){
  var api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  if(root)root.CargoFictionalFlow=api;
})(typeof window!=='undefined'?window:null,function(){
  'use strict';
  var demo=Object.freeze({
    pickup:'テスト集荷地・さいたま市',
    delivery:'テスト配送先・東京都内',
    cargo:'テスト用・精密機器の箱',
    pieces:'2',weight:'8.5',length:'40',width:'30',height:'25',
    handling:'yes',readiness:'ready',
    note:'テスト専用の架空案件。積み降ろし補助を相談。',
    clientName:'テスト担当者',clientContact:'',
    today:true,reviewConfirm:true
  });
  var keys=Object.freeze(Object.keys(demo));
  function sample(){return Object.assign({},demo)}
  function matches(data){
    if(!data||typeof data!=='object'||Array.isArray(data))return false;
    return keys.every(function(key){return data[key]===demo[key]});
  }
  function otpSample(){
    // Only fields accepted by operator-only readiness.validate_sample.
    // The same fields are fixed on the server for the synthetic OTP binding.
    return Object.freeze({
      pickup:demo.pickup,delivery:demo.delivery,cargo:demo.cargo,
      pieces:Number(demo.pieces),weight:Number(demo.weight)
    });
  }
  return Object.freeze({sample:sample,matches:matches,otpSample:otpSample});
});
