'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {stripTypeScriptTypes}=require('node:module');
const source=fs.readFileSync(path.join(__dirname,'../integrations/cargo-safety-preparation/operator-ip-policy.ts'),'utf8');
const code=stripTypeScriptTypes(source.replace(/^export /gm,''),{mode:'strip'});
const noSideEffects=()=>assert.fail('IP policy must not access headers, network, secrets, storage or logs');
const policyModule=vm.runInNewContext(code+'\n({DISABLED_OPERATOR_IP_POLICY,matchOperatorIpPolicy});',{
 fetch:noSideEffects,Request:noSideEffects,Headers:noSideEffects,
 Deno:{env:{get:noSideEffects}},localStorage:new Proxy({},{get:noSideEffects}),
 console:{log:noSideEffects,error:noSideEffects,warn:noSideEffects}
});
const match=(policy,ip)=>JSON.parse(JSON.stringify(policyModule.matchOperatorIpPolicy(policy,ip)));
const config=(...addresses)=>({enabled:true,addresses});
const checked=(policy,ip,code,matched=false)=>{
 const result=match(policy,ip);
 assert.deepEqual(result,{code,match:matched,source_verified:false,enforcement_ready:false});
 return result;
};

// Documentation-only address ranges: RFC 5737 and RFC 3849. No real operator IPs.
test('missing and explicitly disabled policies cannot authorize or match',()=>{
 checked(undefined,'192.0.2.1','IP_POLICY_UNCONFIGURED');
 checked(null,'192.0.2.1','IP_POLICY_UNCONFIGURED');
 checked(policyModule.DISABLED_OPERATOR_IP_POLICY,'192.0.2.1','IP_POLICY_DISABLED');
 checked({enabled:false,addresses:['192.0.2.1']},'192.0.2.1','IP_POLICY_DISABLED');
 assert(Object.isFrozen(policyModule.DISABLED_OPERATOR_IP_POLICY));
 assert(Object.isFrozen(policyModule.DISABLED_OPERATOR_IP_POLICY.addresses));
});

test('exact IPv4 matches do not cover other addresses or prefixes',()=>{
 checked(config('192.0.2.1'),'192.0.2.1','IP_ADDRESS_MATCH',true);
 checked(config('192.0.2.1'),'192.0.2.2','IP_ADDRESS_NO_MATCH');
 checked(config('192.0.2.1','198.51.100.2'),'198.51.100.2','IP_ADDRESS_MATCH',true);
 checked(config('192.0.2.1'),'2001:db8::1','IP_ADDRESS_NO_MATCH');
});

test('IPv6 case, compression and leading zeroes share the same exact identity',()=>{
 for(const address of ['2001:DB8::1','2001:0db8:0000:0000:0000:0000:0000:0001',
  '2001:db8:0:0::1','2001:db8::0:1']){
  checked(config('2001:db8::1'),address,'IP_ADDRESS_MATCH',true);
  checked(config(address),'2001:db8::1','IP_ADDRESS_MATCH',true);
 }
 checked(config('2001:db8::1'),'2001:db8::2','IP_ADDRESS_NO_MATCH');
 checked(config('2001:db8::'),'2001:db8:0:0:0:0:0:0','IP_ADDRESS_MATCH',true);
});

test('IPv4-mapped IPv6 cannot create a second identity; compatible IPv6 remains distinct',()=>{
 for(const address of ['::ffff:192.0.2.1','::FFFF:c000:201','0:0:0:0:0:ffff:c000:0201']){
  checked(config('192.0.2.1'),address,'IP_ADDRESS_MATCH',true);
  checked(config(address),'192.0.2.1','IP_ADDRESS_MATCH',true);
 }
 checked(config('192.0.2.1'),'::192.0.2.1','IP_ADDRESS_NO_MATCH');
 checked(config('2001:db8::192.0.2.1'),'2001:db8::c000:201','IP_ADDRESS_MATCH',true);
});

test('invalid and ambiguous IPv4 representations, coercions and wrappers are rejected',()=>{
 const invalid=['192.0.2','192.0.2.1.2','192.0.2.256','192.0.2.-1','0192.0.2.1',
  '192.00.2.1','0xc0000201','3221225985','0xc0.0.2.1','192.0.2.1:443',
  '[192.0.2.1]','192.0.2.1/32','192.0.2.1, 198.51.100.2','for=192.0.2.1',
  ' 192.0.2.1','192.0.2.1 ','192.0.2.1\n','192.0.2.1\u0000',
  'example.invalid','https://192.0.2.1',1,true,null,undefined,{},['192.0.2.1']];
 for(const address of invalid){
  checked(config('192.0.2.1'),address,'IP_ADDRESS_INVALID');
  checked(config(address),'192.0.2.1','IP_POLICY_INVALID');
 }
});

test('invalid IPv6 literals, header chains and arbitrary ranges are rejected',()=>{
 const invalid=['2001:db8','2001:db8:',':2001:db8::1','2001:db8::1:',
  '2001:db8:::1','2001:db8::1::2','2001:db8:0:0:0:0:0:0:1',
  '2001:db8:0:0:0:0:0::1','2001:db8:00000::1','2001:db8::g',
  '[2001:db8::1]','[2001:db8::1]:443','2001:db8::1%eth0',
  '2001:db8::/32','2001:db8::1, 2001:db8::2','::ffff:192.0.2.256',
  '::ffff:192.00.2.1','2001:db8::192.0.2.1:1','*','192.0.2.0/0','2001:db8::/0','x'.repeat(100000)];
 for(const address of invalid){
  checked(config('2001:db8::1'),address,'IP_ADDRESS_INVALID');
  checked(config(address),'2001:db8::1','IP_POLICY_INVALID');
 }
});

test('settings are bounded, strictly shaped and invalid entries invalidate the complete policy',()=>{
 for(const policy of [true,[],{}, {enabled:'true',addresses:['192.0.2.1']},
  {enabled:true,addresses:[]},{enabled:true,addresses:'192.0.2.1'},
  {enabled:true,addresses:['192.0.2.1'],header:'x-forwarded-for'},
  config('192.0.2.1','invalid'),config('192.0.2.1','192.0.2.1'),
  config('192.0.2.1','::ffff:192.0.2.1'),config('2001:db8::1','2001:DB8::0001'),
  config(...Array.from({length:65},(_,i)=>'192.0.2.'+(i+1)))]){
  checked(policy,'192.0.2.1','IP_POLICY_INVALID');
 }
 checked(config(...Array.from({length:64},(_,i)=>'192.0.2.'+(i+1))),
  '192.0.2.64','IP_ADDRESS_MATCH',true);
});

test('results contain fixed diagnostics only and never imply trusted-source enforcement',()=>{
 for(const [policy,address] of [[config('192.0.2.1'),'192.0.2.1'],
  [config('2001:db8::1'),'2001:db8::2'],
  [config('192.0.2.1'),'synthetic-secret-in-a-client-header'],
  [config('synthetic-secret-in-settings'),'192.0.2.1']]){
  const output=JSON.stringify(match(policy,address));
  assert(!output.includes('192.0.2.')&&!output.includes('2001:db8')&&!output.includes('synthetic-secret'));
  const result=match(policy,address);
  assert.equal(result.source_verified,false);
  assert.equal(result.enforcement_ready,false);
  assert(!Object.hasOwn(result,'allowed'));
 }
});
