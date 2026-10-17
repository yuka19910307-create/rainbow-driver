// Generates a REVIEW-ONLY first-install SQL file. No DB/network/deploy execution.
'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const SQL_FILES=['schema.review.sql','quotes.review.sql','mail-budget.review.sql','followup.review.sql','closed-no-order-retention.review.sql'].map(x=>'integrations/cargo-customer-intake/'+x);
const TABLES=['cargo_customer_intake_drafts','cargo_customer_intake_requests','cargo_customer_quote_replies','cargo_customer_mail_budget','cargo_customer_quote_followups','cargo_customer_quote_followup_events','cargo_customer_retention_runs'];
const NAMES=TABLES.map(x=>"'"+x+"'").join(',');
function build(root){
 const manifest=JSON.parse(fs.readFileSync(path.join(root,'docs/cargo-production-candidate.review.json'),'utf8'));
 if(manifest.public_intake_enabled!==false)throw Error('Intake must remain OFF');
 const selected=manifest.files.filter(x=>x.kind==='database_review_only');
 if(selected.length!==SQL_FILES.length||selected.some(x=>!SQL_FILES.includes(x.path)))throw Error('Unexpected SQL candidate set');
 const bodies=SQL_FILES.map(file=>{
  const entry=selected.find(x=>x.path===file),raw=fs.readFileSync(path.join(root,file));
  const hash=crypto.createHash('sha1').update('blob '+raw.length+'\0').update(raw).digest('hex');
  if(!entry||entry.git_blob_sha!==hash)throw Error('Source changed; review required: '+file);
  let text=raw.toString('utf8').replace(/^(?:[ \t]*--[^\n]*\n|[ \t]*\n)*/, '');
  const transactions=text.match(/^[ \t]*(?:begin|commit|rollback);[ \t]*$/gm)||[];
  if(transactions.length!==2||transactions[0].trim()!=='begin;'||transactions[1].trim()!=='commit;')throw Error('Unsupported transaction wrapper: '+file);
  text=text.replace(/^[ \t]*begin;[ \t]*$/m,'').replace(/^[ \t]*commit;[ \t]*$/m,'');
  if(file.endsWith('/mail-budget.review.sql')){
   const before=" (id,hourly_limit,daily_limit,hour_started_at,day_started_at)\n values(1,10,50,date_trunc('hour',clock_timestamp()),";
   const after=" (id,enabled,hourly_limit,daily_limit,hour_started_at,day_started_at)\n values(1,false,1,1,date_trunc('hour',clock_timestamp()),";
   if(text.split(before).length!==2)throw Error('Mail budget initializer changed');
   text=text.replace(before,after);
  }
  return '-- SOURCE '+file+' blob '+hash+'\n'+text.trim()+'\n';
 });
 return `-- REVIEW ONLY. First customer-schema install; NOT authorization to execute.
-- Expected target: kvoaorzdewwirqryeizq. Verify the actual connection separately.
-- Existing core data stays in place. No users, test rows, secrets, cron or mail.
-- Mail budget initializes DISABLED at 1/1 placeholders; review before enabling.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
lock table public.cargo_intake_control in share row exclusive mode;
do $preflight$
declare n text;
begin
 if not exists(select 1 from public.cargo_intake_control where id=1
  and intake_enabled=false and captcha_required=true and contact_verification_required=true) then
  raise exception 'CARGO_INSTALL_REQUIRES_PROTECTED_OFF';
 end if;
 if to_regclass('auth.users') is null or to_regclass('public.cargo_operator_accounts') is null then
  raise exception 'CARGO_INSTALL_CORE_DEPENDENCY_MISSING';
 end if;
 if not exists(select 1 from public.cargo_operator_accounts) then raise exception 'CARGO_INSTALL_OPERATOR_MISSING'; end if;
 if not has_table_privilege('service_role','public.cargo_intake_control','SELECT')
  or not has_table_privilege('service_role','public.cargo_intake_control','UPDATE')
  or not has_table_privilege('service_role','public.cargo_operator_accounts','SELECT') then
  raise exception 'CARGO_INSTALL_CORE_ROLE_REVIEW_REQUIRED';
 end if;
 foreach n in array array[${NAMES}] loop
  if to_regclass('public.'||n) is not null then raise exception 'CARGO_INSTALL_SCHEMA_ALREADY_PRESENT'; end if;
 end loop;
 if exists(select 1 from pg_proc where pronamespace='public'::regnamespace and proname like 'cargo_customer_%') then
  raise exception 'CARGO_INSTALL_ROUTINE_ALREADY_PRESENT';
 end if;
end;
$preflight$;

${bodies.join('\n')}
do $postflight$
declare n text;
begin
 if not exists(select 1 from public.cargo_intake_control where id=1
  and intake_enabled=false and captcha_required=true and contact_verification_required=true) then
  raise exception 'CARGO_INSTALL_CONTROL_CHANGED';
 end if;
 foreach n in array array[${NAMES}] loop
  if not (select relrowsecurity from pg_class where oid=to_regclass('public.'||n))
   or has_table_privilege('anon','public.'||n,'SELECT,INSERT,UPDATE,DELETE')
   or has_table_privilege('authenticated','public.'||n,'SELECT,INSERT,UPDATE,DELETE') then
   raise exception 'CARGO_INSTALL_TABLE_ACCESS_UNSAFE';
  end if;
 end loop;
 if exists(select 1 from pg_proc where pronamespace='public'::regnamespace and proname like 'cargo_customer_%'
   and (prosecdef or has_function_privilege('anon',oid,'EXECUTE') or has_function_privilege('authenticated',oid,'EXECUTE'))) then
  raise exception 'CARGO_INSTALL_ROUTINE_ACCESS_UNSAFE';
 end if;
 if not exists(select 1 from public.cargo_customer_mail_budget where id=1 and enabled=false
  and hourly_limit=1 and daily_limit=1 and hour_attempts=0 and day_attempts=0) then
  raise exception 'CARGO_INSTALL_MAIL_MUST_REMAIN_DISABLED';
 end if;
end;
$postflight$;
commit;
`;
}
if(require.main===module){
 if(process.argv.length!==4)throw Error('Usage: node scripts/build-cargo-production-install.cjs <repo-root> <new-output.sql>');
 const sql=build(path.resolve(process.argv[2]));
 fs.writeFileSync(path.resolve(process.argv[3]),sql,{flag:'wx'});
 console.log('REVIEW ONLY: SQL generated; no database connection or deployment was made.');
}
module.exports={build,SQL_FILES,TABLES};
