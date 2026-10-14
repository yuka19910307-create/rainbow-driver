import {createClient} from "npm:@supabase/supabase-js@2.112.3";
const APP="https://app.rainbow-driver.com",TARGET="https://hvdoqcrnztqmbzgwrovd.supabase.co";
const headers={"Access-Control-Allow-Origin":APP,"Access-Control-Allow-Headers":"authorization,apikey,content-type,x-client-info","Access-Control-Allow-Methods":"POST,OPTIONS","Vary":"Origin","Cache-Control":"no-store","Content-Type":"application/json"};
const reply=(d,status=200)=>new Response(JSON.stringify(d),{status,headers});
const fixture={pickup:"テスト集荷地・さいたま市",delivery:"テスト配送先・東京都内",cargo:"テスト用・精密機器の箱",pieces:2,weight:8.5};
const bytea=b=>"\\x"+Array.from(new Uint8Array(b),x=>x.toString(16).padStart(2,"0")).join("");
Deno.serve(async req=>{
 if(req.headers.get("origin")!==APP)return reply({error:"ORIGIN_DENIED"},403);
 if(req.method==="OPTIONS")return new Response(null,{status:204,headers});
 if(req.method!=="POST")return reply({error:"METHOD_NOT_ALLOWED"},405);
 const token=(req.headers.get("authorization")||"").match(/^Bearer\s+(\S+)$/i)?.[1];
 if(!token)return reply({error:"LOGIN_REQUIRED"},401);
 let body;
 try{const raw=await req.text();if(raw.length>200)throw Error();body=JSON.parse(raw);
  if(!body||Array.isArray(body)||!['list','save_verified_sample','start_review','save_quote_draft'].includes(body.action))throw Error();
  const keys=Object.keys(body).sort(),expected=['start_review','save_quote_draft'].includes(body.action)?['action','id']:['action'];
  if(keys.length!==expected.length||keys.some((k,i)=>k!==expected[i]))throw Error();
  if(['start_review','save_quote_draft'].includes(body.action)&&!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.id))throw Error();
 }catch{return reply({error:"INVALID_INPUT"},400)}
 const url=Deno.env.get("SUPABASE_URL"),role=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
 if(url!==TARGET||!role)return reply({error:"STAGING_ONLY"},503);
 try{
  const db=createClient(url,role,{auth:{persistSession:false,autoRefreshToken:false}});
  const {data:auth,error}=await db.auth.getUser(token);
  if(error||!auth?.user)return reply({error:"INVALID_SESSION"},401);
  const uid=auth.user.id;
  const member=await db.from("cargo_operator_accounts").select("user_id").eq("user_id",uid).maybeSingle();
  if(member.error||!member.data)return reply({error:"OPERATOR_ONLY"},403);
  const gate=await db.from("cargo_intake_control").select("intake_enabled,captcha_required,contact_verification_required").eq("id",1).maybeSingle();
  if(gate.error||gate.data?.intake_enabled!==false||gate.data?.captcha_required!==true||gate.data?.contact_verification_required!==true)return reply({error:"INTAKE_MUST_BE_OFF"},423);
  if(body.action==='save_verified_sample'){
   const s=Deno.env.get("CARGO_INTAKE_HMAC_KEY")||'';
   if(!/^[A-Za-z0-9+/]+={0,2}$/.test(s)||s.length%4) return reply({error:"HMAC_NOT_CONFIGURED"},503);
   const raw=Uint8Array.from(atob(s),c=>c.charCodeAt(0));
   if(raw.length<32||raw.length>64)return reply({error:"HMAC_NOT_CONFIGURED"},503);
   const key=await crypto.subtle.importKey('raw',raw,{name:'HMAC',hash:'SHA-256'},false,['sign']);
   const mac=async message=>bytea(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(message)));
   const {data,error:saveError}=await db.rpc('cargo_staging_verified_save',{p_operator_id:uid,p_subject:await mac('CARGO_OPERATOR_SELF_TEST|'+uid),p_fingerprint:await mac('CARGO_OPERATOR_DRAFT_V1|'+JSON.stringify(fixture))});
   if(saveError||!data)return reply({error:"SAVE_UNAVAILABLE"},503);
   if(data.ok!==true)return reply({error:data.reason},422);
  }else if(body.action==='start_review'){
   const {data:reviewed,error:reviewError}=await db.rpc('cargo_staging_verified_start_review',{p_operator_id:uid,p_id:body.id});
   if(reviewError||!reviewed)return reply({error:'REVIEW_UNAVAILABLE'},503);
   if(reviewed.ok!==true)return reply({error:reviewed.reason},409);
  }
  if(body.action==='save_quote_draft'){
   const {data:saved,error:quoteError}=await db.rpc('cargo_staging_quote_draft_save',{p_operator_id:uid,p_id:body.id});
   if(quoteError||!saved)return reply({error:'QUOTE_UNAVAILABLE'},503);
   if(saved.ok!==true)return reply({error:saved.reason},409);
  }
  const rows=await db.from('cargo_staging_verified_requests').select('id,source_draft_id,status,created_at,review_started_at').eq('operator_id',uid).order('created_at',{ascending:false}).limit(10);
  if(rows.error)return reply({error:"QUEUE_UNAVAILABLE"},503);
  const ids=(rows.data||[]).map(r=>r.id);
  const quotes=ids.length?await db.from('cargo_staging_quote_drafts').select('request_id,amount_yen,terms,status,created_at').in('request_id',ids):{data:[],error:null};
  if(quotes.error)return reply({error:'QUOTE_UNAVAILABLE'},503);
  const byId=new Map((quotes.data||[]).map(q=>[q.request_id,q]));
  return reply({ok:true,environment:'CARGO_FREE_STAGING',items:(rows.data||[]).map(r=>({...r,details:fixture,quote_draft:byId.get(r.id)||null})),public_intake_enabled:false,customer_request_created:false,email_sent:false,payment_created:false});
 }catch{return reply({error:"QUEUE_UNAVAILABLE"},503)}
});
