import {createClient} from 'npm:@supabase/supabase-js@2.112.3';
const TARGET='https://hvdoqcrnztqmbzgwrovd.supabase.co',APP='https://app.rainbow-driver.com';
const OWNER='yuka19910307@gmail.com',OWNER_ID='5ccbfcd5-bd0f-4a9a-b570-223b3deb2567';
const headers={'Access-Control-Allow-Origin':APP,'Access-Control-Allow-Headers':'authorization,apikey,content-type','Access-Control-Allow-Methods':'POST,OPTIONS','Vary':'Origin','Cache-Control':'no-store','Content-Type':'application/json'};
const reply=(body,status=200)=>new Response(JSON.stringify(body),{status,headers});
const flags={environment:'CARGO_FREE_STAGING',public_intake_enabled:false,customer_request_created:false,payment_created:false};
async function off(db){const g=await db.from('cargo_intake_control').select('intake_enabled,captcha_required,contact_verification_required').eq('id',1).maybeSingle();return !g.error&&g.data?.intake_enabled===false&&g.data?.captcha_required===true&&g.data?.contact_verification_required===true}
async function external(url,options){return await fetch(url,{...options,redirect:'error',signal:AbortSignal.timeout(15000)})}
Deno.serve(async req=>{
 if(req.headers.get('origin')!==APP)return reply({error:'ORIGIN_DENIED'},403);
 if(req.method==='OPTIONS')return new Response(null,{status:204,headers});
 if(req.method!=='POST')return reply({error:'METHOD_NOT_ALLOWED'},405);
 const token=(req.headers.get('authorization')||'').match(/^Bearer\s+(\S+)$/i)?.[1];
 if(!token)return reply({error:'LOGIN_REQUIRED'},401);
 const url=Deno.env.get('SUPABASE_URL'),key=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
 if(url!==TARGET||!key)return reply({error:'STAGING_ONLY'},503);
 try{
  const raw=await req.text();if(raw.length>3000)return reply({error:'INVALID_INPUT'},400);
  const b=JSON.parse(raw),allowed=b?.action==='status'?['action']:b?.action==='captcha_verify'?['action','captcha_token']:b?.action==='send_test'?['action','captcha_token','confirmation']:[];
  if(!b||Array.isArray(b)||!allowed.length||Object.keys(b).length!==allowed.length||Object.keys(b).some(k=>!allowed.includes(k)))return reply({error:'INVALID_INPUT'},400);
  const db=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}});
  const u=await db.auth.getUser(token);
  if(u.error||u.data?.user?.id!==OWNER_ID||u.data.user.email?.toLowerCase()!==OWNER)return reply({error:'OWNER_ONLY'},403);
  const m=await db.from('cargo_operator_accounts').select('user_id').eq('user_id',OWNER_ID).maybeSingle();
  if(m.error||!m.data)return reply({error:'OPERATOR_ONLY'},403);
  if(!await off(db))return reply({error:'INTAKE_MUST_BE_OFF'},423);
  const site=Deno.env.get('CARGO_CUSTOMER_TURNSTILE_SITE_KEY')||'',secret=Deno.env.get('CARGO_CUSTOMER_TURNSTILE_SECRET')||'';
  const day=new Date().toISOString().slice(0,10);
  const prior=await db.from('cargo_staging_external_mail_checks').select('state').eq('operator_id',OWNER_ID).eq('test_day',day).maybeSingle();
  if(prior.error)return reply({error:'PROBE_SCHEMA_NOT_READY'},503);
  if(b.action==='status')return reply({ok:true,...flags,site_key:site,recipient:OWNER,mail_attempted_today:!!prior.data,mail_state:prior.data?.state||null,email_sent:false});
  if(!site||!secret)return reply({error:'CAPTCHA_NOT_CONFIGURED'},503);
  if(typeof b.captcha_token!=='string'||!b.captcha_token||b.captcha_token.length>2048)return reply({error:'CAPTCHA_REQUIRED'},400);
  if(b.action==='send_test'&&b.confirmation!=='SEND_ONE_OWNER_TEST_EMAIL')return reply({error:'CONFIRMATION_REQUIRED'},400);
  if(b.action==='send_test'&&prior.data)return reply({error:'MAIL_ALREADY_ATTEMPTED'},409);
  const c=await external('https://challenges.cloudflare.com/turnstile/v0/siteverify',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({secret,response:b.captcha_token})});
  const v=await c.json().catch(()=>({}));
  if(!c.ok||v.success!==true||v.hostname!=='app.rainbow-driver.com'||v.action!=='cargo_customer_intake')return reply({error:'CAPTCHA_VERIFICATION_FAILED'},400);
  if(b.action==='captcha_verify')return reply({ok:true,...flags,captcha_verified:true,email_sent:false});
  const api=Deno.env.get('CARGO_CUSTOMER_RESEND_API_KEY'),from=Deno.env.get('CARGO_CUSTOMER_FROM_EMAIL');
  if(Deno.env.get('CARGO_CUSTOMER_EMAIL_PROVIDER')!=='resend'||!api||from!=='cargo@mail.rainbow-driver.com')return reply({error:'MAIL_NOT_CONFIGURED'},503);
  // Unique reservation prevents concurrent sends, refresh/retry, and ambiguous-response repeats.
  const reserve=await db.from('cargo_staging_external_mail_checks').insert({operator_id:OWNER_ID,test_day:day,state:'attempted'});
  if(reserve.error)return reply({error:reserve.error.code==='23505'?'MAIL_ALREADY_ATTEMPTED':'RESERVATION_FAILED'},409);
  if(!await off(db))return reply({error:'INTAKE_MUST_BE_OFF'},423);
  let accepted=false;
  try{
   const r=await external('https://api.resend.com/emails',{method:'POST',headers:{Authorization:'Bearer '+api,'Content-Type':'application/json','Idempotency-Key':'cargo-stage-owner-check-'+OWNER_ID+'-'+day},body:JSON.stringify({from,to:[OWNER],subject:'Rainbow Driver 検証環境：Resend接続確認',text:'管理者本人への接続確認メールです。\n送信元：cargo@mail.rainbow-driver.com\n一般受付はOFFです。配送依頼・運賃確定・決済は作成していません。\nこのメールへの返信や認証コード入力は不要です。'})});
   const d=await r.json().catch(()=>({}));accepted=r.ok&&typeof d.id==='string'&&d.id.trim().length>0&&d.id.length<=200;
  }catch{}
  const update=await db.from('cargo_staging_external_mail_checks').update({state:accepted?'provider_accepted':'unconfirmed'}).eq('operator_id',OWNER_ID).eq('test_day',day);
  if(!accepted)return reply({error:'MAIL_DELIVERY_NOT_CONFIRMED'},502);
  return reply({ok:true,...flags,captcha_verified:true,email_provider_accepted:true,inbox_delivery_verified:false,recipient:OWNER,record_saved:!update.error});
 }catch{return reply({error:'PROBE_UNAVAILABLE'},503)}
});
