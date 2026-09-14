-- Phase 3B Prompt 3 — two bounded failure classes for the webhook egress gateway, and the two
-- trigger functions that decide what they MEAN.
--
-- WHY THIS MIGRATION EXISTS AT ALL
--
-- Prompt 3 says to add a migration only if it is genuinely unavoidable. It is, and the reason is
-- honesty rather than function.
--
-- Delivery now goes through a separate `webhook-egress` service: the worker holds the secrets and
-- has no route to the Internet, the gateway has the route and holds no secrets. That introduces
-- failures that belong to OUR infrastructure and not to the merchant's - the gateway is not
-- running, it refused our authentication, its own secret is unset, it is at its concurrency
-- limit, or we sent it a request its contract refuses.
--
-- Those could be recorded as NETWORK, and everything would still BEHAVE correctly: retryable,
-- bounded by the five-attempt cap, nothing sent. What would be wrong is the record. The attempt
-- history is append-only and is shown to the business owner, and NETWORK means "we tried to reach
-- your endpoint and the network failed". An owner reading that would go and debug an endpoint that
-- was never contacted, while the actual fault sat in a container they cannot see. Writing a
-- diagnosis we know to be false into a history that cannot be corrected is not a saving.
--
-- So: two values.
--
--   GATEWAY_UNAVAILABLE   retryable. The dispatch never left this deployment.
--   GATEWAY_REJECTED      permanent. The gateway refused the CONTRACT - a malformed URL, an
--                         oversized body, a header outside the allow-list. That is a defect on our
--                         side and waiting does not fix it.
--
-- WHY THE TRIGGERS ARE REDEFINED HERE TOO
--
-- The first version of this migration added the two values and stopped, which was a real gap
-- rather than a tidiness one. `walaaplus_validate_webhook_attempt` and
-- `walaaplus_webhook_delivery_guard` (migration 15) enumerate the permanent and retryable classes
-- BY NAME. A value the enum knows and the triggers do not is a value the database has no opinion
-- about - so the restricted runtime role could write GATEWAY_REJECTED as RETRYABLE, exhaust it to
-- FAILED, or record GATEWAY_UNAVAILABLE as PERMANENT, and the append-only history would say
-- something false about work that was never done.
--
-- The application never writes any of those. That is exactly the point: every other rule in these
-- functions is also one the application never breaks, and they exist because "the code is
-- currently correct" is not a constraint.
--
-- Both functions are reproduced below IN FULL and re-created with CREATE OR REPLACE. Every
-- pre-existing rule is carried over unchanged - the bodies were copied from migration 15 rather
-- than retyped - and the edits are confined to the classification lists and the new mirror rule
-- marked in place.
--
-- ONE THING TO NOTICE ABOUT THE COMPARISONS
--
-- Every error-class test now compares `::text`. PostgreSQL will not let a value added to an enum
-- by `ALTER TYPE ... ADD VALUE` be USED as an enum literal in the same transaction, and Prisma
-- runs each migration in one. Comparing the label as text sidesteps that entirely and changes no
-- semantics: an enum's text form is its label. The `status` and `outcome` enums are untouched by
-- this migration and are compared as before.
--
-- WHAT THIS DOES NOT DO
--
-- No table is created, altered, rewritten or locked. No row changes. No existing enum value is
-- renamed or removed, so every row already written keeps its meaning, and every existing CHECK,
-- index and grant is untouched. Migration 20260921120000_webhook_destinations is NOT amended: it
-- is applied on staging and stays exactly as it is. Replacing a function body does not alter the
-- triggers that reference it - they keep pointing at the same function - so no trigger is dropped
-- or recreated and no table is rewritten.

ALTER TYPE "WebhookErrorClass" ADD VALUE 'GATEWAY_UNAVAILABLE';
ALTER TYPE "WebhookErrorClass" ADD VALUE 'GATEWAY_REJECTED';

-- ── The delivery's state rules, with the two new classes ─────────────────────
--
-- Carried over from migration 15 unchanged except for: `::text` comparisons, GATEWAY_REJECTED in
-- the "never retried to exhaustion" list, and the new retryable mirror rule.

