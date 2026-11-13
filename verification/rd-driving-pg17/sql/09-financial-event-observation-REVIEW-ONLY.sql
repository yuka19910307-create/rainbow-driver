-- REVIEW ONLY. No execution/deployment approved. Depends on reviewed SQL01..07,
-- the existing payment_sessions schema, and the EXACT reviewed legacy finalizer.
-- This is an opt-in driving Webhook lane, not a claim of Square reconciliation.
-- Individual refund/dispute observations do NOT establish the complete current
-- payment balance. Historical terminal consent/finalization evidence is immutable.
DO $approval_gate$ BEGIN RAISE EXCEPTION 'RD_FINANCIAL_EVENT_REVIEW_ONLY_NO_APPROVED_EXECUTION'; END $approval_gate$;
BEGIN;

CREATE TABLE rd_private.financial_event_receipts (
 environment text NOT NULL CHECK(environment IN('sandbox','production')),
 event_id text NOT NULL CHECK(event_id ~ '^[A-Za-z0-9_-]{1,200}$'),
 event_type text NOT NULL,
 event_hash text NOT NULL CHECK(event_hash ~ '^[0-9a-f]{64}$'),
 payment_session_id uuid NOT NULL REFERENCES public.payment_sessions(id) ON DELETE RESTRICT,
 request_id uuid REFERENCES public.requests(id) ON DELETE RESTRICT,
 observation jsonb NOT NULL CHECK(jsonb_typeof(observation)='object'),
 receipt jsonb NOT NULL CHECK(jsonb_typeof(receipt)='object'),
 received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(environment,event_id)
);
CREATE INDEX rd_financial_event_request_idx ON rd_private.financial_event_receipts
 (request_id,received_at DESC,event_id DESC);
CREATE INDEX rd_financial_event_session_idx ON rd_private.financial_event_receipts
 (payment_session_id,received_at DESC);
CREATE TABLE rd_private.financial_object_heads (
 environment text NOT NULL CHECK(environment IN('sandbox','production')),
 object_kind text NOT NULL CHECK(object_kind IN('payment','refund','dispute')),
 object_id text NOT NULL CHECK(object_id ~ '^[A-Za-z0-9_-]{1,255}$'),
 payment_session_id uuid NOT NULL REFERENCES public.payment_sessions(id) ON DELETE RESTRICT,
 payment_id text NOT NULL CHECK(payment_id ~ '^[A-Za-z0-9_-]{1,192}$'),
 object_updated_at timestamptz NOT NULL,
 provider_version bigint,
 observation jsonb NOT NULL CHECK(jsonb_typeof(observation)='object'),
 observation_source text NOT NULL DEFAULT 'square_webhook' CHECK(observation_source IN('square_webhook','provider_poll')),
 received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(environment,object_kind,object_id)
);
CREATE INDEX rd_financial_object_session_idx ON rd_private.financial_object_heads(payment_session_id,object_kind);
ALTER TABLE rd_private.financial_event_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE rd_private.financial_object_heads ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON rd_private.financial_event_receipts,rd_private.financial_object_heads
 FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION rd_private.financial_event_immutable()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
BEGIN RAISE EXCEPTION 'RD_FINANCIAL_EVENT_IMMUTABLE'; END $fn$;
REVOKE ALL ON FUNCTION rd_private.financial_event_immutable() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER rd_financial_event_immutable_trg BEFORE UPDATE OR DELETE
 ON rd_private.financial_event_receipts FOR EACH ROW EXECUTE FUNCTION rd_private.financial_event_immutable();

