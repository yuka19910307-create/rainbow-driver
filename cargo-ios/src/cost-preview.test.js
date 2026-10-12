'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const html=fs.readFileSync(path.join(__dirname,'..','..','cargo-cost-preview.html'),'utf8');
const scripts=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(x=>x[1]);
const maps=scripts[scripts.length-1];

test('all inline browser scripts parse as JavaScript',()=>{
  assert.ok(scripts.length>=3);
  for(const script of scripts){assert.doesNotThrow(()=>new vm.Script(script));}
});
test('maps uses three confirmed itinerary legs with live traffic routing',()=>{
  assert.match(maps,/routingPreference:'TRAFFIC_AWARE'/);
  assert.match(maps,/calculateLeg\(origin,pickup,avoid\)/);
  assert.match(maps,/calculateLeg\(pickup,delivery,avoid\)/);
  assert.match(maps,/calculateLeg\(delivery,finish,avoid\)/);
});
test('do not automatically mark road review as complete',()=>{
  assert.doesNotMatch(maps,/\$\('route'\)\.checked=true/);
  assert.match(maps,/経路と交通状況を目視確認/);
});
test('GPS expiration and tab hiding clear route approval',()=>{
  assert.match(maps,/if\(gpsPoint&&!fresh\(\)\)/);
  assert.match(maps,/document\.addEventListener\('visibilitychange'/);
  assert.match(maps,/function clearGPS\(\)[\s\S]*?\$\('gps'\)\.checked=false/);
  assert.match(maps,/function invalidate\(\)[\s\S]*?\$\('route'\)\.checked=false/);
});
test('cost preview has no order creation or stored secrets',()=>{
  assert.match(html,/noindex,nofollow/);
  assert.doesNotMatch(html,/service_role|sk_live_|sb_secret_|Square\.payments/);
  assert.doesNotMatch(html,/fetch\(['"]https:\/\/.*supabase/);
  assert.match(html,/Google Mapsへ送/);
});
