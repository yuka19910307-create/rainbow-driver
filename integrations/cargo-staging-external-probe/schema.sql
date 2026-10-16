create table public.cargo_staging_external_mail_checks (
 operator_id uuid not null references auth.users(id),
 test_day date not null,
 state text not null check (state in ('attempted','provider_accepted','unconfirmed')),
 created_at timestamptz not null default now(),
 primary key (operator_id,test_day)
);
alter table public.cargo_staging_external_mail_checks enable row level security;
revoke all on public.cargo_staging_external_mail_checks from public,anon,authenticated;
grant select,insert,update on public.cargo_staging_external_mail_checks to service_role;
comment on table public.cargo_staging_external_mail_checks is 'Owner-only staging external mail check reservations. No message body or secrets. Intake stays OFF.';