-- Old in-flight handlers cannot overwrite financial fields after this lane is
-- installed. The private transaction context is created only by the atomic RPC.
-- Installing SQL09 therefore requires the coordinated opt-in Webhook rollout;
-- do not install it while enhanced cases still depend on the old writer.
CREATE TABLE rd_private.financial_write_context (
 transaction_id bigint NOT NULL,payment_session_id uuid NOT NULL,
 PRIMARY KEY(transaction_id,payment_session_id)
);
ALTER TABLE rd_private.financial_write_context ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON rd_private.financial_write_context FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION rd_private.financial_legacy_write_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE v_scoped boolean;
BEGIN
 IF TG_OP='UPDATE' AND ROW(NEW.status,NEW.square_payment_id,NEW.request_id,NEW.refunded_amount,NEW.refunded_at,NEW.amount,NEW.currency,NEW.environment,NEW.square_order_id)
    IS NOT DISTINCT FROM ROW(OLD.status,OLD.square_payment_id,OLD.request_id,OLD.refunded_amount,OLD.refunded_at,OLD.amount,OLD.currency,OLD.environment,OLD.square_order_id) THEN
   RETURN NEW; END IF;
 v_scoped:=EXISTS(SELECT 1 FROM rd_private.case_head ch WHERE ch.request_id=OLD.request_id)
   OR EXISTS(SELECT 1 FROM rd_private.checkout_customer_origins co WHERE co.payment_session_id=OLD.id
      AND co.binding_method='authenticated-before-checkout-v1');
 IF NOT v_scoped THEN
   IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
 END IF;
 -- Initial checkout order-linking is not a financial confirmation. It remains
 -- permitted only while pending, unlinked and unbound, with all money intact.
 IF TG_OP='UPDATE' AND OLD.status='pending' AND NEW.status='pending' AND
    OLD.request_id IS NULL AND NEW.request_id IS NULL AND
    nullif(OLD.square_payment_id,'') IS NULL AND nullif(NEW.square_payment_id,'') IS NULL AND
    ROW(NEW.amount,NEW.currency,NEW.environment,NEW.refunded_amount,NEW.refunded_at)
      IS NOT DISTINCT FROM ROW(OLD.amount,OLD.currency,OLD.environment,OLD.refunded_amount,OLD.refunded_at) AND
    (nullif(OLD.square_order_id,'') IS NULL OR NEW.square_order_id IS NOT DISTINCT FROM OLD.square_order_id) THEN
   RETURN NEW; END IF;
 IF TG_OP='UPDATE' AND OLD.status='pending' AND NEW.status='failed' AND
    OLD.request_id IS NULL AND NEW.request_id IS NULL AND
    nullif(OLD.square_payment_id,'') IS NULL AND nullif(NEW.square_payment_id,'') IS NULL AND
    ROW(NEW.amount,NEW.currency,NEW.environment,NEW.refunded_amount,NEW.refunded_at,NEW.square_order_id)
      IS NOT DISTINCT FROM ROW(OLD.amount,OLD.currency,OLD.environment,OLD.refunded_amount,OLD.refunded_at,OLD.square_order_id) THEN
   RETURN NEW; END IF;
 IF TG_OP='DELETE' OR NOT EXISTS(SELECT 1 FROM rd_private.financial_write_context fc
      WHERE fc.transaction_id=pg_catalog.txid_current() AND fc.payment_session_id=OLD.id) THEN
   RAISE EXCEPTION 'RD_FINANCIAL_LEGACY_WRITE_DENIED'; END IF;
 RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION rd_private.financial_legacy_write_guard() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER rd_financial_legacy_write_guard_trg BEFORE UPDATE OR DELETE ON public.payment_sessions
 FOR EACH ROW EXECUTE FUNCTION rd_private.financial_legacy_write_guard();

