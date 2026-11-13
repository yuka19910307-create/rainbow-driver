-- REVIEW ONLY. Depends on jointly reviewed SQL01..04; no execution approved.
-- Source columns: reference/square-payments-v46.redacted.ts (stored session).
-- No business writes; FOR SHARE requires a write-capable transaction, even
-- though this function only reads. This is not a SET TRANSACTION READ ONLY RPC.
-- Edge must verify JWT/AAL2, supply its verified owner/session/expiry, invoke
-- before AND after Square GET, and reject any difference in the whole target.
-- A returned target is not settlement, cancellation, completion or payment proof.
DO $approval_gate$ BEGIN RAISE EXCEPTION 'RD_SETTLEMENT_OBSERVATION_REVIEW_ONLY_NO_APPROVED_EXECUTION'; END $approval_gate$;
BEGIN;
CREATE FUNCTION public.rd_ops_settlement_target_v1(
 p_request uuid,p_owner uuid,p_session uuid,p_aal2 boolean,p_exp bigint,
 p_plan uuid,p_expected_rev bigint
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE r public.requests%ROWTYPE; h rd_private.case_head%ROWTYPE;
 v_plan rd_private.termination_plans%ROWTYPE; ps public.payment_sessions%ROWTYPE;
 v_binding uuid; v_origin uuid; v_count bigint;
BEGIN
 IF p_request IS NULL OR p_owner IS NULL OR p_session IS NULL OR p_plan IS NULL OR
    p_expected_rev IS NULL OR p_expected_rev<0 OR p_expected_rev>9007199254740991 THEN
   RAISE EXCEPTION 'RD_SETTLEMENT_ARGUMENT_INVALID'; END IF;
 -- Shared lock order: booking, authority, head, plan, payment.
 SELECT * INTO r FROM public.requests WHERE id=p_request FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'RD_BOOKING_NOT_FOUND'; END IF;
 IF NOT rd_private.owner_is_current(p_owner,p_session,p_aal2,p_exp) OR
    NOT EXISTS(SELECT 1 FROM rd_private.ops_settings WHERE id=1 AND enabled=true FOR SHARE) THEN
   RAISE EXCEPTION 'RD_SETTLEMENT_AUTH_DENIED'; END IF;
 SELECT b.payment_session_id INTO v_binding FROM rd_private.booking_customer_bindings b
   WHERE b.request_id=p_request AND b.binding_method='original-customer-authority-reviewed'
   FOR SHARE OF b;
 SELECT o.payment_session_id INTO v_origin FROM rd_private.checkout_customer_origins o
   JOIN public.payment_sessions p ON p.id=o.payment_session_id
   WHERE p.request_id=p_request AND o.binding_method='authenticated-before-checkout-v1'
   FOR SHARE OF o;
 IF v_binding IS NULL AND v_origin IS NULL THEN
   RAISE EXCEPTION 'RD_SETTLEMENT_CUSTOMER_AUTHORITY_MISSING'; END IF;
 SELECT * INTO h FROM rd_private.case_head WHERE request_id=p_request FOR SHARE;
 IF NOT FOUND OR h.revision IS DISTINCT FROM p_expected_rev THEN
   RAISE EXCEPTION 'RD_SETTLEMENT_REVISION_STALE'; END IF;
 SELECT * INTO v_plan FROM rd_private.termination_plans WHERE plan_id=p_plan FOR SHARE;
 IF NOT FOUND OR v_plan.request_id IS DISTINCT FROM p_request OR
    v_plan.owner_id IS DISTINCT FROM p_owner OR v_plan.state IS DISTINCT FROM 'pending_review' OR
    v_plan.original_status IS DISTINCT FROM r.status THEN
   RAISE EXCEPTION 'RD_SETTLEMENT_PLAN_MISMATCH'; END IF;
 SELECT count(*) INTO v_count FROM public.payment_sessions WHERE request_id=p_request;
 IF v_count<>1 THEN RAISE EXCEPTION 'RD_SETTLEMENT_PAYMENT_AMBIGUOUS'; END IF;
 SELECT * INTO ps FROM public.payment_sessions WHERE request_id=p_request FOR SHARE;
 IF NOT FOUND OR ps.request_id IS DISTINCT FROM p_request OR
    (ps.id IS DISTINCT FROM v_binding AND ps.id IS DISTINCT FROM v_origin) THEN
   RAISE EXCEPTION 'RD_SETTLEMENT_PAYMENT_BINDING_MISMATCH'; END IF;
 -- Preserve current authority semantics: fully refunded local sessions are
 -- refused until an independently reviewed observation-only contract exists.
 IF NOT rd_private.has_original_customer_authority(p_request) THEN
   RAISE EXCEPTION 'RD_SETTLEMENT_CUSTOMER_AUTHORITY_MISSING'; END IF;
 IF ps.environment IS NULL OR ps.environment NOT IN('sandbox','production') OR
    ps.square_payment_id IS NULL OR ps.square_payment_id !~ '^[A-Za-z0-9_-]{1,192}$' OR
    ps.square_order_id IS NULL OR ps.square_order_id !~ '^[A-Za-z0-9_-]{1,192}$' OR
    ps.amount IS NULL OR ps.amount<=0 OR ps.amount>9007199254740991 OR
    ps.amount::numeric<>trunc(ps.amount::numeric) OR ps.currency IS DISTINCT FROM 'JPY' THEN
   RAISE EXCEPTION 'RD_SETTLEMENT_PAYMENT_INVALID'; END IF;
 -- Revalidate wall-clock expiry after every potentially blocking lock.
 IF NOT rd_private.owner_is_current(p_owner,p_session,p_aal2,p_exp) THEN
   RAISE EXCEPTION 'RD_OWNER_AUTH_EXPIRED'; END IF;
 RETURN jsonb_build_object('requestId',p_request,'planId',p_plan,'revision',h.revision,
   'paymentSessionId',ps.id,'environment',ps.environment,'paymentId',ps.square_payment_id,
   'orderId',ps.square_order_id,'amountYen',ps.amount,'currency',ps.currency);
END $fn$;
REVOKE ALL ON FUNCTION public.rd_ops_settlement_target_v1(uuid,uuid,uuid,boolean,bigint,uuid,bigint)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.rd_ops_settlement_target_v1(uuid,uuid,uuid,boolean,bigint,uuid,bigint)
 TO service_role;
COMMIT;
