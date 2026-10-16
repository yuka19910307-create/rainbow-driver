// Local, offline bookkeeping only. No transport, credentials, destination or DB.
// Guarantees require one trusted host and a private, durable local filesystem.
'use strict';
const fs=require('node:fs'),path=require('node:path');
const {CONFIG,initialState,prepare,claimAttempt,settleAttempt}=require('./prepare-cargo-monitor-notification.cjs');
const FILE='state.json',LOCK='.lock',NEXT='state.next',MAX_BYTES=65536;
const own=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)
 &&Object.keys(value).sort().join(',')===[...keys].sort().join(',');
const natural=value=>Number.isSafeInteger(value)&&value>=0;
const clone=value=>JSON.parse(JSON.stringify(value));
class StoreError extends Error {constructor(code,retainLock=false){super(code);this.code=code;this.retainLock=retainLock;}}
function fail(code,retainLock=false){throw new StoreError(code,retainLock);}
function blocked(code){return {configuration:CONFIG,dispatches:0,status:'blocked',issues:[code],revision:null,state:null};}
function result(status,envelope){return {configuration:CONFIG,dispatches:0,status,issues:[],
 revision:envelope.revision,state:clone(envelope.notification_state)};}
function privateOwner(stat){return stat.uid===process.geteuid()&&(stat.mode&0o077)===0;}
function sameNode(a,b){return a.dev===b.dev&&a.ino===b.ino;}
function noLinks(directory){
 if(typeof directory!=='string'||!path.isAbsolute(directory)||path.resolve(directory)!==directory
  ||directory===path.parse(directory).root)fail('INVALID_STORE_DIRECTORY');
 // Never follow an existing symlink in the configured path, including ancestors.
 const parts=directory.split(path.sep).filter(Boolean);let current=path.parse(directory).root;
 for(const part of parts){
  current=path.join(current,part);const stat=fs.lstatSync(current);
  if(!stat.isDirectory()||stat.isSymbolicLink())fail('STORE_DIRECTORY_UNSAFE');
  // A writable ancestor can replace a private child directory by name. Permit
  // only root/current-user ownership and no group/other writes, except root's
  // sticky temporary directories (which protect another user's child entry).
  if(![0,process.geteuid()].includes(stat.uid)
   ||((stat.mode&0o022)!==0&&!(stat.uid===0&&(stat.mode&0o1000)!==0)))fail('STORE_DIRECTORY_UNSAFE');
 }
}
function directoryStat(directory){
 noLinks(directory);const stat=fs.lstatSync(directory);
 if(!privateOwner(stat))fail('STORE_DIRECTORY_UNSAFE');
 return stat;
}
function syncDirectory(directory){
 const flags=fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW;
 const fd=fs.openSync(directory,flags);try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
}
// Reuse the existing strict kernel validator without copying its schema/code list.
// The probe's synthetic read-failure transition is discarded. Exhausted sequence
// boundaries are deliberately rejected rather than resetting valid-looking data.
function validNotificationState(state){
 try{
  const now=state?.last_observation===null?0:Date.parse(state?.last_observation?.checked_at);
  return prepare({state,read_succeeded:false,now}).status==='disabled';
 }catch{return false;}
}
function validEnvelope(value){
 return own(value,['schema_version','revision','notification_state'])&&value.schema_version===1
  &&natural(value.revision)&&validNotificationState(value.notification_state);
}
function readEnvelope(directory){
 const names=fs.readdirSync(directory);
 if(names.some(name=>![FILE,LOCK].includes(name)))fail('STORE_CONTENTS_UNEXPECTED');
 const target=path.join(directory,FILE);let before;
 try{before=fs.lstatSync(target);}catch(error){if(error.code==='ENOENT')fail('STORE_STATE_MISSING');throw error;}
 if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1||!privateOwner(before))fail('STORE_STATE_UNSAFE');
 if(before.size<1||before.size>MAX_BYTES)fail('STORE_STATE_INVALID');
 const fd=fs.openSync(target,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
 let data;
 try{
  const opened=fs.fstatSync(fd);
  if(!sameNode(before,opened)||!opened.isFile()||opened.nlink!==1||!privateOwner(opened))fail('STORE_STATE_UNSAFE');
  const buffer=Buffer.alloc(MAX_BYTES+1);let length=0,read;
  do{read=fs.readSync(fd,buffer,length,buffer.length-length,length);length+=read;}while(read&&length<buffer.length);
  if(length<1||length>MAX_BYTES)fail('STORE_STATE_INVALID');data=buffer.subarray(0,length).toString('utf8');
 }finally{fs.closeSync(fd);}
 let envelope;try{envelope=JSON.parse(data);}catch{fail('STORE_STATE_INVALID');}
 if(!validEnvelope(envelope))fail('STORE_STATE_INVALID');
 return {envelope,stat:before};
}
function writeEnvelope(directory,envelope,previousStat=null,verifyLock=()=>{}){
 if(!validEnvelope(envelope))fail('STORE_NEXT_STATE_INVALID');
 const text=JSON.stringify(envelope)+'\n';if(Buffer.byteLength(text)>MAX_BYTES)fail('STORE_NEXT_STATE_INVALID');
 const target=path.join(directory,FILE),temporary=path.join(directory,NEXT);let fd;
 try{
  // Any failure from this point is uncertain: retain the lock and all evidence.
  verifyLock();
  fd=fs.openSync(temporary,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
  fs.writeFileSync(fd,text,{encoding:'utf8'});fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;
  verifyLock();
  if(previousStat){
   const current=fs.lstatSync(target);
   if(!current.isFile()||current.isSymbolicLink()||current.nlink!==1||!privateOwner(current)
    ||!sameNode(current,previousStat))fail('STORE_WRITE_UNCERTAIN',true);
  }else if(fs.existsSync(target))fail('STORE_WRITE_UNCERTAIN',true);
  fs.renameSync(temporary,target);syncDirectory(directory);verifyLock();
 }catch{fail('STORE_WRITE_UNCERTAIN',true);}
 finally{if(fd!==undefined){try{fs.closeSync(fd);}catch{}}}
}
function transaction(directory,operation){
 let acquired=false,lockStat,retain=false;
 try{
  if(typeof fs.constants.O_NOFOLLOW!=='number'||typeof fs.constants.O_DIRECTORY!=='number'
   ||typeof process.geteuid!=='function')fail('UNSUPPORTED_FILESYSTEM_GUARD');
  directoryStat(directory);
  const lock=path.join(directory,LOCK);
  try{fs.mkdirSync(lock,{mode:0o700});}catch(error){if(error.code==='EEXIST')fail('STORE_LOCKED');throw error;}
  acquired=true;lockStat=fs.lstatSync(lock);
  const verifyLock=()=>{
   let current;try{current=fs.lstatSync(lock);}catch{fail('STORE_LOCK_CHANGED',true);}
   if(!sameNode(lockStat,current)||!current.isDirectory()||current.isSymbolicLink()||!privateOwner(current))
    fail('STORE_LOCK_CHANGED',true);
  };
  // A process crash must not make an already-started claim look never claimed.
  try{syncDirectory(directory);}catch{fail('STORE_LOCK_DURABILITY_UNCERTAIN',true);}
  const output=operation(verifyLock);verifyLock();return output;
 }catch(error){
  retain=error instanceof StoreError&&error.retainLock;
  return blocked(error instanceof StoreError?error.code:error.code==='ENOENT'?'STORE_MISSING':'STORE_IO_FAILURE');
 }finally{
  if(acquired&&!retain){
   try{
    const lock=path.join(directory,LOCK),current=fs.lstatSync(lock);
    if(!sameNode(lockStat,current)||!current.isDirectory()||current.isSymbolicLink()||!privateOwner(current))
     fail('STORE_LOCK_CHANGED',true);
    fs.rmdirSync(lock);syncDirectory(directory);
   }catch{
    // A result is not successful unless both state and lock release are durable.
    // Returning here overrides a pending success; no error detail/path is exposed.
    return blocked('STORE_LOCK_RELEASE_UNCERTAIN');
   }
  }
 }
}
function initializeStore(directory){
 try{
  if(typeof process.geteuid!=='function'||typeof directory!=='string'||!path.isAbsolute(directory)
   ||path.resolve(directory)!==directory||directory===path.parse(directory).root)fail('INVALID_STORE_DIRECTORY');
  noLinks(path.dirname(directory));
  // Explicit provisioning only. An existing directory is never treated as new,
  // even if its state is missing or empty after a crash/manual operation.
  try{fs.mkdirSync(directory,{mode:0o700});}catch(error){if(error.code==='EEXIST')fail('STORE_ALREADY_EXISTS');throw error;}
  syncDirectory(path.dirname(directory));
  return transaction(directory,verifyLock=>{
   if(fs.readdirSync(directory).some(name=>name!==LOCK))fail('STORE_CONTENTS_UNEXPECTED');
   const envelope={schema_version:1,revision:0,notification_state:initialState()};
   writeEnvelope(directory,envelope,null,verifyLock);return result('initialized',envelope);
  });
 }catch(error){return blocked(error instanceof StoreError?error.code:'STORE_INITIALIZATION_UNCERTAIN');}
}
function readStore(directory){return transaction(directory,()=>result('ready',readEnvelope(directory).envelope));}
function mutate(directory,options,keys,transform,status){
 if(!own(options,keys)||!natural(options.expected_revision))return blocked('INVALID_STORE_OPERATION');
 return transaction(directory,verifyLock=>{
  const {envelope,stat}=readEnvelope(directory);
  if(envelope.revision!==options.expected_revision)fail('STORE_REVISION_CONFLICT');
  if(envelope.revision===Number.MAX_SAFE_INTEGER)fail('STORE_REVISION_EXHAUSTED');
  const next=transform(clone(envelope.notification_state));
  if(!next||!validNotificationState(next))fail('STORE_TRANSITION_REJECTED');
  const updated={schema_version:1,revision:envelope.revision+1,notification_state:next};
  writeEnvelope(directory,updated,stat,verifyLock);return result(status,updated);
 });
}
function observeStore(directory,options={}){
 const keys=Object.keys(options||{});
 if(!options||typeof options!=='object'||Array.isArray(options)
  ||keys.some(key=>!['expected_revision','snapshot','read_succeeded','now'].includes(key)))return blocked('INVALID_STORE_OPERATION');
 return mutate(directory,options,keys,state=>{
  // No new observation may erase unresolved delivery evidence. No retry/reset API.
  if(['attempt_started','unknown','failed'].includes(state.delivery_status))fail('ATTEMPT_REVIEW_REQUIRED');
  const prepared=prepare({...options,state});
  if(prepared.status==='blocked')fail('STORE_OBSERVATION_REJECTED');
  return prepared.state;
 },'observed');
}
function claimStore(directory,options){return mutate(directory,options,['expected_revision','event_id'],state=>{
 if(!Number.isSafeInteger(options.event_id)||options.event_id<1)fail('INVALID_STORE_OPERATION');
 const next=claimAttempt(state,options.event_id);if(!next)fail('ATTEMPT_NOT_CLAIMABLE');return next;
},'claimed');}
function settleStore(directory,options){return mutate(directory,options,['expected_revision','event_id','outcome'],state=>{
 if(!Number.isSafeInteger(options.event_id)||options.event_id<1||!['confirmed','failed','unknown'].includes(options.outcome))
  fail('INVALID_STORE_OPERATION');
 const next=settleAttempt(state,options.event_id,options.outcome);if(!next)fail('ATTEMPT_NOT_SETTLEABLE');return next;
},'settled');}
module.exports={CONFIG,initializeStore,readStore,observeStore,claimStore,settleStore};
