-- Rainbow Driver v7: prospective-only authenticated route quote/presentation/consent.
-- REVIEW ONLY, NOT EXECUTED; SQL01 + SQL02 required; no production deployment.
-- The first exception is not a sufficient execution barrier in all clients.
-- NO approval to execute this file is conveyed by receiving it.
DO $approval_gate$ BEGIN RAISE EXCEPTION 'RD_ROUTE_V7_REVIEW_ONLY_NO_APPROVED_EXECUTION'; END $approval_gate$;

BEGIN;
CREATE TABLE rd_private.route_proposals (
 proposal_id uuid PRIMARY KEY,
 request_id uuid NOT NULL REFERENCES rd_private.case_head(request_id) ON DELETE RESTRICT,
 owner_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
 status text NOT NULL CHECK(status IN('proposed','presented','accepted','declined','expired','superseded')),
 presentation_id uuid NOT NULL UNIQUE,
 reason text NOT NULL CHECK (length(reason)<=1000),
 points jsonb NOT NULL,
 quote jsonb NOT NULL,
 proposed_revision bigint NOT NULL CHECK(proposed_revision>0),
 presented_revision bigint,
 proposed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 presented_at timestamptz,
 expires_at timestamptz NOT NULL,
 decision_operation_id uuid UNIQUE,
 decision_customer uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
 decision_at timestamptz,
 superseded_by_request_id uuid,
 superseded_at timestamptz,
 CHECK ((status='superseded' AND superseded_by_request_id IS NOT NULL AND superseded_at IS NOT NULL
     AND decision_operation_id IS NULL AND decision_customer IS NULL AND decision_at IS NULL)
   OR (status<>'superseded' AND superseded_by_request_id IS NULL AND superseded_at IS NULL))
);
CREATE UNIQUE INDEX rd_route_one_open_proposal ON rd_private.route_proposals(request_id)
 WHERE status IN('proposed','presented');
