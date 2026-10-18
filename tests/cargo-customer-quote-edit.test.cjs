const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),test=require('node:test');
function element(tag){return {tag,children:[],style:{},dataset:{},listeners:{},append(...x){this.children.push(...x)},addEventListener(k,f){this.listeners[k]=f}}}
for(const file of ['cargo-customer-review.html','staging/cargo-customer-review.html']){
 test(file+': quote confirmation uses saved values; edits require a fresh save',async()=>{
  const html=fs.readFileSync(file,'utf8'),messages=[];
  const src=html.slice(html.indexOf('function quotePane('),html.indexOf('function followupPane('));
  const ctx={document:{createElement:element},label:text=>Object.assign(element('p'),{textContent:text}),
   button:(text,fn)=>Object.assign(element('button'),{textContent:text,onclick:fn}),
   busy:false,confirm:message=>{messages.push(message);return false},
   localDate:()=> '2030/1/2 10:00:00',Date};
  vm.createContext(ctx);vm.runInContext(src,ctx);
  const item={quote:{amount_yen:12500,terms:'保存済みの条件です',valid_until:'2030-01-02T01:00:00Z',delivery_status:'ready_to_send'}};
  const send=c=>c.children.find(x=>x.tag==='button'&&x.textContent.includes('1通送信'));
  const review=c=>{
   const list=c.children.find(x=>x.tag==='fieldset');
   for(const wrap of list.children.filter(x=>x.tag==='label')){
    const input=wrap.children[0];input.checked=true;input.listeners.change();
   }
  };
  const initial=ctx.quotePane(item);review(initial);await send(initial).onclick();
  assert.equal(messages.length,1);assert.match(messages[0],/12,500円/);assert.match(messages[0],/保存済みの条件です/);assert.match(messages[0],/日本時間/);
  for(let field=0;field<3;field++){
   const c=ctx.quotePane(item),inputs=c.children.filter(x=>x.tag==='label').map(x=>x.children[0]);
   inputs[field].value='edited';inputs[field].listeners.input();
   assert.equal(send(c).disabled,true);review(c);assert.equal(send(c).disabled,true);await send(c).onclick();
   assert.equal(messages.length,1,'dirty quote must not reach confirmation or API');
   assert(c.children.some(x=>x.textContent?.includes('変更は未保存')));
  }
  const fresh=ctx.quotePane({});assert.equal(fresh.children.find(x=>x.tag==='label').children[0].value,'');
  assert.equal(send(fresh),undefined);
  for(const status of ['sending','sent','delivery_unknown'])assert.equal(send(ctx.quotePane({quote:{...item.quote,delivery_status:status}})),undefined);
 });
}
