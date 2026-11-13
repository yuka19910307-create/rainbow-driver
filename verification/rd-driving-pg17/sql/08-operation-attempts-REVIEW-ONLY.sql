-- Rainbow Driver: authenticated submission observations, not operation results.
-- REVIEW ONLY. NOT EXECUTED. Requires SQL01-07 and separate owner approval.
-- The exception is a review marker, not protection against clients that continue
-- after errors. Do not submit this file to a database without explicit approval.
DO $approval_gate$ BEGIN RAISE EXCEPTION 'RD_OPS_ATTEMPTS_REVIEW_ONLY'; END $approval_gate$;

BEGIN;

-- The Edge creates a fresh attempt ID for each authenticated operation_submit.
-- It commits admission before dispatching the business RPC, in a separate RPC
-- transaction. A business rollback therefore cannot erase admission. Absence
-- of an observation means only that no observation has been retained.
-- No payload, credential, session ID, provider ID, raw error, or email is stored.
CREATE TABLE rd_private.operation_attempts (
 attempt_id uuid PRIMARY KEY,
 request_id uuid NOT NULL REFERENCES rd_private.case_head(request_id) ON DELETE RESTRICT,
 operation_id uuid NOT NULL,
 actor_kind text NOT NULL CHECK(actor_kind IN ('operator','customer')),
 actor_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
 action text NOT NULL,
 expected_revision bigint NOT NULL CHECK(expected_revision BETWEEN 0 AND 9007199254740991),
 envelope_hash text NOT NULL CHECK(envelope_hash ~ '^[0-9a-f]{64}$'),
 -- Epoch milliseconds are stored once. Cursor and index use the exact same
 -- integer, so sub-millisecond timestamps cannot lose or duplicate a page item.
 registered_at bigint NOT NULL DEFAULT floor(extract(epoch from clock_timestamp())*1000)::bigint
   CHECK(registered_at BETWEEN 1 AND 9007199254740991),
 CHECK(attempt_id<>operation_id)
);
CREATE INDEX rd_attempt_operation_idx ON rd_private.operation_attempts(operation_id);
CREATE INDEX rd_attempt_history_idx
 ON rd_private.operation_attempts(request_id,registered_at DESC,attempt_id DESC);

CREATE TABLE rd_private.operation_attempt_observations (
 attempt_id uuid PRIMARY KEY REFERENCES rd_private.operation_attempts(attempt_id) ON DELETE RESTRICT,
 kind text NOT NULL,
 reason_category text NOT NULL,
 observed_at bigint NOT NULL DEFAULT floor(extract(epoch from clock_timestamp())*1000)::bigint
   CHECK(observed_at BETWEEN 1 AND 9007199254740991),
 CHECK(
   (kind='acknowledged_pending' AND reason_category='none') OR
   (kind='response_denied' AND reason_category IN
     ('revision_conflict','business_rule','authorization','feature_disabled')) OR
   (kind='result_unknown' AND reason_category IN
     ('provider_unavailable','transport','response_unverified'))
 )
);
ALTER TABLE rd_private.operation_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE rd_private.operation_attempt_observations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON rd_private.operation_attempts,rd_private.operation_attempt_observations
 FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER rd_attempt_immutable_trg
 BEFORE UPDATE OR DELETE ON rd_private.operation_attempts FOR EACH ROW
 EXECUTE FUNCTION rd_private.deny_operation_evidence_mutation();
CREATE TRIGGER rd_attempt_observation_immutable_trg
 BEFORE UPDATE OR DELETE ON rd_private.operation_attempt_observations FOR EACH ROW
 EXECUTE FUNCTION rd_private.deny_operation_evidence_mutation();

