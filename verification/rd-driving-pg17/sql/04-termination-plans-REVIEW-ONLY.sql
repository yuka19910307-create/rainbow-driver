-- Rainbow Driver v8. REVIEW ONLY; SQL01/02/03 must be jointly audited first.
-- NO SQL has been executed. Do not paste/run this script without owner approval.
-- A termination plan is an INTENT, not a cancelled/completed booking or a refund.
DO $approval_gate$ BEGIN RAISE EXCEPTION 'RD_TERMINATION_V8_REVIEW_ONLY_NO_APPROVED_EXECUTION'; END $approval_gate$;

BEGIN;
-- A customer request records intent only; owner review and monetary consent
-- remain distinct operations with distinct authenticated actors and receipts.
CREATE TABLE rd_private.customer_termination_requests (
 customer_request_id uuid PRIMARY KEY,
 request_id uuid NOT NULL REFERENCES rd_private.case_head(request_id) ON DELETE RESTRICT,
 customer_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
 auth_session_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN('cancel','early_end')),
 reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 1000 AND reason=btrim(reason)),
 original_status text NOT NULL CHECK(original_status IN('accepted','en_route','arrived','driving')),
 requested_revision bigint NOT NULL CHECK(requested_revision>=0),
 requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 state text NOT NULL CHECK(state IN('open','linked')),
 linked_plan_id uuid UNIQUE,
 UNIQUE(request_id,customer_request_id),
 CHECK ((kind='cancel' AND original_status IN('accepted','en_route','arrived')) OR
   (kind='early_end' AND original_status='driving')),
 CHECK ((state='open' AND linked_plan_id IS NULL) OR (state='linked' AND linked_plan_id IS NOT NULL))
);
CREATE UNIQUE INDEX rd_one_open_customer_termination ON rd_private.customer_termination_requests(request_id)
 WHERE state='open';
CREATE INDEX rd_customer_termination_history ON rd_private.customer_termination_requests(request_id,requested_revision DESC);
ALTER TABLE rd_private.customer_termination_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON rd_private.customer_termination_requests FROM PUBLIC,anon,authenticated,service_role;