CREATE OR REPLACE FUNCTION walaaplus_webhook_delivery_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  destination_business TEXT;
  destination_state "WebhookDestinationState";
  event_business TEXT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT "businessId", "state" INTO destination_business, destination_state
      FROM "WebhookDestination" WHERE "id" = NEW."destinationId";
    IF NOT FOUND THEN
      RAISE EXCEPTION 'WebhookDelivery: the destination does not exist' USING ERRCODE = 'check_violation';
    END IF;

    -- The cross-tenant rule, and the reason it is a trigger: both ids exist and both foreign keys
    -- are satisfied by a row that would send one merchant's activity to another's endpoint.
    IF destination_business IS DISTINCT FROM NEW."businessId" THEN
      RAISE EXCEPTION 'WebhookDelivery: the destination belongs to a different business'
        USING ERRCODE = 'check_violation';
    END IF;

    -- A revoked destination receives nothing, ever again.
    IF destination_state = 'REVOKED' THEN
      RAISE EXCEPTION 'WebhookDelivery: the destination is revoked' USING ERRCODE = 'check_violation';
    END IF;

    IF NEW."integrationEventId" IS NOT NULL THEN
      SELECT "businessId" INTO event_business FROM "IntegrationEvent" WHERE "id" = NEW."integrationEventId";
      IF NOT FOUND THEN
        RAISE EXCEPTION 'WebhookDelivery: the event does not exist' USING ERRCODE = 'check_violation';
      END IF;
      IF event_business IS DISTINCT FROM NEW."businessId" THEN
        RAISE EXCEPTION 'WebhookDelivery: the event belongs to a different business'
          USING ERRCODE = 'check_violation';
      END IF;
      -- A real delivery only exists for an ENABLED destination. A disabled one receives nothing,
      -- which is what "begins disabled" has to mean at the layer that cannot be bypassed.
      IF destination_state <> 'ENABLED' THEN
        RAISE EXCEPTION 'WebhookDelivery: the destination is not enabled' USING ERRCODE = 'check_violation';
      END IF;
    END IF;

    -- Work starts unstarted. A row created as DELIVERED would be a delivery nobody made, and one
    -- created already claimed would be a lease nobody holds.
    IF NEW."status" <> 'PENDING' OR NEW."attemptCount" <> 0 OR NEW."settledAt" IS NOT NULL THEN
      RAISE EXCEPTION 'WebhookDelivery: a new delivery is pending and unattempted'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."claimedAt" IS NOT NULL OR NEW."leaseExpiresAt" IS NOT NULL OR NEW."claimToken" IS NOT NULL THEN
      RAISE EXCEPTION 'WebhookDelivery: a new delivery is unclaimed' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  -- What the delivery IS cannot change; only how it is going.
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."businessId" IS DISTINCT FROM OLD."businessId"
     OR NEW."destinationId" IS DISTINCT FROM OLD."destinationId"
     OR NEW."integrationEventId" IS DISTINCT FROM OLD."integrationEventId"
     OR NEW."isTest" IS DISTINCT FROM OLD."isTest"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
  THEN
    RAISE EXCEPTION 'WebhookDelivery: what a delivery is cannot change, only how it is going'
      USING ERRCODE = 'check_violation';
  END IF;

  -- PENDING is the only state work leaves. A settled delivery is settled.
  IF OLD."status" <> 'PENDING' AND NEW."status" IS DISTINCT FROM OLD."status" THEN
    RAISE EXCEPTION 'WebhookDelivery: % is a rest state', OLD."status" USING ERRCODE = 'check_violation';
  END IF;

  -- Attempts only ever go up, and by one. A counter that could be rewritten is a retry cap that is
  -- not a cap.
  IF NEW."attemptCount" < OLD."attemptCount" THEN
    RAISE EXCEPTION 'WebhookDelivery: the attempt count cannot go down' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."attemptCount" > OLD."attemptCount" + 1 THEN
    RAISE EXCEPTION 'WebhookDelivery: attempts are recorded one at a time' USING ERRCODE = 'check_violation';
  END IF;

  -- A settled delivery stops being due; a pending one has somewhere to be picked up from.
  IF NEW."status" = 'PENDING' THEN
    IF NEW."settledAt" IS NOT NULL THEN
      RAISE EXCEPTION 'WebhookDelivery: a pending delivery is not settled' USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW."settledAt" IS NULL OR NEW."nextAttemptAt" IS NOT NULL THEN
      RAISE EXCEPTION 'WebhookDelivery: a settled delivery has a settled time and no next attempt'
        USING ERRCODE = 'check_violation';
    END IF;
    -- A settled delivery holds no lease. Leaving one would make a finished row look claimed forever.
    IF NEW."claimedAt" IS NOT NULL OR NEW."leaseExpiresAt" IS NOT NULL OR NEW."claimToken" IS NOT NULL THEN
      RAISE EXCEPTION 'WebhookDelivery: a settled delivery holds no claim' USING ERRCODE = 'check_violation';
    END IF;
    -- The rule a bug would most plausibly break, written down so it cannot: a timeout or a network
    -- error is NEVER delivered.
    IF NEW."status" = 'DELIVERED' AND NEW."lastErrorClass"::text <> 'NONE' THEN
      RAISE EXCEPTION 'WebhookDelivery: a delivered delivery carries no error class'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" = 'DELIVERED' AND (NEW."lastHttpStatus" IS NULL OR NEW."lastHttpStatus" >= 300) THEN
      RAISE EXCEPTION 'WebhookDelivery: delivered means the receiver answered 2xx'
        USING ERRCODE = 'check_violation';
    END IF;
    -- The permanent classes are never retried, so none of them can be the reason a delivery ran out
    -- of attempts. Each settles REFUSED, immediately. GATEWAY_REJECTED is one of them: our own
    -- contract violation is refused on the first attempt, not retried five times first.
    IF NEW."status" = 'FAILED'
       AND NEW."lastErrorClass"::text IN ('UNSAFE_ADDRESS', 'CIPHERTEXT_INVALID',
                                          'DESTINATION_NOT_ELIGIBLE', 'GATEWAY_REJECTED') THEN
      RAISE EXCEPTION 'WebhookDelivery: % is refused, never retried to exhaustion', NEW."lastErrorClass"
        USING ERRCODE = 'check_violation';
    END IF;

    /*
     * And the mirror of that rule, which migration 15 did not have because it did not need it.
     *
     * A class the database calls RETRYABLE cannot settle as a permanent REFUSAL, and cannot reach
     * FAILED before the attempt cap. Without the first half, a writer could record "we refused to
     * deliver this" about a delivery that was never attempted because one of OUR containers was
     * down. Without the second, it could exhaust a delivery on attempt one and call it exhausted.
     *
     * FIVE is the same literal the retry cap below uses. It is written twice on purpose: a trigger
     * cannot read the application's MAX_ATTEMPTS, and a rule that silently disagreed with it would
     * be worse than one that is obviously duplicated.
     */
    IF NEW."status" = 'REFUSED'
       AND NEW."lastErrorClass"::text IN ('ENCRYPTION_UNAVAILABLE', 'GATEWAY_UNAVAILABLE') THEN
      RAISE EXCEPTION 'WebhookDelivery: % is retryable and is never a refusal', NEW."lastErrorClass"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" = 'FAILED'
       AND NEW."lastErrorClass"::text IN ('ENCRYPTION_UNAVAILABLE', 'GATEWAY_UNAVAILABLE')
       AND NEW."attemptCount" < 5 THEN
      RAISE EXCEPTION 'WebhookDelivery: % reaches FAILED only at the attempt cap, not after %',
        NEW."lastErrorClass", NEW."attemptCount"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  /*
   * The retry cap, as a state rule rather than only a counter.
   *
   * A delivery that has used every attempt is not pending — there is nothing left to do with it. A
   * caller that left one PENDING at the cap would create a row the worker picks up forever.
   */
  IF NEW."status" = 'PENDING' AND NEW."attemptCount" >= 5 THEN
    RAISE EXCEPTION 'WebhookDelivery: a delivery at the attempt cap is settled, not pending'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$$;