CREATE TABLE rd_private.accepted_routes (
 request_id uuid PRIMARY KEY REFERENCES rd_private.case_head(request_id) ON DELETE RESTRICT,
 proposal_id uuid NOT NULL UNIQUE REFERENCES rd_private.route_proposals(proposal_id) ON DELETE RESTRICT,
 quote jsonb NOT NULL,
 customer_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
 accepted_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE rd_private.route_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE rd_private.accepted_routes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON rd_private.route_proposals,rd_private.accepted_routes FROM PUBLIC,anon,authenticated;

-- This is a service-role-only read-only preflight. No Google call is made until
-- the operator's current AAL2 session, original booking, revision and paid
-- link have all passed this check. Every write re-checks the same sources.
CREATE FUNCTION public.rd_ops_route_preflight_v1(
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
    EXISTS(SELECT 1 FROM rd_private.wait_interval i WHERE i.request_id=p_request AND i.phase IN('active','review')) OR
    EXISTS(SELECT 1 FROM rd_private.route_proposals p WHERE p.request_id=p_request AND p.status IN('proposed','presented') AND p.expires_at>clock_timestamp()) THEN
    RAISE EXCEPTION 'RD_ROUTE_PREFLIGHT_BLOCKED'; END IF;
 IF p_payload IS NULL OR jsonb_typeof(p_payload) IS DISTINCT FROM 'object' OR
    NOT(p_payload ? 'points' AND p_payload ? 'reason') OR
    jsonb_array_length(p_payload->'points') NOT BETWEEN 2 AND 22 THEN
    RAISE EXCEPTION 'RD_ROUTE_PAYLOAD_INVALID'; END IF;
 -- Keep the original pickup and endpoint identities. The destination address
 -- may be proposed anew; the Edge must not reuse its old coordinates then.
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

-- Monetary verification inside the DB: the service-role Edge must supply the
-- complete Google Routes route, not only a claimed fare total. This secondary
-- validation protects against mismatched revisions and faulty backend adapters.
CREATE FUNCTION rd_private.route_price_valid(p_quote jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE v_points jsonb; v_legs jsonb; v_meter_sum bigint; v_tripkm numeric;
 v_pickupkm numeric; v_pick_fee bigint; v_trip_fee bigint; v_count bigint;
BEGIN
 IF jsonb_typeof(p_quote) IS DISTINCT FROM 'object' OR
    p_quote->>'ruleVersion' IS DISTINCT FROM 'rd-square-v46-sum-meters-round100m-20261028' OR
    jsonb_typeof(p_quote->'route') IS DISTINCT FROM 'object' OR
    jsonb_typeof(p_quote->'serverQuote') IS DISTINCT FROM 'object' THEN RETURN false; END IF;
 v_points:=p_quote#>'{route,points}';v_legs:=p_quote#>'{route,legs}';
 IF jsonb_typeof(v_points) IS DISTINCT FROM 'array' OR
    jsonb_typeof(v_legs) IS DISTINCT FROM 'array' OR
    jsonb_array_length(v_points) NOT BETWEEN 2 AND 22 OR
    jsonb_array_length(v_legs)<>jsonb_array_length(v_points)-1 THEN RETURN false; END IF;
 SELECT count(*),sum((e->>'distanceMeters')::bigint) INTO v_count,v_meter_sum
   FROM jsonb_array_elements(v_legs) e
   WHERE jsonb_typeof(e->'distanceMeters')='number' AND
      (e->>'distanceMeters') ~ '^(0|[1-9][0-9]*)$' AND
      (e->>'distanceMeters')::numeric BETWEEN 0 AND 10000000;
 IF v_count<>jsonb_array_length(v_legs) OR v_meter_sum NOT BETWEEN 0 AND 10000000 OR
    v_meter_sum IS DISTINCT FROM (p_quote->>'totalDistanceMeters')::bigint THEN RETURN false; END IF;
 v_tripkm:=round(v_meter_sum::numeric/100)/10;
 v_pickupkm:=round((p_quote#>>'{route,pickup,distanceMeters}')::numeric/100)/10;
 IF v_pickupkm NOT BETWEEN 0 AND 10000 THEN RETURN false; END IF;
 v_pick_fee:=CASE WHEN v_pickupkm<=5 THEN 1000 WHEN v_pickupkm<=10 THEN 1500
    WHEN v_pickupkm<=15 THEN 2000 WHEN v_pickupkm<=20 THEN 2500
    ELSE 2500+ceil((v_pickupkm-20)/5)::bigint*500 END;
 v_trip_fee:=CASE WHEN v_tripkm<=2 THEN 1800 WHEN v_tripkm<=5 THEN 2800
    WHEN v_tripkm<=10 THEN 3500 WHEN v_tripkm<=15 THEN 4500
    WHEN v_tripkm<=20 THEN 5500 WHEN v_tripkm<=25 THEN 6500
    WHEN v_tripkm<=30 THEN 7500 WHEN v_tripkm<=35 THEN 9000
    WHEN v_tripkm<=40 THEN 10500 ELSE 10500+ceil(v_tripkm-40)::bigint*250 END;
 RETURN (p_quote#>>'{serverQuote,pickup_distance_km}')::numeric=v_pickupkm AND
    (p_quote#>>'{serverQuote,trip_distance_km}')::numeric=v_tripkm AND
    (p_quote#>>'{serverQuote,pickup_fee}')::bigint=v_pick_fee AND
    (p_quote#>>'{serverQuote,trip_fee}')::bigint=v_trip_fee AND
    (p_quote#>>'{serverQuote,total_fee}')::bigint=v_pick_fee+v_trip_fee;
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range OR data_exception THEN
 RETURN false;
END $fn$;
REVOKE ALL ON FUNCTION rd_private.route_price_valid(jsonb) FROM PUBLIC,anon,authenticated;

CREATE FUNCTION public.rd_ops_route_propose_v1(
 p_request uuid,p_owner uuid,p_session uuid,p_aal2 boolean,p_exp bigint,
 p_op uuid,p_expected_rev bigint,p_hash text,p_payload jsonb,p_quote jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE r public.requests%ROWTYPE;h rd_private.case_head%ROWTYPE;
 v_old rd_private.operation_receipts%ROWTYPE;v_now timestamptz;
 v_points jsonb;v_reason text;
BEGIN
 IF p_request IS NULL OR p_op IS NULL OR p_hash !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'RD_ROUTE_INVALID'; END IF;
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
      RAISE EXCEPTION 'RD_ROUTE_AUTH_DENIED'; END IF;
 SELECT * INTO h FROM rd_private.case_head WHERE request_id=p_request FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'RD_CASE_NOT_ENROLLED'; END IF;
 PERFORM rd_private.assert_operation_not_closed(p_request,p_owner,p_op,p_expected_rev,p_hash,'route_propose',p_payload);
 SELECT * INTO v_old FROM rd_private.operation_receipts WHERE operation_id=p_op;
 IF FOUND THEN
   IF v_old.request_id IS DISTINCT FROM p_request OR v_old.actor_id IS DISTINCT FROM p_owner OR
      v_old.expected_revision IS DISTINCT FROM p_expected_rev OR v_old.envelope_hash IS DISTINCT FROM p_hash OR
      v_old.action IS DISTINCT FROM 'route_propose' OR v_old.body IS DISTINCT FROM p_payload THEN
      RAISE EXCEPTION 'RD_OPERATION_ID_REUSED'; END IF;
   RETURN jsonb_build_object('accepted',true,'operationId',p_op,'pendingIndependentLookup',true);
 END IF;
 PERFORM rd_private.assert_customer_termination_action_allowed(p_request,'route_propose');
 IF h.revision IS DISTINCT FROM p_expected_rev OR
    r.status NOT IN('accepted','en_route','arrived','driving') OR
    NOT EXISTS(SELECT 1 FROM public.payment_sessions ps WHERE ps.request_id=p_request AND ps.status IN('paid','partially_refunded')) OR
    EXISTS(SELECT 1 FROM rd_private.wait_interval i WHERE i.request_id=p_request AND i.phase IN('active','review')) OR
    EXISTS(SELECT 1 FROM rd_private.route_proposals x WHERE x.request_id=p_request AND x.status IN('proposed','presented') AND x.expires_at>clock_timestamp()) THEN
      RAISE EXCEPTION 'RD_ROUTE_STALE_OR_UNAVAILABLE'; END IF;
 -- Expired proposals are never resurrected or presented. Retire them
 -- under the booking lock before inserting another proposal.
 UPDATE rd_private.route_proposals SET status='expired'
   WHERE request_id=p_request AND status IN('proposed','presented') AND expires_at<=clock_timestamp();
 v_points:=p_payload->'points'; v_reason:=p_payload->>'reason';
 IF jsonb_typeof(v_points) IS DISTINCT FROM 'array' OR jsonb_array_length(v_points) NOT BETWEEN 2 AND 22 OR
    v_reason IS NULL OR length(btrim(v_reason))=0 OR length(v_reason)>1000 OR
    (SELECT count(*) FROM jsonb_object_keys(p_payload))<>2 OR
    NOT COALESCE(rd_private.route_price_valid(p_quote),false) THEN RAISE EXCEPTION 'RD_ROUTE_QUOTE_INVALID'; END IF;
 -- A changed destination is still a fully validated point. Do not turn the
 -- removed original-address restriction into permission for null/blank labels.
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(v_points) AS point(item)
     WHERE jsonb_typeof(item) IS DISTINCT FROM 'object' OR
       jsonb_typeof(item->'visitId') IS DISTINCT FROM 'string' OR
       (item->>'visitId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' OR
       jsonb_typeof(item->'address') IS DISTINCT FROM 'string' OR
       length(item->>'address') NOT BETWEEN 1 AND 300 OR
       item->>'address' IS DISTINCT FROM btrim(item->>'address')) OR
    (SELECT count(DISTINCT item->>'visitId') FROM jsonb_array_elements(v_points) AS point(item))<>
       jsonb_array_length(v_points) THEN RAISE EXCEPTION 'RD_ROUTE_POINT_INVALID'; END IF;
 IF p_quote#>'{route,points}' IS DISTINCT FROM
    (SELECT jsonb_agg(jsonb_build_object('id',x.item->>'visitId','label',x.item->>'address') ORDER BY x.ord)
        FROM jsonb_array_elements(v_points) WITH ORDINALITY x(item,ord)) OR
    v_points->0->>'visitId' IS DISTINCT FROM p_request::text OR
    v_points->0->>'address' IS DISTINCT FROM r.pickup_address OR
    v_points->(jsonb_array_length(v_points)-1)->>'visitId' IS DISTINCT FROM (md5(p_request::text || ':destination'))::uuid::text OR
    (p_quote#>>'{serverQuote,pickup_fee}')::bigint IS DISTINCT FROM r.pickup_fee OR
    (p_quote#>>'{serverQuote,pickup_distance_km}')::numeric IS DISTINCT FROM r.pickup_distance_km THEN
      RAISE EXCEPTION 'RD_ROUTE_ENDPOINT_OR_FEE_MISMATCH'; END IF;
 v_now:=clock_timestamp();
 INSERT INTO rd_private.route_proposals(proposal_id,request_id,owner_id,status,presentation_id,
    reason,points,quote,proposed_revision,expires_at,proposed_at)
 VALUES(p_op,p_request,p_owner,'proposed',gen_random_uuid(),v_reason,v_points,p_quote,h.revision+1,
    v_now+interval '30 minutes',v_now);
 UPDATE rd_private.case_head SET revision=revision+1,updated_at=v_now WHERE request_id=p_request RETURNING * INTO h;
 IF NOT rd_private.owner_is_current(p_owner,p_session,p_aal2,p_exp) THEN RAISE EXCEPTION 'RD_OWNER_AUTH_EXPIRED'; END IF;
 INSERT INTO rd_private.operation_receipts(operation_id,request_id,actor_id,action,envelope_hash,
    expected_revision,body,committed_revision,accepted_at)
 VALUES(p_op,p_request,p_owner,'route_propose',p_hash,p_expected_rev,p_payload,h.revision,v_now);
 RETURN jsonb_build_object('accepted',true,'operationId',p_op,'pendingIndependentLookup',true);
END $fn$;
REVOKE ALL ON FUNCTION public.rd_ops_route_propose_v1(uuid,uuid,uuid,boolean,bigint,uuid,bigint,text,jsonb,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.rd_ops_route_propose_v1(uuid,uuid,uuid,boolean,bigint,uuid,bigint,text,jsonb,jsonb) TO service_role;

CREATE FUNCTION public.rd_ops_route_present_v1(
 p_request uuid,p_owner uuid,p_session uuid,p_aal2 boolean,p_exp bigint,
 p_op uuid,p_expected_rev bigint,p_hash text,p_payload jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE r public.requests%ROWTYPE;h rd_private.case_head%ROWTYPE;
 v_old rd_private.operation_receipts%ROWTYPE;v_route rd_private.route_proposals%ROWTYPE;v_now timestamptz;
BEGIN
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
    RAISE EXCEPTION 'RD_ROUTE_AUTH_DENIED'; END IF;
 SELECT * INTO h FROM rd_private.case_head WHERE request_id=p_request FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'RD_CASE_NOT_ENROLLED'; END IF;
 PERFORM rd_private.assert_operation_not_closed(p_request,p_owner,p_op,p_expected_rev,p_hash,'route_present',p_payload);
 SELECT * INTO v_old FROM rd_private.operation_receipts WHERE operation_id=p_op;
 IF FOUND THEN
   IF v_old.request_id IS DISTINCT FROM p_request OR v_old.actor_id IS DISTINCT FROM p_owner OR
      v_old.expected_revision IS DISTINCT FROM p_expected_rev OR v_old.envelope_hash IS DISTINCT FROM p_hash OR
      v_old.action IS DISTINCT FROM 'route_present' OR v_old.body IS DISTINCT FROM p_payload THEN
      RAISE EXCEPTION 'RD_OPERATION_ID_REUSED'; END IF;
   RETURN jsonb_build_object('accepted',true,'operationId',p_op,'pendingIndependentLookup',true);
 END IF;
 PERFORM rd_private.assert_customer_termination_action_allowed(p_request,'route_present');
 IF h.revision IS DISTINCT FROM p_expected_rev OR r.status NOT IN('accepted','en_route','arrived','driving') OR
    jsonb_typeof(p_payload) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(p_payload))<>1 OR
    p_payload->>'proposalId' IS NULL THEN RAISE EXCEPTION 'RD_PRESENT_STALE'; END IF;
 SELECT * INTO v_route FROM rd_private.route_proposals WHERE proposal_id=(p_payload->>'proposalId')::uuid
    AND request_id=p_request AND status='proposed' AND expires_at>clock_timestamp() FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'RD_PROPOSAL_NOT_PRESENTABLE'; END IF;
 v_now:=clock_timestamp();
 UPDATE rd_private.route_proposals SET status='presented',presented_at=v_now,
    presented_revision=h.revision+1,expires_at=v_now+interval '30 minutes'
 WHERE proposal_id=v_route.proposal_id;
 UPDATE rd_private.case_head SET revision=revision+1,updated_at=v_now WHERE request_id=p_request RETURNING * INTO h;
 IF NOT rd_private.owner_is_current(p_owner,p_session,p_aal2,p_exp) THEN RAISE EXCEPTION 'RD_OWNER_AUTH_EXPIRED'; END IF;
 INSERT INTO rd_private.operation_receipts(operation_id,request_id,actor_id,action,envelope_hash,
    expected_revision,body,committed_revision,accepted_at)
 VALUES(p_op,p_request,p_owner,'route_present',p_hash,p_expected_rev,p_payload,h.revision,v_now);
 RETURN jsonb_build_object('accepted',true,'operationId',p_op,'pendingIndependentLookup',true);
END $fn$;
REVOKE ALL ON FUNCTION public.rd_ops_route_present_v1(uuid,uuid,uuid,boolean,bigint,uuid,bigint,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.rd_ops_route_present_v1(uuid,uuid,uuid,boolean,bigint,uuid,bigint,text,jsonb) TO service_role;

CREATE FUNCTION public.rd_ops_route_decide_v1(
 p_request uuid,p_customer uuid,p_session uuid,p_customer_hash text,p_exp bigint,
 p_op uuid,p_expected_rev bigint,p_hash text,p_action text,p_payload jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE r public.requests%ROWTYPE;h rd_private.case_head%ROWTYPE;
 v_old rd_private.operation_receipts%ROWTYPE;v_route rd_private.route_proposals%ROWTYPE;
 v_now timestamptz;
BEGIN
 IF p_action NOT IN('customer_consent','customer_decline') OR
    p_hash !~ '^[0-9a-f]{64}$' OR p_op IS NULL OR p_payload IS NULL OR
    jsonb_typeof(p_payload) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'RD_CUSTOMER_ROUTE_INVALID'; END IF;
 -- Global operation ID first, before booking/auth/case locks.
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
    RAISE EXCEPTION 'RD_CUSTOMER_AUTH_DENIED'; END IF;
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
 IF h.revision IS DISTINCT FROM p_expected_rev OR r.status NOT IN('accepted','en_route','arrived','driving') THEN
    RAISE EXCEPTION 'RD_ROUTE_REVISION_STALE'; END IF;
 IF (SELECT count(*) FROM jsonb_object_keys(p_payload))<>
    (CASE WHEN p_action='customer_consent' THEN 4 ELSE 3 END) OR
    p_payload->>'proposalId' IS NULL OR p_payload->>'presentationId' IS NULL THEN
    RAISE EXCEPTION 'RD_ROUTE_DECISION_INVALID'; END IF;
 SELECT * INTO v_route FROM rd_private.route_proposals
   WHERE proposal_id=(p_payload->>'proposalId')::uuid AND request_id=p_request AND
         presentation_id=(p_payload->>'presentationId')::uuid AND status='presented' AND expires_at>clock_timestamp() FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'RD_QUOTE_EXPIRED_OR_NOT_PRESENTED'; END IF;
 IF p_action='customer_consent' THEN
    IF p_payload->'consent' IS DISTINCT FROM 'true'::jsonb OR
       jsonb_typeof(p_payload->'quotedTotalYen') IS DISTINCT FROM 'number' OR
       p_payload->>'quotedTotalYen' IS DISTINCT FROM v_route.quote#>>'{serverQuote,total_fee}' THEN
       RAISE EXCEPTION 'RD_EXPLICIT_CONSENT_MISMATCH'; END IF;
 ELSIF p_action='customer_decline' THEN
    IF p_payload->>'reason' IS NULL OR length(btrim(p_payload->>'reason'))=0 OR length(p_payload->>'reason')>1000 THEN
       RAISE EXCEPTION 'RD_DECLINE_REASON_REQUIRED'; END IF;
 END IF;
 -- Never treat explicit consent as a Square charge or refund. Financial
 -- differences require the independent settlement writer before completion.
 v_now:=clock_timestamp();
 UPDATE rd_private.route_proposals SET status=CASE WHEN p_action='customer_consent' THEN 'accepted' ELSE 'declined' END,
   decision_operation_id=p_op,decision_customer=p_customer,decision_at=v_now
   WHERE proposal_id=v_route.proposal_id;
 IF p_action='customer_consent' THEN
   INSERT INTO rd_private.accepted_routes(request_id,proposal_id,quote,customer_id,accepted_at)
   VALUES(p_request,v_route.proposal_id,v_route.quote,p_customer,v_now)
   ON CONFLICT(request_id) DO UPDATE SET proposal_id=EXCLUDED.proposal_id,
      quote=EXCLUDED.quote,customer_id=EXCLUDED.customer_id,accepted_at=EXCLUDED.accepted_at;
 END IF;
 IF NOT rd_private.customer_can_finish(p_request,p_customer_hash,p_customer,p_session,p_exp) THEN
    RAISE EXCEPTION 'RD_CUSTOMER_AUTH_EXPIRED'; END IF;
 UPDATE rd_private.case_head SET revision=revision+1,updated_at=v_now WHERE request_id=p_request RETURNING * INTO h;
 INSERT INTO rd_private.operation_receipts(operation_id,request_id,actor_id,action,envelope_hash,
    expected_revision,body,committed_revision,accepted_at)
 VALUES(p_op,p_request,p_customer,p_action,p_hash,p_expected_rev,p_payload,h.revision,v_now);
 RETURN jsonb_build_object('accepted',true,'operationId',p_op,'pendingIndependentLookup',true);
END $fn$;
REVOKE ALL ON FUNCTION public.rd_ops_route_decide_v1(uuid,uuid,uuid,text,bigint,uuid,bigint,text,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.rd_ops_route_decide_v1(uuid,uuid,uuid,text,bigint,uuid,bigint,text,text,jsonb) TO service_role;

-- One transaction per snapshot. Edge cross-checks revisions from original and
-- route snapshots; if they differ, it MUST reject and require a reload.
CREATE FUNCTION public.rd_ops_route_snapshot_v1(
 p_request uuid,p_actor text,p_owner uuid,p_session uuid,p_aal2 boolean,p_customer_hash text,p_exp bigint
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE r public.requests%ROWTYPE;h rd_private.case_head%ROWTYPE;
 v_proposal rd_private.route_proposals%ROWTYPE;v_active rd_private.accepted_routes%ROWTYPE;
 v_points jsonb;v_route jsonb;v_proposal_json jsonb:='null'::jsonb;
 v_enabled boolean:=false;v_unsettled boolean:=false;v_has_open boolean:=false;v_route_delta bigint:=0;
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
 v_enabled:=NOT rd_private.has_open_customer_termination(p_request) AND
   rd_private.has_original_customer_authority(p_request) AND
    EXISTS(SELECT 1 FROM rd_private.ops_settings WHERE id=1 AND enabled=true FOR SHARE) AND
    EXISTS(SELECT 1 FROM pg_catalog.pg_trigger t
       WHERE t.tgname='rd_ops_legacy_writer_guard_trg'
         AND t.tgrelid=pg_catalog.to_regclass('public.requests')
         AND t.tgfoid=pg_catalog.to_regprocedure('rd_private.guard_legacy_status_change()')
         AND t.tgenabled IN('O','A') AND t.tgtype=19 AND NOT t.tgisinternal);
 SELECT * INTO v_active FROM rd_private.accepted_routes a WHERE a.request_id=p_request;
 IF FOUND THEN
  SELECT COALESCE(jsonb_agg(jsonb_build_object('visitId',x.item->>'id','address',x.item->>'label') ORDER BY x.ord),'[]'::jsonb)
    INTO v_points FROM jsonb_array_elements(v_active.quote#>'{route,points}') WITH ORDINALITY x(item,ord);
  v_route:=jsonb_build_object('points',v_points);
  v_route_delta:=(v_active.quote#>>'{serverQuote,total_fee}')::bigint - r.total_fee;
  v_unsettled:=v_route_delta<>0;
 ELSE
  v_route:=jsonb_build_object('points',jsonb_build_array(
    jsonb_build_object('visitId',p_request,'address',r.pickup_address),
    jsonb_build_object('visitId',(md5(p_request::text || ':destination'))::uuid,'address',r.destination_address)));
 END IF;
 SELECT * INTO v_proposal FROM rd_private.route_proposals p
  WHERE p.request_id=p_request AND p.status IN('proposed','presented') AND p.expires_at>clock_timestamp()
  ORDER BY p.proposed_at DESC LIMIT 1;
 v_has_open:=FOUND;
 IF v_has_open AND (p_actor='operator' OR (v_proposal.status='presented' AND v_proposal.expires_at>clock_timestamp())) THEN
   v_proposal_json:=jsonb_build_object('proposalId',v_proposal.proposal_id,
     'presentationId',v_proposal.presentation_id,
     'revision',COALESCE(v_proposal.presented_revision,v_proposal.proposed_revision),
     'expiresAt',FLOOR(EXTRACT(EPOCH FROM v_proposal.expires_at)*1000)::bigint,
     'reason',v_proposal.reason,'quote',v_proposal.quote);
 END IF;
 IF p_actor='operator' AND NOT rd_private.owner_is_current(p_owner,p_session,p_aal2,p_exp) THEN
   RAISE EXCEPTION 'RD_OWNER_AUTH_EXPIRED'; END IF;
 RETURN jsonb_build_object('requestId',p_request,'revision',h.revision,
   'route',v_route,'proposal',v_proposal_json,
   'customerConsent',(v_enabled AND p_actor='customer' AND v_proposal.status='presented' AND v_proposal.expires_at>clock_timestamp()),
   'routes',(v_enabled AND p_actor='operator' AND NOT v_has_open AND
       r.status IN('accepted','en_route','arrived','driving') AND
       NOT EXISTS(SELECT 1 FROM rd_private.wait_interval i WHERE i.request_id=p_request AND i.phase IN('active','review'))),
   'routePresented',(v_enabled AND p_actor='operator' AND v_has_open AND v_proposal.status='proposed'),
   'hasPendingProposal',v_has_open,'financialReviewPending',v_unsettled,
   'routeDeltaYen',v_route_delta);
END $fn$;
REVOKE ALL ON FUNCTION public.rd_ops_route_snapshot_v1(uuid,text,uuid,uuid,boolean,text,bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.rd_ops_route_snapshot_v1(uuid,text,uuid,uuid,boolean,text,bigint) TO service_role;
-- Authenticated proposal lookup; the original customer_finish lookup intentionally
-- cannot read these receipts, so the action is checked here independently.
CREATE FUNCTION public.rd_ops_route_customer_lookup_v1(
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
    v_op.action NOT IN('customer_consent','customer_decline') OR
    v_op.envelope_hash IS DISTINCT FROM p_hash THEN RAISE EXCEPTION 'RD_OPERATION_ID_REUSED'; END IF;
 RETURN jsonb_build_object('status','committed','requestId',v_op.request_id,
    'operationId',v_op.operation_id,'envelopeHash',v_op.envelope_hash,
    'revision',v_op.committed_revision,
    'acceptedAt',FLOOR(EXTRACT(EPOCH FROM v_op.accepted_at)*1000)::bigint);
END $fn$;
REVOKE ALL ON FUNCTION public.rd_ops_route_customer_lookup_v1(uuid,uuid,uuid,text,bigint,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.rd_ops_route_customer_lookup_v1(uuid,uuid,uuid,text,bigint,uuid,text) TO service_role;
-- After the route tables exist, replace BOTH direct completion writers. A
-- UI-only restriction is not an authorization boundary. The original writers
-- from SQL01 are kept otherwise unchanged; SQL04 settlement clearance must
-- be implemented before enabling monetary-change routes in production.
CREATE OR REPLACE FUNCTION public.rd_ops_submit_v1(
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
 PERFORM rd_private.assert_customer_termination_action_allowed(p_request,p_action);
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
   -- A route quote cannot be closed while an explicit choice is pending,
   -- and no changed-price trip can finish without independently verified
   -- Square/refund reconciliation. No fake 'paid' flag is accepted.
   IF EXISTS(SELECT 1 FROM rd_private.route_proposals x WHERE x.request_id=p_request
       AND x.status IN('proposed','presented') AND x.expires_at>clock_timestamp()) OR
      EXISTS(SELECT 1 FROM rd_private.accepted_routes a WHERE a.request_id=p_request
       AND (a.quote#>>'{serverQuote,total_fee}')::bigint IS DISTINCT FROM r.total_fee) THEN
       RAISE EXCEPTION 'RD_ROUTE_SETTLEMENT_PENDING'; END IF;
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
CREATE OR REPLACE FUNCTION public.rd_ops_customer_finish_v1(
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
 PERFORM rd_private.assert_customer_termination_action_allowed(p_request,p_action);
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
 -- Direct RPC invocation is blocked too; hiding a client button is insufficient.
 IF EXISTS(SELECT 1 FROM rd_private.route_proposals x WHERE x.request_id=p_request
       AND x.status IN('proposed','presented') AND x.expires_at>clock_timestamp()) OR
    EXISTS(SELECT 1 FROM rd_private.accepted_routes a WHERE a.request_id=p_request
       AND (a.quote#>>'{serverQuote,total_fee}')::bigint IS DISTINCT FROM r.total_fee) THEN
    RAISE EXCEPTION 'RD_ROUTE_SETTLEMENT_PENDING'; END IF;
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
COMMIT;
