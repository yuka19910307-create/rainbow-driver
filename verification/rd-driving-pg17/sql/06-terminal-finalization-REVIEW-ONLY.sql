-- Rainbow Driver v10: terminal quote / authenticated customer consent /
-- Square manual reconciliation / audited atomic cancel-or-early-end candidate.
-- REVIEW ONLY. NEVER execute SQL01..06 without separate owner approval,
-- verified isolated PG17 trial and simultaneous old/new writer cutover review.
-- The 24-hour owner-case quotation model has NOT been approved as business policy.
-- In particular, `terminal_terms_enabled` remains FALSE after this migration.
-- All monetary effects occur manually in Square; this SQL never moves money.
DO $approval_gate$ BEGIN RAISE EXCEPTION 'RD_TERMINAL_V10_REVIEW_ONLY_UNAPPROVED'; END $approval_gate$;
BEGIN;
ALTER TABLE rd_private.ops_settings ADD COLUMN terminal_terms_enabled boolean NOT NULL DEFAULT false;
CREATE TABLE rd_private.terminal_terms (
 quote_id uuid PRIMARY KEY,
 plan_id uuid NOT NULL UNIQUE REFERENCES rd_private.termination_plans(plan_id) ON DELETE RESTRICT,
 request_id uuid NOT NULL REFERENCES rd_private.case_head(request_id) ON DELETE RESTRICT,
 owner_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
 policy_version text NOT NULL CHECK(policy_version='rd-terminal-owner-case-quote-v1'),
 original_paid_yen bigint NOT NULL CHECK(original_paid_yen>0 AND original_paid_yen<=100000000),
 base_fare_yen bigint NOT NULL CHECK(base_fare_yen>=0),
 wait_fee_yen bigint NOT NULL CHECK(wait_fee_yen>=0),
 route_delta_yen bigint NOT NULL,
 adjustment_yen bigint NOT NULL CHECK(adjustment_yen BETWEEN -100000000 AND 100000000),
 final_charge_yen bigint NOT NULL CHECK(final_charge_yen BETWEEN 0 AND 100000000),
 refund_due_yen bigint NOT NULL CHECK(refund_due_yen>=0),
 additional_due_yen bigint NOT NULL CHECK(additional_due_yen>=0),
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 1000),
 basis text NOT NULL CHECK(length(btrim(basis)) BETWEEN 1 AND 1000),
 presented_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL,
 consent_operation_id uuid UNIQUE,
 consent_customer_id uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
 consented_at timestamptz,
 decline_operation_id uuid UNIQUE,
 decline_customer_id uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
 declined_at timestamptz,
 decline_reason text CHECK(length(decline_reason) BETWEEN 1 AND 1000 AND decline_reason=btrim(decline_reason)),
 CHECK (final_charge_yen=base_fare_yen+wait_fee_yen+route_delta_yen+adjustment_yen),
 CHECK (refund_due_yen=greatest(original_paid_yen-final_charge_yen,0)),
 CHECK (additional_due_yen=greatest(final_charge_yen-original_paid_yen,0)),
 CHECK ((consent_operation_id IS NULL AND consent_customer_id IS NULL AND consented_at IS NULL)
   OR (consent_operation_id IS NOT NULL AND consent_customer_id IS NOT NULL AND consented_at IS NOT NULL)),
 CHECK ((decline_operation_id IS NULL AND decline_customer_id IS NULL AND declined_at IS NULL AND decline_reason IS NULL)
   OR (decline_operation_id IS NOT NULL AND decline_customer_id IS NOT NULL AND declined_at IS NOT NULL AND decline_reason IS NOT NULL)),
 CHECK (consent_operation_id IS NULL OR decline_operation_id IS NULL)
);
CREATE TABLE rd_private.terminal_financial_evidence (
 operation_id uuid PRIMARY KEY,
 quote_id uuid NOT NULL UNIQUE REFERENCES rd_private.terminal_terms(quote_id) ON DELETE RESTRICT,
 request_id uuid NOT NULL REFERENCES rd_private.case_head(request_id) ON DELETE RESTRICT,
 original_payment_id text NOT NULL,
 additional_payment_id text UNIQUE,
 original_paid_yen bigint NOT NULL CHECK(original_paid_yen>=0),
 completed_refund_yen bigint NOT NULL CHECK(completed_refund_yen>=0),
 additional_paid_yen bigint NOT NULL CHECK(additional_paid_yen>=0),
 net_retained_yen bigint NOT NULL CHECK(net_retained_yen>=0),
 observed_at timestamptz NOT NULL,
 validated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 evidence jsonb NOT NULL,
 CHECK (original_paid_yen-completed_refund_yen+additional_paid_yen=net_retained_yen)
);
CREATE TABLE rd_private.terminal_finalization_audit (
 operation_id uuid PRIMARY KEY,
 plan_id uuid NOT NULL UNIQUE REFERENCES rd_private.termination_plans(plan_id) ON DELETE RESTRICT,
 quote_id uuid NOT NULL UNIQUE REFERENCES rd_private.terminal_terms(quote_id) ON DELETE RESTRICT,
 request_id uuid NOT NULL UNIQUE REFERENCES rd_private.case_head(request_id) ON DELETE RESTRICT,
 owner_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
 consent_id uuid NOT NULL,
 old_status text NOT NULL CHECK(old_status IN('accepted','en_route','arrived','driving')),
 new_status text NOT NULL CHECK(new_status IN('cancelled','completed')),
 final_charge_yen bigint NOT NULL CHECK(final_charge_yen>=0),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE rd_private.terminal_plan_transition_intents (
 request_id uuid PRIMARY KEY REFERENCES rd_private.case_head(request_id) ON DELETE RESTRICT,
 operation_id uuid NOT NULL UNIQUE,
 plan_id uuid NOT NULL UNIQUE REFERENCES rd_private.termination_plans(plan_id) ON DELETE RESTRICT,
 owner_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
 old_status text NOT NULL,
 new_status text NOT NULL CHECK(new_status IN('cancelled','completed'))
);
ALTER TABLE rd_private.terminal_terms ENABLE ROW LEVEL SECURITY;
ALTER TABLE rd_private.terminal_financial_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE rd_private.terminal_finalization_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE rd_private.terminal_plan_transition_intents ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON rd_private.terminal_terms,rd_private.terminal_financial_evidence,
 rd_private.terminal_finalization_audit,rd_private.terminal_plan_transition_intents
 FROM PUBLIC,anon,authenticated;

-- All independent writer RPCs acquire the same booking row FIRST.
-- Original payment amount/fee components are checked against server rows;
-- the caller only specifies the adjustment and written rationale.
CREATE FUNCTION public.rd_ops_terminal_quote_v1(
 p_request uuid,p_owner uuid,p_session uuid,p_aal2 boolean,
 p_op uuid,p_expected_rev bigint,p_hash text,p_action text,p_payload jsonb,p_exp bigint
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE r public.requests%ROWTYPE; h rd_private.case_head%ROWTYPE;
 v_plan rd_private.termination_plans%ROWTYPE; v_old rd_private.operation_receipts%ROWTYPE;
 v_amount bigint;v_base bigint;v_wait bigint;v_route bigint:=0;v_adjust bigint;v_final bigint;
 v_now timestamptz; v_ps public.payment_sessions%ROWTYPE;
BEGIN
 IF p_request IS NULL OR p_owner IS NULL OR p_op IS NULL OR p_hash !~ '^[0-9a-f]{64}$' OR
    p_action IS DISTINCT FROM 'terminal_quote' OR p_expected_rev IS NULL OR
    p_expected_rev<0 OR jsonb_typeof(p_payload) IS DISTINCT FROM 'object' OR
    (SELECT count(*) FROM jsonb_object_keys(p_payload))<>6 OR
    p_payload->>'policyVersion' IS DISTINCT FROM 'rd-terminal-owner-case-quote-v1' OR
    p_payload->>'planId' IS NULL OR p_payload->>'planId' !~ '^[0-9a-f-]{36}$' OR
    p_payload->>'reason' IS NULL OR length(btrim(p_payload->>'reason')) NOT BETWEEN 1 AND 1000 OR
    p_payload->>'basis' IS NULL OR length(btrim(p_payload->>'basis')) NOT BETWEEN 1 AND 1000 OR
    p_payload->>'adjustmentYen' !~ '^-?(0|[1-9][0-9]*)$' OR
    p_payload->>'finalChargeYen' !~ '^(0|[1-9][0-9]*)$' THEN
    RAISE EXCEPTION 'RD_TERMINAL_QUOTE_PAYLOAD_INVALID'; END IF;
 -- Global operation ID first, before booking/auth/case locks.
 PERFORM rd_private.lock_operation_id(p_op);
 SELECT * INTO r FROM public.requests WHERE id=p_request FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'RD_BOOKING_NOT_FOUND'; END IF;
 IF NOT rd_private.owner_is_current(p_owner,p_session,p_aal2,p_exp) OR
    NOT rd_private.has_original_customer_authority(p_request) OR
    NOT EXISTS(SELECT 1 FROM rd_private.ops_settings s WHERE s.id=1 AND s.enabled=true
      AND s.terminal_terms_enabled=true FOR SHARE) OR
    NOT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger t
      WHERE t.tgname='rd_ops_legacy_writer_guard_trg'
        AND t.tgrelid=pg_catalog.to_regclass('public.requests')
        AND t.tgenabled IN('O','A') AND NOT t.tgisinternal) THEN
    RAISE EXCEPTION 'RD_TERMINAL_QUOTE_DISABLED'; END IF;
 SELECT * INTO h FROM rd_private.case_head WHERE request_id=p_request FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'RD_CASE_NOT_ENROLLED'; END IF;
 PERFORM rd_private.assert_operation_not_closed(p_request,p_owner,p_op,p_expected_rev,p_hash,p_action,p_payload);
 SELECT * INTO v_old FROM rd_private.operation_receipts WHERE operation_id=p_op;
 IF FOUND THEN
  IF v_old.request_id IS DISTINCT FROM p_request OR v_old.actor_id IS DISTINCT FROM p_owner OR
     v_old.expected_revision IS DISTINCT FROM p_expected_rev OR v_old.envelope_hash IS DISTINCT FROM p_hash OR
     v_old.action IS DISTINCT FROM p_action OR v_old.body IS DISTINCT FROM p_payload THEN
    RAISE EXCEPTION 'RD_OPERATION_ID_REUSED'; END IF;
  RETURN jsonb_build_object('accepted',true,'operationId',p_op,'pendingIndependentLookup',true);
 END IF;
 PERFORM rd_private.assert_customer_termination_action_allowed(p_request,p_action);
 IF h.revision IS DISTINCT FROM p_expected_rev THEN RAISE EXCEPTION 'RD_TERMINAL_QUOTE_REVISION_STALE'; END IF;
 SELECT * INTO v_plan FROM rd_private.termination_plans t
   WHERE t.plan_id=(p_payload->>'planId')::uuid AND t.request_id=p_request
     AND t.state='pending_review' FOR UPDATE;
 IF NOT FOUND OR v_plan.owner_id IS DISTINCT FROM p_owner OR
    v_plan.original_status IS DISTINCT FROM r.status OR
    (v_plan.kind='cancel' AND r.status NOT IN('accepted','en_route','arrived')) OR
    (v_plan.kind='early_end' AND r.status IS DISTINCT FROM 'driving') OR
    EXISTS(SELECT 1 FROM rd_private.terminal_terms x WHERE x.plan_id=v_plan.plan_id) THEN
   RAISE EXCEPTION 'RD_TERMINAL_QUOTE_PLAN_INVALID'; END IF;
 IF EXISTS(SELECT 1 FROM rd_private.wait_interval x WHERE x.request_id=p_request AND x.phase IN('active','review')) OR
    EXISTS(SELECT 1 FROM rd_private.route_proposals q WHERE q.request_id=p_request
        AND q.status IN('proposed','presented') AND q.expires_at>clock_timestamp()) THEN
   RAISE EXCEPTION 'RD_TERMINAL_UNRESOLVED_OPERATIONS'; END IF;
 IF (SELECT count(*) FROM public.payment_sessions WHERE request_id=p_request)<>1 THEN
   RAISE EXCEPTION 'RD_TERMINAL_PAYMENT_AMBIGUOUS'; END IF;
 SELECT * INTO v_ps FROM public.payment_sessions WHERE request_id=p_request FOR SHARE;
 IF NOT FOUND OR v_ps.status NOT IN('paid','partially_refunded') OR v_ps.currency<>'JPY'
    OR v_ps.amount IS NULL OR v_ps.amount NOT BETWEEN 1 AND 100000000 THEN
   RAISE EXCEPTION 'RD_TERMINAL_PAYMENT_INVALID'; END IF;
 v_amount:=v_ps.amount;v_base:=r.total_fee;
 SELECT rd_private.wait_charge(COALESCE(sum(i.billed_ms),0)::bigint) INTO v_wait
  FROM rd_private.wait_interval i WHERE i.request_id=p_request AND i.phase='final';
 SELECT (a.quote#>>'{serverQuote,total_fee}')::bigint-r.total_fee INTO v_route
   FROM rd_private.accepted_routes a WHERE a.request_id=p_request;
 v_route:=COALESCE(v_route,0);
 v_adjust:=(p_payload->>'adjustmentYen')::bigint;
 v_final:=(p_payload->>'finalChargeYen')::bigint;
 IF v_adjust NOT BETWEEN -100000000 AND 100000000 OR
    v_final NOT BETWEEN 0 AND 100000000 OR
    v_final IS DISTINCT FROM v_base+v_wait+v_route+v_adjust THEN
   RAISE EXCEPTION 'RD_TERMINAL_QUOTE_FEE_MISMATCH'; END IF;
 v_now:=clock_timestamp();
 INSERT INTO rd_private.terminal_terms(quote_id,plan_id,request_id,owner_id,policy_version,
   original_paid_yen,base_fare_yen,wait_fee_yen,route_delta_yen,adjustment_yen,
   final_charge_yen,refund_due_yen,additional_due_yen,reason,basis,presented_at,expires_at)
 VALUES(p_op,v_plan.plan_id,p_request,p_owner,'rd-terminal-owner-case-quote-v1',
   v_amount,v_base,v_wait,v_route,v_adjust,v_final,greatest(v_amount-v_final,0),
   greatest(v_final-v_amount,0),p_payload->>'reason',p_payload->>'basis',v_now,v_now+interval '24 hours');
 IF NOT rd_private.owner_is_current(p_owner,p_session,p_aal2,p_exp) THEN
    RAISE EXCEPTION 'RD_OWNER_AUTH_EXPIRED'; END IF;
 UPDATE rd_private.case_head SET revision=revision+1,updated_at=v_now
  WHERE request_id=p_request RETURNING * INTO h;
 INSERT INTO rd_private.operation_receipts(operation_id,request_id,actor_id,action,envelope_hash,
    expected_revision,body,committed_revision,accepted_at)
 VALUES(p_op,p_request,p_owner,p_action,p_hash,p_expected_rev,p_payload,h.revision,v_now);
 RETURN jsonb_build_object('accepted',true,'operationId',p_op,'pendingIndependentLookup',true);
END $fn$;
REVOKE ALL ON FUNCTION public.rd_ops_terminal_quote_v1(uuid,uuid,uuid,boolean,uuid,bigint,text,text,jsonb,bigint)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.rd_ops_terminal_quote_v1(uuid,uuid,uuid,boolean,uuid,bigint,text,text,jsonb,bigint)
 TO service_role;

-- Original verified customer must accept or decline the exact immutable terms;
-- viewing the booking token and OTP without pre-checkout binding is insufficient.
CREATE FUNCTION public.rd_ops_terminal_consent_v1(
 p_request uuid,p_customer uuid,p_session uuid,p_customer_hash text,p_exp bigint,
 p_op uuid,p_expected_rev bigint,p_hash text,p_action text,p_payload jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE r public.requests%ROWTYPE;h rd_private.case_head%ROWTYPE;
 t rd_private.termination_plans%ROWTYPE;q rd_private.terminal_terms%ROWTYPE;
 old rd_private.operation_receipts%ROWTYPE; v_now timestamptz;
BEGIN
 IF p_request IS NULL OR p_customer IS NULL OR p_session IS NULL OR p_op IS NULL OR
   p_hash IS NULL OR p_hash !~ '^[0-9a-f]{64}$' OR
   p_action IS NULL OR p_action NOT IN('customer_terminal_consent','customer_terminal_decline') OR
   p_expected_rev IS NULL OR p_expected_rev<0 OR
   jsonb_typeof(p_payload) IS DISTINCT FROM 'object' THEN
   RAISE EXCEPTION 'RD_TERMINAL_CONSENT_PAYLOAD_INVALID'; END IF;
 IF jsonb_typeof(p_payload->'planId') IS DISTINCT FROM 'string' OR
   p_payload->>'planId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' OR
   jsonb_typeof(p_payload->'quoteId') IS DISTINCT FROM 'string' OR
   p_payload->>'quoteId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' OR
   jsonb_typeof(p_payload->'finalChargeYen') IS DISTINCT FROM 'number' OR
   p_payload->>'finalChargeYen' !~ '^(0|[1-9][0-9]*)$' THEN
   RAISE EXCEPTION 'RD_TERMINAL_CONSENT_PAYLOAD_INVALID'; END IF;
 IF p_action='customer_terminal_consent' THEN
   IF (SELECT count(*) FROM jsonb_object_keys(p_payload))<>5 OR
      p_payload->'confirmed' IS DISTINCT FROM 'true'::jsonb OR
      jsonb_typeof(p_payload->'statement') IS DISTINCT FROM 'string' OR
      length(btrim(p_payload->>'statement')) NOT BETWEEN 1 AND 1000 THEN
     RAISE EXCEPTION 'RD_TERMINAL_CONSENT_PAYLOAD_INVALID'; END IF;
 ELSE
   IF (SELECT count(*) FROM jsonb_object_keys(p_payload))<>4 OR
      jsonb_typeof(p_payload->'reason') IS DISTINCT FROM 'string' OR
      length(p_payload->>'reason') NOT BETWEEN 1 AND 1000 OR
      p_payload->>'reason' IS DISTINCT FROM btrim(p_payload->>'reason') THEN
     RAISE EXCEPTION 'RD_TERMINAL_DECLINE_PAYLOAD_INVALID'; END IF;
 END IF;
 -- Global operation ID first, before booking/auth/case locks.
 PERFORM rd_private.lock_operation_id(p_op);
 SELECT * INTO r FROM public.requests WHERE id=p_request FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'RD_BOOKING_NOT_FOUND'; END IF;
 IF NOT rd_private.customer_can_finish(p_request,p_customer_hash,p_customer,p_session,p_exp) OR
    NOT EXISTS(SELECT 1 FROM rd_private.ops_settings s WHERE s.id=1 AND s.enabled=true
      AND s.terminal_terms_enabled=true FOR SHARE) THEN
   RAISE EXCEPTION 'RD_TERMINAL_CUSTOMER_DENIED'; END IF;
 SELECT * INTO h FROM rd_private.case_head WHERE request_id=p_request FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'RD_CASE_NOT_ENROLLED'; END IF;
 PERFORM rd_private.assert_operation_not_closed(p_request,p_customer,p_op,p_expected_rev,p_hash,p_action,p_payload);
 SELECT * INTO old FROM rd_private.operation_receipts WHERE operation_id=p_op;
 IF FOUND THEN
  IF old.request_id IS DISTINCT FROM p_request OR old.actor_id IS DISTINCT FROM p_customer OR
     old.expected_revision IS DISTINCT FROM p_expected_rev OR old.envelope_hash IS DISTINCT FROM p_hash OR
     old.action IS DISTINCT FROM p_action OR old.body IS DISTINCT FROM p_payload THEN
    RAISE EXCEPTION 'RD_OPERATION_ID_REUSED'; END IF;
  RETURN jsonb_build_object('accepted',true,'operationId',p_op,'pendingIndependentLookup',true);
 END IF;
 PERFORM rd_private.assert_customer_termination_action_allowed(p_request,p_action);
 IF h.revision IS DISTINCT FROM p_expected_rev THEN RAISE EXCEPTION 'RD_TERMINAL_CONSENT_REVISION_STALE'; END IF;
 SELECT * INTO t FROM rd_private.termination_plans
   WHERE plan_id=(p_payload->>'planId')::uuid AND request_id=p_request AND state='pending_review' FOR UPDATE;
 IF NOT FOUND OR t.original_status IS DISTINCT FROM r.status THEN RAISE EXCEPTION 'RD_TERMINAL_PLAN_STALE'; END IF;
 SELECT * INTO q FROM rd_private.terminal_terms
   WHERE quote_id=(p_payload->>'quoteId')::uuid AND plan_id=t.plan_id FOR UPDATE;
 IF NOT FOUND OR q.expires_at<=clock_timestamp() OR q.consent_operation_id IS NOT NULL OR q.decline_operation_id IS NOT NULL OR
    q.final_charge_yen IS DISTINCT FROM (p_payload->>'finalChargeYen')::bigint THEN
   RAISE EXCEPTION 'RD_TERMINAL_QUOTE_STALE'; END IF;
 v_now:=clock_timestamp();
 IF NOT rd_private.customer_can_finish(p_request,p_customer_hash,p_customer,p_session,p_exp) THEN
    RAISE EXCEPTION 'RD_TERMINAL_CUSTOMER_REVOKED'; END IF;
 IF p_action='customer_terminal_consent' THEN
   UPDATE rd_private.terminal_terms SET consent_operation_id=p_op,
     consent_customer_id=p_customer,consented_at=v_now WHERE quote_id=q.quote_id
       AND consent_operation_id IS NULL AND decline_operation_id IS NULL;
 ELSE
   UPDATE rd_private.terminal_terms SET decline_operation_id=p_op,
     decline_customer_id=p_customer,declined_at=v_now,decline_reason=p_payload->>'reason'
     WHERE quote_id=q.quote_id AND consent_operation_id IS NULL AND decline_operation_id IS NULL;
 END IF;
 IF NOT FOUND THEN RAISE EXCEPTION 'RD_TERMINAL_DECISION_CONFLICT'; END IF;
 UPDATE rd_private.case_head SET revision=revision+1,updated_at=v_now
  WHERE request_id=p_request RETURNING * INTO h;
 INSERT INTO rd_private.operation_receipts(operation_id,request_id,actor_id,action,
   envelope_hash,expected_revision,body,committed_revision,accepted_at)
 VALUES(p_op,p_request,p_customer,p_action,p_hash,p_expected_rev,p_payload,h.revision,v_now);
 RETURN jsonb_build_object('accepted',true,'operationId',p_op,'pendingIndependentLookup',true);
END $fn$;
REVOKE ALL ON FUNCTION public.rd_ops_terminal_consent_v1(uuid,uuid,uuid,text,bigint,uuid,bigint,text,text,jsonb)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.rd_ops_terminal_consent_v1(uuid,uuid,uuid,text,bigint,uuid,bigint,text,text,jsonb)
 TO service_role;

CREATE FUNCTION public.rd_ops_terminal_customer_lookup_v1(
 p_request uuid,p_customer uuid,p_session uuid,p_customer_hash text,p_exp bigint,
 p_op uuid,p_hash text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE v_op rd_private.operation_receipts%ROWTYPE;
BEGIN
 IF NOT rd_private.customer_otp_verified(p_request,p_customer_hash,p_customer,p_session,p_exp) OR
    NOT EXISTS(SELECT 1 FROM rd_private.booking_customer_bindings b
      JOIN public.payment_sessions ps ON ps.id=b.payment_session_id
      WHERE b.request_id=p_request AND b.customer_id=p_customer AND ps.request_id=p_request
        AND ps.status IN('paid','partially_refunded','refunded')
        AND b.binding_method='original-customer-authority-reviewed') AND
    NOT EXISTS(SELECT 1 FROM rd_private.checkout_customer_origins o
      JOIN public.payment_sessions ps ON ps.id=o.payment_session_id
      WHERE ps.request_id=p_request AND o.customer_id=p_customer
        AND ps.status IN('paid','partially_refunded','refunded')
        AND o.binding_method='authenticated-before-checkout-v1') THEN
   RAISE EXCEPTION 'RD_TERMINAL_CUSTOMER_AUTH_DENIED'; END IF;
 SELECT * INTO v_op FROM rd_private.operation_receipts WHERE operation_id=p_op;
 IF NOT FOUND THEN RETURN jsonb_build_object('status','not_found'); END IF;
 IF v_op.request_id IS DISTINCT FROM p_request OR v_op.actor_id IS DISTINCT FROM p_customer OR
    v_op.action NOT IN('customer_terminal_consent','customer_terminal_decline') OR v_op.envelope_hash IS DISTINCT FROM p_hash THEN
   RAISE EXCEPTION 'RD_OPERATION_ID_REUSED'; END IF;
 RETURN jsonb_build_object('status','committed','requestId',v_op.request_id,
    'operationId',v_op.operation_id,'envelopeHash',v_op.envelope_hash,
    'revision',v_op.committed_revision,
    'acceptedAt',floor(extract(epoch from v_op.accepted_at)*1000)::bigint);
END $fn$;
REVOKE ALL ON FUNCTION public.rd_ops_terminal_customer_lookup_v1(uuid,uuid,uuid,text,bigint,uuid,text)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.rd_ops_terminal_customer_lookup_v1(uuid,uuid,uuid,text,bigint,uuid,text)
 TO service_role;

-- Read-only source for a SINGLE exact provider reconciliation attempt.
-- The owner must revalidate after the provider GET and before SQL write.
-- A committed operation can be safely acknowledged on retry, without
-- calling Square again or re-creating any charge/refund/booking.
CREATE FUNCTION public.rd_ops_terminal_target_v1(
 p_request uuid,p_owner uuid,p_session uuid,p_aal2 boolean,p_exp bigint,
 p_op uuid,p_expected_rev bigint,p_hash text,p_payload jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE r public.requests%ROWTYPE;h rd_private.case_head%ROWTYPE;
 old rd_private.operation_receipts%ROWTYPE; t rd_private.termination_plans%ROWTYPE;
 q rd_private.terminal_terms%ROWTYPE;ps public.payment_sessions%ROWTYPE;v_now timestamptz;
BEGIN
 IF p_request IS NULL OR p_owner IS NULL OR p_session IS NULL OR p_op IS NULL OR
    p_hash !~ '^[0-9a-f]{64}$' OR p_expected_rev IS NULL OR p_expected_rev<0 OR
    jsonb_typeof(p_payload) IS DISTINCT FROM 'object' OR
    (SELECT count(*) FROM jsonb_object_keys(p_payload))<>4 OR
    p_payload->>'planId' !~ '^[0-9a-f-]{36}$' OR
    p_payload->>'quoteId' !~ '^[0-9a-f-]{36}$' OR
    p_payload->>'consentId' !~ '^[0-9a-f-]{36}$' THEN
   RAISE EXCEPTION 'RD_TERMINAL_TARGET_ARGUMENT_INVALID'; END IF;
 -- Global operation ID first, before booking/auth/case locks.
 PERFORM rd_private.lock_operation_id(p_op);
 SELECT * INTO r FROM public.requests WHERE id=p_request FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'RD_BOOKING_NOT_FOUND'; END IF;
 IF NOT rd_private.owner_is_current(p_owner,p_session,p_aal2,p_exp) OR
    NOT EXISTS(SELECT 1 FROM rd_private.ops_settings s
      WHERE s.id=1 AND s.enabled=true AND s.terminal_terms_enabled=true FOR SHARE) THEN
   RAISE EXCEPTION 'RD_TERMINAL_NOT_AUTHORIZED'; END IF;
 SELECT * INTO h FROM rd_private.case_head WHERE request_id=p_request FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'RD_CASE_NOT_ENROLLED'; END IF;
 PERFORM rd_private.assert_operation_not_closed(p_request,p_owner,p_op,p_expected_rev,p_hash,'terminal_finalize',p_payload);
 SELECT * INTO old FROM rd_private.operation_receipts WHERE operation_id=p_op;
 IF FOUND THEN
  IF old.request_id IS DISTINCT FROM p_request OR old.actor_id IS DISTINCT FROM p_owner OR
     old.action IS DISTINCT FROM 'terminal_finalize' OR old.envelope_hash IS DISTINCT FROM p_hash OR
     old.expected_revision IS DISTINCT FROM p_expected_rev OR old.body IS DISTINCT FROM p_payload THEN
    RAISE EXCEPTION 'RD_OPERATION_ID_REUSED'; END IF;
  RETURN jsonb_build_object('alreadyCommitted',true,'requestId',p_request);
 END IF;
 PERFORM rd_private.assert_customer_termination_action_allowed(p_request,'terminal_finalize');
 IF h.revision IS DISTINCT FROM p_expected_rev THEN RAISE EXCEPTION 'RD_TERMINAL_REVISION_STALE'; END IF;
 SELECT * INTO t FROM rd_private.termination_plans
   WHERE plan_id=(p_payload->>'planId')::uuid AND request_id=p_request
     AND state='pending_review' FOR SHARE;
 IF NOT FOUND OR t.original_status IS DISTINCT FROM r.status OR
    (t.kind='cancel' AND r.status NOT IN('accepted','en_route','arrived')) OR
    (t.kind='early_end' AND r.status IS DISTINCT FROM 'driving') OR
    EXISTS(SELECT 1 FROM rd_private.terminal_finalization_audit a WHERE a.plan_id=t.plan_id) THEN
    RAISE EXCEPTION 'RD_TERMINAL_PLAN_STALE'; END IF;
 SELECT * INTO q FROM rd_private.terminal_terms
   WHERE quote_id=(p_payload->>'quoteId')::uuid AND plan_id=t.plan_id FOR SHARE;
 IF NOT FOUND OR q.consent_operation_id IS DISTINCT FROM (p_payload->>'consentId')::uuid OR
    q.consent_customer_id IS NULL OR q.consented_at IS NULL OR q.decline_operation_id IS NOT NULL OR
    q.expires_at<=clock_timestamp() THEN
   RAISE EXCEPTION 'RD_TERMINAL_CONSENT_MISSING'; END IF;
 PERFORM 1 FROM rd_private.operation_receipts o
   WHERE o.operation_id=q.consent_operation_id AND o.request_id=p_request AND
     o.actor_id=q.consent_customer_id AND o.action='customer_terminal_consent' AND
     o.body->>'planId'=t.plan_id::text AND o.body->>'quoteId'=q.quote_id::text AND
     o.body->>'finalChargeYen'=q.final_charge_yen::text AND o.body->'confirmed'='true'::jsonb
   FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'RD_TERMINAL_CONSENT_EVIDENCE_UNVERIFIED'; END IF;
 IF EXISTS(SELECT 1 FROM rd_private.wait_interval i WHERE i.request_id=p_request AND i.phase IN('active','review')) OR
    EXISTS(SELECT 1 FROM rd_private.route_proposals x WHERE x.request_id=p_request
      AND x.status IN('proposed','presented') AND x.expires_at>clock_timestamp()) THEN
    RAISE EXCEPTION 'RD_TERMINAL_OPERATIONS_UNRESOLVED'; END IF;
 -- Narrow terminal-only exception: a fully refunded cancelled case may
 -- still be finalized, but must have original pre-checkout identity plus
 -- authenticated consent recorded BEFORE that refund. This does not extend
 -- token-only privileges or reopen the general customer/route API.
 IF (SELECT count(*) FROM public.payment_sessions ps WHERE ps.request_id=p_request)<>1 THEN
   RAISE EXCEPTION 'RD_TERMINAL_PAYMENT_AMBIGUOUS'; END IF;
 SELECT * INTO ps FROM public.payment_sessions WHERE request_id=p_request FOR SHARE;
 IF NOT FOUND OR ps.status NOT IN('paid','partially_refunded','refunded') OR
    (ps.status='refunded' AND q.final_charge_yen<>0) OR
    ps.amount IS DISTINCT FROM q.original_paid_yen OR ps.currency IS DISTINCT FROM 'JPY' OR
    ps.environment NOT IN('sandbox','production') OR
    ps.square_payment_id IS NULL OR ps.square_payment_id !~ '^[A-Za-z0-9_-]{1,192}$' OR
    ps.square_order_id IS NULL OR ps.square_order_id !~ '^[A-Za-z0-9_-]{1,192}$' THEN
    RAISE EXCEPTION 'RD_TERMINAL_PAYMENT_MISMATCH'; END IF;
 IF NOT EXISTS(SELECT 1 FROM rd_private.checkout_customer_origins o
      WHERE o.payment_session_id=ps.id AND o.customer_id=q.consent_customer_id
        AND o.binding_method='authenticated-before-checkout-v1') AND
    NOT EXISTS(SELECT 1 FROM rd_private.booking_customer_bindings b
      WHERE b.request_id=p_request AND b.payment_session_id=ps.id
        AND b.customer_id=q.consent_customer_id AND
        b.binding_method='original-customer-authority-reviewed') THEN
    RAISE EXCEPTION 'RD_TERMINAL_ORIGINAL_CUSTOMER_MISSING'; END IF;
 IF NOT rd_private.owner_is_current(p_owner,p_session,p_aal2,p_exp) THEN
   RAISE EXCEPTION 'RD_OWNER_AUTH_EXPIRED'; END IF;
 RETURN jsonb_build_object('requestId',p_request,'planId',t.plan_id,
   'quoteId',q.quote_id,'consentId',q.consent_operation_id,'revision',h.revision,
   'originalPaidYen',q.original_paid_yen,'finalChargeYen',q.final_charge_yen,
   'expectedRefundYen',q.refund_due_yen,'expectedAdditionalYen',q.additional_due_yen,
   'paymentSessionId',ps.id,
   'paymentId',ps.square_payment_id,'orderId',ps.square_order_id,
   'environment',ps.environment,'currency','JPY');
END $fn$;
REVOKE ALL ON FUNCTION public.rd_ops_terminal_target_v1(uuid,uuid,uuid,boolean,bigint,uuid,bigint,text,jsonb)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.rd_ops_terminal_target_v1(uuid,uuid,uuid,boolean,bigint,uuid,bigint,text,jsonb)
 TO service_role;

CREATE FUNCTION public.rd_ops_terminal_finalize_v1(
 p_request uuid,p_owner uuid,p_session uuid,p_aal2 boolean,
 p_op uuid,p_expected_rev bigint,p_hash text,p_action text,p_payload jsonb,p_exp bigint,
 p_evidence jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE r public.requests%ROWTYPE;h rd_private.case_head%ROWTYPE;
 t rd_private.termination_plans%ROWTYPE;q rd_private.terminal_terms%ROWTYPE;
 old rd_private.operation_receipts%ROWTYPE;target jsonb;
 new_status text;v_at bigint;v_now timestamptz;v_additional text;
BEGIN
 IF p_action IS DISTINCT FROM 'terminal_finalize' OR p_request IS NULL OR p_op IS NULL OR
    p_expected_rev IS NULL OR p_expected_rev<0 OR p_hash !~ '^[0-9a-f]{64}$' OR
    jsonb_typeof(p_payload) IS DISTINCT FROM 'object' OR
    jsonb_typeof(p_evidence) IS DISTINCT FROM 'object' THEN
   RAISE EXCEPTION 'RD_TERMINAL_FINAL_ARGUMENT_INVALID'; END IF;
 -- Same booking lock as driver-api and the other rd_ops writers.
 -- Global operation ID first, before booking/auth/case locks.
 PERFORM rd_private.lock_operation_id(p_op);
 SELECT * INTO r FROM public.requests WHERE id=p_request FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'RD_BOOKING_NOT_FOUND'; END IF;
 IF NOT rd_private.owner_is_current(p_owner,p_session,p_aal2,p_exp) THEN
   RAISE EXCEPTION 'RD_OWNER_AUTH_DENIED'; END IF;
 SELECT * INTO h FROM rd_private.case_head WHERE request_id=p_request FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'RD_CASE_NOT_ENROLLED'; END IF;
 PERFORM rd_private.assert_operation_not_closed(p_request,p_owner,p_op,p_expected_rev,p_hash,p_action,p_payload);
 SELECT * INTO old FROM rd_private.operation_receipts WHERE operation_id=p_op;
 IF FOUND THEN
  IF old.request_id IS DISTINCT FROM p_request OR old.actor_id IS DISTINCT FROM p_owner OR
     old.action IS DISTINCT FROM p_action OR old.envelope_hash IS DISTINCT FROM p_hash OR
     old.expected_revision IS DISTINCT FROM p_expected_rev OR old.body IS DISTINCT FROM p_payload THEN
    RAISE EXCEPTION 'RD_OPERATION_ID_REUSED'; END IF;
  RETURN jsonb_build_object('accepted',true,'operationId',p_op,'pendingIndependentLookup',true);
 END IF;
 PERFORM rd_private.assert_customer_termination_action_allowed(p_request,p_action);
 target:=public.rd_ops_terminal_target_v1(p_request,p_owner,p_session,p_aal2,p_exp,
    p_op,p_expected_rev,p_hash,p_payload);
 IF target->>'requestId' IS DISTINCT FROM p_request::text OR
    (target->>'revision')::bigint IS DISTINCT FROM h.revision OR
    h.revision IS DISTINCT FROM p_expected_rev THEN
   RAISE EXCEPTION 'RD_TERMINAL_FINAL_TARGET_STALE'; END IF;
 SELECT * INTO t FROM rd_private.termination_plans
   WHERE plan_id=(p_payload->>'planId')::uuid AND request_id=p_request FOR UPDATE;
 SELECT * INTO q FROM rd_private.terminal_terms
   WHERE quote_id=(p_payload->>'quoteId')::uuid AND plan_id=t.plan_id FOR UPDATE;
 IF NOT FOUND OR q.consent_operation_id IS DISTINCT FROM (p_payload->>'consentId')::uuid OR
    q.decline_operation_id IS NOT NULL THEN
    RAISE EXCEPTION 'RD_TERMINAL_FINAL_CONSENT_INVALID'; END IF;
 -- The provider response is produced ONLY inside the owner-authenticated
 -- Edge handler. Service-role trust boundary; no client-provided `paid:true`.
 IF (SELECT count(*) FROM jsonb_object_keys(p_evidence))<>21 OR
    p_evidence->>'requestId' IS DISTINCT FROM p_request::text OR
    p_evidence->>'planId' IS DISTINCT FROM t.plan_id::text OR
    p_evidence->>'quoteId' IS DISTINCT FROM q.quote_id::text OR
    p_evidence->>'consentId' IS DISTINCT FROM q.consent_operation_id::text OR
    p_evidence->>'paymentSessionId' IS DISTINCT FROM target->>'paymentSessionId' OR
    p_evidence->>'originalPaymentId' IS DISTINCT FROM target->>'paymentId' OR
    p_evidence->>'orderId' IS DISTINCT FROM target->>'orderId' OR
    p_evidence->>'environment' IS DISTINCT FROM target->>'environment' OR
    p_evidence->>'currency' IS DISTINCT FROM 'JPY' OR
    p_evidence->>'revision' IS DISTINCT FROM target->>'revision' OR
    p_evidence->>'originalPaidYen' IS DISTINCT FROM q.original_paid_yen::text OR
    p_evidence->>'completedRefundYen' IS DISTINCT FROM q.refund_due_yen::text OR
    p_evidence->>'additionalPaidYen' IS DISTINCT FROM q.additional_due_yen::text OR
    p_evidence->>'netRetainedYen' IS DISTINCT FROM q.final_charge_yen::text OR
    p_evidence->'pendingRefund' IS DISTINCT FROM 'false'::jsonb OR
    p_evidence->'disputesChecked' IS DISTINCT FROM 'true'::jsonb OR
    p_evidence->'disputeFound' IS DISTINCT FROM 'false'::jsonb OR
    p_evidence->'originalPaymentVerified' IS DISTINCT FROM 'true'::jsonb OR
    p_evidence->'additionalPaymentVerified' IS DISTINCT FROM 'true'::jsonb OR
    p_evidence->>'observedAt' !~ '^[1-9][0-9]{11,13}$' THEN
   RAISE EXCEPTION 'RD_TERMINAL_PROVIDER_EVIDENCE_INVALID'; END IF;
 IF q.additional_due_yen>0 THEN
   v_additional:=p_payload->>'additionalPaymentId';
   IF v_additional IS NULL OR v_additional !~ '^[A-Za-z0-9_-]{1,192}$' OR
      p_evidence->>'additionalPaymentId' IS DISTINCT FROM v_additional THEN
     RAISE EXCEPTION 'RD_TERMINAL_ADDITIONAL_PAYMENT_NOT_VERIFIED'; END IF;
 ELSE
   IF p_payload->'additionalPaymentId' IS DISTINCT FROM 'null'::jsonb OR
      p_evidence->'additionalPaymentId' IS DISTINCT FROM 'null'::jsonb THEN
     RAISE EXCEPTION 'RD_TERMINAL_EXTRA_PAYMENT_UNEXPECTED'; END IF;
 END IF;
 v_at:=(p_evidence->>'observedAt')::bigint;v_now:=clock_timestamp();
 IF v_at>(extract(epoch from v_now)*1000)::bigint+5000 OR
    v_at<(extract(epoch from v_now)*1000)::bigint-120000 THEN
   RAISE EXCEPTION 'RD_TERMINAL_PROVIDER_OBSERVATION_STALE'; END IF;
 IF NOT rd_private.owner_is_current(p_owner,p_session,p_aal2,p_exp) OR
    t.state IS DISTINCT FROM 'pending_review' OR
    t.original_status IS DISTINCT FROM r.status OR
    q.expires_at<=v_now OR
    NOT EXISTS(SELECT 1 FROM rd_private.ops_settings s WHERE s.id=1
       AND s.enabled=true AND s.terminal_terms_enabled=true FOR SHARE) THEN
   RAISE EXCEPTION 'RD_TERMINAL_FINAL_AUTH_OR_STATUS_STALE'; END IF;
 new_status:=CASE WHEN t.kind='cancel' THEN 'cancelled'
     WHEN t.kind='early_end' THEN 'completed' ELSE NULL END;
 IF new_status IS NULL OR
    (new_status='cancelled' AND r.status NOT IN('accepted','en_route','arrived')) OR
    (new_status='completed' AND r.status IS DISTINCT FROM 'driving') THEN
   RAISE EXCEPTION 'RD_TERMINAL_STATUS_INVALID'; END IF;
 INSERT INTO rd_private.terminal_financial_evidence(operation_id,quote_id,request_id,
    original_payment_id,additional_payment_id,original_paid_yen,completed_refund_yen,
    additional_paid_yen,net_retained_yen,observed_at,evidence)
 VALUES(p_op,q.quote_id,p_request,target->>'paymentId',v_additional,
    q.original_paid_yen,q.refund_due_yen,q.additional_due_yen,q.final_charge_yen,
    to_timestamp(v_at::numeric/1000),p_evidence);
 -- Audited intent + status change + final receipt commit or roll back TOGETHER.
 INSERT INTO rd_private.terminal_finalization_audit(operation_id,plan_id,quote_id,request_id,
   owner_id,consent_id,old_status,new_status,final_charge_yen,recorded_at)
 VALUES(p_op,t.plan_id,q.quote_id,p_request,p_owner,q.consent_operation_id,
   r.status,new_status,q.final_charge_yen,v_now);
 INSERT INTO rd_private.terminal_plan_transition_intents(request_id,operation_id,
   plan_id,owner_id,old_status,new_status)
 VALUES(p_request,p_op,t.plan_id,p_owner,r.status,new_status);
 UPDATE public.requests SET status=new_status,updated_at=v_now
   WHERE id=p_request AND status=r.status;
 IF NOT FOUND OR EXISTS(SELECT 1 FROM rd_private.terminal_plan_transition_intents ti
    WHERE ti.request_id=p_request AND ti.operation_id=p_op) THEN
    RAISE EXCEPTION 'RD_TERMINAL_STATUS_GUARD_NOT_CONSUMED'; END IF;
 IF NOT rd_private.owner_is_current(p_owner,p_session,p_aal2,p_exp) THEN
   RAISE EXCEPTION 'RD_TERMINAL_OWNER_REVOKED'; END IF;
 -- Retire the exact locked plan in the same transaction as its audited status
 -- change. A missed compare-and-set must roll back evidence, status and receipt.
 UPDATE rd_private.termination_plans tp SET state='finalized'
  WHERE tp.plan_id=t.plan_id AND tp.request_id=p_request
    AND tp.state='pending_review' AND tp.original_status=r.status
    AND EXISTS(SELECT 1 FROM rd_private.terminal_finalization_audit a
      WHERE a.operation_id=p_op AND a.plan_id=tp.plan_id AND a.request_id=p_request
        AND a.quote_id=q.quote_id AND a.owner_id=p_owner
        AND a.consent_id=q.consent_operation_id AND a.old_status=r.status
        AND a.new_status=CASE WHEN t.kind='cancel' THEN 'cancelled'
          WHEN t.kind='early_end' THEN 'completed' ELSE NULL END);
 IF NOT FOUND THEN RAISE EXCEPTION 'RD_TERMINAL_PLAN_FINALIZATION_CONFLICT'; END IF;
 UPDATE rd_private.case_head SET revision=revision+1,updated_at=v_now
  WHERE request_id=p_request RETURNING * INTO h;
 INSERT INTO rd_private.operation_receipts(operation_id,request_id,actor_id,action,
    envelope_hash,expected_revision,body,committed_revision,accepted_at)
 VALUES(p_op,p_request,p_owner,p_action,p_hash,p_expected_rev,p_payload,h.revision,v_now);
 RETURN jsonb_build_object('accepted',true,'operationId',p_op,'pendingIndependentLookup',true);
END $fn$;
REVOKE ALL ON FUNCTION public.rd_ops_terminal_finalize_v1(uuid,uuid,uuid,boolean,uuid,bigint,text,text,jsonb,bigint,jsonb)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.rd_ops_terminal_finalize_v1(uuid,uuid,uuid,boolean,uuid,bigint,text,text,jsonb,bigint,jsonb)
 TO service_role;

-- Fourth independently authorized snapshot. Case/head revision is compared
-- with all other three sources by Edge. A missing fourth RPC denies the entire
-- enhanced financial capability; no fallback to a client claim.
CREATE FUNCTION public.rd_ops_terminal_snapshot_v1(
 p_request uuid,p_actor text,p_owner uuid,p_session uuid,p_aal2 boolean,
 p_customer_hash text,p_exp bigint
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE r public.requests%ROWTYPE;h rd_private.case_head%ROWTYPE;
 t rd_private.termination_plans%ROWTYPE;q rd_private.terminal_terms%ROWTYPE;
 v_enabled boolean:=false;v_quote jsonb:='null'::jsonb;v_draft jsonb:='null'::jsonb;
 v_original bigint;v_wait bigint;v_route bigint:=0;
 v_can_quote boolean:=false;v_can_consent boolean:=false;v_can_decline boolean:=false;v_can_finalize boolean:=false;
BEGIN
 SELECT * INTO r FROM public.requests WHERE id=p_request FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'RD_BOOKING_NOT_FOUND'; END IF;
 IF p_actor='operator' THEN
   IF NOT rd_private.owner_is_current(p_owner,p_session,p_aal2,p_exp) THEN
     RAISE EXCEPTION 'RD_OWNER_AUTH_DENIED'; END IF;
 ELSIF p_actor='customer' THEN
   IF NOT rd_private.customer_can_read(p_request,p_customer_hash) THEN
     RAISE EXCEPTION 'RD_CUSTOMER_READ_DENIED'; END IF;
 ELSE RAISE EXCEPTION 'RD_UNKNOWN_ACTOR'; END IF;
 SELECT * INTO h FROM rd_private.case_head WHERE request_id=p_request FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'RD_CASE_NOT_ENROLLED'; END IF;
 SELECT s.enabled AND s.terminal_terms_enabled INTO v_enabled
    FROM rd_private.ops_settings s WHERE s.id=1 FOR SHARE;
 v_enabled:=coalesce(v_enabled,false) AND EXISTS(SELECT 1 FROM pg_catalog.pg_trigger z
   WHERE z.tgname='rd_ops_legacy_writer_guard_trg'
     AND z.tgrelid=pg_catalog.to_regclass('public.requests')
     AND z.tgenabled IN('O','A') AND NOT z.tgisinternal);
 SELECT * INTO t FROM rd_private.termination_plans t
   WHERE t.request_id=p_request AND t.state='pending_review' AND
     NOT EXISTS(SELECT 1 FROM rd_private.terminal_finalization_audit a WHERE a.plan_id=t.plan_id) FOR SHARE;
 IF FOUND THEN
   SELECT * INTO q FROM rd_private.terminal_terms x WHERE x.plan_id=t.plan_id FOR SHARE;
   IF FOUND THEN
     v_quote:=jsonb_build_object('quoteId',q.quote_id,'planId',q.plan_id,
       'finalChargeYen',q.final_charge_yen,'originalPaidYen',q.original_paid_yen,
       'refundDueYen',q.refund_due_yen,'additionalDueYen',q.additional_due_yen,
       'baseFareYen',q.base_fare_yen,'waitFeeYen',q.wait_fee_yen,
       'routeDeltaYen',q.route_delta_yen,'adjustmentYen',q.adjustment_yen,
       'reason',q.reason,'basis',q.basis,
       'expiresAt',floor(extract(epoch from q.expires_at)*1000)::bigint,
       'consentId',q.consent_operation_id,
       'decisionState',CASE WHEN q.decline_operation_id IS NOT NULL THEN 'declined'
         WHEN q.consent_operation_id IS NOT NULL THEN 'consented' ELSE 'pending' END,
       'declineId',q.decline_operation_id,
       'declinedAt',floor(extract(epoch from q.declined_at)*1000)::bigint,
       'declineReason',q.decline_reason);
     v_can_consent:=v_enabled AND p_actor='customer' AND
       q.consent_operation_id IS NULL AND q.decline_operation_id IS NULL AND q.expires_at>clock_timestamp();
     v_can_decline:=v_can_consent;
     v_can_finalize:=v_enabled AND p_actor='operator' AND
       q.consent_operation_id IS NOT NULL AND q.decline_operation_id IS NULL AND q.expires_at>clock_timestamp() AND
       t.original_status IS NOT DISTINCT FROM r.status;
   ELSE
     v_can_quote:=v_enabled AND p_actor='operator' AND
       t.original_status IS NOT DISTINCT FROM r.status AND
       ((t.kind='cancel' AND r.status IN('accepted','en_route','arrived')) OR
         (t.kind='early_end' AND r.status='driving'));
     IF v_can_quote THEN
       SELECT ps.amount INTO v_original FROM public.payment_sessions ps
          WHERE ps.request_id=p_request AND ps.status IN('paid','partially_refunded') FOR SHARE;
       SELECT rd_private.wait_charge(COALESCE(sum(i.billed_ms),0)::bigint) INTO v_wait
          FROM rd_private.wait_interval i WHERE i.request_id=p_request AND i.phase='final';
       SELECT (a.quote#>>'{serverQuote,total_fee}')::bigint-r.total_fee INTO v_route
          FROM rd_private.accepted_routes a WHERE a.request_id=p_request;
       IF v_original IS NULL OR v_wait IS NULL THEN v_can_quote:=false;
       ELSE
         v_draft:=jsonb_build_object('baseFareYen',r.total_fee,'waitFeeYen',v_wait,
           'routeDeltaYen',coalesce(v_route,0),'originalPaidYen',v_original);
       END IF;
     END IF;
   END IF;
 END IF;
 IF p_actor='operator' AND NOT rd_private.owner_is_current(p_owner,p_session,p_aal2,p_exp) THEN
    RAISE EXCEPTION 'RD_OWNER_AUTH_EXPIRED'; END IF;
 RETURN jsonb_build_object('requestId',p_request,'revision',h.revision,
    'quote',v_quote,'draft',v_draft,'terminalQuote',v_can_quote,
    'terminalConsent',v_can_consent,'terminalDecline',v_can_decline,'terminalFinalize',v_can_finalize);
END $fn$;
REVOKE ALL ON FUNCTION public.rd_ops_terminal_snapshot_v1(uuid,text,uuid,uuid,boolean,text,bigint)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.rd_ops_terminal_snapshot_v1(uuid,text,uuid,uuid,boolean,text,bigint)
 TO service_role;
COMMIT;