-- The caller must independently verify the raw Square HMAC against the fixed
-- environment endpoint/key and verify the configured location before this RPC.
-- Only the service role can call it; no browser-supplied actor is trusted here.
-- Lock order: event advisory lock -> object advisory lock -> existing request -> payment session ->
-- private object head. A session linked after the unlocked discovery causes
-- retryable failure rather than taking request and payment locks in reverse.
CREATE FUNCTION public.rd_ops_apply_square_event_v1(
 p_environment text,p_event_id text,p_event_type text,p_event_hash text,p_object jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE
 v_kind text; v_object_id text; v_payment_id text; v_order_id text; v_status text;
 v_amount bigint; v_refunded bigint; v_version bigint;
 v_updated timestamptz; v_created timestamptz; v_discovered_request uuid;
 v_session_id uuid; v_count bigint; v_scope boolean; v_created_new boolean:=false;
 v_outcome text:='observed'; v_needs_review boolean:=true; v_receipt jsonb;
 v_ps public.payment_sessions%ROWTYPE;
 v_previous rd_private.financial_object_heads%ROWTYPE;
 v_previous_event rd_private.financial_event_receipts%ROWTYPE;
 v_old_refund bigint; v_request uuid;
BEGIN
 IF pg_catalog.current_setting('transaction_isolation')<>'read committed' THEN
   RAISE EXCEPTION 'RD_FINANCIAL_ISOLATION_REQUIRED'; END IF;
 IF p_environment IS NULL OR p_environment NOT IN('sandbox','production') OR
    p_event_id IS NULL OR p_event_id !~ '^[A-Za-z0-9_-]{1,200}$' OR
    p_event_hash IS NULL OR p_event_hash !~ '^[0-9a-f]{64}$' OR
    p_event_type IS NULL OR p_event_type NOT IN('payment.created','payment.updated',
      'refund.created','refund.updated','dispute.created','dispute.state.updated') OR
    p_object IS NULL OR jsonb_typeof(p_object)<>'object' OR octet_length(p_object::text)>4096 THEN
   RAISE EXCEPTION 'RD_FINANCIAL_EVENT_INVALID'; END IF;
 IF (SELECT count(*) FROM jsonb_object_keys(p_object))<>12 OR
    NOT p_object ?& ARRAY['kind','id','paymentId','orderId','locationId','status','amountYen',
      'currency','refundedYen','objectUpdatedAt','eventCreatedAt','version'] THEN
   RAISE EXCEPTION 'RD_FINANCIAL_EVENT_INVALID'; END IF;
 v_kind:=p_object->>'kind';v_object_id:=p_object->>'id';v_payment_id:=p_object->>'paymentId';
 v_order_id:=p_object->>'orderId';v_status:=p_object->>'status';
 IF EXISTS(SELECT 1 FROM unnest(ARRAY['kind','id','paymentId','locationId','status','currency','objectUpdatedAt','eventCreatedAt']) AS keys(name)
      WHERE jsonb_typeof(p_object->keys.name) IS DISTINCT FROM 'string') THEN
   RAISE EXCEPTION 'RD_FINANCIAL_EVENT_INVALID'; END IF;
 IF v_kind IS NULL OR v_kind<>split_part(p_event_type,'.',1) OR
    v_object_id IS NULL OR v_object_id !~ '^[A-Za-z0-9_-]{1,255}$' OR
    v_payment_id IS NULL OR v_payment_id !~ '^[A-Za-z0-9_-]{1,192}$' OR
    p_object->>'locationId' IS NULL OR (p_object->>'locationId') !~ '^[A-Za-z0-9_-]{1,192}$' OR
    v_status IS NULL OR v_status !~ '^[A-Z_]{1,64}$' OR
    p_object->>'currency' IS DISTINCT FROM 'JPY' OR
    jsonb_typeof(p_object->'amountYen') IS DISTINCT FROM 'number' OR
    (p_object->>'amountYen') !~ '^[0-9]{1,16}$' THEN
   RAISE EXCEPTION 'RD_FINANCIAL_EVENT_INVALID'; END IF;
 v_amount:=(p_object->>'amountYen')::bigint;
 IF v_amount>9007199254740991 THEN RAISE EXCEPTION 'RD_FINANCIAL_MONEY_INVALID'; END IF;
 IF v_kind='payment' THEN
   IF v_payment_id IS DISTINCT FROM v_object_id OR v_order_id IS NULL OR
      v_order_id !~ '^[A-Za-z0-9_-]{1,192}$' OR
      v_status NOT IN('APPROVED','PENDING','COMPLETED','CANCELED','FAILED') OR
      jsonb_typeof(p_object->'refundedYen') IS DISTINCT FROM 'number' OR
      (p_object->>'refundedYen') !~ '^[0-9]{1,16}$' OR p_object->'version'<>'null'::jsonb THEN
     RAISE EXCEPTION 'RD_FINANCIAL_EVENT_INVALID'; END IF;
   v_refunded:=(p_object->>'refundedYen')::bigint;
   IF v_refunded>v_amount THEN RAISE EXCEPTION 'RD_FINANCIAL_MONEY_INVALID'; END IF;
 ELSE
   IF p_object->'orderId'<>'null'::jsonb OR p_object->'refundedYen'<>'null'::jsonb THEN
     RAISE EXCEPTION 'RD_FINANCIAL_EVENT_INVALID'; END IF;
   IF v_kind='refund' AND (v_status NOT IN('PENDING','COMPLETED','REJECTED','FAILED') OR
       p_object->'version'<>'null'::jsonb) THEN RAISE EXCEPTION 'RD_FINANCIAL_EVENT_INVALID'; END IF;
   IF v_kind='dispute' THEN
     IF jsonb_typeof(p_object->'version') IS DISTINCT FROM 'number' OR
        (p_object->>'version') !~ '^[1-9][0-9]{0,15}$' THEN RAISE EXCEPTION 'RD_FINANCIAL_EVENT_INVALID'; END IF;
     v_version:=(p_object->>'version')::bigint;
     IF v_version>9007199254740991 THEN RAISE EXCEPTION 'RD_FINANCIAL_EVENT_INVALID'; END IF;
   END IF;
 END IF;
 BEGIN
   v_updated:=(p_object->>'objectUpdatedAt')::timestamptz;
   v_created:=(p_object->>'eventCreatedAt')::timestamptz;
 EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
   RAISE EXCEPTION 'RD_FINANCIAL_EVENT_TIME_INVALID';
 END;
 IF v_updated IS NULL OR v_created IS NULL OR NOT isfinite(v_updated) OR NOT isfinite(v_created) OR
    v_updated<'2000-01-01'::timestamptz OR v_created<'2000-01-01'::timestamptz OR
    v_updated>clock_timestamp()+interval '10 minutes' OR v_created>clock_timestamp()+interval '10 minutes' THEN
   RAISE EXCEPTION 'RD_FINANCIAL_EVENT_TIME_INVALID'; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('rd-financial-event:'||p_environment||':'||p_event_id,0));
 IF v_kind='payment' THEN
   PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('rd-financial-order:'||p_environment||':'||v_order_id,0));
 END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
   'rd-financial-object:'||p_environment||':'||v_kind||':'||v_object_id,0));
 SELECT * INTO v_previous_event FROM rd_private.financial_event_receipts er
   WHERE er.environment=p_environment AND er.event_id=p_event_id;
 IF FOUND THEN
   IF v_previous_event.event_hash IS DISTINCT FROM p_event_hash OR
      v_previous_event.event_type IS DISTINCT FROM p_event_type OR
      v_previous_event.observation IS DISTINCT FROM p_object THEN
     RAISE EXCEPTION 'RD_FINANCIAL_EVENT_ID_CONFLICT'; END IF;
   RETURN v_previous_event.receipt||jsonb_build_object('replay',true);
 END IF;
 SELECT count(*) INTO v_count FROM public.payment_sessions sp
   WHERE sp.environment=p_environment AND
     ((v_kind='payment' AND sp.square_order_id=v_order_id) OR
       (v_kind<>'payment' AND sp.square_payment_id=v_payment_id));
 IF v_count<>1 THEN RAISE EXCEPTION 'RD_FINANCIAL_SESSION_UNMATCHED_OR_AMBIGUOUS'; END IF;
 SELECT sp.id,sp.request_id INTO v_session_id,v_discovered_request FROM public.payment_sessions sp
   WHERE sp.environment=p_environment AND
     ((v_kind='payment' AND sp.square_order_id=v_order_id) OR
       (v_kind<>'payment' AND sp.square_payment_id=v_payment_id));
 IF v_discovered_request IS NOT NULL THEN
   PERFORM 1 FROM public.requests br WHERE br.id=v_discovered_request FOR UPDATE;
   IF NOT FOUND THEN RAISE EXCEPTION 'RD_FINANCIAL_REQUEST_MISSING'; END IF;
 END IF;
 SELECT * INTO v_ps FROM public.payment_sessions sp WHERE sp.id=v_session_id FOR UPDATE;
 IF NOT FOUND OR v_ps.environment IS DISTINCT FROM p_environment OR
    v_ps.request_id IS DISTINCT FROM v_discovered_request OR
    (v_kind='payment' AND v_ps.square_order_id IS DISTINCT FROM v_order_id) THEN
   RAISE EXCEPTION 'RD_FINANCIAL_SESSION_CHANGED'; END IF;
 -- Positive driving membership only. No edits to unrelated/legacy/cargo cases.
 v_scope:=EXISTS(SELECT 1 FROM rd_private.case_head ch WHERE ch.request_id=v_ps.request_id)
   OR EXISTS(SELECT 1 FROM rd_private.checkout_customer_origins co WHERE co.payment_session_id=v_ps.id
      AND co.binding_method='authenticated-before-checkout-v1');
 IF NOT v_scope THEN
   RAISE EXCEPTION 'RD_FINANCIAL_SCOPE_CHANGED';
 END IF;
 IF nullif(v_ps.square_payment_id,'') IS NOT NULL AND v_ps.square_payment_id<>v_payment_id THEN
   RAISE EXCEPTION 'RD_FINANCIAL_PAYMENT_ID_MISMATCH'; END IF;
 IF v_kind<>'payment' AND nullif(v_ps.square_payment_id,'') IS NULL THEN
   RAISE EXCEPTION 'RD_FINANCIAL_PAYMENT_ID_UNBOUND'; END IF;
 IF v_ps.currency IS DISTINCT FROM 'JPY' OR v_ps.amount IS NULL OR v_ps.amount<=0 OR
    (v_kind='payment' AND v_amount<>v_ps.amount) OR
    (v_kind<>'payment' AND v_amount>v_ps.amount) THEN
   RAISE EXCEPTION 'RD_FINANCIAL_SESSION_MONEY_MISMATCH'; END IF;
 v_request:=v_ps.request_id;
 SELECT * INTO v_previous FROM rd_private.financial_object_heads oh
   WHERE oh.environment=p_environment AND oh.object_kind=v_kind AND oh.object_id=v_object_id FOR UPDATE;
 IF FOUND THEN
   IF v_previous.payment_session_id IS DISTINCT FROM v_session_id OR
      v_previous.payment_id IS DISTINCT FROM v_payment_id THEN
     RAISE EXCEPTION 'RD_FINANCIAL_OBJECT_BINDING_MISMATCH'; END IF;
   IF v_kind='dispute' AND ((v_version>v_previous.provider_version AND v_updated<v_previous.object_updated_at) OR
       (v_version<v_previous.provider_version AND v_updated>v_previous.object_updated_at)) THEN
     RAISE EXCEPTION 'RD_FINANCIAL_VERSION_TIME_CONFLICT'; END IF;
   IF (v_kind='dispute' AND v_version<v_previous.provider_version) OR v_updated<v_previous.object_updated_at THEN
     v_outcome:='stale';
   ELSIF (v_kind='dispute' AND v_version=v_previous.provider_version) OR v_updated=v_previous.object_updated_at THEN
     IF (v_previous.observation-'eventCreatedAt') IS DISTINCT FROM (p_object-'eventCreatedAt') THEN
       RAISE EXCEPTION 'RD_FINANCIAL_SAME_VERSION_CONFLICT'; END IF;
     v_outcome:='unchanged';
   ELSIF v_kind='payment' AND v_previous.observation->>'status'='COMPLETED' AND v_status<>'COMPLETED' THEN
     RAISE EXCEPTION 'RD_FINANCIAL_PAYMENT_STATE_REGRESSION';
   ELSIF v_kind='refund' AND v_previous.observation->>'status'='COMPLETED' AND v_status<>'COMPLETED' THEN
     RAISE EXCEPTION 'RD_FINANCIAL_REFUND_STATE_REGRESSION';
   END IF;
 END IF;
 IF v_outcome NOT IN('stale','unchanged') THEN
   IF v_kind='payment' AND v_status='COMPLETED' THEN
     INSERT INTO rd_private.financial_write_context(transaction_id,payment_session_id)
       VALUES(pg_catalog.txid_current(),v_session_id);
     -- Cumulative provider payment amount, never one individual refund amount.
     v_old_refund:=coalesce(v_ps.refunded_amount,0);
     IF v_old_refund<0 OR v_old_refund>v_amount OR v_refunded<v_old_refund THEN
       RAISE EXCEPTION 'RD_FINANCIAL_REFUND_AMOUNT_REGRESSION'; END IF;
     IF nullif(v_ps.square_payment_id,'') IS NULL THEN
       UPDATE public.payment_sessions SET square_payment_id=v_payment_id WHERE id=v_session_id;
     END IF;
     IF v_request IS NULL AND v_refunded=0 THEN
       SELECT fp.request_id,fp.created_new INTO v_request,v_created_new
         FROM public.finalize_paid_payment_session(v_session_id,v_payment_id) fp;
       IF v_request IS NULL OR v_created_new IS NULL THEN RAISE EXCEPTION 'RD_FINANCIAL_FINALIZER_UNVERIFIED'; END IF;
       IF NOT EXISTS(SELECT 1 FROM public.payment_sessions sp WHERE sp.id=v_session_id AND
           sp.request_id=v_request AND sp.square_payment_id=v_payment_id) THEN
         RAISE EXCEPTION 'RD_FINANCIAL_FINALIZER_LINK_MISMATCH'; END IF;
     END IF;
     -- A refund before booking creation remains unlinked and needs review;
     -- it cannot silently create a fresh operational booking after a refund.
     UPDATE public.payment_sessions SET
       status=CASE WHEN v_refunded=v_amount THEN 'refunded' WHEN v_refunded>0 THEN 'partially_refunded' ELSE 'paid' END,
       square_payment_id=v_payment_id,refunded_amount=v_refunded,
       refunded_at=CASE WHEN v_refunded>0 THEN v_updated ELSE refunded_at END,
       updated_at=clock_timestamp(),last_error=NULL WHERE id=v_session_id;
     DELETE FROM rd_private.financial_write_context fc WHERE fc.transaction_id=pg_catalog.txid_current()
       AND fc.payment_session_id=v_session_id;
     v_outcome:='applied';
   END IF;
   INSERT INTO rd_private.financial_object_heads(environment,object_kind,object_id,payment_session_id,
       payment_id,object_updated_at,provider_version,observation)
     VALUES(p_environment,v_kind,v_object_id,v_session_id,v_payment_id,v_updated,v_version,p_object)
     ON CONFLICT(environment,object_kind,object_id) DO UPDATE SET
       object_updated_at=EXCLUDED.object_updated_at,provider_version=EXCLUDED.provider_version,
       observation=EXCLUDED.observation,observation_source='square_webhook',received_at=clock_timestamp();
 END IF;
 -- This intentionally remains true: a delivered event is not a fresh complete
 -- provider reconciliation and does not authorize settlement or change consent.
 v_receipt:=jsonb_build_object('scope','driving','environment',p_environment,
   'eventId',p_event_id,'eventHash',p_event_hash,'requestId',v_request,
   'paymentSessionId',v_session_id,'replay',false,'createdNew',v_created_new,
   'outcome',v_outcome,'needsReview',v_needs_review);
 INSERT INTO rd_private.financial_event_receipts(environment,event_id,event_type,event_hash,
     payment_session_id,request_id,observation,receipt)
   VALUES(p_environment,p_event_id,p_event_type,p_event_hash,v_session_id,v_request,p_object,v_receipt);
 RETURN v_receipt;
