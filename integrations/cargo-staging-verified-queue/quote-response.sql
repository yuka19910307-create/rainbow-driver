-- Admin simulates a customer response to a fictional draft. No real customer action.
create table public.cargo_staging_quote_responses (
 request_id uuid primary key references public.cargo_staging_quote_drafts(request_id),
 response text not null check(response in ('interested','declined')),
 mode text not null default 'ADMIN_SIMULATION' check(mode='ADMIN_SIMULATION'),
 created_at timestamptz not null default now()
);
alter table public.cargo_staging_quote_responses enable row level security;
revoke all on public.cargo_staging_quote_responses from public,anon,authenticated;
grant select,insert on public.cargo_staging_quote_responses to service_role;
create function public.cargo_staging_quote_response_save(p_operator_id uuid,p_id uuid,p_response text)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare r public.cargo_staging_verified_requests%rowtype; v_response text;
begin
 if p_operator_id is null or p_id is null or p_response is null or p_response not in ('interested','declined') then
  return jsonb_build_object('ok',false,'reason','INVALID_INPUT');end if;
 perform 1 from public.cargo_operator_accounts where user_id=p_operator_id;
 if not found then return jsonb_build_object('ok',false,'reason','OPERATOR_ONLY');end if;
 perform 1 from public.cargo_intake_control where id=1 and intake_enabled=false and captcha_required=true and contact_verification_required=true for share;
 if not found then return jsonb_build_object('ok',false,'reason','INTAKE_MUST_BE_OFF');end if;
 select * into r from public.cargo_staging_verified_requests where id=p_id and operator_id=p_operator_id for update;
 if not found then return jsonb_build_object('ok',false,'reason','REQUEST_NOT_FOUND');end if;
 if r.status is distinct from 'operator_reviewing' then return jsonb_build_object('ok',false,'reason','REVIEW_REQUIRED');end if;
 perform 1 from public.cargo_staging_quote_drafts where request_id=r.id and status='draft';
 if not found then return jsonb_build_object('ok',false,'reason','QUOTE_DRAFT_REQUIRED');end if;
 select response into v_response from public.cargo_staging_quote_responses where request_id=r.id;
 if found then
  if v_response is distinct from p_response then return jsonb_build_object('ok',false,'reason','RESPONSE_ALREADY_SAVED');end if;
  return jsonb_build_object('ok',true,'already_saved',true);
 end if;
 insert into public.cargo_staging_quote_responses(request_id,response) values(r.id,p_response);
 return jsonb_build_object('ok',true,'already_saved',false);
end;
$$;
revoke all on function public.cargo_staging_quote_response_save(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.cargo_staging_quote_response_save(uuid,uuid,text) to service_role;
