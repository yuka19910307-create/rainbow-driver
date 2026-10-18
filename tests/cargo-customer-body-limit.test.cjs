'use strict';
// Actual handlers, synthetic streams only: no database, provider, or live requests.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {stripTypeScriptTypes}=require('node:module');
const encoder=new TextEncoder();
const cases=[
 {file:'index.ts',limit:12000,invalidStatus:400,invalidError:'INVALID_INPUT',valid:{action:'status'}},
 {file:'operator.ts',limit:12000,invalidStatus:422,invalidError:'INVALID_INPUT',valid:{action:'list'}},
 {file:'quote-reply.ts',limit:350,invalidStatus:422,invalidError:'INVALID_LINK',valid:{action:'view',id:'11111111-1111-4111-8111-111111111111',token:'0'.repeat(64)}}
];
function setup(file){
 let handler;
 const ctx={Deno:{serve:f=>handler=f,env:{get:()=>''}},TextEncoder,TextDecoder,Uint8Array,Uint32Array,
  Response,atob,crypto:require('node:crypto').webcrypto,
  createClient:()=>{throw Error('Body validation must finish before database access')},
  fetch:()=>{throw Error('No external requests allowed')}};
 vm.createContext(ctx);
 vm.runInContext(stripTypeScriptTypes(fs.readFileSync(path.join(__dirname,'../integrations/cargo-customer-intake',file),'utf8').replace(/^import .*;\n/,'')),ctx);
 return {handler,async read(req,maxBytes){ctx.testRequest=req;ctx.testMaxBytes=maxBytes;return vm.runInContext('boundedBody(testRequest,testMaxBytes)',ctx)}};
}
function streamRequest(chunks,declared,readError){
 let reads=0,cancellations=0,releases=0;
 const reader={async read(){const index=reads++;if(readError)throw Error(readError);return index<chunks.length?{done:false,value:chunks[index]}:{done:true}},
  async cancel(){cancellations++},releaseLock(){releases++}};
 const headers=new Headers({origin:'https://app.rainbow-driver.com',authorization:'Bearer synthetic', 'content-type':'application/json'});
 if(declared!==undefined)headers.set('content-length',String(declared));
 return {method:'POST',headers,body:{getReader:()=>reader,async cancel(){cancellations++}},
  stats:()=>({reads,cancellations,releases})};
}
async function result(handler,req){const response=await handler(req);return {status:response.status,body:await response.json()}}
function split(bytes,width){const chunks=[];for(let i=0;i<bytes.length;i+=width)chunks.push(bytes.subarray(i,i+width));return chunks}
let identicalHelper;
for(const c of cases){
 const s=setup(c.file),maxBytes=c.limit*3;
 const source=fs.readFileSync(path.join(__dirname,'../integrations/cargo-customer-intake',c.file),'utf8');
 const helper=source.slice(source.indexOf('// Keep each deployment'),source.indexOf('\n}',source.indexOf('async function boundedBody'))+2);
 if(identicalHelper===undefined)identicalHelper=helper;
 assert.equal(helper,identicalHelper,'Single-file deployment helpers must stay identical');

 test(c.file+': normal JSON and original character limit remain accepted',async()=>{
  const raw=JSON.stringify(c.valid).padEnd(c.limit,' ');
  assert.equal(raw.length,c.limit);
  const accepted=await result(s.handler,streamRequest(split(encoder.encode(raw),29)));
  assert.deepEqual(accepted,{status:503,body:{error:'NOT_CONFIGURED'}},'Valid input reaches the configuration gate');
  const tooLong=await result(s.handler,streamRequest([encoder.encode(raw+' ')]));
  assert.deepEqual(tooLong,{status:413,body:{error:'BODY_TOO_LARGE'}},'Original UTF-16 character cap still applies');
 });
 test(c.file+': UTF-8 maximum width and split Japanese/emoji survive decoding',async()=>{
  const japanese='荷'.repeat(c.limit),bytes=encoder.encode(japanese),req=streamRequest(split(bytes,127));
  assert.equal(bytes.length,maxBytes);
  assert.equal(await s.read(req,maxBytes),japanese);
  assert.equal(req.stats().cancellations,0);
  assert.equal(req.stats().releases,1);
  const mixed='あ😀い';
  assert.equal(await s.read(streamRequest(split(encoder.encode(mixed),1)),maxBytes),mixed);
 });
 test(c.file+': unknown or false length cannot evade the streaming byte cap',async()=>{
  for(const declared of [undefined,'1','not-a-number']){
   const req=streamRequest([new Uint8Array(maxBytes),Uint8Array.of(32),encoder.encode('must never be read')],declared);
   assert.deepEqual(await result(s.handler,req),{status:413,body:{error:'BODY_TOO_LARGE'}});
   assert.deepEqual(req.stats(),{reads:2,cancellations:1,releases:1},'Cancel immediately at the byte boundary');
  }
 });
 test(c.file+': declared oversized bodies are cancelled before reading',async()=>{
  for(const declared of [String(maxBytes+1),'9'.repeat(100)]){
   const req=streamRequest([encoder.encode('must never be read')],declared);
   assert.deepEqual(await result(s.handler,req),{status:413,body:{error:'BODY_TOO_LARGE'}});
   assert.deepEqual(req.stats(),{reads:0,cancellations:1,releases:0});
  }
 });
 test(c.file+': a single oversized chunk is cancelled without decoding',async()=>{
  // Invalid UTF-8 beyond the cap must not hide the body-too-large result.
  const req=streamRequest([new Uint8Array(maxBytes+1).fill(255),encoder.encode('unread')]);
  assert.deepEqual(await result(s.handler,req),{status:413,body:{error:'BODY_TOO_LARGE'}});
  assert.deepEqual(req.stats(),{reads:1,cancellations:1,releases:1});
 });
 test(c.file+': malformed UTF-8 and stream failures return only generic input errors',async()=>{
  for(const invalid of [Uint8Array.of(0xc3,0x28),Uint8Array.of(0xc0,0xaf),Uint8Array.of(0xed,0xa0,0x80),Uint8Array.of(0xe2,0x82)]){
   const req=streamRequest([encoder.encode('{"private":"'),invalid,encoder.encode('"}')]);
   assert.deepEqual(await result(s.handler,req),{status:c.invalidStatus,body:{error:c.invalidError}});
   assert.equal(req.stats().cancellations,1);
   assert.equal(req.stats().releases,1);
  }
  const req=streamRequest([],undefined,'private upstream error must stay hidden');
  assert.deepEqual(await result(s.handler,req),{status:c.invalidStatus,body:{error:c.invalidError}});
  assert.deepEqual(req.stats(),{reads:1,cancellations:1,releases:1});
 });
 test(c.file+': actual Web Request stream accepts JSON split inside UTF-8 sequences',async()=>{
  let raw=JSON.stringify(c.valid);
  if(c.file==='index.ts')raw=JSON.stringify({...c.valid,note:'荷物😀'});
  if(c.file==='operator.ts')raw=JSON.stringify({action:'quote_prepare',id:'11111111-1111-4111-8111-111111111111',amount_yen:1000,terms:'架空の見積もり条件です。'.repeat(10),valid_until:'2099-01-01T00:00:00.000Z'});
  const chunks=split(encoder.encode(raw),1);
  const req=new Request('https://synthetic.invalid',{method:'POST',headers:{origin:'https://app.rainbow-driver.com',authorization:'Bearer synthetic'},duplex:'half',
   body:new ReadableStream({pull(controller){const chunk=chunks.shift();if(chunk)controller.enqueue(chunk);else controller.close()}})});
  assert.deepEqual(await result(s.handler,req),{status:503,body:{error:'NOT_CONFIGURED'}});
 });
}