END $fn$;
REVOKE ALL ON FUNCTION public.rd_ops_apply_square_event_v1(text,text,text,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.rd_ops_apply_square_event_v1(text,text,text,text,jsonb) TO service_role;

-- Existing status polling recovers a missed initial payment notification through
-- this wrapper. The observation comes from an authenticated provider GET at Edge,
-- not a fabricated Webhook. Only an exact zero-refund COMPLETED payment can
-- create a new booking; any known refund/dispute requires separate reconciliation.
CREATE FUNCTION public.rd_ops_finalize_driving_payment_v1(
 p_session_id uuid,p_environment text,p_payment jsonb,p_observed_at bigint
) RETURNS TABLE(request_id uuid,created_new boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE
 v_payment_id text;v_order_id text;v_updated timestamptz;v_amount bigint;
 v_before_request uuid;v_request uuid;v_created_new boolean;v_scoped boolean;v_count bigint;
 v_ps public.payment_sessions%ROWTYPE;v_head rd_private.financial_object_heads%ROWTYPE;
BEGIN
 IF pg_catalog.current_setting('transaction_isolation')<>'read committed' THEN
   RAISE EXCEPTION 'RD_FINANCIAL_ISOLATION_REQUIRED'; END IF;
 IF p_session_id IS NULL OR p_environment IS NULL OR p_environment NOT IN('sandbox','production') OR
    p_payment IS NULL OR jsonb_typeof(p_payment)<>'object' OR octet_length(p_payment::text)>4096 OR
    p_observed_at IS NULL OR p_observed_at<floor(extract(epoch from clock_timestamp())*1000)::bigint-120000 OR
    p_observed_at>floor(extract(epoch from clock_timestamp())*1000)::bigint+5000 THEN
   RAISE EXCEPTION 'RD_PAYMENT_CONFIRMATION_UNVERIFIED'; END IF;
 IF (SELECT count(*) FROM jsonb_object_keys(p_payment))<>11 OR
    NOT p_payment ?& ARRAY['kind','id','paymentId','orderId','locationId','status','amountYen',
      'currency','refundedYen','objectUpdatedAt','version'] OR
    p_payment->>'kind' IS DISTINCT FROM 'payment' OR p_payment->>'status' IS DISTINCT FROM 'COMPLETED' OR
    p_payment->>'currency' IS DISTINCT FROM 'JPY' OR p_payment->'refundedYen' IS DISTINCT FROM '0'::jsonb OR
    p_payment->'version' IS DISTINCT FROM 'null'::jsonb OR
    jsonb_typeof(p_payment->'amountYen') IS DISTINCT FROM 'number' OR
    (p_payment->>'amountYen') !~ '^[1-9][0-9]{0,15}$' THEN
   RAISE EXCEPTION 'RD_PAYMENT_CONFIRMATION_UNVERIFIED'; END IF;
 IF EXISTS(SELECT 1 FROM unnest(ARRAY['kind','id','paymentId','orderId','locationId','status','currency','objectUpdatedAt']) AS keys(name)
      WHERE jsonb_typeof(p_payment->keys.name) IS DISTINCT FROM 'string') THEN
   RAISE EXCEPTION 'RD_PAYMENT_CONFIRMATION_UNVERIFIED'; END IF;
 v_payment_id:=p_payment->>'paymentId';v_order_id:=p_payment->>'orderId';v_amount:=(p_payment->>'amountYen')::bigint;
 IF v_payment_id !~ '^[A-Za-z0-9_-]{1,192}$' OR v_order_id !~ '^[A-Za-z0-9_-]{1,192}$' OR
    p_payment->>'id' IS DISTINCT FROM v_payment_id OR (p_payment->>'locationId') !~ '^[A-Za-z0-9_-]{1,192}$' OR
    v_amount>9007199254740991 THEN RAISE EXCEPTION 'RD_PAYMENT_CONFIRMATION_UNVERIFIED'; END IF;
 BEGIN v_updated:=(p_payment->>'objectUpdatedAt')::timestamptz;
 EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
   RAISE EXCEPTION 'RD_PAYMENT_CONFIRMATION_UNVERIFIED'; END;
 IF v_updated IS NULL OR NOT isfinite(v_updated) OR v_updated<'2000-01-01'::timestamptz OR
    v_updated>clock_timestamp()+interval '10 minutes' THEN RAISE EXCEPTION 'RD_PAYMENT_CONFIRMATION_UNVERIFIED'; END IF;
 -- Same provider order/object locks as the Webhook lane, before booking locks.
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('rd-financial-order:'||p_environment||':'||v_order_id,0));
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('rd-financial-object:'||p_environment||':payment:'||v_payment_id,0));
 SELECT sp.request_id INTO v_before_request FROM public.payment_sessions sp WHERE sp.id=p_session_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'RD_FINANCIAL_SESSION_UNMATCHED_OR_AMBIGUOUS'; END IF;
 IF v_before_request IS NOT NULL THEN
   PERFORM 1 FROM public.requests br WHERE br.id=v_before_request FOR UPDATE;
   IF NOT FOUND THEN RAISE EXCEPTION 'RD_FINANCIAL_REQUEST_MISSING'; END IF;
 END IF;
 SELECT * INTO v_ps FROM public.payment_sessions sp WHERE sp.id=p_session_id FOR UPDATE;
 IF NOT FOUND OR v_ps.request_id IS DISTINCT FROM v_before_request OR
    v_ps.environment IS DISTINCT FROM p_environment OR v_ps.square_order_id IS DISTINCT FROM v_order_id OR
    v_ps.amount IS DISTINCT FROM v_amount OR v_ps.currency IS DISTINCT FROM 'JPY' THEN
   RAISE EXCEPTION 'RD_FINANCIAL_SESSION_CHANGED'; END IF;
 SELECT count(*) INTO v_count FROM public.payment_sessions sp
   WHERE sp.environment=p_environment AND sp.square_order_id=v_order_id;
 IF v_count<>1 THEN RAISE EXCEPTION 'RD_FINANCIAL_SESSION_UNMATCHED_OR_AMBIGUOUS'; END IF;
 v_scoped:=EXISTS(SELECT 1 FROM rd_private.case_head ch WHERE ch.request_id=v_ps.request_id)
   OR EXISTS(SELECT 1 FROM rd_private.checkout_customer_origins co WHERE co.payment_session_id=v_ps.id
      AND co.binding_method='authenticated-before-checkout-v1');
 IF NOT v_scoped THEN
   RAISE EXCEPTION 'RD_FINANCIAL_SCOPE_CHANGED';
 END IF;
 IF nullif(v_ps.square_payment_id,'') IS NOT NULL AND v_ps.square_payment_id<>v_payment_id THEN
   RAISE EXCEPTION 'RD_FINANCIAL_PAYMENT_ID_MISMATCH'; END IF;
 IF coalesce(v_ps.refunded_amount,0)<>0 OR v_ps.status NOT IN('pending','paid') OR
    EXISTS(SELECT 1 FROM rd_private.financial_object_heads oh WHERE oh.payment_session_id=p_session_id AND
      (oh.object_kind='dispute' OR (oh.object_kind='refund' AND oh.observation->>'status' IN('PENDING','COMPLETED')))) THEN
   RAISE EXCEPTION 'RD_PAYMENT_RECONCILIATION_REQUIRED'; END IF;
 SELECT * INTO v_head FROM rd_private.financial_object_heads oh WHERE oh.environment=p_environment
   AND oh.object_kind='payment' AND oh.object_id=v_payment_id FOR UPDATE;
 IF FOUND THEN
   IF v_head.payment_session_id IS DISTINCT FROM p_session_id OR v_head.payment_id IS DISTINCT FROM v_payment_id THEN
     RAISE EXCEPTION 'RD_FINANCIAL_OBJECT_BINDING_MISMATCH'; END IF;
   IF v_updated<v_head.object_updated_at OR
      (v_updated=v_head.object_updated_at AND (v_head.observation-'eventCreatedAt') IS DISTINCT FROM p_payment) THEN
     RAISE EXCEPTION 'RD_PAYMENT_RECONCILIATION_REQUIRED'; END IF;
 END IF;
 IF p_observed_at<floor(extract(epoch from clock_timestamp())*1000)::bigint-120000 OR
    p_observed_at>floor(extract(epoch from clock_timestamp())*1000)::bigint+5000 THEN
   RAISE EXCEPTION 'RD_PAYMENT_CONFIRMATION_UNVERIFIED'; END IF;
 INSERT INTO rd_private.financial_write_context(transaction_id,payment_session_id)
   VALUES(pg_catalog.txid_current(),p_session_id);
 IF nullif(v_ps.square_payment_id,'') IS NULL THEN
   UPDATE public.payment_sessions SET square_payment_id=v_payment_id WHERE id=p_session_id;
 END IF;
 SELECT fp.request_id,fp.created_new INTO v_request,v_created_new
   FROM public.finalize_paid_payment_session(p_session_id,v_payment_id) fp;
 IF v_request IS NULL OR v_created_new IS NULL OR NOT EXISTS(
     SELECT 1 FROM public.payment_sessions sp WHERE sp.id=p_session_id AND sp.request_id=v_request AND
       sp.square_payment_id=v_payment_id AND sp.status='paid' AND coalesce(sp.refunded_amount,0)=0) THEN
   RAISE EXCEPTION 'RD_FINANCIAL_FINALIZER_LINK_MISMATCH'; END IF;
 DELETE FROM rd_private.financial_write_context fc WHERE fc.transaction_id=pg_catalog.txid_current() AND fc.payment_session_id=p_session_id;
 INSERT INTO rd_private.financial_object_heads(environment,object_kind,object_id,payment_session_id,payment_id,
     object_updated_at,provider_version,observation,observation_source)
   VALUES(p_environment,'payment',v_payment_id,p_session_id,v_payment_id,v_updated,NULL,p_payment,'provider_poll')
   ON CONFLICT(environment,object_kind,object_id) DO UPDATE SET object_updated_at=EXCLUDED.object_updated_at,
     observation=EXCLUDED.observation,observation_source='provider_poll',received_at=clock_timestamp();
 IF p_observed_at<floor(extract(epoch from clock_timestamp())*1000)::bigint-120000 OR
    p_observed_at>floor(extract(epoch from clock_timestamp())*1000)::bigint+5000 THEN
   RAISE EXCEPTION 'RD_PAYMENT_CONFIRMATION_UNVERIFIED'; END IF;
 RETURN QUERY SELECT v_request,v_created_new;
