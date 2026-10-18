const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {stripTypeScriptTypes}=require('node:module');
const root='integrations/cargo-customer-intake/';
const files=['index.ts','operator.ts','quote-reply.ts'].map(n=>fs.readFileSync(root+n,'utf8'));
const snippets=files.map(s=>s.slice(s.indexOf('// BEGIN STAGING OWNER TEST GUARD'),s.indexOf('// END STAGING OWNER TEST GUARD')+'// END STAGING OWNER TEST GUARD'.length));
const stage='https://hvdoqcrnztqmbzgwrovd.supabase.co',owner='5ccbfcd5-bd0f-4a9a-b570-223b3deb2567';
function context(){const ctx={Request};vm.createContext(ctx);vm.runInContext(stripTypeScriptTypes(snippets[0]),ctx);return ctx}
test('same guard in all handlers; production bypass does not read auth or ledger',async()=>{
 assert(snippets[0].length>100);for(const s of snippets)assert.equal(s,snippets[0]);
 const ctx=context();ctx.db={};ctx.req=new Request('https://synthetic.invalid');
 const r=await vm.runInContext('stagingOwnerTest(db,"https://kvoaorzdewwirqryeizq.supabase.co",req,"start",{})',ctx);
 assert.equal(r.allowed,true);assert.equal(r.staging,false);
});
test('confirmed owner only; recipient and fixture substitution rejected before slot claim',async()=>{
 const ctx=context();let calls=0,user={id:owner,email:'synthetic@example.invalid',email_confirmed_at:'2026-01-01'};
 ctx.db={auth:{getUser:async()=>({data:{user}})},rpc:async()=>{calls++;return{data:{ok:true,draft_id:'11111111-1111-4111-8111-111111111111'}}}};
 ctx.req=new Request('https://synthetic.invalid');ctx.stage=stage;
 assert.equal((await vm.runInContext('stagingOwnerTest(db,stage,req,"status",{})',ctx)).allowed,false);
 ctx.req=new Request('https://synthetic.invalid',{headers:{authorization:'Bearer synthetic-session'}});
 for(const u of [{...user,id:'another-user'},{...user,email_confirmed_at:null}]){const previous=user;user=u;assert.equal((await vm.runInContext('stagingOwnerTest(db,stage,req,"status",{})',ctx)).allowed,false);user=previous}
 assert.equal(calls,0);
 const fixture=vm.runInContext('stagingFixture()',ctx);ctx.body={attempt_id:'11111111-1111-4111-8111-111111111111',email:'someone-else@example.invalid',request:fixture};
 assert.equal((await vm.runInContext('stagingOwnerTest(db,stage,req,"start",body,true)',ctx)).allowed,false);
 ctx.body.email=user.email;ctx.body.request={...fixture,pickup:'実データへ変更'};
 assert.equal((await vm.runInContext('stagingOwnerTest(db,stage,req,"start",body,true)',ctx)).allowed,false);assert.equal(calls,0);
 ctx.body.request=fixture;let args;ctx.db.rpc=async(name,a)=>{assert.equal(name,'cargo_staging_owner_test_authorize');args=a;return{data:{ok:true,draft_id:a.p_target_id}}};
 assert.equal((await vm.runInContext('stagingOwnerTest(db,stage,req,"start",body,true)',ctx)).allowed,true);assert.equal(args.p_owner_id,owner);assert.equal(args.p_target_id,ctx.body.attempt_id);assert.equal(args.p_claim,true);
 ctx.db.rpc=async()=>({data:{ok:false}});assert.equal((await vm.runInContext('stagingOwnerTest(db,stage,req,"start",body,true)',ctx)).allowed,false);
 ctx.db.rpc=async()=>{throw Error('unavailable')};assert.equal((await vm.runInContext('stagingOwnerTest(db,stage,req,"status",{})',ctx)).allowed,false);
});
test('anonymous staging status/start/verify remain closed even with database switch enabled',async()=>{
 let handler,rpc=0;const db={from(){const q={select(){return q},eq(){return q},async maybeSingle(){return{data:{intake_enabled:true,captcha_required:true,contact_verification_required:true}}}};return q},rpc(){rpc++;throw Error('must not call')}};
 const ctx={createClient:()=>db,Deno:{serve:f=>handler=f,env:{get:k=>({SUPABASE_URL:stage,SUPABASE_SERVICE_ROLE_KEY:'synthetic'}[k]||'')}},Response,Request,TextEncoder,TextDecoder,Uint8Array,Uint32Array,URLSearchParams,atob,crypto:require('node:crypto').webcrypto};
 vm.createContext(ctx);vm.runInContext(stripTypeScriptTypes(files[0].replace(/^import .*;\n/,'')),ctx);
 for(const action of ['status','start','verify']){const r=await handler(new Request('https://synthetic.invalid',{method:'POST',headers:{origin:'https://app.rainbow-driver.com'},body:JSON.stringify({action})}));const body=await r.json();if(action==='status'){assert.equal(body.public_intake_enabled,false);assert.equal(body.ready,false)}else assert.equal(r.status,423)}assert.equal(rpc,0);
});
