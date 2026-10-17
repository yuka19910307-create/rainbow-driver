-- Disposable PostgreSQL-only cleanup tests; NEVER run on production.
\set ON_ERROR_STOP on
do $$
declare
  n integer;
  before_count integer;
begin
  if has_function_privilege('anon','public.cargo_operator_draft_otp_cleanup(integer)','EXECUTE')
   or has_function_privilege('authenticated','public.cargo_operator_draft_otp_cleanup(integer)','EXECUTE')
   or not has_function_privilege('service_role','public.cargo_operator_draft_otp_cleanup(integer)','EXECUTE') then
    raise exception 'CLEANUP_EXECUTE_PRIVILEGES_INCORRECT';
  end if;
  select count(*) into before_count from public.cargo_operator_draft_otp_bindings;
  if public.cargo_operator_draft_otp_cleanup(0)<>0
   or public.cargo_operator_draft_otp_cleanup(101)<>0
   or public.cargo_operator_draft_otp_cleanup(null)<>0 then
    raise exception 'CLEANUP_INVALID_LIMIT_NOT_REJECTED';
  end if;
  if (select count(*) from public.cargo_operator_draft_otp_bindings)<>before_count then
    raise exception 'INVALID_LIMIT_DELETED_DATA';
  end if;
  -- Mark three synthetic bindings expired. Their OTP challenges are untouched.
  update public.cargo_operator_draft_otp_bindings
   set expires_at=clock_timestamp()-interval '3 minutes',
       delete_after=clock_timestamp()-interval '1 minute'
   where draft_id in (
     'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1',
     'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2',
     'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3'
   );
  n:=public.cargo_operator_draft_otp_cleanup(2);
  if n<>2 then raise exception 'CLEANUP_LIMIT_BROKEN %',n; end if;
  if (select count(*) from public.cargo_operator_draft_otp_bindings)<>before_count-2 then
    raise exception 'CLEANUP_WRONG_ROW_COUNT';
  end if;
  if (select count(*) from public.cargo_email_verification_challenges)<>10 then
    raise exception 'CLEANUP_DELETED_OTP_CHALLENGES';
  end if;
  n:=public.cargo_operator_draft_otp_cleanup(100);
  if n<>1 then raise exception 'CLEANUP_REMAINING_FAILED %',n; end if;
  if (select count(*) from public.cargo_operator_draft_otp_bindings)<>before_count-3 then
    raise exception 'CLEANUP_DELETED_UNEXPIRED';
  end if;
  if public.cargo_operator_draft_otp_cleanup(100)<>0 then
    raise exception 'CLEANUP_NOT_IDEMPOTENT';
  end if;
  raise notice 'PASS: cleanup bound, permissions, expiry, OTP preservation, idempotence';
end $$;
set role service_role;
do $$
declare n integer;
begin
  n:=public.cargo_operator_draft_otp_cleanup(100);
  if n<>0 then raise exception 'SERVICE_ROLE_CLEANUP_UNEXPECTED %',n; end if;
  raise notice 'PASS: service_role can execute cleanup';
end $$;
reset role;