END $fn$;
REVOKE ALL ON FUNCTION public.rd_ops_finalize_driving_payment_v1(uuid,text,jsonb,bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.rd_ops_finalize_driving_payment_v1(uuid,text,jsonb,bigint) TO service_role;

-- Scope is resolved before new provider-shape requirements are applied at Edge.
-- No financial writes. A missing/ambiguous route is never interpreted as legacy.
CREATE FUNCTION public.rd_ops_square_scope_v1(
 p_environment text,p_session_id uuid,p_order_id text,p_payment_id text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE v_ids uuid[];v_ps public.payment_sessions%ROWTYPE;v_scoped boolean;
BEGIN
 IF p_environment IS NULL OR p_environment NOT IN('sandbox','production') OR
    (p_order_id IS NOT NULL AND p_order_id !~ '^[A-Za-z0-9_-]{1,192}$') OR
    (p_payment_id IS NOT NULL AND p_payment_id !~ '^[A-Za-z0-9_-]{1,192}$') OR
    (p_session_id IS NULL AND p_order_id IS NULL AND p_payment_id IS NULL) THEN
   RAISE EXCEPTION 'RD_FINANCIAL_SCOPE_UNVERIFIED'; END IF;
 SELECT array_agg(sp.id) INTO v_ids FROM public.payment_sessions sp WHERE sp.environment=p_environment AND
   CASE WHEN p_session_id IS NOT NULL THEN sp.id=p_session_id
        WHEN p_order_id IS NOT NULL THEN sp.square_order_id=p_order_id
        ELSE sp.square_payment_id=p_payment_id END;
 IF coalesce(cardinality(v_ids),0)<>1 THEN RAISE EXCEPTION 'RD_FINANCIAL_SCOPE_UNVERIFIED'; END IF;
 SELECT * INTO v_ps FROM public.payment_sessions sp WHERE sp.id=v_ids[1] FOR SHARE;
 IF NOT FOUND OR v_ps.environment IS DISTINCT FROM p_environment OR
    (p_session_id IS NULL AND p_order_id IS NOT NULL AND v_ps.square_order_id IS DISTINCT FROM p_order_id) OR
    (p_session_id IS NULL AND p_order_id IS NULL AND v_ps.square_payment_id IS DISTINCT FROM p_payment_id) THEN
   RAISE EXCEPTION 'RD_FINANCIAL_SCOPE_UNVERIFIED'; END IF;
 v_scoped:=EXISTS(SELECT 1 FROM rd_private.case_head ch WHERE ch.request_id=v_ps.request_id)
   OR EXISTS(SELECT 1 FROM rd_private.checkout_customer_origins co WHERE co.payment_session_id=v_ps.id
      AND co.binding_method='authenticated-before-checkout-v1');
 RETURN jsonb_build_object('scope',CASE WHEN v_scoped THEN 'driving' ELSE 'legacy' END,
   'environment',p_environment,'paymentSessionId',v_ps.id);
END $fn$;
REVOKE ALL ON FUNCTION public.rd_ops_square_scope_v1(text,uuid,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.rd_ops_square_scope_v1(text,uuid,text,text) TO service_role;

-- A provider sample cannot override newer locally received financial evidence.
-- The caller's booking lock serializes this fence with the event lane. This
-- checks current originals and leaves all prior finalized evidence unchanged.
-- A missed refund event can therefore block finalization until independent
-- reconciliation; absence of a notification is not evidence of zero refunds.
CREATE FUNCTION rd_private.financial_terminal_evidence_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE v_count bigint;v_ps public.payment_sessions%ROWTYPE;
BEGIN
 PERFORM 1 FROM public.requests br WHERE br.id=NEW.request_id FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'RD_FINANCIAL_REQUEST_MISSING'; END IF;
 SELECT count(*) INTO v_count FROM public.payment_sessions sp WHERE sp.request_id=NEW.request_id;
 IF v_count<>1 THEN RAISE EXCEPTION 'RD_TERMINAL_FINANCIAL_RECONCILIATION_REQUIRED'; END IF;
 SELECT * INTO v_ps FROM public.payment_sessions sp WHERE sp.request_id=NEW.request_id FOR SHARE;
 IF v_ps.square_payment_id IS DISTINCT FROM NEW.original_payment_id OR
    v_ps.amount IS DISTINCT FROM NEW.original_paid_yen OR
    coalesce(v_ps.refunded_amount,0) IS DISTINCT FROM NEW.completed_refund_yen OR
    EXISTS(SELECT 1 FROM rd_private.financial_event_receipts er WHERE er.payment_session_id=v_ps.id AND
      er.received_at>NEW.observed_at-interval '5 seconds') THEN
   RAISE EXCEPTION 'RD_TERMINAL_FINANCIAL_RECONCILIATION_REQUIRED'; END IF;
 RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION rd_private.financial_terminal_evidence_guard() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER rd_terminal_financial_event_fence_trg BEFORE INSERT ON rd_private.terminal_financial_evidence
 FOR EACH ROW EXECUTE FUNCTION rd_private.financial_terminal_evidence_guard();
COMMIT;
