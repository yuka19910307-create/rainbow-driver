import {createClient} from "npm:@supabase/supabase-js@2.112.3";
const TARGET="https://hvdoqcrnztqmbzgwrovd.supabase.co",APP="https://app.rainbow-driver.com";
const headers={"Access-Control-Allow-Origin":APP,"Access-Control-Allow-Headers":"authorization,apikey,content-type,x-client-info","Access-Control-Allow-Methods":"POST,OPTIONS","Vary":"Origin","Cache-Control":"no-store","Content-Type":"application/json"};
const reply=(data,status=200)=>new Response(JSON.stringify(data),{status,headers});
Deno.serve(async req=>{
 if(req.headers.get("origin")!==APP)return reply({error:"ORIGIN_DENIED"},403);
 if(req.method==="OPTIONS")return new Response(null,{status:204,headers});
 if(req.method!=="POST")return reply({error:"METHOD_NOT_ALLOWED"},405);
 const token=(req.headers.get("authorization")||"").match(/^Bearer\s+(\S+)$/i)?.[1];
 if(!token)return reply({error:"LOGIN_REQUIRED"},401);
 let body;
 try{const raw=await req.text();if(raw.length>128)throw Error();body=JSON.parse(raw);
  if(!body||Array.isArray(body)||Object.keys(body).length!==1||!['load','create','review'].includes(body.action))throw Error();
 }catch{return reply({error:"INVALID_INPUT"},400)}
 const url=Deno.env.get("SUPABASE_URL"),key=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
 if(url!==TARGET||!key)return reply({error:"STAGING_ONLY"},503);
 try{
  const db=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}});
  const {data:auth,error}=await db.auth.getUser(token);
  if(error||!auth?.user)return reply({error:"INVALID_SESSION"},401);
  const {data:member,error:memberError}=await db.from("cargo_operator_accounts").select("user_id").eq("user_id",auth.user.id).maybeSingle();
  if(memberError||!member)return reply({error:"OPERATOR_ONLY"},403);
  const {data,error:dbError}=await db.rpc("cargo_staging_sample_action",{p_operator_id:auth.user.id,p_action:body.action});
  if(dbError||!data)return reply({error:"SAMPLE_UNAVAILABLE"},503);
  if(data.ok!==true)return reply({error:data.error},409);
  return reply({ok:true,environment:"CARGO_FREE_STAGING",public_intake_enabled:false,
   customer_request_created:false,email_sent:false,payment_created:false,sample:data.sample});
 }catch{return reply({error:"SAMPLE_UNAVAILABLE"},503)}
});
