-- Rainbow Driver cargo: OPERATOR-ONLY fictional draft/OTP binding prototype.
-- REVIEW ONLY. This file has NOT been applied to any database.
-- Do not expose a customer-facing intake or email endpoint.
-- No personal contacts or real delivery requests are stored here.
begin;

create table if not exists public.cargo_operator_draft_otp_bindings (
  draft_id uuid primary key,
  operator_id uuid not null references auth.users(id),
  challenge_id uuid not null unique references public.cargo_email_verification_challenges(id) on delete cascade,
  subject_hmac bytea not null check (octet_length(subject_hmac)=32),
  draft_fingerprint_hmac bytea not null check (octet_length(draft_fingerprint_hmac)=32),
  expires_at timestamptz not null,
  claimed_at timestamptz,
  created_at timestamptz not null default now(),
  delete_after timestamptz not null default (now()+interval '30 minutes'),
  constraint cargo_operator_draft_binding_expiry check (expires_at <= delete_after)
);
alter table public.cargo_operator_draft_otp_bindings enable row level security;
revoke all on table public.cargo_operator_draft_otp_bindings from public, anon, authenticated;
grant select,insert,update,delete on table public.cargo_operator_draft_otp_bindings to service_role;

-- Claim a verified code ONCE for the SAME operator, fictional draft,
-- immutable server-computed fingerprint, subject, and challenge.
-- Caller is service_role after authenticating a cargo operator in Edge Function.
-- SECURITY INVOKER and explicit grants avoid a public SECURITY DEFINER endpoint.
create or replace function public.cargo_operator_draft_otp_claim(
  p_operator_id uuid,
  p_draft_id uuid,
  p_challenge_id uuid,
  p_subject_hmac bytea,
  p_draft_fingerprint_hmac bytea
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_binding public.cargo_operator_draft_otp_bindings%rowtype;
  v_challenge public.cargo_email_verification_challenges%rowtype;
  v_now timestamptz := clock_timestamp();
begin
  if p_operator_id is null or p_draft_id is null or p_challenge_id is null
     or p_subject_hmac is null or octet_length(p_subject_hmac) <> 32
     or p_draft_fingerprint_hmac is null or octet_length(p_draft_fingerprint_hmac) <> 32 then
    return jsonb_build_object('ok',false,'reason','INVALID_INPUT');
  end if;
  -- Fail closed unless the cargo intake remains disabled and this is a known operator.
  if not exists (
    select 1 from public.cargo_intake_control
    where id=1 and intake_enabled=false
      and captcha_required=true and contact_verification_required=true
  ) then
    return jsonb_build_object('ok',false,'reason','INTAKE_MUST_BE_OFF');
  end if;
  if not exists (
    select 1 from public.cargo_operator_accounts where user_id=p_operator_id
  ) then
    return jsonb_build_object('ok',false,'reason','OPERATOR_ONLY');
  end if;
  select * into v_binding from public.cargo_operator_draft_otp_bindings
   where draft_id=p_draft_id for update;
  if not found then
    return jsonb_build_object('ok',false,'reason','DRAFT_NOT_FOUND');
  end if;
  if v_binding.operator_id <> p_operator_id
     or v_binding.challenge_id <> p_challenge_id
     or v_binding.subject_hmac <> p_subject_hmac
     or v_binding.draft_fingerprint_hmac <> p_draft_fingerprint_hmac then
    return jsonb_build_object('ok',false,'reason','BINDING_MISMATCH');
  end if;
  if v_binding.claimed_at is not null then
    return jsonb_build_object('ok',false,'reason','ALREADY_CLAIMED');
  end if;
  if v_now >= v_binding.expires_at then
    return jsonb_build_object('ok',false,'reason','EXPIRED');
  end if;
  select * into v_challenge from public.cargo_email_verification_challenges
   where id=v_binding.challenge_id for update;
  if not found or v_challenge.subject_hmac <> v_binding.subject_hmac
     or v_challenge.consumed_at is null
     or v_challenge.consumed_at > v_binding.expires_at
     or v_now >= v_challenge.expires_at then
    return jsonb_build_object('ok',false,'reason','CHALLENGE_NOT_VERIFIED');
  end if;
  update public.cargo_operator_draft_otp_bindings
    set claimed_at=v_now where draft_id=p_draft_id;
  return jsonb_build_object('ok',true,'reason','CLAIMED');
end;
$$;
revoke all on function public.cargo_operator_draft_otp_claim(uuid,uuid,uuid,bytea,bytea)
  from public,anon,authenticated;
grant execute on function public.cargo_operator_draft_otp_claim(uuid,uuid,uuid,bytea,bytea)
  to service_role;

commit;
