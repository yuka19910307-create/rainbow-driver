-- Disposable database only. No active trial survives this transaction.
\set ON_ERROR_STOP on
begin;
do $$
declare o uuid:='5ccbfcd5-bd0f-4a9a-b570-223b3deb2567';j jsonb;d uuid;e text;
begin
 delete from public.cargo_staging_owner_test_runs;
 insert into auth.users(id) values(o) on conflict do nothing;
 insert into public.cargo_operator_accounts(user_id) values(o) on conflict do nothing;
 update public.cargo_intake_control set intake_enabled=false,captcha_required=true,contact_verification_required=true where id=1;
 if has_function_privilege('anon','public.cargo_staging_owner_test_session(uuid,text)','EXECUTE') or
 has_function_privilege('authenticated','public.cargo_staging_owner_test_expire()','EXECUTE') then raise exception 'PUBLIC_SESSION_ACCESS';end if;
 j:=public.cargo_staging_owner_test_session(gen_random_uuid(),'begin');if (j->>'ok')::boolean then raise exception 'WRONG_OWNER_BEGIN';end if;
 j:=public.cargo_staging_owner_test_session(o,'status');if j->>'state'<>'NOT_STARTED' then raise exception 'STATUS_BAD';end if;
 j:=public.cargo_staging_owner_test_session(o,'begin');d:=(j->>'draft_id')::uuid;e:=j->>'expires_at';
 if j->>'state'<>'ACTIVE' or not (select intake_enabled from public.cargo_intake_control where id=1) then raise exception 'BEGIN_FAILED';end if;
 perform public.cargo_staging_owner_test_authorize(o,'start',d,true);
 j:=public.cargo_staging_owner_test_session(o,'begin');
 if (j->>'draft_id')::uuid<>d or j->>'expires_at'<>e or not (j->>'start_claimed')::boolean then raise exception 'BEGIN_RESET_WINDOW_OR_SLOT';end if;
 perform public.cargo_staging_owner_test_session(o,'finish');
 if (select intake_enabled from public.cargo_intake_control where id=1) then raise exception 'FINISH_LEFT_SWITCH_ON';end if;
 j:=public.cargo_staging_owner_test_session(o,'begin');if j->>'state'<>'CLOSED' then raise exception 'RESTARTED_USED_TRIAL';end if;
 update public.cargo_staging_owner_test_runs set enabled=true,created_at=clock_timestamp()-interval '20 minutes',expires_at=clock_timestamp()-interval '1 minute';
 update public.cargo_intake_control set intake_enabled=true where id=1;
 if public.cargo_staging_owner_test_expire()<>1 or (select intake_enabled from public.cargo_intake_control where id=1) then raise exception 'EXPIRY_DID_NOT_STOP';end if;
 if public.cargo_staging_owner_test_expire()<>0 then raise exception 'EXPIRY_NOT_IDEMPOTENT';end if;
end $$;
rollback;
