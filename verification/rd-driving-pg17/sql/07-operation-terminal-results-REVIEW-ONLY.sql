-- Rainbow Driver: explicit durable closure of an unresolved operation ID.
-- REVIEW ONLY. NOT EXECUTED. Requires SQL01-06 and separate owner approval.
DO $approval_gate$ BEGIN RAISE EXCEPTION 'RD_OPS_OPERATION_TERMINAL_REVIEW_ONLY'; END $approval_gate$;

BEGIN;

-- Recovery authority is distinct from authority to change a fare or booking.
-- A feature switch may be OFF or a payment already refunded while an earlier
-- operation still needs lookup/closure. No grants, booking bindings, or enabled
-- flags are minted here. closed_by always means the current closure requester.
CREATE FUNCTION rd_private.operation_recovery_authorized(
 p_request uuid,p_actor text,p_actor_id uuid,p_session uuid,p_aal2 boolean,
 p_customer_hash text,p_exp bigint
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
BEGIN
 IF p_actor='operator' THEN
   RETURN p_customer_hash IS NULL AND
     rd_private.owner_is_current(p_actor_id,p_session,p_aal2,p_exp);
 ELSIF p_actor='customer' THEN
   IF p_aal2 IS DISTINCT FROM false OR
      NOT rd_private.customer_otp_verified(p_request,p_customer_hash,p_actor_id,p_session,p_exp) THEN
     RETURN false; END IF;
   -- Retain original-customer binding after refund/status changes. This helper
   -- is used ONLY by recovery RPCs, never by a business-operation writer.
   PERFORM 1 FROM rd_private.booking_customer_bindings b
     JOIN public.payment_sessions ps ON ps.id=b.payment_session_id
     WHERE b.request_id=p_request AND b.customer_id=p_actor_id
       AND ps.request_id=p_request AND b.binding_method='original-customer-authority-reviewed'
     FOR SHARE OF b,ps;
   IF NOT FOUND THEN
     PERFORM 1 FROM rd_private.checkout_customer_origins o
       JOIN public.payment_sessions ps ON ps.id=o.payment_session_id
       WHERE ps.request_id=p_request AND o.customer_id=p_actor_id
         AND o.binding_method='authenticated-before-checkout-v1'
       FOR SHARE OF o,ps;
     IF NOT FOUND THEN RETURN false; END IF;
   END IF;
   RETURN rd_private.customer_otp_verified(p_request,p_customer_hash,p_actor_id,p_session,p_exp);
 END IF;
 RETURN false;
END $fn$;
REVOKE ALL ON FUNCTION rd_private.operation_recovery_authorized(uuid,text,uuid,uuid,boolean,text,bigint)
 FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION rd_private.validate_operation_recovery_input(
 p_request uuid,p_actor text,p_actor_id uuid,p_session uuid,p_op uuid,
 p_expected_rev bigint,p_hash text,p_action text,p_payload jsonb
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
BEGIN
 IF p_request IS NULL OR p_actor_id IS NULL OR p_session IS NULL OR p_op IS NULL OR
    p_expected_rev IS NULL OR p_expected_rev<0 OR p_expected_rev>9007199254740991 OR
    p_hash IS NULL OR p_hash !~ '^[0-9a-f]{64}$' OR
    jsonb_typeof(p_payload) IS DISTINCT FROM 'object' OR
    octet_length(p_payload::text)>32768 OR p_actor IS NULL OR p_action IS NULL THEN
   RAISE EXCEPTION 'RD_OPERATION_RECOVERY_ARGUMENT_INVALID'; END IF;
 IF NOT (
   (p_actor='operator' AND p_action IN (
     'status_transition','wait_start','wait_stop_claim','wait_confirm','settlement_approve','complete_request',
     'route_propose','route_present','cancel_plan','early_end_plan','terminal_withdraw','terminal_quote','terminal_finalize')) OR
   (p_actor='customer' AND p_action IN (
     'customer_finish_confirmation','customer_consent','customer_decline','customer_terminal_consent'))
 ) THEN RAISE EXCEPTION 'RD_OPERATION_RECOVERY_ACTION_DENIED'; END IF;
END $fn$;
REVOKE ALL ON FUNCTION rd_private.validate_operation_recovery_input(uuid,text,uuid,uuid,uuid,bigint,text,text,jsonb)
 FROM PUBLIC,anon,authenticated,service_role;

-- Private helper. Call only while holding the operation ID transaction lock,
-- after current authority checks. A successful receipt has precedence.
CREATE FUNCTION rd_private.operation_result_exact(
 p_request uuid,p_actor text,p_actor_id uuid,p_op uuid,
 p_expected_rev bigint,p_hash text,p_action text,p_payload jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE v_receipt rd_private.operation_receipts%ROWTYPE;
 v_closed rd_private.operation_terminal_results%ROWTYPE;
BEGIN
 SELECT * INTO v_receipt FROM rd_private.operation_receipts WHERE operation_id=p_op;
 IF FOUND THEN
   IF v_receipt.request_id IS DISTINCT FROM p_request OR v_receipt.actor_id IS DISTINCT FROM p_actor_id OR
      v_receipt.expected_revision IS DISTINCT FROM p_expected_rev OR v_receipt.envelope_hash IS DISTINCT FROM p_hash OR
      v_receipt.action IS DISTINCT FROM p_action OR v_receipt.body IS DISTINCT FROM p_payload THEN
     RAISE EXCEPTION 'RD_OPERATION_ID_REUSED'; END IF;
   -- Existing successful receipt contract is unchanged.
   RETURN jsonb_build_object('status','committed','requestId',v_receipt.request_id,
     'operationId',v_receipt.operation_id,'envelopeHash',v_receipt.envelope_hash,
     'revision',v_receipt.committed_revision,
     'acceptedAt',floor(extract(epoch from v_receipt.accepted_at)*1000)::bigint);
 END IF;
 SELECT * INTO v_closed FROM rd_private.operation_terminal_results WHERE operation_id=p_op;
 IF FOUND THEN
   IF v_closed.request_id IS DISTINCT FROM p_request OR v_closed.closed_by IS DISTINCT FROM p_actor_id OR
      v_closed.actor_kind IS DISTINCT FROM p_actor OR v_closed.expected_revision IS DISTINCT FROM p_expected_rev OR
      v_closed.envelope_hash IS DISTINCT FROM p_hash OR v_closed.action IS DISTINCT FROM p_action OR
      v_closed.body IS DISTINCT FROM p_payload THEN
     RAISE EXCEPTION 'RD_OPERATION_ID_REUSED'; END IF;
   RETURN jsonb_build_object('status','not_executed','requestId',v_closed.request_id,
     'operationId',v_closed.operation_id,'envelopeHash',v_closed.envelope_hash,
     'actor',v_closed.actor_kind,'action',v_closed.action,'expectedRevision',v_closed.expected_revision,
     'closedAt',floor(extract(epoch from v_closed.closed_at)*1000)::bigint,
     'reason',v_closed.reason);
 END IF;
 -- Absence is never evidence that a late request cannot still commit.
 RETURN jsonb_build_object('status','not_found','requestId',p_request,
   'operationId',p_op,'envelopeHash',p_hash,'actor',p_actor,
   'action',p_action,'expectedRevision',p_expected_rev);
END $fn$;
REVOKE ALL ON FUNCTION rd_private.operation_result_exact(uuid,text,uuid,uuid,bigint,text,text,jsonb)
 FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.rd_ops_close_unexecuted_v1(
 p_request uuid,p_actor text,p_actor_id uuid,p_session uuid,p_aal2 boolean,p_customer_hash text,p_exp bigint,
 p_op uuid,p_expected_rev bigint,p_hash text,p_action text,p_payload jsonb,p_confirm boolean
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE v_result jsonb;
BEGIN
 IF p_confirm IS DISTINCT FROM true THEN RAISE EXCEPTION 'RD_EXPLICIT_OPERATION_CLOSE_REQUIRED'; END IF;
 PERFORM rd_private.validate_operation_recovery_input(
   p_request,p_actor,p_actor_id,p_session,p_op,p_expected_rev,p_hash,p_action,p_payload);
 -- Same order as EVERY business writer/preflight: ID -> booking -> authority.
 PERFORM rd_private.lock_operation_id(p_op);
 PERFORM 1 FROM public.requests WHERE id=p_request FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'RD_BOOKING_NOT_FOUND'; END IF;
 IF NOT rd_private.operation_recovery_authorized(
   p_request,p_actor,p_actor_id,p_session,p_aal2,p_customer_hash,p_exp) THEN
   RAISE EXCEPTION 'RD_OPERATION_RECOVERY_AUTH_DENIED'; END IF;
 PERFORM 1 FROM rd_private.case_head WHERE request_id=p_request FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'RD_CASE_NOT_ENROLLED'; END IF;
 v_result:=rd_private.operation_result_exact(
   p_request,p_actor,p_actor_id,p_op,p_expected_rev,p_hash,p_action,p_payload);
 IF v_result->>'status'='not_found' THEN
   -- This is an independent, successful control transaction, not a business
   -- rejection caught and re-raised in the same rolled-back transaction.
   INSERT INTO rd_private.operation_terminal_results(
     operation_id,request_id,actor_kind,closed_by,closed_by_session,action,envelope_hash,
     expected_revision,body,outcome,reason,closed_at)
   VALUES(p_op,p_request,p_actor,p_actor_id,p_session,p_action,p_hash,p_expected_rev,p_payload,
     'not_executed','explicit_unexecuted_close',clock_timestamp());
 ELSIF v_result->>'status' NOT IN ('committed','not_executed') THEN
   RAISE EXCEPTION 'RD_OPERATION_RESULT_INVALID';
 END IF;
 -- Clock/session/grant may expire while any lock is awaited. Failure rolls
 -- back this closure; it does not manufacture a terminal proof.
 IF NOT rd_private.operation_recovery_authorized(
   p_request,p_actor,p_actor_id,p_session,p_aal2,p_customer_hash,p_exp) THEN
   RAISE EXCEPTION 'RD_OPERATION_RECOVERY_AUTH_EXPIRED'; END IF;
 -- Do not return a receipt here. Client MUST use a separate lookup request.
 RETURN jsonb_build_object('closureAccepted',true,'pendingIndependentLookup',true);
END $fn$;
REVOKE ALL ON FUNCTION public.rd_ops_close_unexecuted_v1(
 uuid,text,uuid,uuid,boolean,text,bigint,uuid,bigint,text,text,jsonb,boolean)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.rd_ops_close_unexecuted_v1(
 uuid,text,uuid,uuid,boolean,text,bigint,uuid,bigint,text,text,jsonb,boolean)
 TO service_role;

CREATE FUNCTION public.rd_ops_operation_result_v1(
 p_request uuid,p_actor text,p_actor_id uuid,p_session uuid,p_aal2 boolean,p_customer_hash text,p_exp bigint,
 p_op uuid,p_expected_rev bigint,p_hash text,p_action text,p_payload jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE v_result jsonb;
BEGIN
 PERFORM rd_private.validate_operation_recovery_input(
   p_request,p_actor,p_actor_id,p_session,p_op,p_expected_rev,p_hash,p_action,p_payload);
 PERFORM rd_private.lock_operation_id(p_op);
 PERFORM 1 FROM public.requests WHERE id=p_request FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'RD_BOOKING_NOT_FOUND'; END IF;
 IF NOT rd_private.operation_recovery_authorized(
   p_request,p_actor,p_actor_id,p_session,p_aal2,p_customer_hash,p_exp) THEN
   RAISE EXCEPTION 'RD_OPERATION_RECOVERY_AUTH_DENIED'; END IF;
 PERFORM 1 FROM rd_private.case_head WHERE request_id=p_request FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'RD_CASE_NOT_ENROLLED'; END IF;
 v_result:=rd_private.operation_result_exact(
   p_request,p_actor,p_actor_id,p_op,p_expected_rev,p_hash,p_action,p_payload);
 IF NOT rd_private.operation_recovery_authorized(
   p_request,p_actor,p_actor_id,p_session,p_aal2,p_customer_hash,p_exp) THEN
   RAISE EXCEPTION 'RD_OPERATION_RECOVERY_AUTH_EXPIRED'; END IF;
 RETURN v_result;
END $fn$;
REVOKE ALL ON FUNCTION public.rd_ops_operation_result_v1(
 uuid,text,uuid,uuid,boolean,text,bigint,uuid,bigint,text,text,jsonb)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.rd_ops_operation_result_v1(
 uuid,text,uuid,uuid,boolean,text,bigint,uuid,bigint,text,text,jsonb)
 TO service_role;

COMMIT;