CREATE FUNCTION rd_private.validate_attempt_input(
 p_request uuid,p_actor text,p_actor_id uuid,p_session uuid,p_attempt uuid,
 p_op uuid,p_expected_rev bigint,p_hash text,p_action text
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
BEGIN
 -- Use the existing action/role and identity checks; this constant is neither
 -- a supplied business payload nor an assertion that its hash has been checked.
 -- Edge must validate/hash the complete immutable envelope before admission.
 PERFORM rd_private.validate_operation_recovery_input(
   p_request,p_actor,p_actor_id,p_session,p_op,p_expected_rev,p_hash,p_action,'{}'::jsonb);
 IF p_attempt IS NULL OR p_attempt=p_op THEN
   RAISE EXCEPTION 'RD_ATTEMPT_ID_INVALID'; END IF;
END $fn$;
REVOKE ALL ON FUNCTION rd_private.validate_attempt_input(uuid,text,uuid,uuid,uuid,uuid,bigint,text,text)
 FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION rd_private.lock_attempt_id(p_attempt uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
BEGIN
 IF p_attempt IS NULL THEN RAISE EXCEPTION 'RD_ATTEMPT_ID_INVALID'; END IF;
 IF current_setting('transaction_isolation') IS DISTINCT FROM 'read committed' THEN
   RAISE EXCEPTION 'RD_OPERATION_ISOLATION_UNSUPPORTED'; END IF;
 -- Dedicated namespace. All attempt writers take attempt -> operation ->
 -- booking -> authority locks. Existing business writers never take this lock.
 PERFORM pg_catalog.pg_advisory_xact_lock(724032,pg_catalog.hashtext(p_attempt::text));
END $fn$;
REVOKE ALL ON FUNCTION rd_private.lock_attempt_id(uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION rd_private.attempt_identity_matches(
 p_row rd_private.operation_attempts,p_request uuid,p_actor text,p_actor_id uuid,
 p_op uuid,p_expected_rev bigint,p_hash text,p_action text
) RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path='' AS $fn$
 SELECT (p_row).request_id IS NOT DISTINCT FROM p_request AND
   (p_row).actor_kind IS NOT DISTINCT FROM p_actor AND (p_row).actor_id IS NOT DISTINCT FROM p_actor_id AND
   (p_row).operation_id IS NOT DISTINCT FROM p_op AND (p_row).expected_revision IS NOT DISTINCT FROM p_expected_rev AND
   (p_row).envelope_hash IS NOT DISTINCT FROM p_hash AND (p_row).action IS NOT DISTINCT FROM p_action;
$fn$;
REVOKE ALL ON FUNCTION rd_private.attempt_identity_matches(rd_private.operation_attempts,uuid,text,uuid,uuid,bigint,text,text)
 FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.rd_ops_attempt_begin_v1(
 p_request uuid,p_actor text,p_actor_id uuid,p_session uuid,p_aal2 boolean,p_customer_hash text,p_exp bigint,
 p_attempt uuid,p_op uuid,p_expected_rev bigint,p_hash text,p_action text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE v_attempt rd_private.operation_attempts%ROWTYPE;
 v_receipt rd_private.operation_receipts%ROWTYPE;v_closed rd_private.operation_terminal_results%ROWTYPE;
BEGIN
 PERFORM rd_private.validate_attempt_input(
   p_request,p_actor,p_actor_id,p_session,p_attempt,p_op,p_expected_rev,p_hash,p_action);
 PERFORM rd_private.lock_attempt_id(p_attempt);
 PERFORM rd_private.lock_operation_id(p_op);
 PERFORM 1 FROM public.requests WHERE id=p_request FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'RD_BOOKING_NOT_FOUND'; END IF;
 -- Recovery authority records the authenticated submission, including one
 -- rejected later by a business switch. It does not authorize the business RPC.
 IF rd_private.operation_recovery_authorized(
   p_request,p_actor,p_actor_id,p_session,p_aal2,p_customer_hash,p_exp) IS DISTINCT FROM true THEN
   RAISE EXCEPTION 'RD_ATTEMPT_AUTH_DENIED'; END IF;
 PERFORM 1 FROM rd_private.case_head WHERE request_id=p_request FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'RD_CASE_NOT_ENROLLED'; END IF;

 SELECT * INTO v_attempt FROM rd_private.operation_attempts ar WHERE ar.attempt_id=p_attempt;
 IF FOUND THEN
   IF rd_private.attempt_identity_matches(v_attempt,p_request,p_actor,p_actor_id,
      p_op,p_expected_rev,p_hash,p_action) IS DISTINCT FROM true THEN
     RAISE EXCEPTION 'RD_ATTEMPT_ID_REUSED'; END IF;
 ELSE
   -- An operation ID cannot be re-labelled by a later admitted HTTP request.
   -- These checks compare identity only; they do not return an operation result.
   IF EXISTS(SELECT 1 FROM rd_private.operation_attempts ar WHERE ar.operation_id=p_op AND
       (ar.request_id IS DISTINCT FROM p_request OR ar.actor_kind IS DISTINCT FROM p_actor OR
        ar.actor_id IS DISTINCT FROM p_actor_id OR ar.expected_revision IS DISTINCT FROM p_expected_rev OR
        ar.envelope_hash IS DISTINCT FROM p_hash OR ar.action IS DISTINCT FROM p_action)) THEN
     RAISE EXCEPTION 'RD_OPERATION_ID_REUSED'; END IF;
   SELECT * INTO v_receipt FROM rd_private.operation_receipts rr WHERE rr.operation_id=p_op;
   IF FOUND AND (v_receipt.request_id IS DISTINCT FROM p_request OR v_receipt.actor_id IS DISTINCT FROM p_actor_id OR
       v_receipt.expected_revision IS DISTINCT FROM p_expected_rev OR v_receipt.envelope_hash IS DISTINCT FROM p_hash OR
       v_receipt.action IS DISTINCT FROM p_action OR
       (v_receipt.actor_kind IS NOT NULL AND v_receipt.actor_kind IS DISTINCT FROM p_actor)) THEN
     RAISE EXCEPTION 'RD_OPERATION_ID_REUSED'; END IF;
   SELECT * INTO v_closed FROM rd_private.operation_terminal_results cr WHERE cr.operation_id=p_op;
   IF FOUND AND (v_closed.request_id IS DISTINCT FROM p_request OR v_closed.closed_by IS DISTINCT FROM p_actor_id OR
       v_closed.actor_kind IS DISTINCT FROM p_actor OR v_closed.expected_revision IS DISTINCT FROM p_expected_rev OR
       v_closed.envelope_hash IS DISTINCT FROM p_hash OR v_closed.action IS DISTINCT FROM p_action) THEN
     RAISE EXCEPTION 'RD_OPERATION_ID_REUSED'; END IF;
   INSERT INTO rd_private.operation_attempts
     (attempt_id,request_id,operation_id,actor_kind,actor_id,action,expected_revision,envelope_hash)
     VALUES(p_attempt,p_request,p_op,p_actor,p_actor_id,p_action,p_expected_rev,p_hash)
     RETURNING * INTO v_attempt;
 END IF;
 IF rd_private.operation_recovery_authorized(
   p_request,p_actor,p_actor_id,p_session,p_aal2,p_customer_hash,p_exp) IS DISTINCT FROM true THEN
   RAISE EXCEPTION 'RD_ATTEMPT_AUTH_EXPIRED'; END IF;
 RETURN jsonb_build_object('requestId',v_attempt.request_id,'operationId',v_attempt.operation_id,
   'attemptId',v_attempt.attempt_id,'registeredAt',v_attempt.registered_at);
END $fn$;
REVOKE ALL ON FUNCTION public.rd_ops_attempt_begin_v1(uuid,text,uuid,uuid,boolean,text,bigint,uuid,uuid,bigint,text,text)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.rd_ops_attempt_begin_v1(uuid,text,uuid,uuid,boolean,text,bigint,uuid,uuid,bigint,text,text)
 TO service_role;

CREATE FUNCTION public.rd_ops_attempt_observe_v1(
 p_request uuid,p_actor text,p_actor_id uuid,p_session uuid,p_aal2 boolean,p_customer_hash text,p_exp bigint,
 p_attempt uuid,p_op uuid,p_expected_rev bigint,p_hash text,p_action text,p_kind text,p_reason text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE v_attempt rd_private.operation_attempts%ROWTYPE;
 v_observation rd_private.operation_attempt_observations%ROWTYPE;
BEGIN
 PERFORM rd_private.validate_attempt_input(
   p_request,p_actor,p_actor_id,p_session,p_attempt,p_op,p_expected_rev,p_hash,p_action);
 IF p_kind IS NULL OR p_reason IS NULL OR NOT (
   (p_kind='acknowledged_pending' AND p_reason='none') OR
   (p_kind='response_denied' AND p_reason IN ('revision_conflict','business_rule','authorization','feature_disabled')) OR
   (p_kind='result_unknown' AND p_reason IN ('provider_unavailable','transport','response_unverified'))
 ) THEN RAISE EXCEPTION 'RD_ATTEMPT_OBSERVATION_INVALID'; END IF;
 PERFORM rd_private.lock_attempt_id(p_attempt);
 PERFORM rd_private.lock_operation_id(p_op);
 PERFORM 1 FROM public.requests WHERE id=p_request FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'RD_BOOKING_NOT_FOUND'; END IF;
 IF rd_private.operation_recovery_authorized(
   p_request,p_actor,p_actor_id,p_session,p_aal2,p_customer_hash,p_exp) IS DISTINCT FROM true THEN
   RAISE EXCEPTION 'RD_ATTEMPT_AUTH_DENIED'; END IF;
 PERFORM 1 FROM rd_private.case_head WHERE request_id=p_request FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'RD_CASE_NOT_ENROLLED'; END IF;
 SELECT * INTO v_attempt FROM rd_private.operation_attempts ar WHERE ar.attempt_id=p_attempt;
 IF NOT FOUND THEN RAISE EXCEPTION 'RD_ATTEMPT_NOT_FOUND'; END IF;
 IF rd_private.attempt_identity_matches(v_attempt,p_request,p_actor,p_actor_id,
     p_op,p_expected_rev,p_hash,p_action) IS DISTINCT FROM true THEN
   RAISE EXCEPTION 'RD_ATTEMPT_ID_REUSED'; END IF;
 SELECT * INTO v_observation FROM rd_private.operation_attempt_observations ao WHERE ao.attempt_id=p_attempt;
 IF FOUND THEN
   IF v_observation.kind IS DISTINCT FROM p_kind OR v_observation.reason_category IS DISTINCT FROM p_reason THEN
     RAISE EXCEPTION 'RD_ATTEMPT_OBSERVATION_CONFLICT'; END IF;
 ELSE
   INSERT INTO rd_private.operation_attempt_observations(attempt_id,kind,reason_category)
     VALUES(p_attempt,p_kind,p_reason) RETURNING * INTO v_observation;
   IF v_observation.observed_at<v_attempt.registered_at THEN
     RAISE EXCEPTION 'RD_ATTEMPT_CLOCK_REVERSED'; END IF;
 END IF;
 IF rd_private.operation_recovery_authorized(
   p_request,p_actor,p_actor_id,p_session,p_aal2,p_customer_hash,p_exp) IS DISTINCT FROM true THEN
   RAISE EXCEPTION 'RD_ATTEMPT_AUTH_EXPIRED'; END IF;
 RETURN jsonb_build_object('recorded',true);
END $fn$;
REVOKE ALL ON FUNCTION public.rd_ops_attempt_observe_v1(uuid,text,uuid,uuid,boolean,text,bigint,uuid,uuid,bigint,text,text,text,text)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.rd_ops_attempt_observe_v1(uuid,text,uuid,uuid,boolean,text,bigint,uuid,uuid,bigint,text,text,text,text)
 TO service_role;

CREATE FUNCTION public.rd_ops_attempt_page_v1(
 p_request uuid,p_actor text,p_actor_id uuid,p_session uuid,p_aal2 boolean,p_customer_hash text,p_exp bigint,
 p_cursor jsonb DEFAULT NULL,p_limit integer DEFAULT 20
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE v_at bigint;v_attempt_id uuid;v_rows jsonb;v_items jsonb;v_more boolean;
 v_next jsonb:='null'::jsonb;v_last jsonb;
BEGIN
 IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 50 THEN RAISE EXCEPTION 'RD_ATTEMPT_LIMIT_INVALID'; END IF;
 IF p_cursor IS NOT NULL AND p_cursor IS DISTINCT FROM 'null'::jsonb THEN
   -- Keep the object guard separate from jsonb_object_keys; do not rely on
   -- boolean expression evaluation order for malformed untrusted cursors.
   IF jsonb_typeof(p_cursor) IS DISTINCT FROM 'object' THEN
     RAISE EXCEPTION 'RD_ATTEMPT_CURSOR_INVALID'; END IF;
   IF (SELECT count(*) FROM jsonb_object_keys(p_cursor))<>2 OR
      jsonb_typeof(p_cursor->'at') IS DISTINCT FROM 'number' OR
      p_cursor->>'at' !~ '^[1-9][0-9]*$' OR (p_cursor->>'at')::numeric>9007199254740991 OR
      jsonb_typeof(p_cursor->'attemptId') IS DISTINCT FROM 'string' OR
      p_cursor->>'attemptId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
     RAISE EXCEPTION 'RD_ATTEMPT_CURSOR_INVALID'; END IF;
   v_at:=(p_cursor->>'at')::bigint;v_attempt_id:=(p_cursor->>'attemptId')::uuid;
 END IF;
 PERFORM 1 FROM public.requests WHERE id=p_request FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'RD_BOOKING_NOT_FOUND'; END IF;
 IF rd_private.operation_recovery_authorized(
   p_request,p_actor,p_actor_id,p_session,p_aal2,p_customer_hash,p_exp) IS DISTINCT FROM true THEN
   RAISE EXCEPTION 'RD_ATTEMPT_AUTH_DENIED'; END IF;
 PERFORM 1 FROM rd_private.case_head WHERE request_id=p_request FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'RD_CASE_NOT_ENROLLED'; END IF;
 IF v_at IS NOT NULL AND NOT EXISTS(
   SELECT 1 FROM rd_private.operation_attempts ar WHERE ar.request_id=p_request
     AND ar.attempt_id=v_attempt_id AND ar.registered_at=v_at
 ) THEN RAISE EXCEPTION 'RD_ATTEMPT_CURSOR_INVALID'; END IF;

 SELECT coalesce(jsonb_agg(page_row.item ORDER BY page_row.registered_at DESC,page_row.attempt_id DESC),'[]'::jsonb)
   INTO v_rows FROM (
     SELECT ar.registered_at,ar.attempt_id,
       jsonb_build_object('attemptId',ar.attempt_id,'operationId',ar.operation_id,'action',ar.action,
         'actor',ar.actor_kind,'actorId',CASE WHEN p_actor='operator' THEN ar.actor_id ELSE NULL END,
         'expectedRevision',ar.expected_revision,'registeredAt',ar.registered_at,
         'observation',CASE WHEN ao.attempt_id IS NULL THEN NULL ELSE
           jsonb_build_object('kind',ao.kind,'reasonCategory',ao.reason_category,'observedAt',ao.observed_at) END) item
       FROM rd_private.operation_attempts ar
       LEFT JOIN rd_private.operation_attempt_observations ao ON ao.attempt_id=ar.attempt_id
       WHERE ar.request_id=p_request AND
         (v_at IS NULL OR (ar.registered_at,ar.attempt_id)<(v_at,v_attempt_id))
       ORDER BY ar.registered_at DESC,ar.attempt_id DESC LIMIT p_limit+1
   ) page_row;
 v_more:=jsonb_array_length(v_rows)>p_limit;
 SELECT coalesce(jsonb_agg(page_item.item ORDER BY page_item.ord),'[]'::jsonb) INTO v_items
   FROM jsonb_array_elements(v_rows) WITH ORDINALITY page_item(item,ord) WHERE page_item.ord<=p_limit;
 IF v_more THEN
   v_last:=v_items->(jsonb_array_length(v_items)-1);
   v_next:=jsonb_build_object('at',v_last->'registeredAt','attemptId',v_last->'attemptId');
 END IF;
 IF rd_private.operation_recovery_authorized(
   p_request,p_actor,p_actor_id,p_session,p_aal2,p_customer_hash,p_exp) IS DISTINCT FROM true THEN
   RAISE EXCEPTION 'RD_ATTEMPT_AUTH_EXPIRED'; END IF;
 RETURN jsonb_build_object('schemaVersion',1,'requestId',p_request,'items',v_items,
   'hasMore',v_more,'nextCursor',v_next,'coverage','authenticated_submissions_only');
END $fn$;
REVOKE ALL ON FUNCTION public.rd_ops_attempt_page_v1(uuid,text,uuid,uuid,boolean,text,bigint,jsonb,integer)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.rd_ops_attempt_page_v1(uuid,text,uuid,uuid,boolean,text,bigint,jsonb,integer)
 TO service_role;

COMMIT;
