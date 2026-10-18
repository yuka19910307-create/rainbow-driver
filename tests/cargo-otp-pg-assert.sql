-- Execute ONLY inside a disposable local PostgreSQL 16 container.
\set ON_ERROR_STOP on
-- The review DDL must have been applied after cargo-otp-pg-fixtures.sql.
insert into public.cargo_operator_draft_otp_bindings
(draft_id,operator_id,challenge_id,subject_hmac,draft_fingerprint_hmac,
 expires_at,delete_after,created_at)
select ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb'||right(id::text,1))::uuid,
 '11111111-1111-4111-8111-111111111111'::uuid,id,subject_hmac,
 decode(repeat('ab',32),'hex'),expires_at,delete_after,
 case when right(id::text,1)='9' then now()-interval '10 seconds'
 else now()-interval '1 minute' end
from public.cargo_email_verification_challenges
where id::text like 'aaaaaaaa-aaaa-4aaa-8aaa-%';

do $$
declare
 o constant uuid := '11111111-1111-4111-8111-111111111111';
 other constant uuid := '22222222-2222-4222-8222-222222222222';
 b uuid;
 c uuid;
 result jsonb;
 i integer;
begin
 if has_table_privilege('anon','public.cargo_operator_draft_otp_bindings','SELECT')
    or has_table_privilege('authenticated','public.cargo_operator_draft_otp_bindings','INSERT')
    or has_function_privilege('anon','public.cargo_operator_draft_otp_claim(uuid,uuid,uuid,bytea,bytea)','EXECUTE')
    or has_function_privilege('authenticated','public.cargo_operator_draft_otp_claim(uuid,uuid,uuid,bytea,bytea)','EXECUTE') then
  raise exception 'PUBLIC_ROLE_PRIVILEGE_EXPOSED';
 end if;
 if not has_table_privilege('service_role','public.cargo_operator_draft_otp_bindings','UPDATE')
    or not has_function_privilege('service_role','public.cargo_operator_draft_otp_claim(uuid,uuid,uuid,bytea,bytea)','EXECUTE') then
  raise exception 'SERVICE_ROLE_MISSING_PRIVILEGES';
 end if;
 if not (select relrowsecurity from pg_class where oid='public.cargo_operator_draft_otp_bindings'::regclass) then
  raise exception 'RLS_NOT_ENABLED';
 end if;
 -- Null readiness probe must never write or claim.
 result:=public.cargo_operator_draft_otp_claim(null,null,null,null,null);
 if result->>'reason'<>'INVALID_INPUT' then raise exception 'READINESS_PROBE_UNEXPECTED %',result; end if;

 -- Successful claim exactly once.
 b:='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1';
 c:='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
 result:=public.cargo_operator_draft_otp_claim(o,b,c,decode(repeat('11',32),'hex'),decode(repeat('ab',32),'hex'));
 if result->>'reason'<>'CLAIMED' then raise exception 'VALID_CLAIM_FAILED %',result; end if;
 result:=public.cargo_operator_draft_otp_claim(o,b,c,decode(repeat('11',32),'hex'),decode(repeat('ab',32),'hex'));
 if result->>'reason'<>'ALREADY_CLAIMED' then raise exception 'REPLAY_NOT_REJECTED %',result; end if;

 -- An unverified code cannot claim.
 b:='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2';
 c:='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
 result:=public.cargo_operator_draft_otp_claim(o,b,c,decode(repeat('22',32),'hex'),decode(repeat('ab',32),'hex'));
 if result->>'reason'<>'CHALLENGE_NOT_VERIFIED' then raise exception 'UNVERIFIED_ACCEPTED %',result; end if;

 -- Expired code cannot claim.
 b:='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3';
 c:='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3';
 result:=public.cargo_operator_draft_otp_claim(o,b,c,decode(repeat('33',32),'hex'),decode(repeat('ab',32),'hex'));
 if result->>'reason'<>'EXPIRED' then raise exception 'EXPIRED_ACCEPTED %',result; end if;

 -- Different operator cannot claim.
 b:='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb4';
 c:='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4';
 result:=public.cargo_operator_draft_otp_claim(other,b,c,decode(repeat('44',32),'hex'),decode(repeat('ab',32),'hex'));
 if result->>'reason'<>'BINDING_MISMATCH' then raise exception 'OTHER_OPERATOR_ACCEPTED %',result; end if;

 -- Tampered draft fingerprint cannot claim.
 b:='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb5';
 c:='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5';
 result:=public.cargo_operator_draft_otp_claim(o,b,c,decode(repeat('55',32),'hex'),decode(repeat('00',32),'hex'));
 if result->>'reason'<>'BINDING_MISMATCH' then raise exception 'TAMPER_ACCEPTED %',result; end if;

 -- A newer OTP supersedes the earlier challenge.
 b:='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb7';
 c:='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa7';
 result:=public.cargo_operator_draft_otp_claim(o,b,c,decode(repeat('77',32),'hex'),decode(repeat('ab',32),'hex'));
 if result->>'reason'<>'OLDER_CODE_SUPERSEDED' then raise exception 'OLD_OTP_ACCEPTED %',result; end if;

 -- Verification that occurred BEFORE draft binding must not authorize the draft.
 b:='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb9';
 c:='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa9';
 result:=public.cargo_operator_draft_otp_claim(o,b,c,decode(repeat('99',32),'hex'),decode(repeat('ab',32),'hex'));
 if result->>'reason'<>'CHALLENGE_NOT_VERIFIED' then raise exception 'POST_VERIFICATION_BIND_ACCEPTED %',result; end if;

 -- An open intake switch must fail closed.
 update public.cargo_intake_control set intake_enabled=true where id=1;
 b:='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb6';
 c:='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa6';
 result:=public.cargo_operator_draft_otp_claim(o,b,c,decode(repeat('66',32),'hex'),decode(repeat('ab',32),'hex'));
 if result->>'reason'<>'INTAKE_MUST_BE_OFF' then raise exception 'PUBLIC_INTAKE_GATE_BYPASSED %',result; end if;
 update public.cargo_intake_control set intake_enabled=false where id=1;
 raise notice 'PASS: RLS, grants, claim, replay, unverified, expired, operator, fingerprint, supersession, late-binding, intake gate';
end $$;

-- The real service_role (not just table owner) must be able to claim.
set role service_role;
do $$
declare
 result jsonb;
begin
 result:=public.cargo_operator_draft_otp_claim(
  '11111111-1111-4111-8111-111111111111'::uuid,
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb8'::uuid,
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa8'::uuid,
  decode(repeat('88',32),'hex'),decode(repeat('ab',32),'hex'));
 if result->>'reason'<>'CLAIMED' then raise exception 'SERVICE_ROLE_CLAIM_FAILED %',result; end if;
 raise notice 'PASS: service_role executes authorized claim';
end $$;
reset role;
