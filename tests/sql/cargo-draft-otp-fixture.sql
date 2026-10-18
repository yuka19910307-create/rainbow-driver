-- Ephemeral PostgreSQL ONLY. Test fixtures; never run against Supabase.
create role anon nologin;
create role authenticated nologin;
create role service_role nologin;
create schema auth;
create table auth.users(id uuid primary key);
create table public.cargo_operator_accounts(user_id uuid primary key references auth.users(id));
create table public.cargo_intake_control(
 id integer primary key,
 intake_enabled boolean not null,
 captcha_required boolean not null,
 contact_verification_required boolean not null
);
create table public.cargo_email_verification_challenges(
 id uuid primary key,
 subject_hmac bytea not null,
 created_at timestamptz not null default now(),
 expires_at timestamptz not null,
 delete_after timestamptz not null,
 consumed_at timestamptz
);
insert into auth.users(id) values
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
 ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
insert into public.cargo_operator_accounts(user_id)
 values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
insert into public.cargo_intake_control(id,intake_enabled,captcha_required,contact_verification_required)
 values (1,false,true,true);
grant usage on schema public to service_role;
grant select on public.cargo_operator_accounts,public.cargo_intake_control,
 public.cargo_email_verification_challenges to service_role;
