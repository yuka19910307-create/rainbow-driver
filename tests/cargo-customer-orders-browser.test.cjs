/* New Stage 2 UI only. Every browser request and every Supabase invocation is mocked.
 * Run: node tests/cargo-customer-orders-browser.test.cjs --browser=chromium --page=root
 * CI repeats with webkit and staging; this never opens a Supabase/project endpoint.
 */
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const {test:nodeTest,before,after}=require('node:test');
const playwright=require('playwright');
const options=Object.fromEntries(process.argv.slice(2).filter(a=>a.startsWith('--')).map(a=>a.slice(2).split('=')));
const engine=options.browser||process.env.CARGO_ORDERS_BROWSER||'chromium';
const selection=options.page||process.env.CARGO_ORDERS_PAGE||'both';
if(!['chromium','webkit'].includes(engine)||!['root','staging','both'].includes(selection))throw Error('Use --browser=chromium|webkit --page=root|staging|both');
const ROOT=path.resolve(__dirname,'..');
const APP='https://app.rainbow-driver.com';
const REQUEST='22222222-2222-4222-8222-222222222222';
const USER='11111111-1111-4111-8111-111111111111';
const OTHER='33333333-3333-4333-8333-333333333333';
const AT='2026-10-16T01:02:03.000Z';
const CONDITIONS='合成配送条件：消費税と高速料金、待機料金と荷役条件を個別に確認済みです。';
const NOTE='電話で条件の合意を確認した合成記録';
const XSS='<img src=x onerror="window.orderXssExecuted=true">';
const FLAGS={legal_contract_determined:false,customer_notified:false,payment_created:false,dispatch_created:false};
const copy=v=>structuredClone(v);
const op=i=>`44444444-4444-4444-8444-${String(i).padStart(12,'0')}`;
function agreement(version=1,changes={}){return {request_id:REQUEST,version,amount_yen:12000,
 pickup_at:'2030-01-01T01:00:00.000Z',delivery_at:'2030-01-01T03:00:00.000Z',
 customer_confirmed_at:AT,confirmation_method:'phone',recorded_by:USER,recorded_at:AT,
 conditions:CONDITIONS,confirmation_note:NOTE,...changes};}
function order(changes={}){return {request_id:REQUEST,status:'accepted',version:1,active_agreement_version:1,
 accepted_by:USER,accepted_at:AT,updated_by:USER,updated_at:AT,completed_at:null,cancelled_at:null,
 retention_policy:'undetermined_hold',retention_until:null,...changes};}
function event(sequence=1,changes={}){return {request_id:REQUEST,sequence,operation_id:op(sequence),
 kind:'customer_agreement_recorded',from_status:null,to_status:null,order_version:0,
 agreement_version:1,actor_id:USER,recorded_at:AT,payload:null,...changes};}
function consultation(changes={}){return {id:REQUEST,status:'quoted',created_at:AT,retention_hold:true,
 closed_no_order_at:null,delete_after:'2030-01-01T00:00:00.000Z',
 details:{pickup:'合成集荷地',delivery:'合成配送先',cargo:'合成荷物',pieces:1,weight:2,
 length:30,width:20,height:10,readiness:'ready',handling:'no',note:'合成相談',clientName:'合成担当者',
 email:'synthetic@example.invalid',today:true},quote:{amount_yen:12000,terms:CONDITIONS,
 valid_until:'2030-01-01T00:00:00.000Z',delivery_status:'sent',response_state:'interested',responded_at:AT},
 followup:null,...changes};}
let browser;
before(async()=>{const launch={headless:true};if(engine==='chromium'&&process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH)
 launch.executablePath=process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;browser=await playwright[engine].launch(launch);});
