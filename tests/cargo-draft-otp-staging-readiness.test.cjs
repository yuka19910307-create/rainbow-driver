const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const code=fs.readFileSync(path.join(__dirname,'../integrations/cargo-staging-readiness/index.ts'),'utf8').replace(/^import .*;\n/,'');
async function run(opts={}){
 let handler,calls=0;
 const db={auth:{getUser:async()=>({data:{user:opts.badJwt?null:{id:'synthetic'}}})},from(table){calls++;const q={select(){return q},eq(){return q},async maybeSingle(){return {data:table==='cargo_operator_accounts'?(opts.nonOperator?null:{user_id:'synthetic'}):{intake_enabled:!!opts.intakeOn,captcha_required:true,contact_verification_required:true}}},async limit(){return {data:[],error:opts.noSchema?{}:null}}};return q}};
 vm.runInNewContext(code,{Response,Deno:{serve:f=>handler=f,env:{get:k=>k==='SUPABASE_URL'?(opts.wrongProject?'https://wrong.invalid':'https://hvdoqcrnztqmbzgwrovd.supabase.co'):'synthetic'}},createClient:()=>db});
 const r=await handler(new Request('https://synthetic.invalid',{method:'POST',headers:{origin:'https://app.rainbow-driver.com',...(opts.noJwt?{}:{authorization:'Bearer synthetic'})},body:JSON.stringify(opts.body||{action:'status'})}));
 return {status:r.status,body:await r.json(),calls};
}
test('staging readiness verifies operator, schema and OFF gate',async()=>{const r=await run();assert.equal(r.status,200);assert.equal(r.body.operator_verified,true);assert.equal(r.body.database_ready,true);for(const k of ['public_intake_enabled','email_sent','request_created','payment_created','customer_flow_ready'])assert.equal(r.body[k],false)});
test('missing JWT, invalid JWT and non-operator are denied',async()=>{for(const [opts,status] of [[{noJwt:true},401],[{badJwt:true},401],[{nonOperator:true},403]])assert.equal((await run(opts)).status,status)});
test('wrong project cannot query any table',async()=>{const r=await run({wrongProject:true});assert.equal(r.status,503);assert.equal(r.calls,0)});
test('intake ON and missing schema fail closed',async()=>{assert.equal((await run({intakeOn:true})).status,423);assert.equal((await run({noSchema:true})).status,503)});
test('write actions and unexpected fields cannot reach database',async()=>{for(const body of [{action:'send_test'},{action:'status',email:'synthetic@example.invalid'}]){const r=await run({body});assert.equal(r.status,400);assert.equal(r.calls,0)}});
