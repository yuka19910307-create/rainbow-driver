// CI-only disposable PostgreSQL. No network clients, Supabase project or secrets.
'use strict';
const fs=require('node:fs'),{spawnSync}=require('node:child_process'),assert=require('node:assert/strict');
const {assess}=require('../scripts/check-cargo-retention-preview.cjs');
const preview=fs.readFileSync('integrations/cargo-production-maintenance/retention-preview.readonly.sql','utf8');
const cleanupDraft=fs.readFileSync('integrations/cargo-customer-intake/schema.review.sql','utf8').match(/create or replace function public\.cargo_customer_intake_cleanup[\s\S]+?\n\$\$;/)[0];
const cleanupClosed=fs.readFileSync('integrations/cargo-customer-intake/closed-no-order-retention.review.sql','utf8').match(/create or replace function public\.cargo_customer_closed_cleanup[\s\S]+?\n\$body\$;/)[0];
const container='cargo-safety-ci-postgres',database='cargo_retention_preview_ci_'+process.pid;
function psql(input,db=database){
 const r=spawnSync('docker',['exec','-i',container,'psql','-X','-qAt','-U','postgres','-d',db,'-v','ON_ERROR_STOP=1'],{input,encoding:'utf8'});
 assert.ifError(r.error);assert.equal(r.status,0,'Disposable retention preview SQL failed: '+r.stderr);return r.stdout.trim();
}
const setup=`
create table public.cargo_customer_intake_drafts(id uuid primary key,delete_after timestamptz,consumed_at timestamptz,encrypted_payload text);
create table public.cargo_customer_intake_requests(id uuid primary key,source_draft_id uuid unique,status text,closed_no_order_at timestamptz,delete_after timestamptz,retention_hold boolean);
create table public.cargo_customer_quote_replies(request_id uuid unique,delivery_status text);
create table public.cargo_customer_quote_followups(request_id uuid unique,stage text);
create table public.cargo_customer_quote_followup_events(request_id uuid);
create table public.cargo_customer_retention_runs(ran_at timestamptz default now(),requests_deleted integer,quotes_deleted integer,followups_deleted integer,events_deleted integer,drafts_deleted integer);
create schema cron;
create table cron.job(jobid bigint,jobname text,command text,database text,active boolean);
create table cron.job_run_details(jobid bigint,status text,end_time timestamptz,return_message text);
${cleanupDraft}
${cleanupClosed}
`;
const request=(i,override='')=>`insert into public.cargo_customer_intake_requests values(md5('${i}')::uuid,md5('source-${i}')::uuid,'closed',now()-interval '31 days',now()-interval '1 day',false);${override}`;
const rich=request(1)+`
insert into public.cargo_customer_quote_replies values(md5('1')::uuid,'sent');
insert into public.cargo_customer_quote_followups values(md5('1')::uuid,'closed_no_order');
insert into public.cargo_customer_quote_followup_events values(md5('1')::uuid),(md5('1')::uuid);
insert into public.cargo_customer_intake_drafts values(md5('source-1')::uuid,now()+interval '1 day',now(),'synthetic-private-payload');
`;
// Ninety-nine older rows precede two tied rows at the cutoff. Insert the higher
// UUID first and vary dependents so a different selection changes their counts.
const orderedBoundary=`
insert into public.cargo_customer_intake_requests
 select md5('ordered-old-'||n)::uuid,md5('ordered-source-'||n)::uuid,
 'closed',now()-interval '32 days',now()-interval '1 day',false
 from generate_series(1,99) n;
insert into public.cargo_customer_intake_requests values
 ('00000000-0000-4000-8000-000000000101','00000000-0000-4000-8001-000000000101','closed',now()-interval '31 days',now()-interval '1 day',false),
 ('00000000-0000-4000-8000-000000000100','00000000-0000-4000-8001-000000000100','closed',now()-interval '31 days',now()-interval '1 day',false);
insert into public.cargo_customer_quote_replies values('00000000-0000-4000-8000-000000000100','sent');
insert into public.cargo_customer_quote_followups values('00000000-0000-4000-8000-000000000100','closed_no_order');
insert into public.cargo_customer_quote_followup_events values
 ('00000000-0000-4000-8000-000000000100'),('00000000-0000-4000-8000-000000000100'),
 ('00000000-0000-4000-8000-000000000101'),('00000000-0000-4000-8000-000000000101'),('00000000-0000-4000-8000-000000000101');
insert into public.cargo_customer_intake_drafts values
 ('00000000-0000-4000-8001-000000000100',now()+interval '1 day',now(),'synthetic-private-payload'),
 ('00000000-0000-4000-8001-000000000101',now()+interval '1 day',null,'synthetic-private-payload');
`;
psql('create database '+database+';','postgres');
try{
 psql(setup);
 const readOnly=JSON.parse(psql('begin read only;\n'+preview+'\ncommit;'));
 assert.equal(readOnly.closed.eligible,0);
 console.log('PASS retention preview SQL: succeeds in READ ONLY transaction');
 for(const [name,mutation,expected,expectedBatch] of [
  ['empty','',0],
  ['expired drafts only',`insert into public.cargo_customer_intake_drafts values
   (md5('draft-1')::uuid,now()-interval '1 hour',null,'synthetic-private-payload'),
   (md5('draft-2')::uuid,now()-interval '1 hour',now(),null),
   (md5('draft-3')::uuid,now()+interval '1 hour',null,'synthetic-private-payload');`,0],
  ['linked quote followup events and consumed source',rich,1],
  ['unconsumed source is preserved',request(1)+`insert into public.cargo_customer_intake_drafts values(md5('source-1')::uuid,now()+interval '1 day',null,'synthetic-private-payload');`,1],
  ['hold protects old closed consultation',request(1,"update public.cargo_customer_intake_requests set retention_hold=true;"),0],
  ['thirty day deadline not reached',request(1,"update public.cargo_customer_intake_requests set closed_no_order_at=now()-interval '29 days';"),0],
  ['delete deadline not reached',request(1,"update public.cargo_customer_intake_requests set delete_after=now()+interval '1 day';"),0],
  ['ongoing consultation is preserved',request(1,"update public.cargo_customer_intake_requests set status='operator_reviewing',closed_no_order_at=null;"),0],
  ['ongoing followup is preserved',request(1)+"insert into public.cargo_customer_quote_followups values(md5('1')::uuid,'handled_offline');",0],
  ['sending quote is preserved',request(1)+"insert into public.cargo_customer_quote_replies values(md5('1')::uuid,'sending');",0],
  ['unknown delivery is preserved',request(1)+"insert into public.cargo_customer_quote_replies values(md5('1')::uuid,'delivery_unknown');",0],
  ['batch is bounded at one hundred',Array.from({length:101},(_,i)=>request(i+1)).join('\n')+`insert into public.cargo_customer_intake_drafts select md5('draft-'||n)::uuid,now()-interval '1 hour',null,'synthetic-private-payload' from generate_series(1,101) n;`,100],
  ['batch boundary follows closure time then UUID',orderedBoundary,100,
   {requests:100,quotes:1,followups:1,events:2,consumed_source_drafts:1}]
 ]){
  const output=psql('begin;\n'+mutation+'\n'+preview+'\nselect public.cargo_customer_intake_cleanup(100);\nrollback;');
  assert(!output.includes('synthetic-private-payload'));
  const [snapshotLine,draftDeleted]=output.split('\n'),snapshot=JSON.parse(snapshotLine);
  assert.deepEqual(assess(snapshot),{ok:true,review_only:true,execution_enabled:false,issues:[]});
  assert.equal(snapshot.closed.batch.requests,expected,name);
  if(expectedBatch)assert.deepEqual(snapshot.closed.batch,expectedBatch,name+': selected dependent counts');
  assert.equal(snapshot.drafts.batch,Number(draftDeleted),name+': existing draft cleanup agrees');
  // Separate rollback: first cleanup cannot change the second comparison.
  const closedOutput=psql('begin;\n'+mutation+'\n'+preview+'\nselect public.cargo_customer_closed_cleanup(100);\nrollback;').split('\n');
  const snapshot2=JSON.parse(closedOutput[0]),deleted=JSON.parse(closedOutput[1]);
  for(const [previewKey,cleanupKey] of Object.entries({requests:'requests_deleted',quotes:'quotes_deleted',followups:'followups_deleted',events:'events_deleted',consumed_source_drafts:'drafts_deleted'}))assert.equal(snapshot2.closed.batch[previewKey],deleted[cleanupKey],name+': '+previewKey);
  console.log('PASS retention preview SQL: '+name+' (existing cleanup compared, rolled back)');
 }
 const collision=JSON.parse(psql(`begin;
 insert into cron.job values
 (1,'cargo-production-expired-intake-drafts','select 1;',current_database(),false),
 (2,'different-name','select public.cargo_customer_closed_cleanup(100);','other_database',true),
 (3,'unrelated-existing-work','select 1;',current_database(),true);
 insert into cron.job_run_details values(2,'failed',now(),'synthetic-private-error'),(3,'failed',now(),'unrelated-private-error');
 ${preview}
 rollback;`));
 assert.deepEqual(collision.existing_cleanup_jobs,{related:2,active:1,other_database:1});
 assert.equal(collision.history.related_cron_runs,1);
 assert(!JSON.stringify(collision).includes('private-error'));
 assert(assess(collision).issues.includes('EXISTING_CLEANUP_JOB_REVIEW_REQUIRED'));
 console.log('PASS retention preview SQL: inactive named job / differently named cleanup / unrelated history separation');
}finally{psql('drop database '+database+';','postgres');}