-- ── The attempt's coherence rules, with the two new classes ──────────────────
--
-- Carried over from migration 15 unchanged except for: `::text` comparisons, GATEWAY_REJECTED in
-- the permanent list, and GATEWAY_UNAVAILABLE in the must-be-retryable rule.

CREATE OR REPLACE FUNCTION walaaplus_validate_webhook_attempt() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  delivery "WebhookDelivery"%ROWTYPE;
BEGIN
  -- Server-assigned, like every other event time in this product. A caller-chosen attempt time is a
  -- caller-chosen answer to "how long has this been failing?".
  NEW."attemptedAt" := (now() AT TIME ZONE 'UTC');

  SELECT * INTO delivery FROM "WebhookDelivery" WHERE "id" = NEW."deliveryId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'WebhookDeliveryAttempt: the delivery does not exist' USING ERRCODE = 'check_violation';
  END IF;
  IF delivery."businessId" IS DISTINCT FROM NEW."businessId" THEN
    RAISE EXCEPTION 'WebhookDeliveryAttempt: the delivery belongs to a different business'
      USING ERRCODE = 'check_violation';
  END IF;

  -- An attempt is numbered by the delivery it belongs to, and the delivery's counter is the
  -- authority. Writing attempt 7 against a delivery that has made two is rewriting history.
  IF NEW."attemptNumber" <> delivery."attemptCount" THEN
    RAISE EXCEPTION 'WebhookDeliveryAttempt: attempt % does not follow the delivery''s % attempts',
      NEW."attemptNumber", delivery."attemptCount"
      USING ERRCODE = 'check_violation';
  END IF;

  -- The outcome and the error class have to agree, so a "delivered" attempt cannot carry a timeout.
  IF NEW."outcome" = 'DELIVERED' AND NEW."errorClass"::text <> 'NONE' THEN
    RAISE EXCEPTION 'WebhookDeliveryAttempt: a delivered attempt carries no error class'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."outcome" <> 'DELIVERED' AND NEW."errorClass"::text = 'NONE' THEN
    RAISE EXCEPTION 'WebhookDeliveryAttempt: a failed attempt says why' USING ERRCODE = 'check_violation';
  END IF;
  -- The FOUR permanent classes. Classifying an unsafe address retryable is what would make the
  -- product attempt an SSRF a second time; the others are permanent because no amount of waiting
  -- changes them. GATEWAY_REJECTED joins them here: the egress gateway refused the dispatch
  -- CONTRACT - a malformed URL, an oversized body, a header outside the allow-list - which is a
  -- defect on this side, and waiting does not make a malformed dispatch well formed.
  IF NEW."errorClass"::text IN ('UNSAFE_ADDRESS', 'CIPHERTEXT_INVALID', 'DESTINATION_NOT_ELIGIBLE',
                                'GATEWAY_REJECTED')
     AND NEW."outcome" <> 'PERMANENT' THEN
    RAISE EXCEPTION 'WebhookDeliveryAttempt: % is permanent', NEW."errorClass"
      USING ERRCODE = 'check_violation';
  END IF;
  /*
   * And the TWO that must NOT be permanent.
   *
   * A missing environment key is a deployment condition an operator corrects, so a delivery that met
   * one waits and tries again. Recording it as permanent would quietly discard every queued webhook
   * because a variable was unset for five minutes — which is the gap this rule exists to close.
   *
   * GATEWAY_UNAVAILABLE is the same kind of fact and the same kind of mistake. It means the egress
   * gateway was unreachable, unauthenticated, unconfigured or at its concurrency limit — so NOTHING
   * WAS SENT, and the fault is ours and temporary. Recording it permanent would refuse a webhook
   * because one of our own containers was restarting.
   */
  IF NEW."errorClass"::text IN ('ENCRYPTION_UNAVAILABLE', 'GATEWAY_UNAVAILABLE')
     AND NEW."outcome" <> 'RETRYABLE' THEN
    RAISE EXCEPTION 'WebhookDeliveryAttempt: % is retryable, not permanent', NEW."errorClass"
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$$;
