// Tests installation only in a NEW database inside the disposable CI container.
'use strict';
const fs=require('node:fs'),assert=require('node:assert/strict'),{spawnSync}=require('node:child_process');
const {build,TABLES}=require('../scripts/build-cargo-production-install.cjs');
const sql=build(process.cwd()),fixture=fs.readFileSync('tests/cargo-otp-pg-fixtures.sql','utf8');
function psql(database,input){return spawnSync('docker',['exec','-i','cargo-otp-ci-postgres','psql','-X','-qAt','-U','postgres','-d',database,'-v','ON_ERROR_STOP=1'],{input,encoding:'utf8'});}
function checked(database,input){const r=psql(database,input);assert.equal(r.status,0,r.stderr);return r.stdout.trim();}
let number=0;
function scenario(name,setup,mutateSql,expected){
 const database='cargo_install_ci_'+(++number);
 checked('postgres','create database '+database+';');
 try{
  checked(database,fixture);if(setup)checked(database,setup);
  const r=psql(database,mutateSql?mutateSql(sql):sql);
  if(expected){assert.notEqual(r.status,0,name);assert(r.stderr.includes(expected),name+': '+r.stderr);}
  else assert.equal(r.status,0,name+': '+r.stderr);
  const inventory=JSON.parse(checked(database,`select jsonb_build_object(
   'tables',(select count(*) from pg_class where relnamespace='public'::regnamespace and relname in (${TABLES.map(n=>"'"+n+"'").join(',')})),
   'intake_enabled',(select intake_enabled from public.cargo_intake_control where id=1),
   'operators',(select count(*) from public.cargo_operator_accounts));`));
  assert.equal(inventory.operators,2,'existing operator records preserved');
  if(!expected){
   assert.equal(inventory.tables,7);assert.equal(inventory.intake_enabled,false);
   const budget=JSON.parse(checked(database,"select jsonb_build_object('enabled',enabled,'hourly',hourly_limit,'daily',daily_limit,'attempts',hour_attempts+day_attempts) from public.cargo_customer_mail_budget where id=1;"));
   assert.deepEqual(budget,{enabled:false,hourly:1,daily:1,attempts:0});
   const again=psql(database,sql);assert.notEqual(again.status,0);assert(again.stderr.includes('CARGO_INSTALL_SCHEMA_ALREADY_PRESENT'));
  }else if(name==='existing customer table'){
   assert.equal(inventory.tables,1);assert.equal(checked(database,"select data_type from information_schema.columns where table_schema='public' and table_name='cargo_customer_intake_drafts' and column_name='id';"),'integer');
  }else assert.equal(inventory.tables,0,'failure must leave no partial customer schema');
  assert.equal(inventory.intake_enabled,name==='intake ON','existing control preserved');
  console.log('PASS atomic production install fixture: '+name);
 }finally{checked('postgres','drop database '+database+';');}
}
scenario('protected OFF','',null,null);
scenario('intake ON','update public.cargo_intake_control set intake_enabled=true;',null,'CARGO_INSTALL_REQUIRES_PROTECTED_OFF');
scenario('protection disabled','update public.cargo_intake_control set captcha_required=false;',null,'CARGO_INSTALL_REQUIRES_PROTECTED_OFF');
scenario('existing customer table','create table public.cargo_customer_intake_drafts(id integer);',null,'CARGO_INSTALL_SCHEMA_ALREADY_PRESENT');
scenario('existing customer routine','create function public.cargo_customer_existing() returns integer language sql as $$ select 1 $$;',null,'CARGO_INSTALL_ROUTINE_ALREADY_PRESENT');
scenario('mid-install failure','',s=>s.replace('\ncommit;\n','\nselect 1/0;\ncommit;\n'),'division by zero');
