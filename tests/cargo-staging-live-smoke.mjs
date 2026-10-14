import assert from 'node:assert/strict';

const host='https://hvdoqcrnztqmbzgwrovd.supabase.co';
const key=process.env.CARGO_STAGING_PUBLISHABLE_KEY;
assert.ok(key?.startsWith('sb_publishable_'),'Missing staging public key');
const origin='https://app.rainbow-driver.com';
async function call(slug,body,requestOrigin=origin){
 const response=await fetch(host+'/functions/v1/'+slug,{
  method:'POST',
  headers:{'content-type':'application/json',origin:requestOrigin,apikey:key},
  body:JSON.stringify(body),
  signal:AbortSignal.timeout(12000)
 });
 let json;
 try{json=await response.json()}catch{throw Error(slug+' non-JSON response HTTP '+response.status)}
 return {status:response.status,json};
}
const status=await call('cargo-customer-intake',{action:'status'});
assert.equal(status.status,200,'Customer status endpoint must respond');
assert.equal(status.json.public_intake_enabled,false,'Stop: public intake is ON');
assert.equal(status.json.ready,false);
assert.equal(status.json.accepts_orders,false);
assert.equal(status.json.payment_enabled,false);
console.log('PASS: deployed customer API reports intake OFF and no payment or order acceptance');

const denied=await call('cargo-customer-intake',{action:'status'},'https://untrusted.example');
assert.equal(denied.status,403);
assert.equal(denied.json.error,'ORIGIN_DENIED');
console.log('PASS: deployed customer API rejects untrusted origin');

// No valid OTP, email, customer request, quote, or payment is submitted.
const invalid=await call('cargo-customer-intake',{action:'invalid_action'});
assert.equal(invalid.status,400);
assert.equal(invalid.json.error,'INVALID_INPUT');
console.log('PASS: invalid public action rejected');

const op=await call('cargo-customer-review-operator',{action:'list'});
assert.ok([401,403].includes(op.status),'Operator endpoint must require a JWT');
assert.ok(['LOGIN_REQUIRED','UNAUTHORIZED'].includes(op.json.error));
console.log('PASS: operator endpoint denies anonymous access');