after(async()=>{await browser?.close();});
async function createSetup(config={}){
 const target=config.target;const PAGE=target==='root'?'/cargo-customer-review.html':'/staging/cargo-customer-review.html';
 const viewport=config.viewport||{width:390,height:844};
 const context=config.context||await browser.newContext({viewport,timezoneId:'UTC',serviceWorkers:'block',
  isMobile:viewport.width<768,hasTouch:viewport.width<768});
 const page=await context.newPage();
 const t={page,context,calls:[],unexpected:[],errors:[],dialogs:[],denyDialog:false,
  model:config.sharedModel||{order:config.order===undefined?null:copy(config.order),agreements:copy(config.agreements||[]),events:copy(config.events||[])},
  readFailure:null,writeFailure:null,beforeWrite:null,beforeRead:null,holdWrite:null,readCount:0};
 let initialAuth;
 if(config.delayInitialAuth){
  initialAuth=new Promise(resolve=>{t.releaseInitialAuth=()=>resolve({data:{user:{id:USER}},error:null});});
  await page.exposeFunction('mockOrderInitialAuth',()=>initialAuth);
 }
 if(config.noLocks)await page.addInitScript(()=>Object.defineProperty(navigator,'locks',{value:undefined,configurable:true}));
 if(config.shortenDeadline)await page.addInitScript(()=>{
  const timeout=window.setTimeout.bind(window);window.setTimeout=(fn,delay,...args)=>timeout(fn,delay===15000?50:delay,...args);
 });
 page.on('pageerror',error=>t.errors.push(error.message));
 page.on('dialog',async dialog=>{t.dialogs.push(dialog.message());if(t.denyDialog)await dialog.dismiss();else await dialog.accept();});
 const fail=(status=503,error='ORDER_UNAVAILABLE')=>({__mockError:{status,error},data:null});
 t.snapshot=body=>{
  const model=body.request_id===REQUEST?t.model:config.extraSnapshots?.[body.request_id];assert(model,'read must use a synthetic consultation');
  const agreements=model.agreements.filter(a=>!body.before_agreement_version||a.version<body.before_agreement_version).sort((a,b)=>b.version-a.version);
  const events=model.events.filter(e=>!body.before_event_sequence||e.sequence<body.before_event_sequence).sort((a,b)=>b.sequence-a.sequence);
  return {data:{ok:true,request_id:body.request_id,order:copy(model.order),agreements:copy(agreements.slice(0,50)),events:copy(events.slice(0,50)),
   next_before_agreement_version:agreements.length>50?agreements[49].version:null,
   next_before_event_sequence:events.length>50?events[49].sequence:null,
   snapshot_consistent:true,customer_agreement_source:'operator_observation',...FLAGS},error:null};
 };
 t.commit=body=>{
  const latest=Math.max(0,...t.model.agreements.map(a=>a.version));
  const expected=t.model.order?.version||0;
  assert.equal(body.request_id,REQUEST);assert.equal(body.expected_order_version,expected);
  assert.match(body.operation_id,/^[a-f0-9-]{36}$/i);
  assert(!t.model.events.some(e=>e.operation_id===body.operation_id),'operation IDs must not be reused as writes');
  const from=t.model.order?.status||null;
  let kind;
  if(body.action==='record_agreement'){
   assert.equal(body.expected_agreement_version,latest);
   assert.equal(body.confirmation,'RECORD_OBSERVED_CUSTOMER_AGREEMENT');
   t.model.agreements.push(agreement(latest+1,Object.fromEntries(['amount_yen','pickup_at','delivery_at','customer_confirmed_at','confirmation_method','conditions','confirmation_note'].map(k=>[k,body[k]]))));
   kind='customer_agreement_recorded';
  }else if(body.action==='accept_order'){
   assert.equal(body.confirmation,'RECORD_OPERATOR_ACCEPTANCE');assert.equal(body.agreement_version,latest);
   assert.equal(expected,0);t.model.order=order({active_agreement_version:latest});kind='order_accepted';
  }else if(body.action==='apply_agreement'){
   assert.equal(body.confirmation,'APPLY_RECORDED_AGREEMENT');assert.equal(body.agreement_version,latest);
   t.model.order.active_agreement_version=latest;t.model.order.version++;kind='agreement_applied';
  }else if(body.action==='change_status'){
   assert.equal(body.confirmation,'RECORD_DELIVERY_STATE_CHANGE');
   const allowed={accepted:['preparing','cancelled'],preparing:['in_transit','cancelled'],in_transit:['completed','cancelled']};
   assert(allowed[from]?.includes(body.next_status),'UI must not send an invalid state transition');
   if(body.next_status==='cancelled')assert(body.note.trim().length>=5);
   t.model.order.status=body.next_status;t.model.order.version++;
   if(body.next_status==='completed')t.model.order.completed_at=AT;
   if(body.next_status==='cancelled')t.model.order.cancelled_at=AT;
   kind='status_changed';
  }else throw Error('unexpected order mutation');
  const agreementVersion=Math.max(0,...t.model.agreements.map(a=>a.version));
  t.model.events.push(event(Math.max(0,...t.model.events.map(e=>e.sequence))+1,{operation_id:body.operation_id,kind,
   from_status:from,to_status:t.model.order?.status||null,order_version:t.model.order?.version||0,
   agreement_version:agreementVersion,payload:body.action==='change_status'?{note:body.note}:null}));
  return {data:{ok:true,request_id:REQUEST,order_version:t.model.order?.version||0,
   agreement_version:agreementVersion,status:t.model.order?.status||null,customer_agreement_source:'operator_observation',...FLAGS},error:null};
 };
 await page.exposeFunction('mockOrderInvoke',async(name,body)=>{
  t.calls.push({name,body:copy(body)});
  if(name==='cargo-customer-review-operator'){
   if(!['list','list_retention'].includes(body.action))throw Error('old write/mail/notification/payment invoke forbidden');
   return {data:{ok:true,items:copy(config.items||[consultation()])},error:null};
  }
  assert.equal(name,'cargo-customer-orders','unexpected service call');
  if(body.action==='read'){
   t.readCount++;if(t.beforeRead)await t.beforeRead(body);
   if(t.readFailure)return fail(t.readFailure);
   return t.snapshot(body);
  }
  if(t.beforeWrite)await t.beforeWrite(body);
  if(t.holdWrite)await t.holdWrite;
  if(t.writeFailure){const {status=503,commit=false}=t.writeFailure;if(commit)t.commit(body);return fail(status,status===409?'ORDER_CONFLICT':'ORDER_UNAVAILABLE');}
  return t.commit(body);
 });
 await page.route('**/*',async route=>{
  const url=new URL(route.request().url());
  if(url.origin===APP&&url.pathname===PAGE)return route.fulfill({contentType:'text/html',body:fs.readFileSync(path.join(ROOT,PAGE),'utf8')});
  if(url.origin===APP&&['/cargo-pwa/request-review-rules.js','/cargo-pwa/order-management.js','/cargo-pwa/order-management.css'].includes(url.pathname))
   return route.fulfill({contentType:url.pathname.endsWith('.css')?'text/css':'text/javascript',body:fs.readFileSync(path.join(ROOT,url.pathname),'utf8')});
  if(url.origin==='https://cdn.jsdelivr.net'&&url.pathname.includes('/@supabase/supabase-js@'))return route.fulfill({contentType:'text/javascript',body:`
   window.supabase={createClient:(url,key,options)=>{
    if(url!==${JSON.stringify(target==='root'?'https://kvoaorzdewwirqryeizq.supabase.co':'https://hvdoqcrnztqmbzgwrovd.supabase.co')})throw Error('wrong project');
    return {auth:{getUser:async()=>{${config.delayInitialAuth?'const value=await window.mockOrderInitialAuth();window.mockInitialAuthDelivered=true;return value;':`return {data:{user:{id:${JSON.stringify(USER)}}},error:null};`}},onAuthStateChange:callback=>{window.mockAuthEvent=(event,user)=>callback(event,user?{user}:null);return {data:{subscription:{unsubscribe(){}}}}}},
     functions:{invoke:async(name,{body})=>{const r=await window.mockOrderInvoke(name,body);if(r.__mockError)return {data:r.data,error:{context:new Response(JSON.stringify(r.__mockError.status===409?{ok:false,error:'ORDER_CONFLICT',legal_contract_determined:false,customer_notified:false,payment_created:false,dispatch_created:false}:{error:r.__mockError.error}),{status:r.__mockError.status})}};return r;}}};
   }};`});
  if(url.origin===APP&&url.pathname==='/favicon.ico')return route.fulfill({status:204});
  t.unexpected.push(route.request().url());return route.abort();
 });
 await page.goto(APP+PAGE);
 t.panel=page.locator(`[data-order-panel="${REQUEST}"]`);
 if(config.delayInitialAuth)await page.waitForFunction(()=>typeof window.mockAuthEvent==='function');
 else{
  await t.panel.waitFor({state:'visible'});
  await page.waitForFunction(()=>document.querySelector('[data-order-panel] [data-order-action="read"]'));
 }
 await tick(page);
 t.writes=()=>t.calls.filter(c=>c.name==='cargo-customer-orders'&&c.body.action!=='read');
 t.action=(action,status)=>t.panel.locator(`[data-order-action="${action}"]${status?`[data-next-status="${status}"]`:''}`);
 t.field=field=>t.panel.locator(`[data-order-field="${field}"]`);
 t.confirm=action=>t.panel.locator(`[data-order-confirm="${action}"]`);
 t.message=()=>t.panel.locator('[data-order-message]').innerText();
 t.close=async()=>{assert.deepEqual(t.unexpected,[],'all HTTP must be explicitly fulfilled');assert.deepEqual(t.errors,[],'no browser exceptions');if(!config.context)await context.close();else await page.close();};
 return t;
}
async function tick(page){await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));}
async function read(t){await t.action('read').click();await tick(t.page);}
async function fillAgreement(t,changes={}){
 const values={amount_yen:'18000',pickup_at:'2030-01-02T10:30',delivery_at:'2030-01-02T12:30',
  customer_confirmed_at:'2026-10-15T11:12',conditions:CONDITIONS,confirmation_note:NOTE,...changes};
 for(const [field,value] of Object.entries(values))await t.field(field).fill(value);
 await t.field('confirmation_method').selectOption('phone');
}
async function agree(t){await fillAgreement(t);await t.confirm('record_agreement').check();await t.action('record_agreement').click();await tick(t.page);}
async function accept(t){await t.confirm('accept_order').check();await t.action('accept_order').click();await tick(t.page);}
async function status(t,next,note=''){
 await t.field('state_note').fill(note);
 if(await t.confirm('change_status').count())await t.confirm('change_status').check();
 await t.action('change_status',next).click();await tick(t.page);
}
async function storage(t){return t.page.evaluate(()=>Object.fromEntries(Object.keys(localStorage).map(k=>[k,localStorage.getItem(k)])));}
function assertNoPrivateStorage(value){const s=JSON.stringify(value);for(const text of [CONDITIONS,NOTE,'synthetic@example.invalid','合成集荷地','合成配送先'])assert(!s.includes(text),'private/form data must never be persisted');}

