-- Disposable database ONLY; all fixture changes roll back.
\set ON_ERROR_STOP on
begin;
do $$
declare o uuid:='5ccbfcd5-bd0f-4a9a-b570-223b3deb2567';d uuid:='11111111-1111-4111-8111-111111111111';r uuid:='22222222-2222-4222-8222-222222222222';
begin
 if exists(select 1 from public.cargo_staging_owner_test_runs) then raise exception 'UNEXPECTED_FIXTURE';end if;
 if not (select relrowsecurity from pg_class where oid='public.cargo_staging_owner_test_runs'::regclass) or
 has_table_privilege('anon','public.cargo_staging_owner_test_runs','SELECT') or
 has_table_privilege('authenticated','public.cargo_staging_owner_test_runs','UPDATE') or
 has_function_privilege('anon','public.cargo_staging_owner_test_authorize(uuid,text,uuid,boolean)','EXECUTE') or
 has_function_privilege('authenticated','public.cargo_staging_owner_test_authorize(uuid,text,uuid,boolean)','EXECUTE') then raise exception 'PUBLIC_ACCESS';end if;
 insert into auth.users(id) values(o) on conflict do nothing;
 insert into public.cargo_staging_owner_test_runs(owner_id,draft_id,expires_at) values(o,d,clock_timestamp()+interval '20 minutes');
 if (public.cargo_staging_owner_test_authorize(o,'status')->>'ok')::boolean then raise exception 'DISABLED_ALLOWED';end if;
 update public.cargo_staging_owner_test_runs set enabled=true;
 if (public.cargo_staging_owner_test_authorize(gen_random_uuid(),'status')->>'ok')::boolean then raise exception 'WRONG_OWNER_ALLOWED';end if;
 if (public.cargo_staging_owner_test_authorize(o,'start',gen_random_uuid(),true)->>'ok')::boolean then raise exception 'WRONG_DRAFT_ALLOWED';end if;
 if not (public.cargo_staging_owner_test_authorize(o,'start',d,true)->>'ok')::boolean then raise exception 'START_DENIED';end if;
 if (public.cargo_staging_owner_test_authorize(o,'start',d,true)->>'ok')::boolean then raise exception 'START_REPLAY';end if;
 if not (public.cargo_staging_owner_test_authorize(o,'verify',d)->>'ok')::boolean then raise exception 'VERIFY_DENIED';end if;
 insert into public.cargo_customer_intake_requests(id,source_draft_id,contact_hmac,encrypted_payload)
 values(r,d,decode(repeat('ab',32),'hex'),decode(repeat('ab',30),'hex'));
 if (public.cargo_staging_owner_test_authorize(o,'view',r)->>'ok')::boolean then raise exception 'UNSENT_VIEW_ALLOWED';end if;
 if (public.cargo_staging_owner_test_authorize(o,'quote_send',gen_random_uuid(),true)->>'ok')::boolean then raise exception 'OTHER_REQUEST_ALLOWED';end if;
 if not (public.cargo_staging_owner_test_authorize(o,'quote_send',r,true)->>'ok')::boolean then raise exception 'QUOTE_DENIED';end if;
 if (public.cargo_staging_owner_test_authorize(o,'quote_send',r,true)->>'ok')::boolean then raise exception 'QUOTE_REPLAY';end if;
 if not (public.cargo_staging_owner_test_authorize(o,'view',r)->>'ok')::boolean then raise exception 'VIEW_DENIED';end if;
 update public.cargo_staging_owner_test_runs set created_at=clock_timestamp()-interval '20 minutes',expires_at=clock_timestamp()-interval '1 minute';
 if (public.cargo_staging_owner_test_authorize(o,'reply',r)->>'ok')::boolean then raise exception 'EXPIRED_ALLOWED';end if;
 if (public.cargo_staging_owner_test_authorize(o,'status',null,null)->>'ok')::boolean then raise exception 'NULL_CLAIM_ALLOWED';end if;
end $$;
rollback;
