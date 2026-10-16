import {createClient as realClient} from 'npm:@supabase/supabase-js@2.112.3';
import {createCore,validateRequest} from './core.ts';
import {decrypt} from './operator-crypto.ts';
const TARGET='https://hvdoqcrnztqmbzgwrovd.supabase.co',APP='https://app.rainbow-driver.com';
const OWNER='yuka19910307@gmail.com',OWNER_ID='5ccbfcd5-bd0f-4a9a-b570-223b3deb2567';
const FIXED={pickup:'テスト集荷地・さいたま市',delivery:'テスト配送先・東京都内',cargo:'テスト用・精密機器の箱',pieces:2,weight:8.5,length:40,width:30,height:25,handling:'unknown',readiness:'ready',note:'管理者限定の架空案件です。',clientName:'テスト担当者'};
const headers={'Access-Control-Allow-Origin':APP,'Access-Control-Allow-Headers':'authorization,apikey,content-type','Access-Control-Allow-Methods':'POST,OPTIONS','Vary':'Origin','Cache-Control':'no-store','Content-Type':'application/json'};
const flags={mode:'OWNER_FIXED_E2E',environment:'CARGO_FREE_STAGING',public_intake_enabled:false,customer_request_created:false,payment_created:false};
const reply=(data,status=200)=>new Response(JSON.stringify({...data,...flags}),{status,headers});
async function off(db){const g=await db.from('cargo_intake_control').select('intake_enabled,captcha_required,contact_verification_required').eq('id',1).maybeSingle();return !g.error&&g.data?.intake_enabled===false&&g.data?.captcha_required===true&&g.data?.contact_verification_required===true}
Deno.serve(async req=>{
 if(req.headers.get('origin')!==APP)return reply({error:'ORIGIN_DENIED'},403);
 if(req.method==='OPTIONS')return new Response(null,{status:204,headers});
 if(req.method!=='POST')return reply({error:'METHOD_NOT_ALLOWED'},405);
 const token=(req.headers.get('authorization')||'').match(/^Bearer\s+(\S+)$/i)?.[1];
 if(!token)return reply({error:'LOGIN_REQUIRED'},401);
 if(Deno.env.get('SUPABASE_URL')!==TARGET||!Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'))return reply({error:'STAGING_ONLY'},503);
 try{
  const raw=await req.text();if(raw.length>6000)return reply({error:'INVALID_INPUT'},400);
  const b=JSON.parse(raw),keys={status:['action'],start:['action','attempt_id','email','request','captcha_token'],verify:['action','challenge_id','code'],list:['action'],start_review:['action','id']}[b?.action];
  if(!b||Array.isArray(b)||!keys||Object.keys(b).length!==keys.length||Object.keys(b).some(k=>!keys.includes(k)))return reply({error:'INVALID_INPUT'},400);
  const db=realClient(TARGET,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),{auth:{persistSession:false,autoRefreshToken:false}});
  const u=await db.auth.getUser(token);
  if(u.error||u.data?.user?.id!==OWNER_ID||u.data.user.email?.toLowerCase()!==OWNER)return reply({error:'OWNER_ONLY'},403);
  const member=await db.from('cargo_operator_accounts').select('user_id').eq('user_id',OWNER_ID).maybeSingle();
  if(member.error||!member.data)return reply({error:'OPERATOR_ONLY'},403);
  if(!await off(db))return reply({error:'INTAKE_MUST_BE_OFF'},423);
  const reserved=await db.from('cargo_staging_owner_e2e_sends').select('challenge_id').eq('operator_id',OWNER_ID).maybeSingle();
  if(reserved.error)return reply({error:'TEST_SCHEMA_NOT_READY'},503);
  if(b.action==='list'||b.action==='start_review'){
   if(!reserved.data)return reply({ok:true,item:null});
   if(b.action==='start_review'){
    if(typeof b.id!=='string')return reply({error:'INVALID_INPUT'},400);
    const changed=await db.from('cargo_staging_owner_e2e_requests').update({status:'operator_reviewing'}).eq('id',b.id).eq('source_draft_id',reserved.data.challenge_id).eq('status','pending_operator_review');
    if(changed.error)return reply({error:'REVIEW_UNAVAILABLE'},503);
   }
   const row=await db.from('cargo_staging_owner_e2e_requests').select('id,status,encrypted_payload').eq('source_draft_id',reserved.data.challenge_id).maybeSingle();
   if(row.error)return reply({error:'LIST_UNAVAILABLE'},503);
   if(!row.data)return reply({ok:true,item:null,email_sent:false});
   const rawKey=Uint8Array.from(atob(Deno.env.get('CARGO_CONTACT_AES_256_GCM_KEY')||''),c=>c.charCodeAt(0));
   const key=await crypto.subtle.importKey('raw',rawKey,'AES-GCM',false,['decrypt']);
   const details=await decrypt(key,row.data.encrypted_payload);
   const checked=validateRequest({...Object.fromEntries(Object.keys(FIXED).map(k=>[k,details[k]])),today:true,reviewConfirm:true});
   if(details.email!==OWNER||JSON.stringify(checked)!==JSON.stringify(FIXED))return reply({error:'TEST_PAYLOAD_MISMATCH'},503);
   return reply({ok:true,item:{id:row.data.id,status:row.data.status,details:checked},email_sent:false});
  }
  if(b.action==='start'){
   if(reserved.data)return reply({error:'TEST_MAIL_ALREADY_ATTEMPTED'},409);
   if(b.email!==OWNER)return reply({error:'FIXED_OWNER_ONLY'},400);
   let details;try{details=validateRequest(b.request)}catch{return reply({error:'FIXED_FIXTURE_REQUIRED'},400)}
   if(JSON.stringify(details)!==JSON.stringify(FIXED))return reply({error:'FIXED_FIXTURE_REQUIRED'},400);
  }
  if(b.action==='verify'&&(!reserved.data||b.challenge_id!==reserved.data.challenge_id))return reply({error:'TEST_CHALLENGE_REQUIRED'},403);
  // The unchanged intake core is isolated behind real owner authentication.
  // Its virtual gate applies only to these test tables/RPC; the real gate stays OFF.
  const scoped={from(table){
   if(table==='cargo_intake_control'){const q={select:()=>q,eq:()=>q,maybeSingle:async()=>({data:{intake_enabled:await off(db),captcha_required:true,contact_verification_required:true}})};return q}
   if(table==='cargo_customer_intake_drafts')return{async insert(row){
    if(!await off(db))return{error:{code:'INTAKE_MUST_BE_OFF'}};
    const reserve=await db.from('cargo_staging_owner_e2e_sends').insert({operator_id:OWNER_ID,challenge_id:row.id});
    if(reserve.error)return reserve;
    return db.from('cargo_staging_owner_e2e_drafts').insert(row);
   },delete:()=>db.from('cargo_staging_owner_e2e_drafts').delete()};
   throw Error('UNSCOPED_TABLE');
  },async rpc(name,args){
   if(name==='cargo_intake_rate_hit')return{data:{allowed:true}}; // permanent owner reservation is stricter
   if(name==='cargo_customer_intake_verify_commit')return db.rpc('cargo_staging_owner_e2e_verify',args);
   throw Error('UNSCOPED_RPC');
  }};
  const core=createCore(()=>scoped);
  const inner=await core(new Request(req.url,{method:'POST',headers:req.headers,body:JSON.stringify(b)}));
  const result=await inner.json();
  let resume=null;
  if(b.action==='status'&&reserved.data){const d=await db.from('cargo_staging_owner_e2e_drafts').select('id,expires_at,consumed_at').eq('id',reserved.data.challenge_id).maybeSingle();if(d.error)return reply({error:'RESUME_UNAVAILABLE'},503);if(d.data&&d.data.consumed_at===null&&Date.parse(d.data.expires_at)>Date.now())resume={id:d.data.id,expires_at:d.data.expires_at};}
  return reply({...result,resume_challenge:resume,mail_attempted:b.action==='start'||!!reserved.data,recipient:OWNER},inner.status);
 }catch{return reply({error:'TEST_UNAVAILABLE'},503)}
});
