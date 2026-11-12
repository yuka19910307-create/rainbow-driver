-- SYNTHETIC TEST FIXTURE ONLY. Run exclusively in runner-created empty cluster.
-- This minimal schema is NOT a faithful copy or proof of hosted Supabase Auth.
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;
CREATE SCHEMA auth;
CREATE TABLE auth.users (
 id uuid PRIMARY KEY, is_anonymous boolean NOT NULL DEFAULT false,
 email_confirmed_at timestamptz, phone_confirmed_at timestamptz, banned_until timestamptz
);
CREATE TABLE auth.sessions (
 id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES auth.users(id),
 factor_id uuid, aal text, created_at timestamptz NOT NULL,
 not_after timestamptz
);
CREATE TABLE auth.mfa_factors (
 id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES auth.users(id),
 status text, factor_type text
);
CREATE TABLE public.requests (
 id uuid PRIMARY KEY, status text NOT NULL,
 customer_token_hash text, pickup_address text NOT NULL,
 destination_address text NOT NULL, updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 pickup_lat numeric, pickup_lng numeric, destination_lat numeric, destination_lng numeric,
 pickup_distance_km numeric NOT NULL DEFAULT 3, pickup_eta_min integer NOT NULL DEFAULT 10,
 trip_distance_km numeric NOT NULL DEFAULT 8, trip_eta_min integer NOT NULL DEFAULT 20,
 pickup_fee bigint NOT NULL DEFAULT 1000, trip_fee bigint NOT NULL DEFAULT 3500,
 total_fee bigint NOT NULL DEFAULT 4500
);
CREATE TABLE public.payment_sessions (
 id uuid PRIMARY KEY, request_id uuid UNIQUE REFERENCES public.requests(id),
 status text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 environment text NOT NULL DEFAULT 'sandbox', currency text NOT NULL DEFAULT 'JPY',
 amount bigint NOT NULL DEFAULT 4500, square_payment_id text NOT NULL DEFAULT 'SYNTHETIC_PAYMENT',
 square_order_id text NOT NULL DEFAULT 'SYNTHETIC_ORDER'
);
INSERT INTO auth.users(id) VALUES ('22222222-2222-4222-8222-222222222222');
INSERT INTO auth.mfa_factors VALUES (
 '44444444-4444-4444-8444-444444444444','22222222-2222-4222-8222-222222222222','verified','totp');
INSERT INTO auth.sessions VALUES (
 '33333333-3333-4333-8333-333333333333','22222222-2222-4222-8222-222222222222',
 '44444444-4444-4444-8444-444444444444','aal2',clock_timestamp(),clock_timestamp()+interval '1 hour');
-- Separate synthetic confirmed-contact identity for pre-checkout origin.
INSERT INTO auth.users(id,email_confirmed_at) VALUES
 ('77777777-7777-4777-8777-777777777777',clock_timestamp());
INSERT INTO auth.sessions VALUES (
 '88888888-8888-4888-8888-888888888888','77777777-7777-4777-8777-777777777777',
 NULL,'aal1',clock_timestamp(),clock_timestamp()+interval '1 hour');
-- Existing old booking (case 6) predates the new trigger and has no origin.
INSERT INTO public.requests(id,status,customer_token_hash,pickup_address,destination_address)
VALUES ('11111111-1111-4111-8111-000000000006','driving',repeat('a',64),'架空旧出発地','架空旧目的地');
-- Cases 1–5: prospective test bookings; 7: paid-link while feature OFF;
-- 8: old-tab/no-origin checkout created after code installation.
INSERT INTO public.payment_sessions(id,request_id,status)
SELECT ('55555555-5555-4555-8555-'||lpad(n::text,12,'0'))::uuid,
 CASE WHEN n=6 THEN '11111111-1111-4111-8111-000000000006'::uuid ELSE NULL END,
 CASE WHEN n=6 THEN 'paid' ELSE 'pending' END FROM generate_series(1,8) n;