function suite(target){
const setup=(config={})=>createSetup({...config,target});
const test=(name,run)=>nodeTest(`${target}/${name}`,run);
test('load reads existing quote/orders only, separates operator observation from customer app consent',async()=>{
 const t=await setup();try{assert.equal(t.writes().length,0);assert(t.calls.some(c=>c.body.action==='read'));
  const text=await t.panel.innerText();assert.match(text,/管理者/);assert.match(text,/顧客|お客様/);assert.match(text,/アプリ|本人/);
  assert.equal(await t.action('accept_order').count(),0);assertNoPrivateStorage(await storage(t));
 }finally{await t.close();}
});
test('existing review and manual quote controls coexist without invoking old write or mail APIs',async()=>{
 const pending=consultation({id:OTHER,status:'pending_operator_review',quote:null});
 const reviewing=consultation({id:'55555555-5555-4555-8555-555555555555',status:'operator_reviewing',
  quote:{amount_yen:12000,terms:CONDITIONS,valid_until:'2030-01-01T00:00:00.000Z',delivery_status:'ready_to_send'}});
 const t=await setup({items:[consultation(),pending,reviewing]});try{
  assert.equal(await t.page.getByRole('button',{name:'審査を開始',exact:true}).count(),1);
  assert.equal(await t.page.getByRole('button',{name:'辞退として記録',exact:true}).count(),1);
  const save=t.page.getByRole('button',{name:'見積もりを下書き保存',exact:true});assert.equal(await save.isEnabled(),false);
  for(const box of await t.page.locator('[data-consultation-check]').all())await box.check();
  assert.equal(await save.isEnabled(),true);assert.equal(t.writes().length,0);
  assert(t.calls.every(c=>['list','read'].includes(c.body.action)));
 }finally{await t.close();}
});
test('agreement requires deliberate confirmation and cancel leaves no record',async()=>{
 const t=await setup();try{await fillAgreement(t);await t.action('record_agreement').click();assert.equal(t.writes().length,0);
  await t.confirm('record_agreement').check();t.denyDialog=true;await t.action('record_agreement').click();await tick(t.page);
  assert.equal(t.writes().length,0);assert.equal(t.model.agreements.length,0);assert(t.dialogs.length>0);
 }finally{await t.close();}
});
test('recorded agreement preserves Japan-local dates as canonical UTC and never accepts automatically',async()=>{
 const t=await setup();try{await agree(t);const sent=t.writes()[0].body;
  assert.equal(sent.pickup_at,'2030-01-02T01:30:00.000Z');assert.equal(sent.delivery_at,'2030-01-02T03:30:00.000Z');
  assert.equal(sent.customer_confirmed_at,'2026-10-15T02:12:00.000Z');assert.equal(t.model.order,null);
  assert.equal(t.writes().length,1);assert.equal(t.model.agreements.length,1);
  assertNoPrivateStorage(await storage(t));assert.equal(Object.keys(await storage(t)).length,0);
 }finally{await t.close();}
});
test('formal acceptance needs its own confirmation and records the chosen agreement version',async()=>{
 const t=await setup({agreements:[agreement()],events:[event()]});try{
  await t.action('accept_order').click();assert.equal(t.writes().length,0);await accept(t);
  assert.equal(t.writes().length,1);assert.equal(t.writes()[0].body.action,'accept_order');
  assert.equal(t.model.order.status,'accepted');assert.equal(t.model.order.active_agreement_version,1);
  assert.equal(t.model.order.retention_until,null);assert.match(await t.panel.innerText(),/保存|削除/);
  assert.equal(await t.page.locator(`[data-order-legacy="${REQUEST}"]`).isVisible(),false);
 }finally{await t.close();}
});
test('state buttons enforce the sequence and completion needs an explicit operator action',async()=>{
 const t=await setup({order:order(),agreements:[agreement()],events:[event(1,{kind:'order_accepted',to_status:'accepted',order_version:1})]});try{
  assert.equal(await t.action('change_status','completed').isVisible(),false);
  await status(t,'preparing');assert.equal(t.model.order.status,'preparing');
  await status(t,'in_transit');assert.equal(t.model.order.status,'in_transit');
  assert.equal(t.model.order.completed_at,null);assert.equal(t.writes().length,2);
  await status(t,'completed','配送先で完了を確認');assert.equal(t.model.order.status,'completed');
  assert.equal(t.model.order.completed_at,AT);assert.equal(t.writes().length,3);
  assert.equal(await t.action('change_status').count(),0);
 }finally{await t.close();}
});
test('cancellation requires a reason and leaves actor/time/state history',async()=>{
 const t=await setup({order:order(),agreements:[agreement()]});try{
  await t.field('state_note').fill('短い');if(await t.confirm('change_status').count())await t.confirm('change_status').check();
  await t.action('change_status','cancelled').click();assert.equal(t.writes().length,0);
  await status(t,'cancelled','顧客の都合で配送中止を確認');
  assert.equal(t.model.order.status,'cancelled');assert.equal(t.model.events[0].kind,'status_changed');
  const text=await t.panel.innerText();assert.match(text,/中止/);assert(text.includes(USER));assert.match(text,/2026/);
  assert(text.includes('顧客の都合で配送中止を確認'));
 }finally{await t.close();}
});
test('new conditions remain pending until compared and explicitly applied',async()=>{
 const t=await setup({order:order(),agreements:[agreement()]});try{
  await agree(t);assert.equal(t.model.order.active_agreement_version,1);assert.equal(t.model.agreements.length,2);
  assert.equal(await t.action('change_status','preparing').isEnabled(),false);
  const text=await t.panel.innerText();assert(text.includes('12,000')&&text.includes('18,000'),text);
  await t.action('apply_agreement').click();assert.equal(t.writes().length,1);
  await t.confirm('apply_agreement').check();await t.action('apply_agreement').click();await tick(t.page);
  assert.equal(t.model.order.active_agreement_version,2);assert.equal(t.model.events.at(-1).kind,'agreement_applied');
  await t.action('change_status','preparing').click();assert.equal(t.writes().length,2,'state change still needs a separate confirmation');
 }finally{await t.close();}
});
test('double clicks and legacy actions cannot write during an in-flight order operation',async()=>{
 const t=await setup({agreements:[agreement()]});let release;try{
  t.holdWrite=new Promise(resolve=>release=resolve);await t.confirm('accept_order').check();
  await t.action('accept_order').click();await t.page.waitForFunction(()=>document.querySelector('[data-order-action="accept_order"]').disabled);
  await t.page.evaluate(()=>{document.querySelector('[data-order-action="accept_order"]').click();document.querySelector('#refresh').click();
   for(const button of document.querySelectorAll('[data-order-legacy] button'))button.click();});
  assert.equal(t.writes().length,1);assert.equal(t.calls.filter(c=>c.name==='cargo-customer-review-operator').length,1);
  release();await tick(t.page);assert.equal(t.model.order.status,'accepted');assert.equal(t.writes().length,1);
 }finally{release?.();await t.close();}
});
test('another tab cannot replace an in-flight operation journal or reconcile before that operation settles',async()=>{
 const t=await setup({agreements:[agreement()]});let second,release;try{
  second=await setup({context:t.context,sharedModel:t.model});
  await t.confirm('accept_order').check();await second.confirm('accept_order').check();
  t.holdWrite=new Promise(resolve=>release=resolve);t.writeFailure={status:503,commit:true};
  await t.action('accept_order').click();await t.page.waitForFunction(()=>localStorage.length>0);
  const id=t.writes()[0].body.operation_id;await tick(second.page);
  const reads=second.readCount;await second.action('accept_order').evaluate(node=>node.click());
  await second.action('reconcile').click();await tick(second.page);
  assert.equal(second.writes().length,0);assert.equal(second.readCount,reads,'held Web Lock must reject concurrent reconciliation');
  assert(JSON.stringify(await storage(t)).includes(id));release();await tick(t.page);
  assert(JSON.stringify(await storage(t)).includes(id),'unknown first operation must remain recoverable');
  await second.action('reconcile').click();await tick(second.page);
  assert(!JSON.stringify(await storage(t)).includes(id));assert.equal(t.writes().length,1);assert.equal(second.writes().length,0);
 }finally{release?.();await second?.close();await t.close();}
});
test('two consultation cards share the host operation guard',async()=>{
 const t=await setup({agreements:[agreement()],items:[consultation(),consultation({id:OTHER})],
  extraSnapshots:{[OTHER]:{order:null,agreements:[agreement(1,{request_id:OTHER})],events:[]}}});let release;try{
  const other=t.page.locator(`[data-order-panel="${OTHER}"]`);
  await other.locator('[data-order-confirm="accept_order"]').check();await t.confirm('accept_order').check();
  t.holdWrite=new Promise(resolve=>release=resolve);await t.action('accept_order').click();
  await other.locator('[data-order-action="accept_order"]').click();await tick(t.page);
  assert.equal(t.writes().length,1);assert.match(await other.locator('[data-order-message]').innerText(),/別|操作中|完了/);
  release();await tick(t.page);assert.equal(t.writes().length,1);
 }finally{release?.();await t.close();}
});
test('browser without Web Locks permits reading but fails closed for every write',async()=>{
 const t=await setup({noLocks:true,agreements:[agreement()]});try{
  assert((await t.panel.innerText()).includes(CONDITIONS));assert.equal(await t.action('read').isEnabled(),true);
  assert.equal(await t.action('record_agreement').isEnabled(),false);assert.equal(await t.action('accept_order').isEnabled(),false);
  await t.action('accept_order').evaluate(node=>node.click());assert.equal(t.writes().length,0);
  assert.equal(Object.keys(await storage(t)).length,0);
 }finally{await t.close();}
});
test('409 conflict blocks stale action, reloads current data and requires confirmation again',async()=>{
 const t=await setup({agreements:[agreement()]});try{
  t.writeFailure={status:409};await accept(t);assert.equal(t.writes().length,1);
  assert.match(await t.message(),/競合|更新|別|確認/);await t.action('accept_order').click();assert.equal(t.writes().length,1);
  t.writeFailure=null;await read(t);await t.action('accept_order').click();assert.equal(t.writes().length,1);
  await accept(t);assert.equal(t.writes().length,2);assert.notEqual(t.writes()[0].body.operation_id,t.writes()[1].body.operation_id);
 }finally{await t.close();}
});
for(const code of [401,403])test(`${code} removes private records and prevents further order writes`,async()=>{
 const t=await setup({order:order(),agreements:[agreement()]});try{
  assert((await t.panel.innerText()).includes(CONDITIONS));t.readFailure=code;await read(t);
  assert(!(await t.page.locator('#requests').innerText()).includes(CONDITIONS));
  assert(!(await t.page.locator('#requests').innerText()).includes('synthetic@example.invalid'));
  assert.equal(t.writes().length,0);assertNoPrivateStorage(await storage(t));
 }finally{await t.close();}
});
for(const code of [401,403])test(`${code} on a write clears only its rejected operation and scrubs the page`,async()=>{
 const t=await setup({agreements:[agreement()]});try{
  t.writeFailure={status:code};await accept(t);assert.equal(t.writes().length,1);
  assert.equal(Object.keys(await storage(t)).length,0);
  assert(!(await t.page.locator('#requests').innerText()).includes(CONDITIONS));
  assert(!(await t.page.locator('#requests').innerText()).includes('synthetic@example.invalid'));
  assert.equal(await t.page.locator('#refresh').isEnabled(),false);
 }finally{await t.close();}
});
test('sign-out removes all private cards immediately and disables list refresh',async()=>{
 const t=await setup({order:order(),agreements:[agreement()]});try{
  assert((await t.page.locator('#requests').innerText()).includes(CONDITIONS));
  await t.page.evaluate(()=>window.mockAuthEvent('SIGNED_OUT',null));await tick(t.page);
  assert.equal((await t.page.locator('#requests').innerText()).trim(),'');
  assert.equal(await t.page.locator('#refresh').isEnabled(),false);assert.equal(t.writes().length,0);
 }finally{await t.close();}
});
test('stale initial authentication cannot restore cards after another user signs in',async()=>{
 const t=await setup({delayInitialAuth:true,order:order(),agreements:[agreement()]});try{
  assert.equal(t.calls.length,0);
  await t.page.evaluate(id=>window.mockAuthEvent('SIGNED_IN',{id}),OTHER);
  t.releaseInitialAuth();await t.page.waitForFunction(()=>window.mockInitialAuthDelivered===true);await tick(t.page);
  assert.equal((await t.page.locator('#requests').innerText()).trim(),'');
  assert.equal(await t.page.locator('#refresh').isEnabled(),false);
  assert.equal(await t.page.locator('#retentionView').isEnabled(),false);
  assert.equal(t.calls.length,0,'the old authentication response must not trigger any private list or order read');
  assert.equal(await t.page.locator('[data-order-panel]').count(),0);
 }finally{t.releaseInitialAuth?.();await t.close();}
});
test('missing read API fails closed and hides unsafe legacy closure/hold actions',async()=>{
 const t=await setup({beforeRead:()=>{}});try{
  t.readFailure=503;await read(t);assert.equal(await t.action('record_agreement').count(),0);
  assert.equal(await t.page.locator(`[data-order-legacy="${REQUEST}"]`).isVisible(),false);
  assert.equal(t.writes().length,0);assert.match(await t.message(),/確認|取得|接続/);
 }finally{await t.close();}
});
test('unknown write survives reload as metadata only and is released by matching its operation history',async()=>{
 const t=await setup({agreements:[agreement()]});try{
  t.writeFailure={status:503,commit:true};await accept(t);assert.equal(t.writes().length,1);
  const id=t.writes()[0].body.operation_id;const saved=await storage(t);assert(JSON.stringify(saved).includes(id));assertNoPrivateStorage(saved);
  t.writeFailure=null;await t.page.reload();await tick(t.page);assert.equal(t.writes().length,1);
  assert.equal(await t.action('change_status','preparing').isEnabled(),false);
  await t.action('reconcile').click();await tick(t.page);
  assert.equal(t.writes().length,1);assert(!JSON.stringify(await storage(t)).includes(id));
  assert.match(await t.message(),/照合|確認/);
 }finally{await t.close();}
});
test('host timeout retains the operation journal even when a late server result succeeds',async()=>{
 const t=await setup({agreements:[agreement()],shortenDeadline:true});let release;try{
  t.holdWrite=new Promise(resolve=>release=resolve);await t.confirm('accept_order').check();await t.action('accept_order').click();
  await t.page.waitForFunction(()=>document.querySelector('[data-order-message]').textContent.includes('二重処理'));
  const id=t.writes()[0].body.operation_id;assert(JSON.stringify(await storage(t)).includes(id));
  release();await tick(t.page);assert.equal(t.model.order.status,'accepted');
  assert(JSON.stringify(await storage(t)).includes(id),'late response must not silently clear uncertainty');
  await t.action('reconcile').click();await tick(t.page);assert(!JSON.stringify(await storage(t)).includes(id));
  assert.equal(t.writes().length,1);
 }finally{release?.();await t.close();}
});
test('unknown write not found in all history stays blocked without retry or a new operation ID',async()=>{
 const t=await setup({agreements:[agreement()]});try{
  t.writeFailure={status:503,commit:false};await accept(t);const id=t.writes()[0].body.operation_id;
  t.writeFailure=null;await t.action('reconcile').click();await tick(t.page);
  assert.equal(t.writes().length,1);assert(JSON.stringify(await storage(t)).includes(id));
  assert.equal(await t.action('accept_order').isEnabled(),false);assert.match(await t.message(),/不明|見つ|停止|再送/);
 }finally{await t.close();}
});
test('reconciliation searches older history pages and normal history pagination displays older actors',async()=>{
 const events=Array.from({length:55},(_,i)=>event(i+1,{actor_id:i===0?OTHER:USER}));
 const t=await setup({agreements:[agreement()],events});try{
  t.writeFailure={status:503,commit:false};await accept(t);const id=t.writes()[0].body.operation_id;
  t.model.events[0].operation_id=id;t.model.events[0].kind='order_accepted';t.model.events[0].to_status='accepted';t.model.events[0].order_version=1;
  t.model.order=order();t.writeFailure=null;
  await t.action('reconcile').click();await tick(t.page);
  assert(t.calls.some(c=>c.body.action==='read'&&c.body.before_event_sequence));
  assert(!JSON.stringify(await storage(t)).includes(id));assert.equal(t.writes().length,1);
  await read(t);await t.action('more_events').click();await tick(t.page);
  assert((await t.panel.innerText()).includes(OTHER));
 }finally{await t.close();}
});
test('agreement history pagination keeps earlier agreed terms available',async()=>{
 const agreements=Array.from({length:55},(_,i)=>agreement(i+1,{conditions:CONDITIONS+` 第${i+1}版`}));
 const t=await setup({agreements});try{
  await t.action('more_agreements').click();await tick(t.page);
  assert(t.calls.some(c=>c.body.before_agreement_version));assert((await t.panel.innerText()).includes('第1版'));
  assert.equal(t.writes().length,0);
 }finally{await t.close();}
});
test('currently applied conditions are fetched even when older than the first 50 condition records',async()=>{
 const agreements=Array.from({length:55},(_,i)=>agreement(i+1,{amount_yen:i===0?12000:18000,conditions:CONDITIONS+` 第${i+1}版`}));
 const t=await setup({order:order(),agreements});try{
  assert(t.calls.some(c=>c.body.action==='read'&&c.body.before_agreement_version===2));
  const text=await t.panel.innerText();assert(text.includes('第1版'));assert(text.includes('第55版'));
  assert(text.includes('12,000')&&text.includes('18,000'));assert.equal(t.writes().length,0);
 }finally{await t.close();}
});
test('untrusted conditions and state notes render as text and never execute HTML',async()=>{
 const t=await setup({order:order(),agreements:[agreement(1,{conditions:CONDITIONS+XSS,confirmation_note:NOTE+XSS})],
  events:[event(1,{kind:'status_changed',from_status:'accepted',to_status:'preparing',order_version:2,payload:{note:XSS}})]});try{
  assert((await t.panel.innerText()).includes(XSS));assert.equal(await t.panel.locator('img').count(),0);
  assert.equal(await t.page.evaluate(()=>window.orderXssExecuted),undefined);assertNoPrivateStorage(await storage(t));
 }finally{await t.close();}
});
for(const width of [320,390,1280])test(`management controls and long histories fit ${width}px viewport`,async()=>{
 const t=await setup({viewport:{width,height:844},order:order(),agreements:[agreement(1,{conditions:CONDITIONS+'長'.repeat(400)})],
  events:[event(1,{kind:'order_accepted',order_version:1,to_status:'accepted'})]});try{
  assert(await t.page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),'page must not overflow horizontally');
  const buttons=t.panel.locator('button:visible');for(let i=0;i<await buttons.count();i++){
   const box=await buttons.nth(i).boundingBox();assert(box.x>=0&&box.x+box.width<=width+1,'touch control must fit viewport');
   assert(box.height>=44,'touch control must be at least 44px high');
  }
  assert.equal(t.writes().length,0);
  if(width<768&&process.env.CARGO_ORDERS_SCREENSHOT_DIR){
   const directory=path.resolve(process.env.CARGO_ORDERS_SCREENSHOT_DIR);
   assert(directory.startsWith('/tmp/'),'synthetic screenshots must use an explicit temporary directory');
   fs.mkdirSync(directory,{recursive:true});await t.page.screenshot({path:path.join(directory,`cargo-orders-${target}-${engine}-${width}.png`),fullPage:true});
  }
 }finally{await t.close();}
});
}
for(const target of selection==='both'?['root','staging']:[selection])suite(target);
