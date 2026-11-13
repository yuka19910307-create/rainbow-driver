-- SYNTHETIC EXTENSION FIXTURE ONLY. Not deployed and not production schema proof.
-- Existing finalizer below is copied byte-for-byte from the historical reference.
-- Reference SHA256: 7dd80c8af0f0333fc6467a5073319a849e6f2db859d4c30cf6f51ec83bf08266
-- Fixture-only columns/defaults satisfy that saved function's actual dependencies.
BEGIN;
ALTER TABLE public.requests ALTER COLUMN id SET DEFAULT pg_catalog.gen_random_uuid();
ALTER TABLE public.requests ADD COLUMN customer_name text;
ALTER TABLE public.requests ADD COLUMN customer_phone text;
ALTER TABLE public.requests ADD COLUMN notes text;
ALTER TABLE public.payment_sessions ALTER COLUMN square_payment_id DROP NOT NULL;
ALTER TABLE public.payment_sessions ADD COLUMN customer_token_hash text DEFAULT repeat('a',64);
ALTER TABLE public.payment_sessions ADD COLUMN request_payload jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE public.payment_sessions ADD COLUMN paid_at timestamptz;
ALTER TABLE public.payment_sessions ADD COLUMN updated_at timestamptz NOT NULL DEFAULT clock_timestamp();
ALTER TABLE public.payment_sessions ADD COLUMN last_error text;
ALTER TABLE public.payment_sessions ADD COLUMN refunded_amount bigint NOT NULL DEFAULT 0;
ALTER TABLE public.payment_sessions ADD COLUMN refunded_at timestamptz;
-- BEGIN EXACT HISTORICAL FINALIZER
CREATE OR REPLACE FUNCTION public.finalize_paid_payment_session(p_session_id uuid, p_payment_id text)
 RETURNS TABLE(request_id uuid, created_new boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  s public.payment_sessions%rowtype;
  new_request_id uuid;
begin
  select *
    into s
  from public.payment_sessions
  where id = p_session_id
  for update;

  if not found then
    raise exception 'payment_session_not_found';
  end if;

  if s.request_id is not null then
    return query select s.request_id, false;
    return;
  end if;

  if s.status not in ('pending','paid') then
    raise exception 'payment_session_not_finalizable';
  end if;

  insert into public.requests (
    customer_token_hash,
    customer_name,
    customer_phone,
    pickup_address,
    destination_address,
    pickup_lat,
    pickup_lng,
    destination_lat,
    destination_lng,
    pickup_distance_km,
    trip_distance_km,
    pickup_eta_min,
    trip_eta_min,
    pickup_fee,
    trip_fee,
    total_fee,
    notes,
    status
  ) values (
    s.customer_token_hash,
    nullif(s.request_payload->>'customer_name',''),
    nullif(s.request_payload->>'customer_phone',''),
    s.request_payload->>'pickup_address',
    s.request_payload->>'destination_address',
    nullif(s.request_payload->>'pickup_lat','')::double precision,
    nullif(s.request_payload->>'pickup_lng','')::double precision,
    nullif(s.request_payload->>'destination_lat','')::double precision,
    nullif(s.request_payload->>'destination_lng','')::double precision,
    nullif(s.request_payload->>'pickup_distance_km','')::numeric,
    nullif(s.request_payload->>'trip_distance_km','')::numeric,
    nullif(s.request_payload->>'pickup_eta_min','')::integer,
    nullif(s.request_payload->>'trip_eta_min','')::integer,
    coalesce(nullif(s.request_payload->>'pickup_fee','')::integer,0),
    coalesce(nullif(s.request_payload->>'trip_fee','')::integer,0),
    coalesce(nullif(s.request_payload->>'total_fee','')::integer,0),
    nullif(s.request_payload->>'notes',''),
    'requested'
  )
  returning id into new_request_id;

  update public.payment_sessions
  set status = 'paid',
      square_payment_id = p_payment_id,
      request_id = new_request_id,
      paid_at = coalesce(paid_at, now()),
      updated_at = now(),
      last_error = null
  where id = p_session_id;

  return query select new_request_id, true;
end;
$function$;
-- END EXACT HISTORICAL FINALIZER
COMMIT;
