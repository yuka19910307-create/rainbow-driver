-- Ephemeral PostgreSQL-only fixtures. Never execute against the live Supabase DB.
\set ON_ERROR_STOP on
create schema auth;
create table auth.users(id uuid primary key);
do $$
begin
  if not exists(select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role nologin; end if;
end $$;
create table public.cargo_intake_control (
 id integer primary key, intake_enabled boolean not null,
 captcha_required boolean not null, contact_verification_required boolean not null
);
create table public.cargo_operator_accounts(
 user_id uuid primary key references auth.users(id)
);
create table public.cargo_email_verification_challenges(
 id uuid primary key, subject_hmac bytea not null,
 created_at timestamptz not null, expires_at timestamptz not null,
 delete_after timestamptz not null, consumed_at timestamptz
);
grant usage on schema public to service_role;
grant select on public.cargo_intake_control,public.cargo_operator_accounts,
 public.cargo_email_verification_challenges to service_role;
insert into auth.users(id) values
 ('11111111-1111-4111-8111-111111111111'),
 ('22222222-2222-4222-8222-222222222222');
insert into public.cargo_operator_accounts(user_id) values
 ('11111111-1111-4111-8111-111111111111'),
 ('22222222-2222-4222-8222-222222222222');
insert into public.cargo_intake_control values(1,false,true,true);
-- Fixtures use synthetic HMAC values only, never real OTP or customer information.
insert into public.cargo_email_verification_challenges
 (id,subject_hmac,created_at,expires_at,delete_after,consumed_at)
values
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',decode(repeat('11',32),'hex'),now()-interval '2 minutes',now()+interval '8 minutes',now()+interval '28 minutes',now()-interval '30 seconds'),
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',decode(repeat('22',32),'hex'),now()-interval '2 minutes',now()+interval '8 minutes',now()+interval '28 minutes',null),
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3',decode(repeat('33',32),'hex'),now()-interval '15 minutes',now()-interval '5 minutes',now()+interval '15 minutes',now()-interval '10 minutes'),
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4',decode(repeat('44',32),'hex'),now()-interval '2 minutes',now()+interval '8 minutes',now()+interval '28 minutes',now()-interval '30 seconds'),
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5',decode(repeat('55',32),'hex'),now()-interval '2 minutes',now()+interval '8 minutes',now()+interval '28 minutes',now()-interval '30 seconds'),
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa6',decode(repeat('66',32),'hex'),now()-interval '2 minutes',now()+interval '8 minutes',now()+interval '28 minutes',now()-interval '30 seconds'),
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa7',decode(repeat('77',32),'hex'),now()-interval '2 minutes',now()+interval '8 minutes',now()+interval '28 minutes',now()-interval '30 seconds'),
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa8',decode(repeat('88',32),'hex'),now()-interval '2 minutes',now()+interval '8 minutes',now()+interval '28 minutes',now()-interval '30 seconds'),
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa9',decode(repeat('99',32),'hex'),now()-interval '2 minutes',now()+interval '8 minutes',now()+interval '28 minutes',now()-interval '30 seconds');
-- An additional, newer OTP supersedes challenge 7.
insert into public.cargo_email_verification_challenges
 (id,subject_hmac,created_at,expires_at,delete_after,consumed_at)
values ('ffffffff-ffff-4fff-8fff-fffffffffff7',decode(repeat('77',32),'hex'),
 now()-interval '1 minute',now()+interval '9 minutes',now()+interval '29 minutes',null);