CREATE TABLE rd_private.termination_plans (
 plan_id uuid PRIMARY KEY,
 request_id uuid NOT NULL REFERENCES rd_private.case_head(request_id) ON DELETE RESTRICT,
 owner_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
 kind text NOT NULL CHECK(kind IN('cancel','early_end')),
 state text NOT NULL CHECK(state IN('pending_review','withdrawn','finalized')),
 reason text NOT NULL CHECK(length(btrim(reason))>0 AND length(reason)<=1000),
 original_status text NOT NULL CHECK(original_status IN('accepted','en_route','arrived','driving')),
 created_revision bigint NOT NULL CHECK(created_revision>0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 withdrawn_at timestamptz,
 withdrawn_by uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
 withdrawal_reason text,
 source_customer_request_id uuid UNIQUE,
 UNIQUE(request_id,plan_id),
 FOREIGN KEY(request_id,source_customer_request_id)
   REFERENCES rd_private.customer_termination_requests(request_id,customer_request_id) ON DELETE RESTRICT,
 CHECK ((state IN('pending_review','finalized') AND withdrawn_at IS NULL AND withdrawn_by IS NULL AND withdrawal_reason IS NULL)
   OR (state='withdrawn' AND withdrawn_at IS NOT NULL AND withdrawn_by IS NOT NULL AND withdrawal_reason IS NOT NULL))
);
CREATE UNIQUE INDEX rd_one_pending_termination ON rd_private.termination_plans(request_id)
 WHERE state='pending_review';
CREATE INDEX rd_termination_history ON rd_private.termination_plans(request_id,created_at DESC);
ALTER TABLE rd_private.termination_plans ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON rd_private.termination_plans FROM PUBLIC,anon,authenticated;
ALTER TABLE rd_private.customer_termination_requests ADD FOREIGN KEY(request_id,linked_plan_id)
 REFERENCES rd_private.termination_plans(request_id,plan_id) ON DELETE RESTRICT;
ALTER TABLE rd_private.route_proposals ADD FOREIGN KEY(request_id,superseded_by_request_id)
 REFERENCES rd_private.customer_termination_requests(request_id,customer_request_id) ON DELETE RESTRICT;

CREATE FUNCTION rd_private.guard_customer_termination_request_history()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'RD_CUSTOMER_TERMINATION_HISTORY_IMMUTABLE'; END IF;
 IF (to_jsonb(NEW)-ARRAY['state','linked_plan_id']) IS DISTINCT FROM
      (to_jsonb(OLD)-ARRAY['state','linked_plan_id']) OR OLD.state<>'open' OR NEW.state<>'linked' OR
    NOT EXISTS(SELECT 1 FROM rd_private.termination_plans p
      WHERE p.plan_id=NEW.linked_plan_id AND p.request_id=OLD.request_id
        AND p.source_customer_request_id=OLD.customer_request_id AND p.kind=OLD.kind
        AND p.original_status=OLD.original_status AND p.state='pending_review') THEN
   RAISE EXCEPTION 'RD_CUSTOMER_TERMINATION_HISTORY_IMMUTABLE'; END IF;
 RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION rd_private.guard_customer_termination_request_history() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER rd_customer_termination_history_trg BEFORE UPDATE OR DELETE ON rd_private.customer_termination_requests
 FOR EACH ROW EXECUTE FUNCTION rd_private.guard_customer_termination_request_history();

CREATE FUNCTION rd_private.guard_superseded_route_history()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
BEGIN
 IF OLD.status='superseded' THEN RAISE EXCEPTION 'RD_SUPERSEDED_ROUTE_IMMUTABLE'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 IF NEW.status='superseded' AND
    (OLD.status NOT IN('proposed','presented') OR
     (to_jsonb(NEW)-ARRAY['status','superseded_by_request_id','superseded_at']) IS DISTINCT FROM
       (to_jsonb(OLD)-ARRAY['status','superseded_by_request_id','superseded_at']) OR
     NOT EXISTS(SELECT 1 FROM rd_private.customer_termination_requests cr
       WHERE cr.customer_request_id=NEW.superseded_by_request_id AND cr.request_id=OLD.request_id
         AND cr.state='open' AND cr.requested_at=NEW.superseded_at)) THEN
   RAISE EXCEPTION 'RD_SUPERSEDED_ROUTE_EVIDENCE_INVALID'; END IF;
 RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION rd_private.guard_superseded_route_history() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER rd_superseded_route_history_trg BEFORE UPDATE OR DELETE ON rd_private.route_proposals
 FOR EACH ROW EXECUTE FUNCTION rd_private.guard_superseded_route_history();

CREATE FUNCTION rd_private.guard_termination_source_link()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'RD_TERMINATION_PLAN_HISTORY_IMMUTABLE'; END IF;
 IF NEW.source_customer_request_id IS DISTINCT FROM OLD.source_customer_request_id THEN
   RAISE EXCEPTION 'RD_CUSTOMER_TERMINATION_SOURCE_IMMUTABLE'; END IF;
 IF (to_jsonb(NEW)-ARRAY['state','withdrawn_at','withdrawn_by','withdrawal_reason'])
   IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','withdrawn_at','withdrawn_by','withdrawal_reason']) THEN
   RAISE EXCEPTION 'RD_TERMINATION_PLAN_HISTORY_IMMUTABLE'; END IF;
 RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION rd_private.guard_termination_source_link() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER rd_termination_source_link_trg BEFORE UPDATE OR DELETE ON rd_private.termination_plans
 FOR EACH ROW EXECUTE FUNCTION rd_private.guard_termination_source_link();

-- Existing status writer remains protected by SQL02. An unreviewed termination
-- plan can never be silently overwritten by complete/cancel/decline operations.
-- A future, separately approved atomic finalization writer is still required.
CREATE FUNCTION rd_private.guard_pending_termination_status()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
BEGIN
 IF NEW.status IS DISTINCT FROM OLD.status AND rd_private.has_open_customer_termination(OLD.id) THEN
   RAISE EXCEPTION 'RD_CUSTOMER_TERMINATION_OPEN'; END IF;
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
 PERFORM rd_private.assert_customer_termination_action_allowed(NEW.request_id,NEW.action);
 IF NEW.action NOT IN('cancel_plan','early_end_plan','terminal_withdraw',
    'terminal_quote','customer_terminal_consent','terminal_finalize',
    'termination_plan_from_customer','customer_terminal_decline') AND EXISTS(
    SELECT 1 FROM rd_private.termination_plans p
      WHERE p.request_id=NEW.request_id AND p.state IN('pending_review','finalized')) THEN
    RAISE EXCEPTION 'RD_TERMINATION_REVIEW_PENDING';
 END IF;
 RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION rd_private.guard_pending_termination_receipt() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER rd_ops_pending_termination_receipt_trg BEFORE INSERT ON rd_private.operation_receipts
  FOR EACH ROW EXECUTE FUNCTION rd_private.guard_pending_termination_receipt();

CREATE FUNCTION public.rd_ops_customer_termination_request_v1(
 p_request uuid,p_customer uuid,p_session uuid,p_customer_hash text,p_exp bigint,
 p_op uuid,p_expected_rev bigint,p_hash text,p_action text,p_payload jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE r public.requests%ROWTYPE;h rd_private.case_head%ROWTYPE;
 v_old rd_private.operation_receipts%ROWTYPE;v_now timestamptz;v_kind text;v_reason text;
BEGIN
 IF p_request IS NULL OR p_customer IS NULL OR p_session IS NULL OR p_op IS NULL OR
    p_expected_rev IS NULL OR p_expected_rev<0 OR p_expected_rev>9007199254740991 OR
    p_hash IS NULL OR p_hash !~ '^[0-9a-f]{64}$' OR
    p_action IS DISTINCT FROM 'customer_termination_request' OR
    jsonb_typeof(p_payload) IS DISTINCT FROM 'object' THEN
   RAISE EXCEPTION 'RD_CUSTOMER_TERMINATION_ARGUMENT_INVALID'; END IF;
 IF (SELECT count(*) FROM jsonb_object_keys(p_payload))<>3 OR
    jsonb_typeof(p_payload->'kind') IS DISTINCT FROM 'string' OR
    p_payload->>'kind' NOT IN('cancel','early_end') OR
    jsonb_typeof(p_payload->'reason') IS DISTINCT FROM 'string' OR
    length(p_payload->>'reason') NOT BETWEEN 1 AND 1000 OR
    p_payload->>'reason' IS DISTINCT FROM btrim(p_payload->>'reason') OR
    p_payload->'confirmed' IS DISTINCT FROM 'true'::jsonb THEN
   RAISE EXCEPTION 'RD_CUSTOMER_TERMINATION_PAYLOAD_INVALID'; END IF;
 PERFORM rd_private.lock_operation_id(p_op);
 SELECT * INTO r FROM public.requests WHERE id=p_request FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'RD_BOOKING_NOT_FOUND'; END IF;
 IF NOT rd_private.customer_can_finish(p_request,p_customer_hash,p_customer,p_session,p_exp) OR
    NOT EXISTS(SELECT 1 FROM rd_private.ops_settings WHERE id=1 AND enabled=true FOR SHARE) OR
    NOT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger t
      WHERE t.tgname='rd_ops_legacy_writer_guard_trg'
        AND t.tgrelid=pg_catalog.to_regclass('public.requests')
        AND t.tgfoid=pg_catalog.to_regprocedure('rd_private.guard_legacy_status_change()')
        AND t.tgenabled IN('O','A') AND t.tgtype=19 AND NOT t.tgisinternal) THEN
   RAISE EXCEPTION 'RD_CUSTOMER_TERMINATION_AUTH_DENIED'; END IF;
 SELECT * INTO h FROM rd_private.case_head WHERE request_id=p_request FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'RD_CASE_NOT_ENROLLED'; END IF;
 PERFORM rd_private.assert_operation_not_closed(p_request,p_customer,p_op,p_expected_rev,p_hash,p_action,p_payload);
 SELECT * INTO v_old FROM rd_private.operation_receipts WHERE operation_id=p_op;
 IF FOUND THEN
   IF v_old.request_id IS DISTINCT FROM p_request OR v_old.actor_id IS DISTINCT FROM p_customer OR
      v_old.expected_revision IS DISTINCT FROM p_expected_rev OR v_old.envelope_hash IS DISTINCT FROM p_hash OR
      v_old.action IS DISTINCT FROM p_action OR v_old.body IS DISTINCT FROM p_payload THEN
     RAISE EXCEPTION 'RD_OPERATION_ID_REUSED'; END IF;
   RETURN jsonb_build_object('accepted',true,'operationId',p_op,'pendingIndependentLookup',true);
 END IF;
 PERFORM rd_private.assert_customer_termination_action_allowed(p_request,p_action);
 PERFORM rd_private.capture_operation_before(p_request,p_op);
 IF h.revision IS DISTINCT FROM p_expected_rev THEN RAISE EXCEPTION 'RD_CUSTOMER_TERMINATION_REVISION_STALE'; END IF;
 v_kind:=p_payload->>'kind';v_reason:=p_payload->>'reason';
 IF (v_kind='cancel' AND r.status NOT IN('accepted','en_route','arrived')) OR
    (v_kind='early_end' AND r.status IS DISTINCT FROM 'driving') THEN
   RAISE EXCEPTION 'RD_CUSTOMER_TERMINATION_STATUS_INVALID'; END IF;
 IF rd_private.has_open_customer_termination(p_request) OR
    EXISTS(SELECT 1 FROM rd_private.termination_plans t
      WHERE t.request_id=p_request AND t.state IN('pending_review','finalized')) THEN
   RAISE EXCEPTION 'RD_CUSTOMER_TERMINATION_ALREADY_OPEN'; END IF;
 -- Active/review waits are preserved and may still be stopped/confirmed.
 -- Unaccepted route quotes become immutable history, never customer refusal
 -- or acceptance. No accepted route, booked fare or payment row is changed.
 v_now:=clock_timestamp();
 INSERT INTO rd_private.customer_termination_requests(customer_request_id,request_id,customer_id,
   auth_session_id,kind,reason,original_status,requested_revision,requested_at,state)
 VALUES(p_op,p_request,p_customer,p_session,v_kind,v_reason,r.status,p_expected_rev,v_now,'open');
 UPDATE rd_private.route_proposals SET status='superseded',superseded_by_request_id=p_op,superseded_at=v_now
   WHERE request_id=p_request AND status IN('proposed','presented');
 IF NOT rd_private.customer_can_finish(p_request,p_customer_hash,p_customer,p_session,p_exp) THEN
   RAISE EXCEPTION 'RD_CUSTOMER_TERMINATION_AUTH_EXPIRED'; END IF;
 UPDATE rd_private.case_head SET revision=revision+1,updated_at=v_now
   WHERE request_id=p_request RETURNING * INTO h;
 INSERT INTO rd_private.operation_receipts(operation_id,request_id,actor_id,action,
   envelope_hash,expected_revision,body,committed_revision,accepted_at)
 VALUES(p_op,p_request,p_customer,p_action,p_hash,p_expected_rev,p_payload,h.revision,v_now);
 RETURN jsonb_build_object('accepted',true,'operationId',p_op,'pendingIndependentLookup',true);
END $fn$;
REVOKE ALL ON FUNCTION public.rd_ops_customer_termination_request_v1(uuid,uuid,uuid,text,bigint,uuid,bigint,text,text,jsonb)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.rd_ops_customer_termination_request_v1(uuid,uuid,uuid,text,bigint,uuid,bigint,text,text,jsonb)
 TO service_role;

CREATE FUNCTION public.rd_ops_termination_plan_v1(
 p_request uuid,p_owner uuid,p_session uuid,p_aal2 boolean,
 p_op uuid,p_expected_rev bigint,p_hash text,p_action text,p_payload jsonb,p_exp bigint
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE r public.requests%ROWTYPE;h rd_private.case_head%ROWTYPE;
 v_existing rd_private.operation_receipts%ROWTYPE;
 v_plan rd_private.termination_plans%ROWTYPE;
 v_customer_request rd_private.customer_termination_requests%ROWTYPE;
 v_now timestamptz;
 v_reason text; v_plan_id uuid;v_kind text;
BEGIN
 IF p_request IS NULL OR p_owner IS NULL OR p_session IS NULL OR p_op IS NULL OR
    p_expected_rev IS NULL OR p_expected_rev<0 OR p_hash IS NULL OR
    p_hash !~ '^[0-9a-f]{64}$' OR
    p_action IS NULL OR p_action NOT IN('cancel_plan','early_end_plan','terminal_withdraw','termination_plan_from_customer') OR
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
 PERFORM rd_private.assert_customer_termination_action_allowed(p_request,p_action);
 PERFORM rd_private.capture_operation_before(p_request,p_op);
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
    IF p_action='termination_plan_from_customer' THEN
      IF (SELECT count(*) FROM jsonb_object_keys(p_payload))<>2 OR
         jsonb_typeof(p_payload->'customerRequestId') IS DISTINCT FROM 'string' OR
         p_payload->>'customerRequestId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        RAISE EXCEPTION 'RD_CUSTOMER_TERMINATION_LINK_INVALID'; END IF;
      SELECT * INTO v_customer_request FROM rd_private.customer_termination_requests cr
        WHERE cr.customer_request_id=(p_payload->>'customerRequestId')::uuid
          AND cr.request_id=p_request AND cr.state='open' FOR UPDATE;
      IF NOT FOUND OR v_customer_request.original_status IS DISTINCT FROM r.status THEN
        RAISE EXCEPTION 'RD_CUSTOMER_TERMINATION_LINK_STALE'; END IF;
      v_kind:=v_customer_request.kind;
    ELSE
      IF (SELECT count(*) FROM jsonb_object_keys(p_payload))<>1 THEN
        RAISE EXCEPTION 'RD_TERMINATION_ARGUMENT_INVALID'; END IF;
      v_kind:=CASE WHEN p_action='cancel_plan' THEN 'cancel' ELSE 'early_end' END;
    END IF;
    IF (v_kind='cancel' AND r.status NOT IN('accepted','en_route','arrived')) OR
       (v_kind='early_end' AND r.status IS DISTINCT FROM 'driving') THEN
       RAISE EXCEPTION 'RD_TERMINATION_STATUS_INVALID'; END IF;
    IF NOT EXISTS(SELECT 1 FROM public.payment_sessions ps
       WHERE ps.request_id=p_request AND ps.status IN('paid','partially_refunded')) THEN
       RAISE EXCEPTION 'RD_PAYMENT_NOT_CONFIRMED'; END IF;
    IF EXISTS(SELECT 1 FROM rd_private.termination_plans t
       WHERE t.request_id=p_request AND t.state IN('pending_review','finalized')) OR
       EXISTS(SELECT 1 FROM rd_private.wait_interval i
       WHERE i.request_id=p_request AND i.phase IN('active','review')) OR
       EXISTS(SELECT 1 FROM rd_private.route_proposals q
       WHERE q.request_id=p_request AND q.status IN('proposed','presented') AND q.expires_at>v_now) THEN
       RAISE EXCEPTION 'RD_TERMINATION_NOT_READY'; END IF;
    -- Amount unknown: do not invent cancellation fees, unpaid balance or
    -- a Square charge/refund from a free-text reason.
    INSERT INTO rd_private.termination_plans(plan_id,request_id,owner_id,kind,state,reason,original_status,created_revision,created_at,source_customer_request_id)
       VALUES(p_op,p_request,p_owner,v_kind,'pending_review',v_reason,r.status,h.revision+1,v_now,v_customer_request.customer_request_id);
    IF p_action='termination_plan_from_customer' THEN
      UPDATE rd_private.customer_termination_requests SET state='linked',linked_plan_id=p_op
        WHERE customer_request_id=v_customer_request.customer_request_id AND request_id=p_request AND state='open';
      IF NOT FOUND THEN RAISE EXCEPTION 'RD_CUSTOMER_TERMINATION_LINK_CONFLICT'; END IF;
    END IF;
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
 v_plan rd_private.termination_plans%ROWTYPE;v_linked rd_private.termination_plans%ROWTYPE;
 v_customer_request rd_private.customer_termination_requests%ROWTYPE;
 v_ready boolean:=false;v_eligible boolean:=false;v_no_plan boolean:=false;
 v_can_request boolean:=false;v_can_link boolean:=false;v_open boolean:=false;
 v_json jsonb:='null'::jsonb;v_request_json jsonb:='null'::jsonb;
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
 SELECT * INTO v_customer_request FROM rd_private.customer_termination_requests cr
   WHERE cr.request_id=p_request ORDER BY cr.requested_revision DESC,cr.customer_request_id DESC LIMIT 1 FOR SHARE;
 IF FOUND THEN
   v_open:=v_customer_request.state='open';
   IF v_customer_request.state='linked' THEN
     SELECT * INTO v_linked FROM rd_private.termination_plans p
       WHERE p.plan_id=v_customer_request.linked_plan_id AND p.request_id=p_request
         AND p.source_customer_request_id=v_customer_request.customer_request_id FOR SHARE;
     IF NOT FOUND THEN RAISE EXCEPTION 'RD_CUSTOMER_TERMINATION_LINK_INCONSISTENT'; END IF;
   END IF;
   v_request_json:=jsonb_build_object(
     'customerRequestId',v_customer_request.customer_request_id,'kind',v_customer_request.kind,
     'reason',v_customer_request.reason,'originalStatus',v_customer_request.original_status,
     'requestedRevision',v_customer_request.requested_revision,
     'requestedAt',floor(extract(epoch from v_customer_request.requested_at)*1000)::bigint,
     'state',v_customer_request.state,'linkedPlanId',v_customer_request.linked_plan_id,
     'planState',v_linked.state,'withdrawnAt',floor(extract(epoch from v_linked.withdrawn_at)*1000)::bigint,
     'withdrawalReason',v_linked.withdrawal_reason);
 END IF;
 SELECT * INTO v_plan FROM rd_private.termination_plans t
    WHERE t.request_id=p_request AND t.state='pending_review'
      AND NOT EXISTS(SELECT 1 FROM rd_private.terminal_finalization_audit fa
        WHERE fa.plan_id=t.plan_id) FOR SHARE;
 IF FOUND THEN
   v_json:=jsonb_build_object('planId',v_plan.plan_id,'kind',v_plan.kind,'state',v_plan.state,
      'reason',v_plan.reason,'createdAt',floor(extract(epoch from v_plan.created_at)*1000)::bigint);
 END IF;
 v_no_plan:=NOT EXISTS(SELECT 1 FROM rd_private.termination_plans p
   WHERE p.request_id=p_request AND p.state IN('pending_review','finalized'));
 v_eligible:=r.status IN('accepted','en_route','arrived','driving') AND
   rd_private.has_original_customer_authority(p_request) AND
   EXISTS(SELECT 1 FROM rd_private.ops_settings WHERE id=1 AND enabled=true FOR SHARE) AND
   EXISTS(SELECT 1 FROM pg_catalog.pg_trigger t
     WHERE t.tgname='rd_ops_legacy_writer_guard_trg'
       AND t.tgrelid=pg_catalog.to_regclass('public.requests')
       AND t.tgfoid=pg_catalog.to_regprocedure('rd_private.guard_legacy_status_change()')
       AND t.tgenabled IN('O','A') AND t.tgtype=19 AND NOT t.tgisinternal) AND
   EXISTS(SELECT 1 FROM public.payment_sessions ps
     WHERE ps.request_id=p_request AND ps.status IN('paid','partially_refunded'));
 -- This customer capability permits the existing identity/binding UI to open;
 -- the write RPC still requires current OTP and original-customer authority.
 v_can_request:=p_actor='customer' AND v_eligible AND v_no_plan AND NOT v_open;
 v_ready:=p_actor='operator' AND v_eligible AND v_no_plan AND
   NOT EXISTS(SELECT 1 FROM rd_private.wait_interval i
     WHERE i.request_id=p_request AND i.phase IN('active','review')) AND
   NOT EXISTS(SELECT 1 FROM rd_private.route_proposals q
     WHERE q.request_id=p_request AND q.status IN('proposed','presented') AND q.expires_at>clock_timestamp());
 v_can_link:=v_ready AND v_open AND v_customer_request.original_status IS NOT DISTINCT FROM r.status;
 v_ready:=v_ready AND NOT v_open;
 IF p_actor='operator' AND NOT rd_private.owner_is_current(p_owner,p_session,p_aal2,p_exp) THEN
    RAISE EXCEPTION 'RD_OWNER_AUTH_EXPIRED'; END IF;
 RETURN jsonb_build_object('requestId',p_request,'revision',h.revision,
   'canPlan',coalesce(v_ready,false),'termination',v_json,
   'canRequest',coalesce(v_can_request,false),'ownerCanLink',coalesce(v_can_link,false),
   'customerRequest',v_request_json);
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
 PERFORM rd_private.assert_customer_termination_action_allowed(p_request,'route_propose');
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
