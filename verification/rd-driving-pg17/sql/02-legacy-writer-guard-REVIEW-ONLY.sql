-- SECOND, SEPARATE, REVIEW-ONLY migration. NEVER APPLY WITHOUT EXPLICIT OWNER
-- APPROVAL AND ISOLATED PG & API TESTS. Paired with rd_ops_submit_v1.
DO $approval_gate$ BEGIN RAISE EXCEPTION 'RD_OPS_LEGACY_WRITER_GUARD_REVIEW_ONLY'; END $approval_gate$;

BEGIN;
-- This trigger covers existing driver-api v32 and any other SQL writer to
-- public.requests.status, including service_role, without a partial Edge
-- deployment that could leave legacy acceptance unusable.
CREATE FUNCTION rd_private.guard_legacy_status_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE v_intent uuid;
BEGIN
 IF NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;
 IF NOT EXISTS(SELECT 1 FROM rd_private.case_head h WHERE h.request_id=OLD.id) THEN
   RETURN NEW; -- Preserve existing bookings not participating in operations.
 END IF;
 IF EXISTS(SELECT 1 FROM rd_private.wait_interval i
       WHERE i.request_id=OLD.id AND i.phase IN ('active','review')) THEN
   RAISE EXCEPTION 'RD_OPERATION_HAS_UNRESOLVED_WAIT';
 END IF;
 -- New operation records require authenticated customer finish evidence and
 -- settlement review; the unmodified driver-api cannot supply them.
 -- Only an audited owner-completion RPC can create this private intent.
 -- The old API has no write access to rd_private. Consume the exact intent
 -- in this trigger, atomically with the status change; no GUC bypass.
 IF NEW.status='completed' AND OLD.status='driving' THEN
   DELETE FROM rd_private.terminal_transition_intents ti
     WHERE ti.request_id=OLD.id AND ti.old_status=OLD.status AND
       ti.new_status=NEW.status
     RETURNING ti.operation_id INTO v_intent;
   IF v_intent IS NOT NULL THEN RETURN NEW; END IF;
 END IF;
 -- Terminal plan finalization has its own audited one-shot intent,
 -- distinct from the ordinary completed-trip customer_finish evidence.
 IF NEW.status IN ('completed','cancelled') AND
    ((NEW.status='completed' AND OLD.status='driving') OR
     (NEW.status='cancelled' AND OLD.status IN('accepted','en_route','arrived'))) THEN
   -- SQL06 owns this optional relation. A partial install must still deny
   -- terminal writes through the normal guard, not query a missing relation.
   IF pg_catalog.to_regclass('rd_private.terminal_plan_transition_intents') IS NOT NULL THEN
     DELETE FROM rd_private.terminal_plan_transition_intents ti
      WHERE ti.request_id=OLD.id AND ti.old_status=OLD.status AND
        ti.new_status=NEW.status
      RETURNING ti.operation_id INTO v_intent;
     IF v_intent IS NOT NULL THEN RETURN NEW; END IF;
   END IF;
 END IF;
 IF NEW.status IN ('completed','cancelled','declined') THEN
   RAISE EXCEPTION 'RD_ENHANCED_CASE_REQUIRES_VERIFIED_FINALIZATION';
 END IF;
 -- Nonterminal updates on enhanced bookings must ALSO be authenticated.
 -- The old driver-api cannot manufacture private status-transition intents.
 DELETE FROM rd_private.status_transition_intents ti
   WHERE ti.request_id=OLD.id AND ti.old_status=OLD.status
     AND ti.new_status=NEW.status
   RETURNING ti.operation_id INTO v_intent;
 IF v_intent IS NOT NULL THEN RETURN NEW; END IF;
 RAISE EXCEPTION 'RD_ENHANCED_CASE_AUTHENTICATED_TRANSITION_REQUIRED';
END $fn$;
REVOKE ALL ON FUNCTION rd_private.guard_legacy_status_change() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER rd_ops_legacy_writer_guard_trg
  BEFORE UPDATE OF status ON public.requests FOR EACH ROW
  EXECUTE FUNCTION rd_private.guard_legacy_status_change();
-- Terminal 'completed' is reachable only when the new owner RPC inserted an
-- exact private intent and the trigger consumed it in the same transaction.
-- Cancellation and early-end need the separately audited terminal-plan writer;
-- decline is still deliberately unavailable. Do not enable
-- until ALL old/new writer paths and customer authentication are tested.
-- On enhanced cases, ALL status writes must carry a private one-shot intent.
-- Legacy bookings without case_head still use driver-api, unchanged.
-- Every writer shares the same public.requests row lock.
COMMIT;
