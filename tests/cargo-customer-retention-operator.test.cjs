const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const {stripTypeScriptTypes}=require('node:module');
const crypto=require('node:crypto').webcrypto;
const path=require('node:path');
const base=process.argv[3]||path.join(__dirname,'..');
const source=fs.readFileSync(process.argv[2]||path.join(base,'integrations/cargo-customer-intake/operator.ts'),'utf8');
const owner='11111111-1111-4111-8111-111111111111';
const id='22222222-2222-4222-8222-222222222222';
let handler,loggedIn=true,operator=true,calls=[],result={ok:true,reason:'CLOSED_NO_ORDER',delete_after:'2026-11-14T02:00:00Z'};
let listedStatuses;
const env={SUPABASE_URL:'https://synthetic.invalid',SUPABASE_SERVICE_ROLE_KEY:'synthetic-role',CARGO_CONTACT_AES_256_GCM_KEY:Buffer.alloc(32,29).toString('base64')};
const db={auth:{getUser:async()=>({data:{user:loggedIn?{id:owner}:null}})},
 from(table){const c={select(){return c},eq(){return c},in(key,values){listedStatuses=values;return c},order(){return c},limit:async()=>({data:[]}),maybeSingle:async()=>({data:operator?{user_id:owner}:null})};return c},
 rpc:async(name,args)=>{calls.push({name,args});return{data:result}}};
const ctx={createClient:()=>db,Deno:{serve:f=>handler=f,env:{get:k=>env[k]}},Request,Response,Uint8Array,TextEncoder,TextDecoder,atob,crypto,fetch:()=>{throw Error('No external mail allowed')},setTimeout,clearTimeout};
vm.createContext(ctx);vm.runInContext(stripTypeScriptTypes(source.replace(/^import .*;\n/,'')),ctx);
async function call(body,auth='Bearer synthetic',origin='https://app.rainbow-driver.com'){
 const r=await handler(new Request('https://synthetic.invalid',{method:'POST',headers:{origin,authorization:auth},body:JSON.stringify(body)}));return{status:r.status,data:await r.json()};
}
async function ui(file){
 class El{constructor(tag){this.tagName=tag;this.children=[];this.style={};this.textContent='';this.disabled=false}append(...nodes){this.children.push(...nodes)}replaceChildren(...nodes){this.children=nodes} }
 const nodes=Object.fromEntries(['auth','refresh','retentionView','requests'].map(k=>[k,new El('div')]));
 let closed=false,hold=false,confirmed=false,bodies=[];
 const record=()=>({id,status:closed?'closed':'operator_reviewing',details:{},created_at:'2026-10-15T00:00:00Z',retention_hold:closed?hold:true,closed_no_order_at:closed?'2026-10-15T02:00:00Z':null,delete_after:'2026-11-14T02:00:00Z'});
 const uiDb={auth:{getUser:async()=>({data:{user:{id:owner}}})},from:()=>({select(){return this},eq(){return this},maybeSingle:async()=>({data:{user_id:owner}})}),functions:{invoke:async(name,{body})=>{
  bodies.push(body);if(body.action==='close_no_order'){closed=true;return{data:{ok:true,reason:'CLOSED_NO_ORDER',delete_after:'2026-11-14T02:00:00Z'}}}
  if(body.action==='retention_hold'){hold=body.hold;return{data:{ok:true,reason:'RETENTION_HOLD_UPDATED'}}}
  return{data:{ok:true,items:body.action===(closed?'list_retention':'list')?[record()]:[]}};
 }}};
 const context={document:{getElementById:k=>nodes[k],createElement:tag=>new El(tag)},window:{supabase:{createClient:()=>uiDb}},confirm:()=>confirmed};
 vm.createContext(context);
 const script=fs.readFileSync(file,'utf8').match(/<script>\s*([\s\S]*?)<\/script>/)[1];
 vm.runInContext(script,context);const settle=()=>new Promise(r=>setImmediate(r));await settle();
 function all(e){return[e,...e.children.flatMap(all)]}
 function find(text){return all(nodes.requests).find(e=>e.tagName==='button'&&e.textContent===text)}
 const close=find('契約なしで対応終了（30日後に削除）');assert(close);
 await close.onclick();assert.equal(bodies.filter(b=>b.action==='close_no_order').length,0);
 confirmed=true;await close.onclick();assert.equal(bodies.filter(b=>b.action==='close_no_order').length,1);
 assert.equal(bodies.find(b=>b.action==='close_no_order').confirmation,'CLOSE_WITHOUT_ORDER_OR_RETENTION_NEED');
 nodes.retentionView.onclick();await settle();
 assert(find('保存を保留する'));await find('保存を保留する').onclick();
 assert.equal(bodies.find(b=>b.action==='retention_hold').hold,true);
 assert(find('保存保留を解除する（30日後に削除）'));
 assert(all(nodes.requests).some(e=>e.textContent==='保存保留中（自動削除しません）'));
 await find('保存保留を解除する（30日後に削除）').onclick();
 assert.equal(bodies.filter(b=>b.action==='retention_hold').at(-1).hold,false);
 assert(!bodies.some(b=>b.action==='quote_send'));
}
(async()=>{
 const close={action:'close_no_order',id,confirmation:'CLOSE_WITHOUT_ORDER_OR_RETENTION_NEED'};
 assert.equal((await call(close,'')).status,401);assert.equal((await call(close,'Bearer synthetic','https://bad.invalid')).status,403);
 assert.equal((await call({...close,operator_id:owner})).status,422);assert.equal((await call({...close,confirmation:'wrong'})).status,422);
 loggedIn=false;assert.equal((await call(close)).status,401);loggedIn=true;operator=false;assert.equal((await call(close)).status,403);operator=true;assert.equal(calls.length,0);
 let r=await call(close);assert.equal(r.status,200);assert.equal(r.data.customer_notified,false);assert.equal(calls[0].name,'cargo_customer_close_no_order');assert.equal(calls[0].args.p_operator_id,owner);
 result={ok:false,reason:'FOLLOWUP_NOT_CLOSED_NO_ORDER'};r=await call(close);assert.equal(r.status,422);assert.equal(r.data.reason,result.reason);
 result={ok:true,reason:'RETENTION_HOLD_UPDATED'};
 r=await call({action:'retention_hold',id,hold:true,confirmation:'KEEP_REQUIRED_RECORD'});assert.equal(r.status,200);assert.equal(calls.at(-1).args.p_hold,true);
 assert.equal((await call({action:'retention_hold',id,hold:false,confirmation:'KEEP_REQUIRED_RECORD'})).status,422);
 r=await call({action:'retention_hold',id,hold:false,confirmation:'RELEASE_WITHOUT_RETENTION_NEED'});assert.equal(r.status,200);assert.equal(calls.at(-1).args.p_hold,false);
 await call({action:'list_retention'});assert.deepEqual(Array.from(listedStatuses),['closed','declined']);
 await call({action:'list'});assert.deepEqual(Array.from(listedStatuses),['pending_operator_review','operator_reviewing','quoted']);
 assert.equal((await call({action:'decision',id,expected_status:'operator_reviewing',next_status:'closed'})).status,422);
 await ui(path.join(base,'cargo-customer-review.html'));await ui(path.join(base,'staging/cargo-customer-review.html'));
 console.log('PASS: operator identity/input guards, closure/hold RPC mapping, separate lists, blocked legacy closure; both UI confirmation and hold/release interactions. Synthetic services, no external requests.');
})().catch(e=>{console.error(e);process.exitCode=1});
