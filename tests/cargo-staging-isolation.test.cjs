'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const root=path.resolve(__dirname,'..');
const read=(file)=>fs.readFileSync(path.join(root,file),'utf8');
const STAGING='https://hvdoqcrnztqmbzgwrovd.supabase.co';
const PRODUCTION='https://kvoaorzdewwirqryeizq.supabase.co';

test('staging customer intake page is isolated from production and has a working relative rules path',()=>{
 const html=read('staging/cargo-customer-intake.html');
 assert.match(html,/検証環境/);
 assert.ok(html.includes(STAGING));
 assert.ok(!html.includes(PRODUCTION));
 assert.match(html,/src="\.\.\/cargo-pwa\/request-review-rules\.js"/);
 assert.ok(fs.existsSync(path.join(root,'cargo-pwa/request-review-rules.js')));
 assert.match(html,/functions\.invoke\("cargo-customer-intake"/);
 assert.match(html,/public_intake_enabled!==true/);
 assert.match(html,/payment_enabled!==false/);
});
test('staging operator preview uses the staging auth namespace and protected API only',()=>{
 const html=read('staging/cargo-customer-review.html');
 assert.ok(html.includes(STAGING));
 assert.ok(!html.includes(PRODUCTION));
 assert.match(html,/rd-cargo-staging-operator-auth-v1/);
 assert.doesNotMatch(html,/rd-cargo-operator-auth-v1/);
 assert.match(html,/functions\.invoke\("cargo-customer-review-operator"/);
 assert.doesNotMatch(html,/db\.from\("cargo_operator_accounts"\)/);
});
test('public customer endpoints fail closed while intake switch is off',()=>{
 const intake=read('integrations/cargo-customer-intake/index.ts');
 const reply=read('integrations/cargo-customer-intake/quote-reply.ts');
 assert.match(intake,/if\(!enabled\)return reply\(\{error:"PUBLIC_INTAKE_DISABLED"\},423\)/);
 assert.match(intake,/captchaOK\(captcha,conf\.captchaSecret\)/);
 assert.match(intake,/if\(!conf\.configured\)/);
 assert.match(reply,/PUBLIC_INTAKE_DISABLED/);
 assert.match(reply,/cargo_customer_quote_reply/);
});
test('operator endpoint checks identity and membership on the server',()=>{
 const src=read('integrations/cargo-customer-intake/operator.ts');
 assert.match(src,/auth\.getUser\(bearer\)/);
 assert.match(src,/cargo_operator_accounts/);
 assert.match(src,/LOGIN_REQUIRED/);
});

test('staging operator login uses isolated auth storage and server-side authorization',()=>{
 const login=read('staging/cargo-operator-login.html');
 const review=read('staging/cargo-customer-review.html');
 assert.ok(login.includes(STAGING));
 assert.ok(!login.includes(PRODUCTION));
 assert.match(login,/rd-cargo-staging-operator-auth-v1/);
 assert.match(login,/auth\.signInWithPassword/);
 assert.match(login,/functions\.invoke\("cargo-customer-review-operator"/);
 assert.doesNotMatch(login,/db\.from\("cargo_operator_accounts"\)/);
 assert.match(review,/href="\.\/cargo-operator-login\.html"/);
 assert.ok(fs.existsSync(path.join(root,'staging/cargo-operator-login.html')));
});

test('staging quote reply stays on the staging API and strips its secret fragment',()=>{
 const html=read('staging/cargo-customer-quote-reply.html');
 assert.match(html,/検証環境/);
 assert.ok(html.includes(STAGING));assert.ok(!html.includes(PRODUCTION));
 assert.ok(html.includes('sb_publishable_A-f3WQb7Oh8uMqO4BJPPtg_l4c_JCfQ'));
 assert.ok(!html.includes('sb_publishable_RG3jeU'));
 assert.ok(html.includes('history.replaceState(null,"",location.pathname)'));
 assert.ok(html.includes('SUPABASE+"/functions/v1/cargo-customer-quote-reply"'));
 assert.ok(html.includes('href="./cargo-customer-intake.html"'));
});
