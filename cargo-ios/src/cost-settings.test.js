'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

const html=fs.readFileSync(path.resolve(__dirname,'..','..','cargo-cost-preview.html'),'utf8');
const js=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m=>m[1]);
function mockContext(saved) {
  const elements=new Map();
  const htmlIds=[...html.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]);
  for(const id of htmlIds){
    elements.set(id,{
      id, value:'', checked:false, hidden:false, open:true, style:{}, textContent:'',
      onclick:null, onchange:null,
      addEventListener(){},
      scrollIntoView(){}
    });
  }
  for(const [id,v] of Object.entries({round:'500',toll:'0',waiting:'0',handling:'0'}))elements.get(id).value=v;
  const localStorage={
    getItem:(key)=>saved.has(key)?saved.get(key):null,
    setItem:(key,v)=>saved.set(key,String(v)),
    removeItem:(key)=>saved.delete(key)
  };
  const context={window:{CargoPricing:{calculate(){},supplementaryFees(){}}},
    document:{getElementById:(id)=>elements.get(id)},
    localStorage,console};
  vm.runInNewContext(js[1],context,{timeout:2000});
  return elements;
}
test('all inline scripts pass syntax check',()=>{for(const script of js)assert.doesNotThrow(()=>new vm.Script(script));});
test('saving stores only opt-in six hypothetical cost fields, never addresses, GPS or API keys',()=>{
  const store=new Map(),els=mockContext(store);
  const defaults={hourly:'4000',perKm:'45',dispatch:'2000',buffer:'30',risk:'15',round:'500'};
  for(const [id,val] of Object.entries(defaults))els.get(id).value=val;
  els.get('routePickup').value='private pickup test';els.get('routeDestination').value='private destination test';
  els.get('routeKey').value='dummy_secret_do_not_store';els.get('aKm').value='13.2';els.get('toll').value='900';
  els.get('saveCost').onclick();
  assert.equal(store.size,1);
  const stored=JSON.parse([...store.values()][0]);
  assert.equal(stored.version,1);
  assert.deepEqual(Object.keys(stored.cost).sort(),Object.keys(defaults).sort());
  for(const value of ['private pickup test','private destination test','dummy_secret_do_not_store','13.2','900'])
    assert.ok(![...store.values()][0].includes(value),value+' was unexpectedly persisted');
  assert.equal(els.get('costDetails').open,false);
});
test('settings restore on subsequent page open; deleting clears only saved settings',()=>{
  const store=new Map();
  const before=mockContext(store);
  Object.entries({hourly:'4000',perKm:'45',dispatch:'2000',buffer:'30',risk:'15',round:'500'})
    .forEach(([k,v])=>before.get(k).value=v);
  before.get('saveCost').onclick();
  const after=mockContext(store);
  assert.equal(after.get('hourly').value,'4000');
  assert.equal(after.get('perKm').value,'45');
  assert.equal(after.get('costDetails').open,false);
  assert.equal(after.get('routePickup').value,'');
  assert.equal(after.get('routeKey').value,'');
  after.get('deleteCost').onclick();
  assert.equal(store.size,0);
});
test('invalid settings are not saved',()=>{
  const store=new Map(),els=mockContext(store);
  Object.entries({hourly:'4000',perKm:'45',dispatch:'2000',buffer:'30',risk:'250',round:'500'})
    .forEach(([k,v])=>els.get(k).value=v);
  els.get('saveCost').onclick();
  assert.equal(store.size,0);
  assert.match(els.get('costStatus').textContent,/保存できません/);
});
