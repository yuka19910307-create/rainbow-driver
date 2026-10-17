// Creates a REVIEW-ONLY bundle. No network, SQL execution, deployment or gate changes.
const fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process');
const root=path.resolve(process.argv[2]||path.join(__dirname,'..'));
if(!process.argv[3])throw Error('Usage: node scripts/package-cargo-candidate.cjs <repo-root> <new-output-directory>');
const output=path.resolve(process.argv[3]);
if(fs.existsSync(output))throw Error('Output already exists; choose a new directory. Nothing overwritten.');
execFileSync(process.execPath,[path.join(root,'scripts/check-cargo-production-candidate.cjs'),root],{stdio:'inherit'});
const manifest=JSON.parse(fs.readFileSync(path.join(root,'docs/cargo-production-candidate.review.json'),'utf8'));
const folders={site:'site',edge_function:'functions-review-only',database_review_only:'sql-review-only'};
for(const file of manifest.files)if(!folders[file.kind])throw Error('Unknown kind: '+file.kind);
fs.mkdirSync(output,{recursive:true});
for(const file of manifest.files){
 const dest=path.join(output,folders[file.kind],file.path);
 fs.mkdirSync(path.dirname(dest),{recursive:true});
 fs.copyFileSync(path.join(root,file.path),dest);
}
fs.copyFileSync(path.join(root,'docs/cargo-production-candidate.review.json'),path.join(output,'manifest.review.json'));
fs.writeFileSync(path.join(output,'README.txt'),[
 'REVIEW ONLY — NOT A COMPLETE WEBSITE OR AN APPROVED DEPLOYMENT.',
 'site/ contains only the four candidate additions. Do not replace the existing site with this directory.',
 'Existing dependencies must remain: '+manifest.existing_site_dependencies.join(', '),
 'functions-review-only/ and sql-review-only/ must never be uploaded to the public web root.',
 'SQL files are review sources, not approved production migrations. No SQL is executed by this script.',
 'No secrets are included. General intake must stay OFF.',
 'Launch blockers: '+manifest.blocked_until.join('; '),
 'Baseline main: '+manifest.main_baseline,
 'Source commit: '+manifest.source_commit
].join('\n')+'\n');
console.log('Prepared '+manifest.files.length+' scoped review files in '+output);
