create table public.cargo_staging_encrypted_storage_checks (
operator_id uuid primary key references auth.users(id),
encrypted_payload bytea not null check (octet_length(encrypted_payload) between 29 and 2000),
created_at timestamptz not null default now()
);
alter table public.cargo_staging_encrypted_storage_checks enable row level security;
revoke all on public.cargo_staging_encrypted_storage_checks from public,anon,authenticated;
grant select,insert,update on public.cargo_staging_encrypted_storage_checks to service_role;
comment on table public.cargo_staging_encrypted_storage_checks is 'Fixed fictional encrypted storage fixture, owner-only, never customer requests.';
