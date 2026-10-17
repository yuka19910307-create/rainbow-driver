'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict'),{test}=require('node:test');
const {build,SQL_FILES}=require('../scripts/build-cargo-production-install.cjs');
const root=path.join(__dirname,'..');
test('builder combines reviewed SQL in order, one transaction and disabled mail',()=>{
 const sql=build(root);assert.equal((sql.match(/^begin;$/gm)||[]).length,1);assert.equal((sql.match(/^commit;$/gm)||[]).length,1);
 assert.equal(sql,fs.readFileSync(path.join(root,'integrations/cargo-customer-intake/production-initial-install.generated.review.sql'),'utf8'));
 let previous=-1;for(const file of SQL_FILES){const i=sql.indexOf('-- SOURCE '+file);assert(i>previous);previous=i;}
 assert(sql.includes('values(1,false,1,1,date_trunc'));assert(!sql.includes('values(1,10,50,date_trunc'));
 assert(sql.includes('CARGO_INSTALL_SCHEMA_ALREADY_PRESENT'));assert(sql.includes('CARGO_INSTALL_ROUTINE_ACCESS_UNSAFE'));
 assert(!/hvdoqcrnztqmbzgwrovd|sb_publishable_|cron\.schedule\(|cargo_staging_owner|5ccbfcd5/.test(sql));
});
test('changed or unreviewed SQL candidates are rejected before output',()=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'cargo-install-'));
 try{
  fs.mkdirSync(path.join(temp,'docs'));const manifest=JSON.parse(fs.readFileSync(path.join(root,'docs/cargo-production-candidate.review.json')));
  for(const file of SQL_FILES){fs.mkdirSync(path.dirname(path.join(temp,file)),{recursive:true});fs.copyFileSync(path.join(root,file),path.join(temp,file));}
  fs.writeFileSync(path.join(temp,'docs/cargo-production-candidate.review.json'),JSON.stringify(manifest));
  fs.appendFileSync(path.join(temp,SQL_FILES[0]),'\n-- unreviewed change');assert.throws(()=>build(temp),/Source changed/);
  manifest.files.push({kind:'database_review_only',path:'staging/unreviewed.sql'});fs.writeFileSync(path.join(temp,'docs/cargo-production-candidate.review.json'),JSON.stringify(manifest));assert.throws(()=>build(temp),/Unexpected SQL/);
 }finally{fs.rmSync(temp,{recursive:true,force:true});}
});
