'use strict';
/**
 * Static predeployment security checks. Does NOT call Supabase, Gmail, or any
 * production service. Run: node --test tests/cargo-draft-otp-security.test.cjs
 */
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
const sql=read('design/cargo-operator-draft-otp-binding.review.sql');
const edge=read('integrations/cargo-draft-otp-binding/index.ts');
const html=read('cargo-request-otp-integration-preview.html');

test('review SQL has an RLS-protected, private, uniquely bound table',()=>{
 assert.match(sql,/challenge_id\s+uuid\s+not\s+null\s+unique/i);
 assert.match(sql,/draft_id\s+uuid\s+primary\s+key/i);
 assert.match(sql,/enable\s+row\s+level\s+security/i);
 assert.match(sql,/revoke\s+all\s+on\s+table\s+public\.cargo_operator_draft_otp_bindings\s+from\s+public,\s*anon,\s*authenticated/i);
 assert.match(sql,/grant\s+select,insert,update,delete\s+on\s+table\s+public\.cargo_operator_draft_otp_bindings\s+to\s+service_role/i);
 assert.doesNotMatch(sql,/^\s*security\s+definer\b/im);
});
test('claim RPC is service-role only and uses row locks for one-time claim',()=>{
 assert.match(sql,/security\s+invoker/i);
 assert.match(sql,/for\s+update/i);
 assert.match(sql,/v_binding\.claimed_at\s+is\s+not\s+null/i);
 assert.match(sql,/set\s+claimed_at\s*=\s*v_now/i);
 assert.match(sql,/revoke\s+all\s+on\s+function\s+public\.cargo_operator_draft_otp_claim[\s\S]*?from\s+public,\s*anon,\s*authenticated/i);
 assert.match(sql,/grant\s+execute\s+on\s+function\s+public\.cargo_operator_draft_otp_claim[\s\S]*?to\s+service_role/i);
});
test('claim rejects expired, unverified, superseded and mismatched challenges',()=>{
 for(const pattern of [
  /INTAKE_MUST_BE_OFF/,/OPERATOR_ONLY/,/BINDING_MISMATCH/,
  /ALREADY_CLAIMED/,/EXPIRED/,/CHALLENGE_NOT_VERIFIED/,
  /OLDER_CODE_SUPERSEDED/,/v_challenge\.consumed_at\s+is\s+null/,
  /v_challenge\.consumed_at\s*<\s*v_binding\.created_at/,
  /v_now\s*>=\s*v_challenge\.expires_at/,
  /v_binding\.draft_fingerprint_hmac\s*<>\s*p_draft_fingerprint_hmac/
 ])assert.match(sql,pattern);
});
test('Edge function authenticates server-side and fails closed on intake state',()=>{
 for(const pattern of [
  /db\.auth\.getUser\(token\)/,
  /from\("cargo_operator_accounts"\)/,
  /from\("cargo_intake_control"\)/,
  /gate\.intake_enabled\s*!==\s*false/,
  /gate\.captcha_required\s*!==\s*true/,
  /gate\.contact_verification_required\s*!==\s*true/,
  /PUBLIC_INTAKE_MUST_BE_DISABLED/,
  /CARGO_INTAKE_HMAC_KEY/,
  /crypto\.subtle\.sign\("HMAC"/,
  /action==="bind"/,
  /action==="claim"/,
  /cargo_operator_draft_otp_claim/
 ])assert.match(edge,pattern);
 assert.doesNotMatch(edge,/\b(Deno\.env\.get\("SUPABASE_SERVICE_ROLE_KEY"\)).*console\./);
 assert.doesNotMatch(edge,/\.from\("cargo_dispatch_requests"\)/);
 assert.doesNotMatch(edge,/\.from\("cargo_contact_vault"\)/);
});
test('Gmail send is gated by two binding API readiness checks',()=>{
 assert.match(edge,/\["status","bind","claim"\]/);
 assert.match(edge,/input\.action==="status"/);
 assert.match(edge,/BINDING_NOT_READY/);
 assert.match(edge,/cargo_operator_draft_otp_claim/);
 assert.match(html,/cargo-draft-otp-binding",\{action:"status"\}/);
 const checks=(html.match(/cargo-draft-otp-binding",\{action:"status"\}/g)||[]).length;
 assert.equal(checks,2,'Readiness must be checked before enabling and again before sending');
 const send=html.indexOf('action:"send_test"');
 const secondCheck=html.lastIndexOf('cargo-draft-otp-binding",{action:"status"}',send);
 assert.ok(secondCheck>=0&&secondCheck<send,'Check binding API before Gmail send');
});
test('claim checks wall-clock expiry after acquiring both row locks',()=>{
 const lock=sql.indexOf('where draft_id=p_draft_id for update;');
 const challengeLock=sql.indexOf('where id=v_binding.challenge_id for update;');
 const clock=sql.indexOf('v_now := clock_timestamp();',challengeLock);
 const expiry=sql.indexOf('v_now >= v_challenge.expires_at',challengeLock);
 assert.ok(lock>0&&challengeLock>lock&&clock>challengeLock&&expiry>clock);
});
test('browser requires bind and claim before success, without live dispatch/payment',()=>{
 assert.match(html,/action:"bind"/);
 assert.match(html,/action:"claim"/);
 assert.match(html,/claimed\.data\?\.reason\s*!==\s*"CLAIMED"/);
 assert.match(html,/await\s+guard\(\)/);
 assert.match(html,/cargo_operator_accounts/);
 assert.doesNotMatch(html,/\.from\("cargo_dispatch_requests"\)/);
 assert.doesNotMatch(html,/payments\.create|squareup\.com\/v2\/payments/i);
});

test('fictional binding cleanup is bounded, expiry-only and service-role-only',()=>{
 assert.match(sql,/create\s+or\s+replace\s+function\s+public\.cargo_operator_draft_otp_cleanup/i);
 assert.match(sql,/p_limit\s+is\s+null\s+or\s+p_limit\s*<\s*1\s+or\s+p_limit\s*>\s*100/i);
 assert.match(sql,/where\s+delete_after\s*<\s*clock_timestamp\(\)/i);
 assert.match(sql,/for\s+update\s+skip\s+locked/i);
 assert.match(sql,/revoke\s+all\s+on\s+function\s+public\.cargo_operator_draft_otp_cleanup\(integer\)[\s\S]*?from\s+public,anon,authenticated/i);
 assert.match(sql,/grant\s+execute\s+on\s+function\s+public\.cargo_operator_draft_otp_cleanup\(integer\)[\s\S]*?to\s+service_role/i);
 assert.doesNotMatch(sql,/delete\s+from\s+public\.cargo_email_verification_challenges/i);
 assert.doesNotMatch(sql,/delete\s+from\s+public\.cargo_dispatch_requests/i);
});
