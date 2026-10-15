// Review candidate only. Reads files; never deploys, executes SQL or sends mail.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=path.resolve(process.argv[2]||path.join(__dirname,'..'));
const manifest=JSON.parse(fs.readFileSync(path.join(root,'docs/cargo-production-candidate.review.json'),'utf8'));
const fail=m=>{throw Error(m)};
const included=new Set(manifest.files.map(x=>x.path));
if(manifest.public_intake_enabled!==false||!manifest.blocked_until.length)fail('Launch gates must remain explicit');
for(const f of manifest.files){
 if(path.isAbsolute(f.path)||f.path.split('/').includes('..')||f.path.startsWith('staging/')||/owner-e2e|staging-bootstrap/.test(f.path))fail('Excluded path: '+f.path);
 const raw=fs.readFileSync(path.join(root,f.path));
 const digest=crypto.createHash('sha1').update('blob '+raw.length+'\0').update(raw).digest('hex');
 if(digest!==f.git_blob_sha)fail('Source changed; review and regenerate manifest: '+f.path);
 if(f.kind==='site'){
  const text=raw.toString('utf8');
  if(/hvdoqcrnztqmbzgwrovd|rd-cargo-staging|cargo-staging-owner/.test(text))fail('Staging reference in site: '+f.path);
  for(const match of text.matchAll(/(?:src|href)=["']([^"']+)/g)){
   const ref=match[1];
   if(/^(https?:|mailto:|#)/.test(ref))continue;
   const target=path.posix.normalize(path.posix.join(path.posix.dirname(f.path),ref.split(/[?#]/)[0]));
   if(!included.has(target)&&!manifest.existing_site_dependencies.includes(target))fail('Unreviewed local dependency: '+target);
  }
 }
}
console.log('PASS: '+manifest.files.length+' pinned candidate files; local links and staging isolation checked.');
console.log('REVIEW ONLY: production notice, operations, E2E and explicit rollout/launch decisions remain required.');
