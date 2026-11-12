-- Rainbow Driver: existing-booking operations backend candidate.
-- REVIEW ONLY. NOT EXECUTED. No automatic deployment. This is NOT a tested migration.
-- The first exception is a review marker, NOT a universal execution barrier.
-- Clients may continue after errors. Never submit this file without approval.
DO $approval_gate$ BEGIN RAISE EXCEPTION 'RD_OPS_REVIEW_ONLY_NO_APPROVED_DB_EXECUTION'; END $approval_gate$;

BEGIN;
CREATE SCHEMA IF NOT EXISTS rd_private;
REVOKE ALL ON SCHEMA rd_private FROM PUBLIC, anon, authenticated;
-- Explicit owner enrollment is separate and unapproved. NO default user grant.
CREATE TABLE rd_private.operator_grants (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE RESTRICT,
  enabled boolean NOT NULL DEFAULT false,
  generation bigint NOT NULL DEFAULT 1 CHECK (generation > 0),
  changed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
-- Session generation is bound only after current AAL2 proof. A generation
-- change or operator grant disable invalidates EVERY earlier bound session.
CREATE FUNCTION rd_private.bump_operator_generation()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
BEGIN
 IF NEW.enabled IS DISTINCT FROM OLD.enabled THEN
   NEW.generation:=GREATEST(NEW.generation,OLD.generation+1);
   NEW.changed_at:=clock_timestamp();
 ELSIF NEW.generation IS DISTINCT FROM OLD.generation THEN
   IF NEW.generation<=OLD.generation THEN
     RAISE EXCEPTION 'RD_GENERATION_CANNOT_DECREASE'; END IF;
   NEW.changed_at:=clock_timestamp();
 END IF;
 RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION rd_private.bump_operator_generation() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER rd_ops_operator_generation_bump_trg
 BEFORE UPDATE OF enabled,generation ON rd_private.operator_grants FOR EACH ROW
 EXECUTE FUNCTION rd_private.bump_operator_generation();

CREATE TABLE rd_private.operator_session_bindings (
 session_id uuid PRIMARY KEY REFERENCES auth.sessions(id) ON DELETE CASCADE,
 user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
 generation bigint NOT NULL CHECK(generation>0),
 bound_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE rd_private.ops_settings (
  id integer PRIMARY KEY CHECK (id=1),
  enabled boolean NOT NULL DEFAULT false,
  -- Separate OFF switch so prospectively verified checkout can be tested
  -- BEFORE new operations are activated. Never enable via this migration.
  identity_intake_enabled boolean NOT NULL DEFAULT false,
  changed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO rd_private.ops_settings(id,enabled,identity_intake_enabled) VALUES (1,false,false);
CREATE TABLE rd_private.case_head (
  request_id uuid PRIMARY KEY REFERENCES public.requests(id) ON DELETE RESTRICT,
  revision bigint NOT NULL DEFAULT 0 CHECK(revision>=0),
  -- This first backend candidate supports wait persistence only. Route/settlement
  -- updates are intentionally not authorized, to avoid unverified fares/consents.
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
-- Coexistence-safe enrollment: enroll ONLY verified checkouts, not every new
-- request. Old tabs keep using the original Square flow and have no origin.
-- Enrollment is tied to the final payment_session link/status, because the
-- existing finalize_paid_payment_session RPC may insert requests BEFORE
-- setting payment_sessions.request_id. A requests AFTER INSERT trigger would
-- observe no paid link and could strand cases, or enroll old-tab bookings.
-- A prospective customer origin is immutable and created BEFORE Square link.
-- No migration/trigger here is deployed or executed.
CREATE FUNCTION rd_private.enroll_verified_paid_case()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
BEGIN
 -- Legacy payments have no prospective origin and are never enrolled here.
 IF NOT EXISTS(SELECT 1 FROM rd_private.checkout_customer_origins o
     WHERE o.payment_session_id=NEW.id AND
       o.binding_method='authenticated-before-checkout-v1') THEN RETURN NEW; END IF;
 -- Enrollment is a first-link decision, not a later payment polling/refund
 -- side effect. Once linked while operations were OFF, remain legacy.
 IF TG_OP='UPDATE' THEN
   IF OLD.request_id IS NOT NULL THEN
     IF NEW.request_id IS DISTINCT FROM OLD.request_id THEN
       RAISE EXCEPTION 'RD_VERIFIED_PAYMENT_BOOKING_REBIND_DENIED'; END IF;
     RETURN NEW;
   END IF;
 END IF;
 IF NEW.request_id IS NOT NULL AND NEW.status IN ('paid','partially_refunded')
   AND EXISTS(SELECT 1 FROM rd_private.ops_settings WHERE id=1 AND enabled=true FOR SHARE) THEN
   INSERT INTO rd_private.case_head(request_id)
     VALUES(NEW.request_id) ON CONFLICT DO NOTHING;
 END IF;
 RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION rd_private.enroll_verified_paid_case() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER rd_ops_enroll_verified_paid_case_trg
 AFTER INSERT OR UPDATE ON public.payment_sessions FOR EACH ROW
 EXECUTE FUNCTION rd_private.enroll_verified_paid_case();
CREATE TABLE rd_private.wait_interval (
  request_id uuid NOT NULL REFERENCES rd_private.case_head(request_id) ON DELETE RESTRICT,
  interval_id uuid NOT NULL,
  kind text NOT NULL CHECK(kind IN ('pickup','stop')),
  phase text NOT NULL CHECK(phase IN ('active','review','final','waived')),
  started_at timestamptz NOT NULL,
  claimed_at timestamptz,
  confirmed_at timestamptz,
  reason text,
  billed_ms bigint NOT NULL DEFAULT 0 CHECK(billed_ms>=0),
  PRIMARY KEY(request_id,interval_id),
  CHECK(
    (phase='active' AND claimed_at IS NULL AND confirmed_at IS NULL) OR
    (phase='review' AND claimed_at IS NOT NULL AND confirmed_at IS NULL) OR
    (phase IN ('final','waived') AND claimed_at IS NOT NULL AND confirmed_at IS NOT NULL)
  )
);
CREATE UNIQUE INDEX rd_ops_one_unresolved_wait ON rd_private.wait_interval(request_id)
  WHERE phase IN ('active','review');
CREATE TABLE rd_private.operation_receipts (
  operation_id uuid PRIMARY KEY,
  request_id uuid NOT NULL REFERENCES public.requests(id) ON DELETE RESTRICT,
  actor_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  action text NOT NULL,
  envelope_hash text NOT NULL CHECK(envelope_hash ~ '^[0-9a-f]{64}$'),
  expected_revision bigint NOT NULL CHECK(expected_revision>=0),
  body jsonb NOT NULL,
  committed_revision bigint NOT NULL CHECK(committed_revision>0),
  accepted_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX rd_ops_receipt_request_idx ON rd_private.operation_receipts(request_id,accepted_at DESC);
-- A successful business receipt and an explicitly closed, unexecuted ID are
-- disjoint durable outcomes. closed_by is the verified closure requester;
-- it does NOT claim to identify an unreceived operation's original operator.
CREATE TABLE rd_private.operation_terminal_results (
 operation_id uuid PRIMARY KEY,
 request_id uuid NOT NULL REFERENCES public.requests(id) ON DELETE RESTRICT,
 actor_kind text NOT NULL CHECK(actor_kind IN ('operator','customer')),
 closed_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
 closed_by_session uuid NOT NULL,
 action text NOT NULL,
 envelope_hash text NOT NULL CHECK(envelope_hash ~ '^[0-9a-f]{64}$'),
 expected_revision bigint NOT NULL CHECK(expected_revision>=0),
 body jsonb NOT NULL CHECK(jsonb_typeof(body)='object'),
 outcome text NOT NULL DEFAULT 'not_executed' CHECK(outcome='not_executed'),
 reason text NOT NULL DEFAULT 'explicit_unexecuted_close'
   CHECK(reason='explicit_unexecuted_close'),
 closed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE rd_private.operation_terminal_results ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON rd_private.operation_terminal_results FROM PUBLIC,anon,authenticated,service_role;

-- Every operation writer/preflight takes this lock BEFORE requests/auth/case
-- locks. UUID hash collisions only serialize unrelated IDs; exact identities
-- are compared separately. READ COMMITTED is an explicit contract: an old
-- REPEATABLE READ snapshot could miss a competing table's committed outcome.
CREATE FUNCTION rd_private.lock_operation_id(p_op uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
BEGIN
 IF p_op IS NULL THEN RAISE EXCEPTION 'RD_OPERATION_ID_REQUIRED'; END IF;
 IF current_setting('transaction_isolation') IS DISTINCT FROM 'read committed' THEN
   RAISE EXCEPTION 'RD_OPERATION_ISOLATION_UNSUPPORTED'; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(724031,pg_catalog.hashtext(p_op::text));
END $fn$;
REVOKE ALL ON FUNCTION rd_private.lock_operation_id(uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION rd_private.assert_operation_not_closed(
 p_request uuid,p_actor_id uuid,p_op uuid,p_expected_rev bigint,p_hash text,p_action text,p_payload jsonb
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE v_closed rd_private.operation_terminal_results%ROWTYPE;
BEGIN
 SELECT * INTO v_closed FROM rd_private.operation_terminal_results WHERE operation_id=p_op;
 IF FOUND THEN
   IF v_closed.request_id IS DISTINCT FROM p_request OR v_closed.closed_by IS DISTINCT FROM p_actor_id OR
      v_closed.expected_revision IS DISTINCT FROM p_expected_rev OR v_closed.envelope_hash IS DISTINCT FROM p_hash OR
      v_closed.action IS DISTINCT FROM p_action OR v_closed.body IS DISTINCT FROM p_payload THEN
     RAISE EXCEPTION 'RD_OPERATION_ID_REUSED'; END IF;
   RAISE EXCEPTION 'RD_OPERATION_CLOSED_UNEXECUTED';
 END IF;
END $fn$;
REVOKE ALL ON FUNCTION rd_private.assert_operation_not_closed(uuid,uuid,uuid,bigint,text,text,jsonb)
 FROM PUBLIC,anon,authenticated,service_role;

-- Defense against a missed fence in a future writer. Never WAIT for an ID
-- lock after a booking lock: try-lock failure aborts instead of deadlocking.
-- Audited writers already hold this transaction lock before any booking lock.
CREATE FUNCTION rd_private.guard_operation_outcome_insert()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
BEGIN
 IF current_setting('transaction_isolation') IS DISTINCT FROM 'read committed' THEN
   RAISE EXCEPTION 'RD_OPERATION_ISOLATION_UNSUPPORTED'; END IF;
 IF NOT pg_catalog.pg_try_advisory_xact_lock(724031,pg_catalog.hashtext(NEW.operation_id::text)) THEN
   RAISE EXCEPTION 'RD_OPERATION_LOCK_REQUIRED'; END IF;
 IF TG_TABLE_NAME='operation_receipts' THEN
   IF EXISTS(SELECT 1 FROM rd_private.operation_terminal_results WHERE operation_id=NEW.operation_id) THEN
     RAISE EXCEPTION 'RD_OPERATION_CLOSED_UNEXECUTED'; END IF;
 ELSIF TG_TABLE_NAME='operation_terminal_results' THEN
   IF EXISTS(SELECT 1 FROM rd_private.operation_receipts WHERE operation_id=NEW.operation_id) THEN
     RAISE EXCEPTION 'RD_OPERATION_ALREADY_COMMITTED'; END IF;
 ELSE RAISE EXCEPTION 'RD_OPERATION_EVIDENCE_TABLE_INVALID'; END IF;
 RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION rd_private.guard_operation_outcome_insert() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER rd_ops_operation_receipt_fence_trg BEFORE INSERT ON rd_private.operation_receipts
 FOR EACH ROW EXECUTE FUNCTION rd_private.guard_operation_outcome_insert();
CREATE TRIGGER rd_ops_operation_terminal_fence_trg BEFORE INSERT ON rd_private.operation_terminal_results
 FOR EACH ROW EXECUTE FUNCTION rd_private.guard_operation_outcome_insert();

CREATE FUNCTION rd_private.deny_operation_evidence_mutation()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
BEGIN RAISE EXCEPTION 'RD_OPERATION_EVIDENCE_IMMUTABLE'; END $fn$;
REVOKE ALL ON FUNCTION rd_private.deny_operation_evidence_mutation() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER rd_ops_operation_receipt_immutable_trg BEFORE UPDATE OR DELETE ON rd_private.operation_receipts
 FOR EACH ROW EXECUTE FUNCTION rd_private.deny_operation_evidence_mutation();
CREATE TRIGGER rd_ops_operation_terminal_immutable_trg BEFORE UPDATE OR DELETE ON rd_private.operation_terminal_results
 FOR EACH ROW EXECUTE FUNCTION rd_private.deny_operation_evidence_mutation();
-- Enhanced completion: customer-signed evidence and an operator-reviewed
-- financial plan. These private rows are inaccessible from the Data API.
CREATE TABLE rd_private.wait_settlement_review (
 request_id uuid PRIMARY KEY REFERENCES rd_private.case_head(request_id) ON DELETE RESTRICT,
 plan_id uuid NOT NULL UNIQUE,
 confirmed_wait_fee_yen bigint NOT NULL CHECK (confirmed_wait_fee_yen >= 0),
 approved_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
 approved_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
-- Original-customer identity must be established by a separately approved
-- authority. No enrollment/provisioning writer is included in this candidate.
-- Booking token + unrelated verified account must NEVER create this binding.
CREATE TABLE rd_private.booking_customer_bindings (
 request_id uuid PRIMARY KEY REFERENCES public.requests(id) ON DELETE RESTRICT,
 customer_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
 payment_session_id uuid NOT NULL REFERENCES public.payment_sessions(id) ON DELETE RESTRICT,
 bound_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 binding_method text NOT NULL CHECK(binding_method='original-customer-authority-reviewed')
);
-- PROSPECTIVE ONLY: immutable proof that a verified customer initiated the
-- Square checkout BEFORE the payment link was returned to the browser.
-- No public table access. Existing/legacy paid reservations have NO origin.
CREATE TABLE rd_private.checkout_customer_origins (
 payment_session_id uuid PRIMARY KEY REFERENCES public.payment_sessions(id) ON DELETE RESTRICT,
 customer_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
 auth_session_id uuid NOT NULL,
 verified_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 binding_method text NOT NULL DEFAULT 'authenticated-before-checkout-v1'
   CHECK(binding_method='authenticated-before-checkout-v1')
);
CREATE INDEX rd_ops_checkout_origin_customer_idx
 ON rd_private.checkout_customer_origins(customer_id,verified_at DESC);
CREATE TABLE rd_private.customer_finish_evidence (
 confirmation_id uuid PRIMARY KEY,
 operation_id uuid NOT NULL UNIQUE,
 request_id uuid NOT NULL REFERENCES rd_private.case_head(request_id) ON DELETE RESTRICT,
 customer_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
 session_id uuid NOT NULL,
 confirmed_wait_fee_yen bigint NOT NULL CHECK (confirmed_wait_fee_yen>=0),
 statement text NOT NULL CHECK(length(btrim(statement))>0 AND length(statement)<=1000),
 evidence_revision bigint NOT NULL CHECK (evidence_revision>0),
 accepted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 revoked_at timestamptz,
 consumed_at timestamptz
);
CREATE UNIQUE INDEX rd_ops_one_unconsumed_finish ON rd_private.customer_finish_evidence(request_id)
 WHERE consumed_at IS NULL AND revoked_at IS NULL;
-- A one-shot internal capability. Only the audited owner RPC may create it.
-- The trigger consumes it during the SAME SQL transaction as the status write.
-- One-shot authenticated nonterminal state transition authorization, consumed
-- by the same trigger guarding ALL updates on enhanced bookings.
CREATE TABLE rd_private.status_transition_intents (
 request_id uuid PRIMARY KEY REFERENCES rd_private.case_head(request_id) ON DELETE RESTRICT,
 operation_id uuid NOT NULL UNIQUE,
 owner_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
 old_status text NOT NULL CHECK(old_status IN ('requested','accepted','en_route','arrived')),
 new_status text NOT NULL CHECK(new_status IN ('accepted','en_route','arrived','driving'))
);
CREATE TABLE rd_private.verified_status_transition_audit (
 operation_id uuid PRIMARY KEY,
 request_id uuid NOT NULL REFERENCES rd_private.case_head(request_id) ON DELETE RESTRICT,
 owner_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
 old_status text NOT NULL,
 new_status text NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE rd_private.terminal_transition_intents (
 request_id uuid PRIMARY KEY REFERENCES rd_private.case_head(request_id) ON DELETE RESTRICT,
 operation_id uuid NOT NULL UNIQUE,
 owner_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
 old_status text NOT NULL,
 new_status text NOT NULL CHECK(new_status='completed'),
 confirmation_id uuid NOT NULL REFERENCES rd_private.customer_finish_evidence(confirmation_id)
);
CREATE TABLE rd_private.verified_finalization_audit (
 operation_id uuid PRIMARY KEY,
 request_id uuid NOT NULL REFERENCES rd_private.case_head(request_id) ON DELETE RESTRICT,
 owner_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
 confirmation_id uuid NOT NULL REFERENCES rd_private.customer_finish_evidence(confirmation_id),
 new_status text NOT NULL CHECK(new_status='completed'),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE rd_private.operator_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE rd_private.operator_session_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE rd_private.ops_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE rd_private.case_head ENABLE ROW LEVEL SECURITY;
ALTER TABLE rd_private.wait_interval ENABLE ROW LEVEL SECURITY;
ALTER TABLE rd_private.operation_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE rd_private.wait_settlement_review ENABLE ROW LEVEL SECURITY;
ALTER TABLE rd_private.customer_finish_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE rd_private.booking_customer_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE rd_private.checkout_customer_origins ENABLE ROW LEVEL SECURITY;
ALTER TABLE rd_private.status_transition_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE rd_private.verified_status_transition_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE rd_private.terminal_transition_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE rd_private.verified_finalization_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA rd_private FROM PUBLIC,anon,authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA rd_private FROM PUBLIC,anon,authenticated;

-- All owner authorization sources are read INSIDE the database and inside the
-- transaction. JWT validation and AAL2 are ALSO required at the Edge boundary.
-- Stage90 fixture is NOT transplanted. Permission row remains empty by default.
-- AAL2 is verified in GoTrue AND current auth.sessions/factors. In addition,
-- sessions must be created AFTER the last generation change, preventing a
-- revoked JWT from being rebound by calling the bind endpoint again.
CREATE FUNCTION rd_private.owner_eligible_generation(
 p_user uuid,p_session uuid,p_aal2 boolean,p_exp bigint
) RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE v_enabled boolean; v_generation bigint; v_changed timestamptz;
 v_factor_id uuid; v_aal text; v_created timestamptz; v_factor boolean; v_not_after timestamptz;
BEGIN
 IF p_user IS NULL OR p_session IS NULL OR p_aal2 IS DISTINCT FROM true OR
    p_exp IS NULL OR p_exp<=EXTRACT(EPOCH FROM clock_timestamp()) THEN RETURN NULL; END IF;
 SELECT g.enabled,g.generation,g.changed_at INTO v_enabled,v_generation,v_changed
   FROM rd_private.operator_grants g WHERE g.user_id=p_user FOR SHARE;
 IF NOT FOUND OR v_enabled IS DISTINCT FROM true THEN RETURN NULL; END IF;
 SELECT s.factor_id,s.aal,s.created_at,s.not_after INTO v_factor_id,v_aal,v_created,v_not_after
   FROM auth.sessions s WHERE s.id=p_session AND s.user_id=p_user AND s.aal='aal2'
   AND (s.not_after IS NULL OR s.not_after>clock_timestamp()) FOR SHARE;
 IF NOT FOUND OR v_factor_id IS NULL OR v_aal IS DISTINCT FROM 'aal2' OR
     v_created<v_changed THEN RETURN NULL; END IF;
 SELECT true INTO v_factor FROM auth.mfa_factors f
   WHERE f.id=v_factor_id AND f.user_id=p_user
     AND f.status='verified' AND f.factor_type='totp' FOR SHARE;
 IF COALESCE(v_factor,false) IS DISTINCT FROM true THEN RETURN NULL; END IF;
 -- Recheck wall-clock expiry after every potentially blocking authority lock.
 IF p_exp<=EXTRACT(EPOCH FROM clock_timestamp()) OR
    (v_not_after IS NOT NULL AND v_not_after<=clock_timestamp()) THEN RETURN NULL; END IF;
 RETURN v_generation;
END $fn$;
REVOKE ALL ON FUNCTION rd_private.owner_eligible_generation(uuid,uuid,boolean,bigint)
 FROM PUBLIC,anon,authenticated;

CREATE FUNCTION rd_private.owner_is_current(p_user uuid,p_session uuid,p_aal2 boolean,p_exp bigint)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE v_generation bigint; v_bound boolean;
BEGIN
 v_generation:=rd_private.owner_eligible_generation(p_user,p_session,p_aal2,p_exp);
 IF v_generation IS NULL THEN RETURN false; END IF;
 SELECT true INTO v_bound FROM rd_private.operator_session_bindings b
   WHERE b.user_id=p_user AND b.session_id=p_session AND b.generation=v_generation FOR SHARE;
 -- Binding lock acquisition can itself wait beyond the JWT/session deadline.
 RETURN COALESCE(v_bound,false) AND
   rd_private.owner_eligible_generation(p_user,p_session,p_aal2,p_exp) IS NOT DISTINCT FROM v_generation;
END $fn$;
REVOKE ALL ON FUNCTION rd_private.owner_is_current(uuid,uuid,boolean,bigint)
 FROM PUBLIC,anon,authenticated;

CREATE FUNCTION public.rd_ops_bind_owner_session_v1(
 p_owner uuid,p_session uuid,p_aal2 boolean,p_exp bigint
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE v_generation bigint;
BEGIN
 v_generation:=rd_private.owner_eligible_generation(p_owner,p_session,p_aal2,p_exp);
 IF v_generation IS NULL THEN RAISE EXCEPTION 'RD_OWNER_BIND_DENIED'; END IF;
 INSERT INTO rd_private.operator_session_bindings(session_id,user_id,generation)
 VALUES(p_session,p_owner,v_generation)
 ON CONFLICT(session_id) DO UPDATE SET
    generation=EXCLUDED.generation,bound_at=clock_timestamp()
    WHERE rd_private.operator_session_bindings.user_id=EXCLUDED.user_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'RD_OWNER_SESSION_CONFLICT'; END IF;
 IF rd_private.owner_eligible_generation(p_owner,p_session,p_aal2,p_exp) IS DISTINCT FROM v_generation THEN
    RAISE EXCEPTION 'RD_OWNER_AUTH_EXPIRED'; END IF;
 RETURN jsonb_build_object('bound',true);
END $fn$;
REVOKE ALL ON FUNCTION public.rd_ops_bind_owner_session_v1(uuid,uuid,boolean,bigint)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.rd_ops_bind_owner_session_v1(uuid,uuid,boolean,bigint)
 TO service_role;

CREATE FUNCTION rd_private.customer_can_read(p_request uuid,p_hash text)
RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path='' AS $fn$
 SELECT p_hash ~ '^[0-9a-f]{64}$' AND EXISTS (
  SELECT 1 FROM public.requests r WHERE r.id=p_request AND r.customer_token_hash=p_hash
 );
$fn$;
REVOKE ALL ON FUNCTION rd_private.customer_can_read(uuid,text) FROM PUBLIC,anon,authenticated;

-- Fail closed on pre-existing bookings whose original customer cannot be
-- verified. Without this gate, a wait could start but never finish safely.
CREATE FUNCTION rd_private.has_original_customer_authority(p_request uuid)
RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path='' AS $fn$
 SELECT EXISTS(
   SELECT 1 FROM rd_private.booking_customer_bindings b
     JOIN public.payment_sessions ps ON ps.id=b.payment_session_id
     WHERE b.request_id=p_request AND ps.request_id=p_request
       AND ps.status IN ('paid','partially_refunded')
       AND b.binding_method='original-customer-authority-reviewed'
 ) OR EXISTS(
   SELECT 1 FROM rd_private.checkout_customer_origins o
     JOIN public.payment_sessions ps ON ps.id=o.payment_session_id
     WHERE ps.request_id=p_request AND ps.status IN ('paid','partially_refunded')
       AND o.binding_method='authenticated-before-checkout-v1'
 );
$fn$;
REVOKE ALL ON FUNCTION rd_private.has_original_customer_authority(uuid) FROM PUBLIC,anon,authenticated;

-- Verified GoTrue identity AND booking-bound capability are required for
-- explicit completion evidence. A booking view-token by itself cannot write.
CREATE FUNCTION rd_private.customer_otp_verified(
 p_request uuid,p_hash text,p_user uuid,p_session uuid,p_exp bigint
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE v_verified boolean; v_not_after timestamptz;
BEGIN
 IF p_request IS NULL OR p_hash IS NULL OR p_hash !~ '^[0-9a-f]{64}$' OR
    p_user IS NULL OR p_session IS NULL OR p_exp IS NULL OR
    p_exp<=EXTRACT(EPOCH FROM clock_timestamp()) THEN RETURN false; END IF;
 IF NOT rd_private.customer_can_read(p_request,p_hash) THEN RETURN false; END IF;
 SELECT true,s.not_after INTO v_verified,v_not_after FROM auth.sessions s JOIN auth.users u ON u.id=s.user_id
  WHERE s.id=p_session AND s.user_id=p_user AND u.is_anonymous IS DISTINCT FROM true
    AND (u.email_confirmed_at IS NOT NULL OR u.phone_confirmed_at IS NOT NULL)
    AND s.aal IN ('aal1','aal2')
    AND (s.not_after IS NULL OR s.not_after>clock_timestamp())
  FOR SHARE OF s,u;
 RETURN COALESCE(v_verified,false) AND p_exp>EXTRACT(EPOCH FROM clock_timestamp()) AND
   (v_not_after IS NULL OR v_not_after>clock_timestamp());
END $fn$;
REVOKE ALL ON FUNCTION rd_private.customer_otp_verified(uuid,text,uuid,uuid,bigint) FROM PUBLIC,anon,authenticated;

-- ONLY Square's verified create_checkout code may invoke this service-role
-- RPC, in the same request that creates the checkout. A post-payment token
-- holder is NEVER allowed to mint a retroactive checkout origin.
CREATE FUNCTION public.rd_ops_record_checkout_origin_v1(
 p_payment_session uuid,p_customer uuid,p_auth_session uuid,p_exp bigint
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE v_now timestamptz; v_created timestamptz; v_not_after timestamptz;
 v_confirmed boolean; v_existing uuid;
BEGIN
 IF p_payment_session IS NULL OR p_customer IS NULL OR p_auth_session IS NULL OR
    p_exp IS NULL THEN RAISE EXCEPTION 'RD_CHECKOUT_ORIGIN_ARGUMENT'; END IF;
 -- Acquire flag lock first, then exactly one pending checkout session row.
 PERFORM 1 FROM rd_private.ops_settings WHERE id=1 AND identity_intake_enabled=true FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'RD_CHECKOUT_ORIGIN_DISABLED'; END IF;
 PERFORM 1 FROM public.payment_sessions ps
   WHERE ps.id=p_payment_session AND ps.status='pending' AND ps.request_id IS NULL FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'RD_CHECKOUT_SESSION_INVALID'; END IF;
 SELECT s.created_at,s.not_after,
    (u.is_anonymous IS DISTINCT FROM true AND
      (u.email_confirmed_at IS NOT NULL OR u.phone_confirmed_at IS NOT NULL))
   INTO v_created,v_not_after,v_confirmed
   FROM auth.sessions s JOIN auth.users u ON u.id=s.user_id
   WHERE s.id=p_auth_session AND s.user_id=p_customer AND s.aal IN ('aal1','aal2')
   FOR SHARE OF s,u;
 IF NOT FOUND OR v_confirmed IS DISTINCT FROM true THEN RAISE EXCEPTION 'RD_CHECKOUT_AUTH_INVALID'; END IF;
 -- Must be a fresh verified login, not a later stolen booking token plus OTP.
 v_now:=clock_timestamp();
 IF v_created>v_now OR v_created<=v_now-interval '10 minutes' OR
    p_exp<=EXTRACT(EPOCH FROM v_now) OR
    (v_not_after IS NOT NULL AND v_not_after<=v_now) THEN
   RAISE EXCEPTION 'RD_CHECKOUT_AUTH_STALE'; END IF;
 INSERT INTO rd_private.checkout_customer_origins
    (payment_session_id,customer_id,auth_session_id,verified_at)
 VALUES(p_payment_session,p_customer,p_auth_session,v_now)
 ON CONFLICT(payment_session_id) DO NOTHING;
 SELECT o.customer_id INTO v_existing FROM rd_private.checkout_customer_origins o
  WHERE o.payment_session_id=p_payment_session FOR SHARE;
 IF v_existing IS DISTINCT FROM p_customer THEN RAISE EXCEPTION 'RD_CHECKOUT_ORIGIN_CONFLICT'; END IF;
 -- Recheck after locks to prevent a stale login from binding a session.
 IF p_exp<=EXTRACT(EPOCH FROM clock_timestamp()) OR
    (v_not_after IS NOT NULL AND v_not_after<=clock_timestamp()) THEN
   RAISE EXCEPTION 'RD_CHECKOUT_AUTH_EXPIRED'; END IF;
 RETURN jsonb_build_object('bound',true);
END $fn$;
REVOKE ALL ON FUNCTION public.rd_ops_record_checkout_origin_v1(uuid,uuid,uuid,bigint)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.rd_ops_record_checkout_origin_v1(uuid,uuid,uuid,bigint)
 TO service_role;

CREATE FUNCTION rd_private.customer_can_finish(
 p_request uuid,p_hash text,p_user uuid,p_session uuid,p_exp bigint
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
BEGIN
 IF NOT rd_private.customer_otp_verified(p_request,p_hash,p_user,p_session,p_exp) THEN
   RETURN false; END IF;
 -- Either an independently approved legacy binding OR a prospective
 -- authenticated checkout origin created BEFORE the Square link was issued.
 PERFORM 1 FROM rd_private.booking_customer_bindings b
   JOIN public.payment_sessions ps ON ps.id=b.payment_session_id
    WHERE b.request_id=p_request AND b.customer_id=p_user
      AND ps.request_id=p_request AND ps.status IN ('paid','partially_refunded')
      AND b.binding_method='original-customer-authority-reviewed' FOR SHARE OF b,ps;
 IF NOT FOUND THEN
   PERFORM 1 FROM rd_private.checkout_customer_origins o
      JOIN public.payment_sessions ps ON ps.id=o.payment_session_id
      WHERE ps.request_id=p_request AND o.customer_id=p_user
        AND ps.status IN ('paid','partially_refunded') FOR SHARE OF o,ps;
   IF NOT FOUND THEN RETURN false; END IF;
 END IF;
 RETURN rd_private.customer_otp_verified(p_request,p_hash,p_user,p_session,p_exp);
END $fn$;
REVOKE ALL ON FUNCTION rd_private.customer_can_finish(uuid,text,uuid,uuid,bigint) FROM PUBLIC,anon,authenticated;

-- Verify an existing independently authorized original-customer binding only.
-- This RPC MUST NOT provision a binding from booking-token possession or OTP.
-- The binding authority/provisioning contract remains unconfirmed; absent rows deny.
CREATE FUNCTION public.rd_ops_bind_customer_v1(
 p_request uuid,p_customer uuid,p_session uuid,p_customer_hash text,p_exp bigint
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
BEGIN
 -- Match all writer lock order: booking first, then authorization sources.
 PERFORM 1 FROM public.requests WHERE id=p_request FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'RD_BOOKING_NOT_FOUND'; END IF;
 IF NOT EXISTS(SELECT 1 FROM rd_private.ops_settings WHERE id=1 AND enabled=true FOR SHARE) THEN
    RAISE EXCEPTION 'RD_OPERATION_DISABLED'; END IF;
 IF NOT rd_private.customer_can_finish(p_request,p_customer_hash,p_customer,p_session,p_exp) THEN
    RAISE EXCEPTION 'RD_ORIGINAL_CUSTOMER_BINDING_REQUIRED'; END IF;
 PERFORM 1 FROM rd_private.booking_customer_bindings b
    JOIN public.payment_sessions ps ON ps.id=b.payment_session_id AND ps.request_id=b.request_id
    WHERE b.request_id=p_request AND b.customer_id=p_customer
      AND b.binding_method='original-customer-authority-reviewed'
      AND ps.status IN ('paid','partially_refunded') FOR SHARE OF b,ps;
 IF NOT FOUND THEN
   PERFORM 1 FROM rd_private.checkout_customer_origins o
      JOIN public.payment_sessions ps ON ps.id=o.payment_session_id
      WHERE ps.request_id=p_request AND o.customer_id=p_customer
        AND ps.status IN ('paid','partially_refunded') FOR SHARE OF o,ps;
   IF NOT FOUND THEN RAISE EXCEPTION 'RD_PAYMENT_NOT_CONFIRMED'; END IF;
 END IF;
 IF NOT rd_private.customer_can_finish(p_request,p_customer_hash,p_customer,p_session,p_exp) THEN
    RAISE EXCEPTION 'RD_CUSTOMER_AUTH_EXPIRED'; END IF;
 RETURN jsonb_build_object('bound',true);
END $fn$;
REVOKE ALL ON FUNCTION public.rd_ops_bind_customer_v1(uuid,uuid,uuid,text,bigint)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.rd_ops_bind_customer_v1(uuid,uuid,uuid,text,bigint) TO service_role;

CREATE FUNCTION rd_private.wait_charge(p_elapsed_ms bigint)
RETURNS bigint LANGUAGE sql IMMUTABLE STRICT SET search_path='' AS $fn$
 -- Stage28 policy: first 300 whole seconds free, then ceil(each 600s)*500 yen.
 SELECT CASE WHEN (p_elapsed_ms/1000)<=300 THEN 0 ELSE
     (((p_elapsed_ms/1000)-300+599)/600)*500 END;
$fn$;
REVOKE ALL ON FUNCTION rd_private.wait_charge(bigint) FROM PUBLIC,anon,authenticated;

-- Only Edge service_role can invoke this. Customer branch is read-only.
-- Snapshot does not mutate business rows. SHARE booking lock keeps cooperating
-- booking writers from mixing revisions across the following reads. All writers
-- must obey this lock; full writer-cutover/concurrency verification is still pending.
CREATE FUNCTION public.rd_ops_snapshot_v1(
  p_request uuid,p_actor text,p_owner uuid,p_session uuid,p_aal2 boolean,p_customer_hash text,p_exp bigint
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE r public.requests%ROWTYPE; head_revision bigint:=0;
  v_active rd_private.wait_interval%ROWTYPE; v_review rd_private.wait_interval%ROWTYPE;
  v_total_ms bigint:=0; v_observed_ms bigint:=0; v_elapsed_ms bigint:=0;
  v_fee bigint:=0; v_wait_state text:='idle'; v_confirmed jsonb:='null'::jsonb;
  v_estimated jsonb:='0'::jsonb; v_route jsonb; v_history jsonb:='[]'::jsonb;
  v_now timestamptz; v_has_intervals boolean:=false;
  v_plan uuid; v_reviewed boolean:=false; v_end rd_private.customer_finish_evidence%ROWTYPE;
  v_final_fee bigint:=0; v_can_finish boolean:=false; v_customer_finish_available boolean:=false;
  v_settle_state text:='none'; v_settle_plan jsonb:='null'::jsonb;
  v_settle_due jsonb:='null'::jsonb;
  v_enrolled boolean:=false; v_write_ready boolean:=false;

BEGIN
 SELECT * INTO r FROM public.requests WHERE id=p_request FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'RD_BOOKING_NOT_FOUND'; END IF;
 IF p_actor='operator' THEN
   IF NOT rd_private.owner_is_current(p_owner,p_session,p_aal2,p_exp) THEN RAISE EXCEPTION 'RD_OWNER_AUTH_DENIED'; END IF;
 ELSIF p_actor='customer' THEN
   IF NOT rd_private.customer_can_read(p_request,p_customer_hash) THEN RAISE EXCEPTION 'RD_CUSTOMER_READ_DENIED'; END IF;
 ELSE RAISE EXCEPTION 'RD_UNKNOWN_ACTOR'; END IF;
 v_now:=clock_timestamp();
 SELECT h.revision INTO head_revision FROM rd_private.case_head h WHERE h.request_id=p_request;
 v_enrolled:=FOUND;
 head_revision:=COALESCE(head_revision,0);
 v_write_ready:=v_enrolled AND rd_private.has_original_customer_authority(p_request) AND
   EXISTS(SELECT 1 FROM rd_private.ops_settings WHERE id=1 AND enabled=true) AND
   EXISTS(SELECT 1 FROM pg_catalog.pg_trigger t
     WHERE t.tgname='rd_ops_legacy_writer_guard_trg'
       AND t.tgrelid=pg_catalog.to_regclass('public.requests')
       AND t.tgfoid=pg_catalog.to_regprocedure('rd_private.guard_legacy_status_change()')
       AND t.tgenabled IN ('O','A') AND t.tgtype=19 AND NOT t.tgisinternal);
 SELECT * INTO v_active FROM rd_private.wait_interval i
   WHERE i.request_id=p_request AND i.phase='active' LIMIT 1;
 SELECT * INTO v_review FROM rd_private.wait_interval i
   WHERE i.request_id=p_request AND i.phase='review' LIMIT 1;
 SELECT EXISTS(SELECT 1 FROM rd_private.wait_interval i WHERE i.request_id=p_request) INTO v_has_intervals;
 SELECT COALESCE(SUM(CASE WHEN i.phase='final' THEN i.billed_ms ELSE 0 END),0),
        COALESCE(SUM(CASE WHEN i.claimed_at IS NOT NULL THEN
             GREATEST(0,FLOOR(EXTRACT(EPOCH FROM (i.claimed_at-i.started_at))*1000)::bigint)
          ELSE 0 END),0)
   INTO v_total_ms,v_observed_ms FROM rd_private.wait_interval i WHERE i.request_id=p_request;
 IF v_active.interval_id IS NOT NULL THEN
   v_wait_state:='running';
   v_observed_ms:=v_observed_ms+GREATEST(0,FLOOR(EXTRACT(EPOCH FROM (v_now-v_active.started_at))*1000)::bigint);
   v_elapsed_ms:=v_total_ms+GREATEST(0,FLOOR(EXTRACT(EPOCH FROM (v_now-v_active.started_at))*1000)::bigint);
   v_estimated:=to_jsonb(rd_private.wait_charge(v_elapsed_ms));
 ELSIF v_review.interval_id IS NOT NULL THEN
   v_wait_state:='review';v_elapsed_ms:=v_total_ms;v_estimated:='null'::jsonb;
 ELSIF v_has_intervals THEN
   v_wait_state:='final';v_elapsed_ms:=v_total_ms;
   v_confirmed:=to_jsonb(rd_private.wait_charge(v_elapsed_ms));v_estimated:='null'::jsonb;
 ELSE
   v_elapsed_ms:=0;
 END IF;
 IF v_wait_state IN ('final','idle') AND r.status='driving' THEN
   v_final_fee:=rd_private.wait_charge(v_total_ms);
   v_customer_finish_available:=true;
   IF v_final_fee>0 THEN
     v_plan:=(md5(p_request::text || ':wait-settlement'))::uuid;
     v_settle_plan:=to_jsonb(v_plan);v_settle_due:=to_jsonb(v_final_fee);
     SELECT true INTO v_reviewed FROM rd_private.wait_settlement_review sr
       WHERE sr.request_id=p_request AND sr.plan_id=v_plan AND
         sr.confirmed_wait_fee_yen=v_final_fee;
     v_reviewed:=COALESCE(v_reviewed,false);
     v_settle_state:=CASE WHEN v_reviewed THEN 'final' ELSE 'pending' END;
     IF NOT v_reviewed THEN v_customer_finish_available:=false; END IF;
   END IF;
   SELECT * INTO v_end FROM rd_private.customer_finish_evidence e
     WHERE e.request_id=p_request AND e.consumed_at IS NULL AND e.revoked_at IS NULL
       AND e.evidence_revision=head_revision AND e.confirmed_wait_fee_yen=v_final_fee
       AND e.accepted_at<=v_now AND e.accepted_at>v_now-interval '24 hours'
     LIMIT 1;
   v_can_finish:=v_customer_finish_available AND v_end.confirmation_id IS NOT NULL;
 END IF;
 -- Stable, read-only first/last visit IDs. This does not change existing booking.
 v_route:=jsonb_build_object('points',jsonb_build_array(
   jsonb_build_object('visitId',p_request,'address',r.pickup_address),
   jsonb_build_object('visitId',(md5(p_request::text || ':destination'))::uuid,'address',r.destination_address)
 ));
 SELECT COALESCE(jsonb_agg(x ORDER BY x.at),'[]'::jsonb) INTO v_history FROM (
   SELECT operation_id AS "operationId",action, FLOOR(EXTRACT(EPOCH FROM accepted_at)*1000)::bigint AS at,
     'committed'::text AS result FROM rd_private.operation_receipts
   WHERE request_id=p_request ORDER BY accepted_at DESC LIMIT 40
 ) x;
 IF p_actor='operator' AND NOT rd_private.owner_is_current(p_owner,p_session,p_aal2,p_exp) THEN
   RAISE EXCEPTION 'RD_OWNER_AUTH_EXPIRED'; END IF;
 RETURN jsonb_build_object(
   'schemaVersion',1,'requestId',p_request,'revision',head_revision,
   'serverNow',FLOOR(EXTRACT(EPOCH FROM v_now)*1000)::bigint,'status',r.status,
   'wait',jsonb_build_object('state',v_wait_state,'policyVersion','demo-total-5m-10m-500-v1',
      'elapsedMs',v_elapsed_ms,'observedMs',v_observed_ms,
      'confirmedFeeYen',v_confirmed,'estimateFeeYen',v_estimated,
      'activeIntervalId',v_active.interval_id,'reviewIntervalId',v_review.interval_id),
   'route',v_route,'proposal',null,
   'settlement',jsonb_build_object('state',v_settle_state,'additionalDueYen',v_settle_due,
      'refundExpectedYen',null,'paidConfirmed',false,'planId',v_settle_plan),
   'canFinish',(v_write_ready AND v_can_finish),'customerConfirmationId',v_end.confirmation_id,'history',v_history,
   'capabilities',jsonb_build_object('wait',(
     rd_private.has_original_customer_authority(p_request) AND v_enrolled AND
     EXISTS(SELECT 1 FROM rd_private.ops_settings WHERE id=1 AND enabled=true) AND
     EXISTS(SELECT 1 FROM pg_catalog.pg_trigger t
       WHERE t.tgname='rd_ops_legacy_writer_guard_trg'
         AND t.tgrelid=pg_catalog.to_regclass('public.requests')
         AND t.tgfoid=pg_catalog.to_regprocedure('rd_private.guard_legacy_status_change()')
         AND t.tgenabled IN ('O','A') AND t.tgtype=19 AND NOT t.tgisinternal)),
     'statusTransitions',(p_actor='operator' AND
       rd_private.has_original_customer_authority(p_request) AND v_enrolled AND
       EXISTS(SELECT 1 FROM rd_private.ops_settings WHERE id=1 AND enabled=true) AND
       EXISTS(SELECT 1 FROM pg_catalog.pg_trigger t
         WHERE t.tgname='rd_ops_legacy_writer_guard_trg'
           AND t.tgrelid=pg_catalog.to_regclass('public.requests')
           AND t.tgfoid=pg_catalog.to_regprocedure('rd_private.guard_legacy_status_change()')
           AND t.tgenabled IN ('O','A') AND t.tgtype=19 AND NOT t.tgisinternal)),
     'routes',false,'customerConsent',false,
     'customerFinish',(v_write_ready AND v_customer_finish_available),
     'settlement',(v_write_ready AND v_wait_state IN ('final','idle') AND r.status='driving')));
END $fn$;
REVOKE ALL ON FUNCTION public.rd_ops_snapshot_v1(uuid,text,uuid,uuid,boolean,text,bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.rd_ops_snapshot_v1(uuid,text,uuid,uuid,boolean,text,bigint) TO service_role;

-- Atomic wait-only writer. The globally disabled switch is a deliberate
-- deployment guard; owner must explicitly approve test/batch roll-out later.
CREATE FUNCTION public.rd_ops_submit_v1(
 p_request uuid,p_owner uuid,p_session uuid,p_aal2 boolean,
 p_op uuid,p_expected_rev bigint,p_hash text,p_action text,p_payload jsonb,p_exp bigint
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE r public.requests%ROWTYPE; h rd_private.case_head%ROWTYPE;
 v_old rd_private.operation_receipts%ROWTYPE; v_now timestamptz;
 v_interval uuid; v_mode text; v_reason text;
 v_final_fee bigint:=0; v_plan uuid; v_finish_id uuid;
 v_evidence rd_private.customer_finish_evidence%ROWTYPE;
 v_next_status text;
BEGIN
 IF p_request IS NULL OR p_owner IS NULL OR p_session IS NULL OR p_op IS NULL OR
    p_expected_rev IS NULL OR p_expected_rev<0 OR p_payload IS NULL OR
    p_hash IS NULL OR p_hash !~ '^[0-9a-f]{64}$' OR p_aal2 IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'RD_INVALID_ARGUMENT'; END IF;
 -- Only these audited, original UI actions are included in this stage.
 IF p_action IS NULL OR p_action NOT IN ('status_transition','wait_start','wait_stop_claim','wait_confirm',
     'settlement_approve','complete_request') THEN
    RAISE EXCEPTION 'RD_ACTION_NOT_IMPLEMENTED'; END IF;
 -- Lock booking first: any future legacy writer must acquire same lock.
 -- Global operation ID first, before booking/auth/case locks.
 PERFORM rd_private.lock_operation_id(p_op);
 SELECT * INTO r FROM public.requests WHERE id=p_request FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'RD_BOOKING_NOT_FOUND'; END IF;
 IF NOT rd_private.owner_is_current(p_owner,p_session,p_aal2,p_exp) THEN RAISE EXCEPTION 'RD_OWNER_AUTH_DENIED'; END IF;
 IF NOT EXISTS(SELECT 1 FROM rd_private.ops_settings WHERE id=1 AND enabled=true FOR SHARE) OR
    NOT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger t
       WHERE t.tgname='rd_ops_legacy_writer_guard_trg'
         AND t.tgrelid=pg_catalog.to_regclass('public.requests')
         AND t.tgfoid=pg_catalog.to_regprocedure('rd_private.guard_legacy_status_change()')
         AND t.tgenabled IN ('O','A') AND t.tgtype=19 AND NOT t.tgisinternal) THEN
   RAISE EXCEPTION 'RD_OPERATION_DISABLED'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.payment_sessions p WHERE p.request_id=p_request AND p.status IN ('paid','partially_refunded')) THEN
   RAISE EXCEPTION 'RD_PAYMENT_NOT_CONFIRMED'; END IF;
 IF NOT rd_private.has_original_customer_authority(p_request) THEN
   RAISE EXCEPTION 'RD_ORIGINAL_CUSTOMER_NOT_AUTHORIZED'; END IF;
 -- Do not implicitly move an old/disabled-at-first-link booking into new scope.
 SELECT * INTO h FROM rd_private.case_head WHERE request_id=p_request FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'RD_CASE_NOT_ENROLLED'; END IF;
 PERFORM rd_private.assert_operation_not_closed(p_request,p_owner,p_op,p_expected_rev,p_hash,p_action,p_payload);
 SELECT * INTO v_old FROM rd_private.operation_receipts WHERE operation_id=p_op;
 IF FOUND THEN
   IF v_old.request_id IS DISTINCT FROM p_request OR v_old.actor_id IS DISTINCT FROM p_owner OR
      v_old.envelope_hash IS DISTINCT FROM p_hash OR v_old.action IS DISTINCT FROM p_action OR
      v_old.expected_revision IS DISTINCT FROM p_expected_rev OR v_old.body IS DISTINCT FROM p_payload
   THEN RAISE EXCEPTION 'RD_OPERATION_ID_REUSED'; END IF;
   RETURN jsonb_build_object('accepted',true,'operationId',p_op,'pendingIndependentLookup',true);
 END IF;
 IF h.revision IS DISTINCT FROM p_expected_rev THEN RAISE EXCEPTION 'RD_REVISION_CONFLICT'; END IF;
 IF (p_action IN ('wait_start','wait_stop_claim','wait_confirm') AND r.status NOT IN ('arrived','driving')) OR
    (p_action IN ('settlement_approve','complete_request') AND r.status<>'driving') THEN
    RAISE EXCEPTION 'RD_INVALID_BOOKING_STATE'; END IF;
 v_now:=clock_timestamp();
 IF jsonb_typeof(p_payload) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'RD_PAYLOAD_INVALID'; END IF;
 IF p_action='status_transition' THEN
   IF (SELECT COUNT(*) FROM jsonb_object_keys(p_payload))<>1 OR
      NOT (p_payload ? 'nextStatus') THEN RAISE EXCEPTION 'RD_STATUS_PAYLOAD_INVALID'; END IF;
   v_next_status:=p_payload->>'nextStatus';
   IF NOT ((r.status='requested' AND v_next_status='accepted') OR
           (r.status='accepted' AND v_next_status='en_route') OR
           (r.status='en_route' AND v_next_status='arrived') OR
           (r.status='arrived' AND v_next_status='driving')) THEN
      RAISE EXCEPTION 'RD_STATUS_TRANSITION_UNAVAILABLE'; END IF;
   IF EXISTS(SELECT 1 FROM rd_private.wait_interval i
       WHERE i.request_id=p_request AND i.phase IN ('active','review')) THEN
      RAISE EXCEPTION 'RD_STATUS_WITH_UNRESOLVED_WAIT'; END IF;
   INSERT INTO rd_private.status_transition_intents
     (request_id,operation_id,owner_id,old_status,new_status)
     VALUES(p_request,p_op,p_owner,r.status,v_next_status);
   UPDATE public.requests SET status=v_next_status,updated_at=v_now
     WHERE id=p_request AND status=r.status;
   IF NOT FOUND THEN RAISE EXCEPTION 'RD_STATUS_RACE'; END IF;
   IF EXISTS(SELECT 1 FROM rd_private.status_transition_intents ti
       WHERE ti.request_id=p_request AND ti.operation_id=p_op) THEN
     RAISE EXCEPTION 'RD_STATUS_INTENT_NOT_CONSUMED'; END IF;
   INSERT INTO rd_private.verified_status_transition_audit
     (operation_id,request_id,owner_id,old_status,new_status,recorded_at)
     VALUES(p_op,p_request,p_owner,r.status,v_next_status,v_now);
 ELSIF p_action='wait_start' THEN
   IF (SELECT COUNT(*) FROM jsonb_object_keys(p_payload))<>2 OR
      NOT (p_payload ? 'kind' AND p_payload ? 'notified') OR
      (p_payload->>'kind') IS NULL OR p_payload->>'kind' NOT IN ('pickup','stop') OR
      p_payload->'notified' IS DISTINCT FROM 'true'::jsonb OR
      (p_payload->>'kind'='pickup' AND r.status<>'arrived') OR
      (SELECT count(*) FROM rd_private.wait_interval i WHERE i.request_id=p_request AND i.phase IN ('active','review'))<>0 THEN
      RAISE EXCEPTION 'RD_WAIT_START_REJECTED'; END IF;
   INSERT INTO rd_private.wait_interval(request_id,interval_id,kind,phase,started_at)
   VALUES(p_request,p_op,p_payload->>'kind','active',v_now);
 ELSIF p_action='wait_stop_claim' THEN
   IF (SELECT COUNT(*) FROM jsonb_object_keys(p_payload))<>1 OR NOT (p_payload ? 'intervalId') THEN
      RAISE EXCEPTION 'RD_PAYLOAD_INVALID'; END IF;
   v_interval:=(p_payload->>'intervalId')::uuid;
   UPDATE rd_private.wait_interval SET phase='review',claimed_at=v_now
     WHERE request_id=p_request AND interval_id=v_interval AND phase='active';
   IF NOT FOUND THEN RAISE EXCEPTION 'RD_WAIT_INTERVAL_NOT_ACTIVE'; END IF;
 ELSIF p_action='wait_confirm' THEN
   IF (SELECT COUNT(*) FROM jsonb_object_keys(p_payload))<>3 OR
      NOT (p_payload ? 'intervalId' AND p_payload ? 'mode' AND p_payload ? 'reason') THEN
      RAISE EXCEPTION 'RD_PAYLOAD_INVALID'; END IF;
   v_interval:=(p_payload->>'intervalId')::uuid;
   v_mode:=p_payload->>'mode';v_reason:=p_payload->>'reason';
   IF v_mode IS NULL OR v_mode NOT IN ('confirm','waive') OR v_reason IS NULL OR length(btrim(v_reason))=0 OR length(v_reason)>1000 THEN
     RAISE EXCEPTION 'RD_WAIT_REVIEW_INVALID'; END IF;
   UPDATE rd_private.wait_interval SET phase=CASE WHEN v_mode='confirm' THEN 'final' ELSE 'waived' END,
     confirmed_at=v_now, reason=v_reason,
     billed_ms=CASE WHEN v_mode='confirm' THEN GREATEST(0,FLOOR(EXTRACT(EPOCH FROM (claimed_at-started_at))*1000)::bigint) ELSE 0 END
     WHERE request_id=p_request AND interval_id=v_interval AND phase='review';
   IF NOT FOUND THEN RAISE EXCEPTION 'RD_WAIT_REVIEW_NOT_FOUND'; END IF;
 ELSIF p_action='settlement_approve' THEN
   IF (SELECT COUNT(*) FROM jsonb_object_keys(p_payload))<>2 OR
      p_payload->'confirmed' IS DISTINCT FROM 'true'::jsonb OR NOT (p_payload ? 'planId') THEN
     RAISE EXCEPTION 'RD_SETTLEMENT_APPROVAL_REQUIRED'; END IF;
   v_plan:=(md5(p_request::text || ':wait-settlement'))::uuid;
   IF p_payload->>'planId' IS DISTINCT FROM v_plan::text OR
      EXISTS(SELECT 1 FROM rd_private.wait_interval i
             WHERE i.request_id=p_request AND i.phase IN ('active','review')) THEN
      RAISE EXCEPTION 'RD_SETTLEMENT_NOT_READY'; END IF;
   SELECT rd_private.wait_charge(COALESCE(SUM(i.billed_ms),0)::bigint) INTO v_final_fee
      FROM rd_private.wait_interval i WHERE i.request_id=p_request AND i.phase='final';
   IF v_final_fee<=0 THEN RAISE EXCEPTION 'RD_NO_SETTLEMENT_DUE'; END IF;
   INSERT INTO rd_private.wait_settlement_review(request_id,plan_id,confirmed_wait_fee_yen,approved_by,approved_at)
     VALUES(p_request,v_plan,v_final_fee,p_owner,v_now)
     ON CONFLICT(request_id) DO UPDATE SET
       confirmed_wait_fee_yen=EXCLUDED.confirmed_wait_fee_yen,
       approved_by=EXCLUDED.approved_by,approved_at=EXCLUDED.approved_at;
 ELSIF p_action='complete_request' THEN
   IF (SELECT COUNT(*) FROM jsonb_object_keys(p_payload))<>1 OR NOT (p_payload ? 'customerConfirmationId') THEN
     RAISE EXCEPTION 'RD_COMPLETION_EVIDENCE_REQUIRED'; END IF;
   v_finish_id:=(p_payload->>'customerConfirmationId')::uuid;
   IF EXISTS(SELECT 1 FROM rd_private.wait_interval i
       WHERE i.request_id=p_request AND i.phase IN ('active','review')) THEN
     RAISE EXCEPTION 'RD_UNRESOLVED_WAIT'; END IF;
   SELECT rd_private.wait_charge(COALESCE(SUM(i.billed_ms),0)::bigint) INTO v_final_fee
     FROM rd_private.wait_interval i WHERE i.request_id=p_request AND i.phase='final';
   IF v_final_fee>0 AND NOT EXISTS(SELECT 1 FROM rd_private.wait_settlement_review sr
       WHERE sr.request_id=p_request AND sr.plan_id=(md5(p_request::text || ':wait-settlement'))::uuid
         AND sr.confirmed_wait_fee_yen=v_final_fee) THEN
     RAISE EXCEPTION 'RD_SETTLEMENT_NOT_APPROVED'; END IF;
   SELECT * INTO v_evidence FROM rd_private.customer_finish_evidence e
     WHERE e.request_id=p_request AND e.confirmation_id=v_finish_id AND e.consumed_at IS NULL
       AND e.revoked_at IS NULL AND e.evidence_revision=h.revision
       AND e.confirmed_wait_fee_yen=v_final_fee AND e.accepted_at<=v_now
       AND e.accepted_at>v_now-interval '24 hours' FOR UPDATE;
   IF NOT FOUND THEN RAISE EXCEPTION 'RD_VERIFIED_CUSTOMER_FINISH_REQUIRED'; END IF;
   -- One-shot intent is invisible to the old driver-api and to the Data API.
   -- A trigger consumes it within this same transaction; no persistent bypass.
   INSERT INTO rd_private.terminal_transition_intents
      (request_id,operation_id,owner_id,old_status,new_status,confirmation_id)
      VALUES (p_request,p_op,p_owner,'driving','completed',v_finish_id);
   UPDATE public.requests SET status='completed',updated_at=v_now
     WHERE id=p_request AND status='driving';
   IF NOT FOUND THEN RAISE EXCEPTION 'RD_TERMINAL_STATUS_CONFLICT'; END IF;
   IF EXISTS(SELECT 1 FROM rd_private.terminal_transition_intents ti
       WHERE ti.request_id=p_request AND ti.operation_id=p_op) THEN
     RAISE EXCEPTION 'RD_TERMINAL_INTENT_NOT_CONSUMED'; END IF;
   UPDATE rd_private.customer_finish_evidence e SET consumed_at=v_now
     WHERE e.confirmation_id=v_finish_id AND e.consumed_at IS NULL;
   IF NOT FOUND THEN RAISE EXCEPTION 'RD_EVIDENCE_RACE'; END IF;
   INSERT INTO rd_private.verified_finalization_audit
      (operation_id,request_id,owner_id,confirmation_id,new_status,recorded_at)
      VALUES(p_op,p_request,p_owner,v_finish_id,'completed',v_now);
 END IF;
 -- Reauthorize after holding booking/receipt/evidence locks; any expired JWT
 -- or revoked factor/session causes rollback of the entire SQL transaction.
 IF NOT rd_private.owner_is_current(p_owner,p_session,p_aal2,p_exp) THEN
    RAISE EXCEPTION 'RD_OWNER_AUTH_EXPIRED'; END IF;
 UPDATE rd_private.case_head SET revision=revision+1,updated_at=v_now WHERE request_id=p_request RETURNING * INTO h;
 INSERT INTO rd_private.operation_receipts(operation_id,request_id,actor_id,action,envelope_hash,
    expected_revision,body,committed_revision,accepted_at)
 VALUES(p_op,p_request,p_owner,p_action,p_hash,p_expected_rev,p_payload,h.revision,v_now);
 RETURN jsonb_build_object('accepted',true,'operationId',p_op,'pendingIndependentLookup',true);
END $fn$;
REVOKE ALL ON FUNCTION public.rd_ops_submit_v1(uuid,uuid,uuid,boolean,uuid,bigint,text,text,jsonb,bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.rd_ops_submit_v1(uuid,uuid,uuid,boolean,uuid,bigint,text,text,jsonb,bigint) TO service_role;

-- Independently authenticated customer confirmation (GoTrue email/phone verified).
-- The booking token is STILL required; JWT alone cannot choose a booking.
-- Does not authorize route consent, settlement payments or Square actions.
CREATE FUNCTION public.rd_ops_customer_finish_v1(
 p_request uuid,p_customer uuid,p_session uuid,p_customer_hash text,p_exp bigint,
 p_op uuid,p_expected_rev bigint,p_hash text,p_action text,p_payload jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE r public.requests%ROWTYPE; h rd_private.case_head%ROWTYPE;
 v_old rd_private.operation_receipts%ROWTYPE; v_fee bigint; v_now timestamptz;
BEGIN
 IF p_request IS NULL OR p_customer IS NULL OR p_session IS NULL OR p_op IS NULL OR
    p_expected_rev IS NULL OR p_expected_rev<0 OR p_payload IS NULL OR
    p_hash IS NULL OR p_hash !~ '^[0-9a-f]{64}$' OR
    p_action IS DISTINCT FROM 'customer_finish_confirmation' THEN
    RAISE EXCEPTION 'RD_CUSTOMER_ACTION_DENIED'; END IF;
 -- Global operation ID first, before booking/auth/case locks.
 PERFORM rd_private.lock_operation_id(p_op);
 SELECT * INTO r FROM public.requests WHERE id=p_request FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'RD_BOOKING_NOT_FOUND'; END IF;
 IF NOT rd_private.customer_can_finish(p_request,p_customer_hash,p_customer,p_session,p_exp) THEN
    RAISE EXCEPTION 'RD_CUSTOMER_AUTH_DENIED'; END IF;
 IF NOT EXISTS(SELECT 1 FROM rd_private.ops_settings WHERE id=1 AND enabled=true FOR SHARE) OR
    NOT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger t
      WHERE t.tgname='rd_ops_legacy_writer_guard_trg'
        AND t.tgrelid=pg_catalog.to_regclass('public.requests')
        AND t.tgfoid=pg_catalog.to_regprocedure('rd_private.guard_legacy_status_change()')
        AND t.tgenabled IN ('O','A') AND t.tgtype=19 AND NOT t.tgisinternal) THEN
    RAISE EXCEPTION 'RD_OPERATION_DISABLED'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.payment_sessions ps
      WHERE ps.request_id=p_request AND ps.status IN ('paid','partially_refunded')) THEN
      RAISE EXCEPTION 'RD_PAYMENT_NOT_CONFIRMED'; END IF;
 -- Do not implicitly move an old/disabled-at-first-link booking into new scope.
 SELECT * INTO h FROM rd_private.case_head WHERE request_id=p_request FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'RD_CASE_NOT_ENROLLED'; END IF;
 PERFORM rd_private.assert_operation_not_closed(p_request,p_customer,p_op,p_expected_rev,p_hash,p_action,p_payload);
 SELECT * INTO v_old FROM rd_private.operation_receipts WHERE operation_id=p_op;
 IF FOUND THEN
   IF v_old.request_id IS DISTINCT FROM p_request OR v_old.actor_id IS DISTINCT FROM p_customer OR
      v_old.envelope_hash IS DISTINCT FROM p_hash OR v_old.action IS DISTINCT FROM p_action OR
      v_old.expected_revision IS DISTINCT FROM p_expected_rev OR v_old.body IS DISTINCT FROM p_payload
   THEN RAISE EXCEPTION 'RD_OPERATION_ID_REUSED'; END IF;
   RETURN jsonb_build_object('accepted',true,'operationId',p_op,'pendingIndependentLookup',true);
 END IF;
 IF r.status<>'driving' OR h.revision IS DISTINCT FROM p_expected_rev THEN
   RAISE EXCEPTION 'RD_CUSTOMER_FINISH_STALE'; END IF;
 IF jsonb_typeof(p_payload) IS DISTINCT FROM 'object' OR
    (SELECT COUNT(*) FROM jsonb_object_keys(p_payload))<>3 OR
    p_payload->'confirmed' IS DISTINCT FROM 'true'::jsonb OR
    p_payload->>'statement' IS NULL OR length(btrim(p_payload->>'statement'))=0 OR
    length(p_payload->>'statement')>1000 OR
    jsonb_typeof(p_payload->'confirmedWaitFeeYen') IS DISTINCT FROM 'number' THEN
      RAISE EXCEPTION 'RD_CUSTOMER_EVIDENCE_INVALID'; END IF;
 IF EXISTS(SELECT 1 FROM rd_private.wait_interval i
       WHERE i.request_id=p_request AND i.phase IN ('active','review')) THEN
      RAISE EXCEPTION 'RD_UNRESOLVED_WAIT'; END IF;
 SELECT rd_private.wait_charge(COALESCE(SUM(i.billed_ms),0)::bigint) INTO v_fee
   FROM rd_private.wait_interval i WHERE i.request_id=p_request AND i.phase='final';
 IF (p_payload->>'confirmedWaitFeeYen') !~ '^(0|[1-9][0-9]*)$' OR
    (p_payload->>'confirmedWaitFeeYen')::bigint IS DISTINCT FROM v_fee THEN
    RAISE EXCEPTION 'RD_CUSTOMER_FEE_STALE'; END IF;
 IF v_fee>0 AND NOT EXISTS(SELECT 1 FROM rd_private.wait_settlement_review sr
     WHERE sr.request_id=p_request AND sr.plan_id=(md5(p_request::text || ':wait-settlement'))::uuid
       AND sr.confirmed_wait_fee_yen=v_fee) THEN RAISE EXCEPTION 'RD_SETTLEMENT_NOT_APPROVED'; END IF;
 v_now:=clock_timestamp();
 UPDATE rd_private.customer_finish_evidence SET revoked_at=v_now
    WHERE request_id=p_request AND consumed_at IS NULL AND revoked_at IS NULL;
 INSERT INTO rd_private.customer_finish_evidence
    (confirmation_id,operation_id,request_id,customer_id,session_id,
     confirmed_wait_fee_yen,statement,evidence_revision,accepted_at)
    VALUES(p_op,p_op,p_request,p_customer,p_session,v_fee,p_payload->>'statement',h.revision+1,v_now);
 -- Lock-protected final authentication check prevents late revocation while
 -- the confirmation is being stored. Never infer identity from the view token.
 IF NOT rd_private.customer_can_finish(p_request,p_customer_hash,p_customer,p_session,p_exp) THEN
    RAISE EXCEPTION 'RD_CUSTOMER_AUTH_EXPIRED'; END IF;
 UPDATE rd_private.case_head SET revision=revision+1,updated_at=v_now WHERE request_id=p_request;
 INSERT INTO rd_private.operation_receipts
    (operation_id,request_id,actor_id,action,envelope_hash,expected_revision,body,committed_revision,accepted_at)
    VALUES(p_op,p_request,p_customer,p_action,p_hash,p_expected_rev,p_payload,h.revision+1,v_now);
 RETURN jsonb_build_object('accepted',true,'operationId',p_op,'pendingIndependentLookup',true);
END $fn$;
REVOKE ALL ON FUNCTION public.rd_ops_customer_finish_v1(uuid,uuid,uuid,text,bigint,uuid,bigint,text,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.rd_ops_customer_finish_v1(uuid,uuid,uuid,text,bigint,uuid,bigint,text,text,jsonb) TO service_role;

CREATE FUNCTION public.rd_ops_customer_lookup_v1(
 p_request uuid,p_customer uuid,p_session uuid,p_customer_hash text,p_exp bigint,
 p_op uuid,p_hash text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE v_op rd_private.operation_receipts%ROWTYPE;
BEGIN
 IF NOT rd_private.customer_can_finish(p_request,p_customer_hash,p_customer,p_session,p_exp) THEN
    RAISE EXCEPTION 'RD_CUSTOMER_AUTH_DENIED'; END IF;
 SELECT * INTO v_op FROM rd_private.operation_receipts WHERE operation_id=p_op;
 IF NOT FOUND THEN RETURN jsonb_build_object('status','not_found'); END IF;
 IF v_op.request_id IS DISTINCT FROM p_request OR v_op.actor_id IS DISTINCT FROM p_customer OR
    v_op.action IS DISTINCT FROM 'customer_finish_confirmation' OR
    v_op.envelope_hash IS DISTINCT FROM p_hash THEN RAISE EXCEPTION 'RD_OPERATION_ID_REUSED'; END IF;
 RETURN jsonb_build_object('status','committed','requestId',v_op.request_id,
    'operationId',v_op.operation_id,'envelopeHash',v_op.envelope_hash,
    'revision',v_op.committed_revision,
    'acceptedAt',FLOOR(EXTRACT(EPOCH FROM v_op.accepted_at)*1000)::bigint);
END $fn$;
REVOKE ALL ON FUNCTION public.rd_ops_customer_lookup_v1(uuid,uuid,uuid,text,bigint,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.rd_ops_customer_lookup_v1(uuid,uuid,uuid,text,bigint,uuid,text) TO service_role;

CREATE FUNCTION public.rd_ops_lookup_v1(
 p_request uuid,p_owner uuid,p_session uuid,p_aal2 boolean,p_op uuid,p_hash text,p_exp bigint
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE v_op rd_private.operation_receipts%ROWTYPE;
BEGIN
 IF NOT rd_private.owner_is_current(p_owner,p_session,p_aal2,p_exp) THEN RAISE EXCEPTION 'RD_OWNER_AUTH_DENIED'; END IF;
 SELECT * INTO v_op FROM rd_private.operation_receipts WHERE operation_id=p_op;
 IF NOT FOUND THEN RETURN jsonb_build_object('status','not_found'); END IF;
 IF v_op.request_id IS DISTINCT FROM p_request OR v_op.actor_id IS DISTINCT FROM p_owner OR
    v_op.envelope_hash IS DISTINCT FROM p_hash THEN RAISE EXCEPTION 'RD_OPERATION_ID_REUSED'; END IF;
 RETURN jsonb_build_object('status','committed','requestId',v_op.request_id,
    'operationId',v_op.operation_id,'envelopeHash',v_op.envelope_hash,
    'revision',v_op.committed_revision,
    'acceptedAt',FLOOR(EXTRACT(EPOCH FROM v_op.accepted_at)*1000)::bigint);
END $fn$;
REVOKE ALL ON FUNCTION public.rd_ops_lookup_v1(uuid,uuid,uuid,boolean,uuid,text,bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.rd_ops_lookup_v1(uuid,uuid,uuid,boolean,uuid,text,bigint) TO service_role;

-- A future separate migration MUST add an atomic legacy transition guard
-- BEFORE ops_settings.enabled can change to true. Not performed here.
COMMIT;
