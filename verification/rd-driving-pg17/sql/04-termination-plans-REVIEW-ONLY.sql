-- Rainbow Driver v8. REVIEW ONLY; SQL01/02/03 must be jointly audited first.
-- NO SQL has been executed. Do not paste/run this script without owner approval.
-- A termination plan is an INTENT, not a cancelled/completed booking or a refund.
DO $approval_gate$ BEGIN RAISE EXCEPTION 'RD_TERMINATION_V8_REVIEW_ONLY_NO_APPROVED_EXECUTION'; END $approval_gate$;

BEGIN;
CREATE TABLE rd_private.termination_plans (
 plan_id uuid PRIMARY KEY,
 request_id uuid NOT NULL REFERENCES rd_private.case_head(request_id) ON DELETE RESTRICT,
 owner_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
 kind text NOT NULL CHECK(kind IN('cancel','early_end')),
 state text NOT NULL CHECK(state IN('pending_review','withdrawn','finalized')),
 reason text NOT NULL CHECK(length(btrim(reason))>0 AND length(reason)<=1000),
 original_status text NOT NULL CHECK(original_status IN('accepted','en_route','arrived','driving')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 withdrawn_at timestamptz,
 withdrawn_by uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
 withdrawal_reason text,
 CHECK ((state IN('pending_review','finalized') AND withdrawn_at IS NULL AND withdrawn_by IS NULL AND withdrawal_reason IS NULL)
   OR (state='withdrawn' AND withdrawn_at IS NOT NULL AND withdrawn_by IS NOT NULL AND withdrawal_reason IS NOT NULL))
);
CREATE UNIQUE INDEX rd_one_pending_termination ON rd_private.termination_plans(request_id)
 WHERE state='pending_review';
CREATE INDEX rd_termination_history ON rd_private.termination_plans(request_id,created_at DESC);
ALTER TABLE rd_private.termination_plans ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON rd_private.termination_plans FROM PUBLIC,anon,authenticated;

-- Existing status writer remains protected by SQL02. An unreviewed termination
-- plan can never be silently overwritten by complete/cancel/decline operations.
-- A future, separately approved atomic finalization writer is still required.
CREATE FUNCTION rd_private.guard_pending_termination_status()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
BEGIN
 -- SQL06 creates this audit relation. Keep its lookup in a separate branch:
 -- the SQL04 trigger also runs for legacy bookings before SQL06 is installed.
 -- Absence grants no bypass; the pending-plan rejection below still applies.
 IF NEW.status IS DISTINCT FROM OLD.status AND
    pg_catalog.to_regclass('rd_private.terminal_finalization_audit') IS NOT NULL THEN
   IF EXISTS(SELECT 1 FROM rd_private.terminal_finalization_audit fa
      WHERE fa.request_id=OLD.id AND fa.old_status=OLD.status AND fa.new_status=NEW.status)
      THEN RETURN NEW; END IF;
 END IF;
 IF NEW.status IS DISTINCT FROM OLD.status AND EXISTS(
    SELECT 1 FROM rd_private.termination_plans p
      WHERE p.request_id=OLD.id AND p.state IN('pending_review','finalized')) THEN
    RAISE EXCEPTION 'RD_TERMINATION_REVIEW_PENDING';
 END IF;
 RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION rd_private.guard_pending_termination_status() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER rd_ops_pending_termination_status_trg BEFORE UPDATE OF status ON public.requests
  FOR EACH ROW EXECUTE FUNCTION rd_private.guard_pending_termination_status();

-- Reject unrelated enhanced-case operations once an end/cancel review is open.
-- Even if an Edge client fails to disable a button, receipt insertion rolls
-- the full writer transaction back. Withdrawal restores the prior status path.
CREATE FUNCTION rd_private.guard_pending_termination_receipt()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
BEGIN
 IF NEW.action NOT IN('cancel_plan','early_end_plan','terminal_withdraw',
    'terminal_quote','customer_terminal_consent','terminal_finalize') AND EXISTS(
    SELECT 1 FROM rd_private.termination_plans p
      WHERE p.request_id=NEW.request_id AND p.state IN('pending_review','finalized')) THEN
    RAISE EXCEPTION 'RD_TERMINATION_REVIEW_PENDING';
 END IF;
 RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION rd_private.guard_pending_termination_receipt() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER rd_ops_pending_termination_receipt_trg BEFORE INSERT ON rd_private.operation_receipts
  FOR EACH ROW EXECUTE FUNCTION rd_private.guard_pending_termination_receipt();

CREATE FUNCTION public.rd_ops_termination_plan_v1(
 p_request uuid,p_owner uuid,p_session uuid,p_aal2 boolean,
 p_op uuid,p_expected_rev bigint,p_hash text,p_action text,p_payload jsonb,p_exp bigint
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE r public.requests%ROWTYPE;h rd_private.case_head%ROWTYPE;
 v_existing rd_private.operation_receipts%ROWTYPE;
 v_plan rd_private.termination_plans%ROWTYPE;
 v_now timestamptz;
 v_reason text; v_plan_id uuid;v_kind text;
BEGIN
 IF p_request IS NULL OR p_owner IS NULL OR p_session IS NULL OR p_op IS NULL OR
    p_expected_rev IS NULL OR p_expected_rev<0 OR p_hash IS NULL OR
    p_hash !~ '^[0-9a-f]{64}$' OR
    p_action IS NULL OR p_action NOT IN('cancel_plan','early_end_plan','terminal_withdraw') OR
    jsonb_typeof(p_payload) IS DISTINCT FROM 'object' THEN
   RAISE EXCEPTION 'RD_TERMINATION_ARGUMENT_INVALID'; END IF;
 -- Global operation ID first, before booking/auth/case locks.
 PERFORM rd_private.lock_operation_id(p_op);
 SELECT * INTO r FROM public.requests WHERE id=p_request FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'RD_BOOKING_NOT_FOUND'; END IF;
 IF NOT rd_private.owner_is_current(p_owner,p_session,p_aal2,p_exp) OR
    NOT rd_private.has_original_customer_authority(p_request) OR
    NOT EXISTS(SELECT 1 FROM rd_private.ops_settings WHERE id=1 AND enabled=true FOR SHARE) OR
    NOT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger t
      WHERE t.tgname='rd_ops_legacy_writer_guard_trg'
      AND t.tgrelid=pg_catalog.to_regclass('public.requests')
      AND t.tgfoid=pg_catalog.to_regprocedure('rd_private.guard_legacy_status_change()')
      AND t.tgenabled IN('O','A') AND t.tgtype=19 AND NOT t.tgisinternal) THEN
   RAISE EXCEPTION 'RD_TERMINATION_AUTH_DENIED'; END IF;
 SELECT * INTO h FROM rd_private.case_head WHERE request_id=p_request FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'RD_CASE_NOT_ENROLLED'; END IF;
 PERFORM rd_private.assert_operation_not_closed(p_request,p_owner,p_op,p_expected_rev,p_hash,p_action,p_payload);
 SELECT * INTO v_existing FROM rd_private.operation_receipts WHERE operation_id=p_op;
 IF FOUND THEN
   IF v_existing.request_id IS DISTINCT FROM p_request OR
      v_existing.actor_id IS DISTINCT FROM p_owner OR
      v_existing.expected_revision IS DISTINCT FROM p_expected_rev OR
      v_existing.envelope_hash IS DISTINCT FROM p_hash OR
      v_existing.action IS DISTINCT FROM p_action OR
      v_existing.body IS DISTINCT FROM p_payload THEN
     RAISE EXCEPTION 'RD_OPERATION_ID_REUSED'; END IF;
   RETURN jsonb_build_object('accepted',true,'operationId',p_op,'pendingIndependentLookup',true);
 END IF;
 IF h.revision IS DISTINCT FROM p_expected_rev THEN RAISE EXCEPTION 'RD_TERMINATION_REVISION_STALE'; END IF;
 v_now:=clock_timestamp();
 v_reason:=p_payload->>'reason';
 IF jsonb_typeof(p_payload->'reason') IS DISTINCT FROM 'string' OR
    v_reason IS NULL OR length(btrim(v_reason))=0 OR length(v_reason)>1000 OR
    v_reason IS DISTINCT FROM btrim(v_reason) THEN RAISE EXCEPTION 'RD_TERMINATION_REASON_REQUIRED'; END IF;
 IF p_action='terminal_withdraw' THEN
    IF (SELECT count(*) FROM jsonb_object_keys(p_payload))<>2 OR
       p_payload->>'planId' IS NULL OR
       jsonb_typeof(p_payload->'planId') IS DISTINCT FROM 'string' OR
       p_payload->>'planId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
       RAISE EXCEPTION 'RD_TERMINATION_WITHDRAW_ARGUMENT'; END IF;
    v_plan_id:=(p_payload->>'planId')::uuid;
    SELECT * INTO v_plan FROM rd_private.termination_plans t
      WHERE t.plan_id=v_plan_id AND t.request_id=p_request AND t.state='pending_review' FOR UPDATE;
    IF NOT FOUND OR r.status IS DISTINCT FROM v_plan.original_status THEN
      RAISE EXCEPTION 'RD_TERMINATION_WITHDRAW_STALE'; END IF;
    UPDATE rd_private.termination_plans SET state='withdrawn',withdrawn_at=v_now,
      withdrawn_by=p_owner,withdrawal_reason=v_reason WHERE plan_id=v_plan_id;
 ELSE
    IF (SELECT count(*) FROM jsonb_object_keys(p_payload))<>1 OR
       (p_action='cancel_plan' AND r.status NOT IN('accepted','en_route','arrived')) OR
       (p_action='early_end_plan' AND r.status IS DISTINCT FROM 'driving') THEN
       RAISE EXCEPTION 'RD_TERMINATION_STATUS_INVALID'; END IF;
    IF NOT EXISTS(SELECT 1 FROM public.payment_sessions ps
       WHERE ps.request_id=p_request AND ps.status IN('paid','partially_refunded')) THEN
       RAISE EXCEPTION 'RD_PAYMENT_NOT_CONFIRMED'; END IF;
    IF EXISTS(SELECT 1 FROM rd_private.termination_plans t
       WHERE t.request_id=p_request AND t.state='pending_review') OR
       EXISTS(SELECT 1 FROM rd_private.wait_interval i
       WHERE i.request_id=p_request AND i.phase IN('active','review')) OR
       EXISTS(SELECT 1 FROM rd_private.route_proposals q
       WHERE q.request_id=p_request AND q.status IN('proposed','presented') AND q.expires_at>v_now) THEN
       RAISE EXCEPTION 'RD_TERMINATION_NOT_READY'; END IF;
    v_kind:=CASE WHEN p_action='cancel_plan' THEN 'cancel' ELSE 'early_end' END;
    -- Amount unknown: do not invent cancellation fees, unpaid balance or
    -- a Square charge/refund from a free-text reason.
    INSERT INTO rd_private.termination_plans(plan_id,request_id,owner_id,kind,state,reason,original_status,created_at)
       VALUES(p_op,p_request,p_owner,v_kind,'pending_review',v_reason,r.status,v_now);
 END IF;
 IF NOT rd_private.owner_is_current(p_owner,p_session,p_aal2,p_exp) THEN
    RAISE EXCEPTION 'RD_OWNER_AUTH_EXPIRED'; END IF;
 UPDATE rd_private.case_head SET revision=revision+1,updated_at=v_now
   WHERE request_id=p_request RETURNING * INTO h;
 INSERT INTO rd_private.operation_receipts(operation_id,request_id,actor_id,action,
   envelope_hash,expected_revision,body,committed_revision,accepted_at)
 VALUES(p_op,p_request,p_owner,p_action,p_hash,p_expected_rev,p_payload,h.revision,v_now);
 RETURN jsonb_build_object('accepted',true,'operationId',p_op,'pendingIndependentLookup',true);
END $fn$;
REVOKE ALL ON FUNCTION public.rd_ops_termination_plan_v1(uuid,uuid,uuid,boolean,uuid,bigint,text,text,jsonb,bigint)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.rd_ops_termination_plan_v1(uuid,uuid,uuid,boolean,uuid,bigint,text,text,jsonb,bigint)
 TO service_role;

-- Independent snapshot: one current revision and proof per source. Edge must
-- cross-check it against the base and route revisions before returning any
-- combined capabilities. No automatic payment status or Square call.
CREATE FUNCTION public.rd_ops_termination_snapshot_v1(
 p_request uuid,p_actor text,p_owner uuid,p_session uuid,p_aal2 boolean,
 p_customer_hash text,p_exp bigint
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE r public.requests%ROWTYPE;h rd_private.case_head%ROWTYPE;
 v_plan rd_private.termination_plans%ROWTYPE;v_ready boolean:=false;
 v_json jsonb:='null'::jsonb;
BEGIN
 SELECT * INTO r FROM public.requests WHERE id=p_request FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'RD_BOOKING_NOT_FOUND'; END IF;
 IF p_actor='operator' THEN
    IF NOT rd_private.owner_is_current(p_owner,p_session,p_aal2,p_exp) THEN RAISE EXCEPTION 'RD_OWNER_AUTH_DENIED'; END IF;
 ELSIF p_actor='customer' THEN
    IF NOT rd_private.customer_can_read(p_request,p_customer_hash) THEN RAISE EXCEPTION 'RD_CUSTOMER_READ_DENIED'; END IF;
 ELSE RAISE EXCEPTION 'RD_UNKNOWN_ACTOR'; END IF;
 SELECT * INTO h FROM rd_private.case_head WHERE request_id=p_request FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'RD_CASE_NOT_ENROLLED'; END IF;
 SELECT * INTO v_plan FROM rd_private.termination_plans t
    WHERE t.request_id=p_request AND t.state='pending_review'
      AND NOT EXISTS(SELECT 1 FROM rd_private.terminal_finalization_audit fa
        WHERE fa.plan_id=t.plan_id) FOR SHARE;
 IF FOUND THEN
   v_json:=jsonb_build_object('planId',v_plan.plan_id,'kind',v_plan.kind,'state',v_plan.state,
      'reason',v_plan.reason,'createdAt',floor(extract(epoch from v_plan.created_at)*1000)::bigint);
 ELSE
   v_ready:=p_actor='operator' AND r.status IN('accepted','en_route','arrived','driving') AND
     rd_private.has_original_customer_authority(p_request) AND
     EXISTS(SELECT 1 FROM rd_private.ops_settings WHERE id=1 AND enabled=true FOR SHARE) AND
     EXISTS(SELECT 1 FROM pg_catalog.pg_trigger t
       WHERE t.tgname='rd_ops_legacy_writer_guard_trg'
         AND t.tgrelid=pg_catalog.to_regclass('public.requests')
         AND t.tgfoid=pg_catalog.to_regprocedure('rd_private.guard_legacy_status_change()')
         AND t.tgenabled IN('O','A') AND t.tgtype=19 AND NOT t.tgisinternal) AND
     EXISTS(SELECT 1 FROM public.payment_sessions ps
       WHERE ps.request_id=p_request AND ps.status IN('paid','partially_refunded')) AND
     NOT EXISTS(SELECT 1 FROM rd_private.wait_interval i
       WHERE i.request_id=p_request AND i.phase IN('active','review')) AND
     NOT EXISTS(SELECT 1 FROM rd_private.route_proposals q
       WHERE q.request_id=p_request AND q.status IN('proposed','presented') AND q.expires_at>clock_timestamp());
 END IF;
 IF p_actor='operator' AND NOT rd_private.owner_is_current(p_owner,p_session,p_aal2,p_exp) THEN
    RAISE EXCEPTION 'RD_OWNER_AUTH_EXPIRED'; END IF;
 RETURN jsonb_build_object('requestId',p_request,'revision',h.revision,
   'canPlan',coalesce(v_ready,false),'termination',v_json);
END $fn$;
REVOKE ALL ON FUNCTION public.rd_ops_termination_snapshot_v1(uuid,text,uuid,uuid,boolean,text,bigint)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.rd_ops_termination_snapshot_v1(uuid,text,uuid,uuid,boolean,text,bigint)
 TO service_role;

-- Override the original route preflight to avoid a billable Google Routes
-- call while a termination review is pending. A receipt-only guard is too
-- late because the provider call happens BETWEEN preflight and submit.
CREATE OR REPLACE FUNCTION public.rd_ops_route_preflight_v1(
 p_request uuid,p_owner uuid,p_session uuid,p_aal2 boolean,
 p_exp bigint,p_op uuid,p_expected_rev bigint,p_hash text,p_payload jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE r public.requests%ROWTYPE; h rd_private.case_head%ROWTYPE;
 v_old rd_private.operation_receipts%ROWTYPE;
BEGIN
 -- Global operation ID first, before booking/auth/case locks.
 PERFORM rd_private.lock_operation_id(p_op);
 SELECT * INTO r FROM public.requests WHERE id=p_request FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'RD_BOOKING_NOT_FOUND'; END IF;
 IF NOT rd_private.owner_is_current(p_owner,p_session,p_aal2,p_exp) OR
    NOT rd_private.has_original_customer_authority(p_request) OR
    NOT EXISTS(SELECT 1 FROM rd_private.ops_settings WHERE id=1 AND enabled=true FOR SHARE) OR
    NOT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger t
      WHERE t.tgname='rd_ops_legacy_writer_guard_trg'
        AND t.tgrelid=pg_catalog.to_regclass('public.requests')
        AND t.tgfoid=pg_catalog.to_regprocedure('rd_private.guard_legacy_status_change()')
        AND t.tgenabled IN('O','A') AND t.tgtype=19 AND NOT t.tgisinternal) THEN
      RAISE EXCEPTION 'RD_ROUTE_AUTH_DISABLED'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.payment_sessions ps
      WHERE ps.request_id=p_request AND ps.status IN('paid','partially_refunded')) THEN
      RAISE EXCEPTION 'RD_PAYMENT_NOT_CONFIRMED'; END IF;
 SELECT * INTO h FROM rd_private.case_head WHERE request_id=p_request FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'RD_CASE_NOT_ENROLLED'; END IF;
 PERFORM rd_private.assert_operation_not_closed(p_request,p_owner,p_op,p_expected_rev,p_hash,'route_propose',p_payload);
 SELECT * INTO v_old FROM rd_private.operation_receipts WHERE operation_id=p_op;
 IF FOUND THEN
   IF v_old.request_id IS DISTINCT FROM p_request OR v_old.actor_id IS DISTINCT FROM p_owner OR
      v_old.expected_revision IS DISTINCT FROM p_expected_rev OR v_old.envelope_hash IS DISTINCT FROM p_hash OR
      v_old.action IS DISTINCT FROM 'route_propose' OR v_old.body IS DISTINCT FROM p_payload THEN
      RAISE EXCEPTION 'RD_OPERATION_ID_REUSED'; END IF;
   RETURN jsonb_build_object('alreadyCommitted',true);
 END IF;
 IF r.status NOT IN('accepted','en_route','arrived','driving') OR
    h.revision IS DISTINCT FROM p_expected_rev OR
    EXISTS(SELECT 1 FROM rd_private.termination_plans t
      WHERE t.request_id=p_request AND t.state='pending_review') OR
    EXISTS(SELECT 1 FROM rd_private.wait_interval i WHERE i.request_id=p_request AND i.phase IN('active','review')) OR
    EXISTS(SELECT 1 FROM rd_private.route_proposals p WHERE p.request_id=p_request AND p.status IN('proposed','presented') AND p.expires_at>clock_timestamp()) THEN
    RAISE EXCEPTION 'RD_ROUTE_PREFLIGHT_BLOCKED'; END IF;
 IF p_payload IS NULL OR jsonb_typeof(p_payload) IS DISTINCT FROM 'object' OR
    NOT(p_payload ? 'points' AND p_payload ? 'reason') OR
    jsonb_array_length(p_payload->'points') NOT BETWEEN 2 AND 22 THEN
    RAISE EXCEPTION 'RD_ROUTE_PAYLOAD_INVALID'; END IF;
 -- Use existing booking pickup/destination; the Edge must reject different
 -- endpoint IDs/addresses before calling Google Routes.
 RETURN jsonb_build_object('alreadyCommitted',false,'requestId',p_request,
    'destinationVisitId',(md5(p_request::text || ':destination'))::uuid,
    'pickup_address',r.pickup_address,'destination_address',r.destination_address,
    'pickup_lat',r.pickup_lat,'pickup_lng',r.pickup_lng,
    'destination_lat',r.destination_lat,'destination_lng',r.destination_lng,
    'pickup_distance_km',r.pickup_distance_km,'pickup_eta_min',r.pickup_eta_min,
    'pickup_fee',r.pickup_fee,'revision',h.revision);
END $fn$;
REVOKE ALL ON FUNCTION public.rd_ops_route_preflight_v1(uuid,uuid,uuid,boolean,bigint,uuid,bigint,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.rd_ops_route_preflight_v1(uuid,uuid,uuid,boolean,bigint,uuid,bigint,text,jsonb) TO service_role;

COMMIT;
