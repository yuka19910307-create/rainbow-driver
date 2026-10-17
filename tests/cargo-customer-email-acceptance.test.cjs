const fs=require('node:fs');
const vm=require('node:vm');
const assert=require('node:assert/strict');
const {stripTypeScriptTypes}=require('node:module');
const source=fs.readFileSync(process.argv[2]||'integrations/cargo-customer-intake/index.ts','utf8');
const code=stripTypeScriptTypes(source.replace(/^import .*;\n/,''));
let fetchCalls=0,handler;
let response={ok:true,json:async()=>({id:'public-test-message-id'})};
const db={from:()=>{const chain={select:()=>chain,eq:()=>chain,maybeSingle:async()=>({data:{intake_enabled:false,captcha_required:true,contact_verification_required:true}})};return chain}};
const ctx={createClient:()=>db,Deno:{serve:f=>handler=f,env:{get:name=>({SUPABASE_URL:'https://staging.invalid',SUPABASE_SERVICE_ROLE_KEY:'mock-service-only'}[name]||'')}},
 fetch:async()=>{fetchCalls++;if(response instanceof Error)throw response;return response},
 TextEncoder,TextDecoder,Uint8Array,Uint32Array,URLSearchParams,AbortController,Response,setTimeout,clearTimeout,atob,crypto:require('node:crypto').webcrypto};
vm.createContext(ctx);vm.runInContext(code,ctx);
async function check(result,expected){response=result;fetchCalls=0;const accepted=await vm.runInContext("sendEmail('test@example.invalid','123456','sender@example.invalid','mock-provider-key')",ctx);assert.equal(accepted,expected);assert.equal(fetchCalls,1,'no automatic retries')}
(async()=>{
 await check({ok:true,json:async()=>({id:'public-test-message-id'})},true);
 for(const id of [undefined,null,0,'','   ','x'.repeat(201)])await check({ok:true,json:async()=>({id})},false);
 await check({ok:true,json:async()=>{throw Error('malformed JSON')}},false);
 await check({ok:false,json:async()=>({id:'irrelevant'})},false);
 await check(Error('timeout'),false);
 fetchCalls=0;response={ok:true,json:async()=>({id:'public-test-message-id'})};
 const req=new Request('https://staging.invalid/test',{method:'POST',headers:{Origin:'https://app.rainbow-driver.com','Content-Type':'application/json'},body:JSON.stringify({action:'start'})});
 const blocked=await handler(req);assert.equal(blocked.status,423);assert.equal((await blocked.json()).error,'PUBLIC_INTAKE_DISABLED');assert.equal(fetchCalls,0);
 console.log('Provider ID required; malformed/error/timeout responses rejected without retry; intake OFF prevents sending.');
})().catch(e=>{console.error(e);process.exitCode=1});
