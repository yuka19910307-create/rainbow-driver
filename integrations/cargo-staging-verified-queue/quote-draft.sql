-- Fictional staging quotation only. No delivery, email or payment actions.
create table public.cargo_staging_quote_drafts (
 request_id uuid primary key references public.cargo_staging_verified_requests(id),
 amount_yen integer not null default 10000 check(amount_yen=10000),
 terms text not null default '架空案件の保存テスト用。実際の運賃ではありません。' check(terms='架空案件の保存テスト用。実際の運賃ではありません。'),
 status text not null default 'draft' check(status='draft'),
 created_at timestamptz not null default now()
);
alter table public.cargo_staging_quote_drafts enable row level security;
revoke all on public.cargo_staging_quote_drafts from public,anon,authenticated;
grant select,insert on public.cargo_staging_quote_drafts to service_role;
create function public.cargo_staging_quote_draft_save(p_operator_id uuid,p_id uuid)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare r public.cargo_staging_verified_requests%rowtype; q public.cargo_staging_quote_drafts%rowtype;
begin
 if p_operator_id is null or p_id is null then return jsonb_build_object('ok',false,'reason','INVALID_INPUT');end if;
 perform 1 from public.cargo_operator_accounts where user_id=p_operator_id;
 if not found then return jsonb_build_object('ok',false,'reason','OPERATOR_ONLY');end if;
 perform 1 from public.cargo_intake_control where id=1 and intake_enabled=false and captcha_required=true and contact_verification_required=true for share;
 if not found then return jsonb_build_object('ok',false,'reason','INTAKE_MUST_BE_OFF');end if;
 select * into r from public.cargo_staging_verified_requests where id=p_id and operator_id=p_operator_id for update;
 if not found then return jsonb_build_object('ok',false,'reason','REQUEST_NOT_FOUND');end if;
 if r.status is distinct from 'operator_reviewing' then return jsonb_build_object('ok',false,'reason','REVIEW_REQUIRED');end if;
 select * into q from public.cargo_staging_quote_drafts where request_id=r.id;
 if found then return jsonb_build_object('ok',true,'already_saved',true);end if;
 insert into public.cargo_staging_quote_drafts(request_id) values(r.id);
 return jsonb_build_object('ok',true,'already_saved',false);
end;
$$;
revoke all on function public.cargo_staging_quote_draft_save(uuid,uuid) from public,anon,authenticated;
grant execute on function public.cargo_staging_quote_draft_save(uuid,uuid) to service_role;
