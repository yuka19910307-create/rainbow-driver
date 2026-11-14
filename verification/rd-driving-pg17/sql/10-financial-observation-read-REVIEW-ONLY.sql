-- REVIEW ONLY. No execution or deployment approved. Requires reviewed SQL01..09.
-- Local observations only: never provider reconciliation or current settlement.
-- This function has no business/financial DML and never changes historical audit.
DO $approval_gate$ BEGIN RAISE EXCEPTION 'RD_FINANCIAL_READ_REVIEW_ONLY_NO_APPROVED_EXECUTION'; END $approval_gate$;
BEGIN;

CREATE FUNCTION public.rd_ops_financial_observation_v1(
 p_request uuid,p_actor text,p_actor_id uuid,p_session uuid,p_aal2 boolean,p_customer_hash text,p_exp bigint
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE
 v_revision bigint;v_count bigint;v_ps public.payment_sessions%ROWTYPE;
 v_head rd_private.financial_object_heads%ROWTYPE;v_object jsonb;v_keys integer;
 v_amount bigint;v_refunded bigint;v_version bigint;v_time timestamptz;
 v_payment jsonb:='null'::jsonb;v_original_state text:='none';
 v_pending bigint:=0;v_completed bigint:=0;v_failed bigint:=0;v_rejected bigint:=0;v_disputes bigint:=0;
 v_receipts bigint:=0;v_stale bigint:=0;v_unchanged bigint:=0;v_last timestamptz;
 v_history jsonb;v_reference jsonb:='null'::jsonb;v_evidence rd_private.terminal_financial_evidence%ROWTYPE;
 v_after jsonb:='null'::jsonb;v_finalized bigint;v_details jsonb:='null'::jsonb;
 v_reasons jsonb:='["delivery_completeness_unverified","additional_payments_untracked"]'::jsonb;
 v_read_at bigint;
BEGIN
 IF pg_catalog.current_setting('transaction_isolation')<>'read committed' THEN
   RAISE EXCEPTION 'RD_FINANCIAL_READ_DATA_UNVERIFIED'; END IF;
 IF p_request IS NULL OR p_actor IS NULL OR p_actor NOT IN('operator','customer') OR
    p_actor_id IS NULL OR p_session IS NULL OR p_exp IS NULL OR
    (p_actor='operator' AND (p_aal2 IS DISTINCT FROM true OR p_customer_hash IS NOT NULL)) OR
    (p_actor='customer' AND (p_aal2 IS DISTINCT FROM false OR p_customer_hash IS NULL OR
      p_customer_hash !~ '^[0-9a-f]{64}$')) THEN
   RAISE EXCEPTION 'RD_FINANCIAL_READ_AUTH_DENIED'; END IF;

 -- SQL09 writers acquire request before session. Never take an object lock
 -- after this request lock; all projections below are protected by this lock.
 PERFORM 1 FROM public.requests br WHERE br.id=p_request FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'RD_FINANCIAL_READ_AUTH_DENIED'; END IF;
 IF rd_private.operation_recovery_authorized(
    p_request,p_actor,p_actor_id,p_session,p_aal2,p_customer_hash,p_exp) IS DISTINCT FROM true THEN
   RAISE EXCEPTION 'RD_FINANCIAL_READ_AUTH_DENIED'; END IF;
 SELECT ch.revision INTO v_revision FROM rd_private.case_head ch WHERE ch.request_id=p_request FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'RD_CASE_NOT_ENROLLED'; END IF;
 IF v_revision IS NULL OR v_revision<0 OR v_revision>9007199254740991 THEN
   RAISE EXCEPTION 'RD_FINANCIAL_READ_DATA_UNVERIFIED'; END IF;
 SELECT count(*) INTO v_count FROM public.payment_sessions ps WHERE ps.request_id=p_request;
 IF v_count<>1 THEN RAISE EXCEPTION 'RD_FINANCIAL_READ_BINDING_UNVERIFIED'; END IF;
 SELECT * INTO v_ps FROM public.payment_sessions ps WHERE ps.request_id=p_request FOR SHARE;
 IF NOT FOUND OR v_ps.currency IS DISTINCT FROM 'JPY' OR
    v_ps.environment IS NULL OR v_ps.environment NOT IN('sandbox','production') OR
    v_ps.square_payment_id IS NULL OR v_ps.square_payment_id !~ '^[A-Za-z0-9_-]{1,192}$' OR
    v_ps.square_order_id IS NULL OR v_ps.square_order_id !~ '^[A-Za-z0-9_-]{1,192}$' OR
    v_ps.amount IS NULL OR v_ps.amount<=0 OR v_ps.amount>9007199254740991 OR
    coalesce(v_ps.refunded_amount,0)<0 OR coalesce(v_ps.refunded_amount,0)>v_ps.amount THEN
   RAISE EXCEPTION 'RD_FINANCIAL_READ_BINDING_UNVERIFIED'; END IF;

 -- Never expose raw JSON. Validate each recorded head before fixed projection;
 -- NULL/malformed observations are not interpreted as an empty or zero balance.
 FOR v_head IN SELECT oh.* FROM rd_private.financial_object_heads oh
   WHERE oh.payment_session_id=v_ps.id ORDER BY oh.object_kind,oh.object_id
 LOOP
   v_object:=v_head.observation;
   IF v_head.environment IS DISTINCT FROM v_ps.environment OR
      v_head.payment_id IS DISTINCT FROM v_ps.square_payment_id OR
      jsonb_typeof(v_object) IS DISTINCT FROM 'object' OR
      octet_length(v_object::text)>4096 OR
      v_head.observation_source NOT IN('square_webhook','provider_poll') OR
      (v_head.observation_source='provider_poll' AND v_head.object_kind<>'payment') THEN
     RAISE EXCEPTION 'RD_FINANCIAL_READ_BINDING_UNVERIFIED'; END IF;
   SELECT count(*) INTO v_keys FROM jsonb_object_keys(v_object);
   IF v_keys<>CASE WHEN v_head.observation_source='square_webhook' THEN 12 ELSE 11 END OR
      NOT v_object ?& ARRAY['kind','id','paymentId','orderId','locationId','status','amountYen',
        'currency','refundedYen','objectUpdatedAt','version'] OR
      (v_head.observation_source='square_webhook' AND NOT v_object ? 'eventCreatedAt') OR
      EXISTS(SELECT 1 FROM unnest(ARRAY['kind','id','paymentId','locationId','status','currency','objectUpdatedAt']) AS keys(name)
        WHERE jsonb_typeof(v_object->keys.name) IS DISTINCT FROM 'string') OR
      v_object->>'kind' IS DISTINCT FROM v_head.object_kind OR
      v_object->>'id' IS DISTINCT FROM v_head.object_id OR
      v_object->>'paymentId' IS DISTINCT FROM v_ps.square_payment_id OR
      v_object->>'currency' IS DISTINCT FROM 'JPY' OR
      v_object->>'locationId' !~ '^[A-Za-z0-9_-]{1,192}$' OR
      v_object->>'status' !~ '^[A-Z_]{1,64}$' OR
      jsonb_typeof(v_object->'amountYen') IS DISTINCT FROM 'number' OR
      v_object->>'amountYen' !~ '^[0-9]{1,16}$' THEN
     RAISE EXCEPTION 'RD_FINANCIAL_READ_DATA_UNVERIFIED'; END IF;
   v_amount:=(v_object->>'amountYen')::bigint;
   IF v_amount>9007199254740991 OR v_amount>v_ps.amount THEN
     RAISE EXCEPTION 'RD_FINANCIAL_READ_DATA_UNVERIFIED'; END IF;
   BEGIN
     v_time:=(v_object->>'objectUpdatedAt')::timestamptz;
   EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
     RAISE EXCEPTION 'RD_FINANCIAL_READ_DATA_UNVERIFIED'; END;
   IF v_time IS DISTINCT FROM v_head.object_updated_at OR NOT isfinite(v_time) OR
      v_time<'2000-01-01'::timestamptz OR v_time>clock_timestamp()+interval '10 minutes' OR
      NOT isfinite(v_head.received_at) OR v_head.received_at<='1970-01-01'::timestamptz OR
      v_head.received_at>clock_timestamp() THEN
     RAISE EXCEPTION 'RD_FINANCIAL_READ_DATA_UNVERIFIED'; END IF;
   IF v_head.object_kind='payment' THEN
     IF v_payment<>'null'::jsonb OR v_head.object_id IS DISTINCT FROM v_ps.square_payment_id OR
        v_object->>'orderId' IS DISTINCT FROM v_ps.square_order_id OR v_amount<>v_ps.amount OR
        v_object->>'status' NOT IN('COMPLETED','APPROVED','PENDING','CANCELED','FAILED') OR
        v_object->'version' IS DISTINCT FROM 'null'::jsonb OR v_head.provider_version IS NOT NULL OR
        jsonb_typeof(v_object->'refundedYen') IS DISTINCT FROM 'number' OR
        v_object->>'refundedYen' !~ '^[0-9]{1,16}$' THEN
       RAISE EXCEPTION 'RD_FINANCIAL_READ_DATA_UNVERIFIED'; END IF;
     v_refunded:=(v_object->>'refundedYen')::bigint;
     IF v_refunded>v_amount OR (v_object->>'status'='COMPLETED' AND
        v_refunded IS DISTINCT FROM coalesce(v_ps.refunded_amount,0)) THEN
       RAISE EXCEPTION 'RD_FINANCIAL_READ_DATA_UNVERIFIED'; END IF;
     v_payment:=jsonb_build_object('status',v_object->>'status','amountYen',v_amount,
       'cumulativeRefundYen',v_refunded,
       'providerUpdatedAt',floor(extract(epoch from v_head.object_updated_at)*1000)::bigint,
       'receivedAt',floor(extract(epoch from v_head.received_at)*1000)::bigint,
       'source',v_head.observation_source);
     v_original_state:='partial';
   ELSE
     IF v_object->'orderId' IS DISTINCT FROM 'null'::jsonb OR
        v_object->'refundedYen' IS DISTINCT FROM 'null'::jsonb THEN
       RAISE EXCEPTION 'RD_FINANCIAL_READ_DATA_UNVERIFIED'; END IF;
     IF v_head.object_kind='refund' THEN
       IF v_object->'version' IS DISTINCT FROM 'null'::jsonb OR v_head.provider_version IS NOT NULL OR
          v_object->>'status' NOT IN('PENDING','COMPLETED','FAILED','REJECTED') THEN
         RAISE EXCEPTION 'RD_FINANCIAL_READ_DATA_UNVERIFIED'; END IF;
       CASE v_object->>'status'
         WHEN 'PENDING' THEN v_pending:=v_pending+1;
         WHEN 'COMPLETED' THEN v_completed:=v_completed+1;
         WHEN 'FAILED' THEN v_failed:=v_failed+1;
         WHEN 'REJECTED' THEN v_rejected:=v_rejected+1;
       END CASE;
     ELSIF v_head.object_kind='dispute' THEN
       IF jsonb_typeof(v_object->'version') IS DISTINCT FROM 'number' OR
          v_object->>'version' !~ '^[1-9][0-9]{0,15}$' THEN
         RAISE EXCEPTION 'RD_FINANCIAL_READ_DATA_UNVERIFIED'; END IF;
       v_version:=(v_object->>'version')::bigint;
       IF v_version>9007199254740991 OR v_version IS DISTINCT FROM v_head.provider_version THEN
         RAISE EXCEPTION 'RD_FINANCIAL_READ_DATA_UNVERIFIED'; END IF;
       v_disputes:=v_disputes+1;
     ELSE RAISE EXCEPTION 'RD_FINANCIAL_READ_DATA_UNVERIFIED'; END IF;
   END IF;
 END LOOP;

 IF EXISTS(SELECT 1 FROM rd_private.financial_event_receipts er WHERE er.payment_session_id=v_ps.id AND
   (er.environment IS DISTINCT FROM v_ps.environment OR
    (er.request_id IS NOT NULL AND er.request_id IS DISTINCT FROM p_request) OR
    er.receipt->>'scope' IS DISTINCT FROM 'driving' OR
    er.receipt->>'environment' IS DISTINCT FROM er.environment OR
    er.receipt->>'eventId' IS DISTINCT FROM er.event_id OR
    er.receipt->>'eventHash' IS DISTINCT FROM er.event_hash OR
    er.receipt->>'paymentSessionId' IS DISTINCT FROM v_ps.id::text OR
    er.receipt->>'requestId' IS DISTINCT FROM er.request_id::text OR
    er.receipt->'needsReview' IS DISTINCT FROM 'true'::jsonb OR
    er.receipt->'replay' IS DISTINCT FROM 'false'::jsonb OR
    er.receipt->>'outcome' IS NULL OR er.receipt->>'outcome' NOT IN('applied','observed','stale','unchanged') OR
    NOT isfinite(er.received_at) OR er.received_at<='1970-01-01'::timestamptz OR er.received_at>clock_timestamp())) THEN
   RAISE EXCEPTION 'RD_FINANCIAL_READ_DATA_UNVERIFIED'; END IF;
 SELECT count(*),count(*) FILTER(WHERE er.receipt->>'outcome'='stale'),
   count(*) FILTER(WHERE er.receipt->>'outcome'='unchanged'),max(er.received_at)
 INTO v_receipts,v_stale,v_unchanged,v_last
 FROM rd_private.financial_event_receipts er WHERE er.payment_session_id=v_ps.id;
 IF greatest(v_receipts,v_stale,v_unchanged,v_pending,v_completed,v_failed,v_rejected,v_disputes)>9007199254740991 THEN
   RAISE EXCEPTION 'RD_FINANCIAL_READ_DATA_UNVERIFIED'; END IF;

 -- The existing verifier binds the historic quote, consent, receipt and audit.
 -- Its monetary values remain historical; no current balance is calculated.
 v_history:=rd_private.terminal_finalization_summary(p_request);
 IF v_history IS NULL THEN RAISE EXCEPTION 'RD_FINANCIAL_READ_DATA_UNVERIFIED'; END IF;
 IF v_history<>'null'::jsonb THEN
   SELECT * INTO v_evidence FROM rd_private.terminal_financial_evidence fe
     WHERE fe.request_id=p_request AND fe.operation_id=(v_history->>'operationId')::uuid;
   IF NOT FOUND OR v_evidence.original_payment_id IS DISTINCT FROM v_ps.square_payment_id OR
      v_evidence.original_paid_yen IS DISTINCT FROM v_ps.amount OR
      v_evidence.evidence->>'paymentSessionId' IS DISTINCT FROM v_ps.id::text OR
      v_evidence.evidence->>'environment' IS DISTINCT FROM v_ps.environment OR
      v_evidence.evidence->>'orderId' IS DISTINCT FROM v_ps.square_order_id THEN
     RAISE EXCEPTION 'RD_FINANCIAL_READ_BINDING_UNVERIFIED'; END IF;
   v_finalized:=(v_history->>'finalizedAt')::bigint;
   v_reference:=jsonb_build_object('operationId',v_history->'operationId',
     'observedAt',v_history->'observedAt','finalizedAt',v_history->'finalizedAt',
     'additionalPaymentRecorded',v_evidence.additional_payment_id IS NOT NULL);
   v_after:=to_jsonb(coalesce(floor(extract(epoch from v_last)*1000)::bigint>v_finalized,false));
 END IF;
 IF v_payment='null'::jsonb THEN v_reasons:=v_reasons||'["original_payment_unobserved"]'::jsonb; END IF;
 IF v_pending>0 THEN v_reasons:=v_reasons||'["refund_pending_observed"]'::jsonb; END IF;
 IF v_disputes>0 THEN v_reasons:=v_reasons||'["payment_review_recorded"]'::jsonb; END IF;
 IF v_after='true'::jsonb THEN v_reasons:=v_reasons||'["notification_after_finalization"]'::jsonb; END IF;
 IF p_actor='operator' THEN
   v_details:=jsonb_build_object('paymentSessionId',v_ps.id,'environment',v_ps.environment,
     'originalPaymentId',v_ps.square_payment_id,'originalOrderId',v_ps.square_order_id,
     'recordedNotificationCount',v_receipts,'staleNotificationCount',v_stale,
     'unchangedNotificationCount',v_unchanged,'recordedDisputeCount',v_disputes);
 END IF;

 -- Locks and slow reads cannot extend caller authority past expiry/revocation.
 IF rd_private.operation_recovery_authorized(
    p_request,p_actor,p_actor_id,p_session,p_aal2,p_customer_hash,p_exp) IS DISTINCT FROM true THEN
   RAISE EXCEPTION 'RD_FINANCIAL_READ_AUTH_EXPIRED'; END IF;
 v_read_at:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
 IF v_read_at<=0 OR v_read_at>8640000000000000 OR
    (v_history<>'null'::jsonb AND ((v_history->>'observedAt')::bigint<=0 OR
      (v_history->>'observedAt')::bigint<v_finalized-120000 OR
      (v_history->>'observedAt')::bigint>v_finalized+5000 OR v_finalized>v_read_at)) THEN
   RAISE EXCEPTION 'RD_FINANCIAL_READ_DATA_UNVERIFIED'; END IF;
 RETURN jsonb_build_object('schemaVersion',1,'requestId',p_request,'caseRevision',v_revision,'readAt',v_read_at,
   'coverage',jsonb_build_object('source','local_recorded_observations','originalPayment',v_original_state,
     'missedEventRecovery','not_performed','additionalPayments','not_implemented','currentSettlementConfirmed',false),
   'originalPaymentObservation',v_payment,
   'recordedRefunds',jsonb_build_object('pendingCount',v_pending,'completedCount',v_completed,
     'failedCount',v_failed,'rejectedCount',v_rejected,'completeSetVerified',false),
   'paymentReviewRecorded',v_disputes>0,
   'lastNotificationReceivedAt',floor(extract(epoch from v_last)*1000)::bigint,
   'historicalReference',v_reference,'notificationReceivedAfterFinalization',v_after,
   'reviewReasons',v_reasons,'operatorDetails',v_details);
END $fn$;
REVOKE ALL ON FUNCTION public.rd_ops_financial_observation_v1(uuid,text,uuid,uuid,boolean,text,bigint)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.rd_ops_financial_observation_v1(uuid,text,uuid,uuid,boolean,text,bigint)
 TO service_role;
COMMIT;
