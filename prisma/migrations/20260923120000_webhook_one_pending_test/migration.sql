-- Phase 3B Prompt 3 release gate - one test delivery in flight per destination.
--
-- WHY THIS MIGRATION EXISTS
--
-- The release-gate audit found that `queueTestDelivery` had no bound. An owner could call it in a
-- loop; a probe queued fifty in a row and every one was accepted and left PENDING.
--
-- On its own that is a row count. What makes it a defect is the other half of the design:
-- `claimDue` takes ten rows per minute ACROSS EVERY BUSINESS, ordered by when they became due, and
-- a test delivery is created due IMMEDIATELY. So one owner's loop puts an unbounded number of their
-- own rows at the front of a queue that every tenant shares.
--
-- Stated precisely, because the honest version is narrower than the alarming one: nothing is
-- exposed, no other tenant's delivery is marked failed, and no attempt is consumed by a delivery
-- that is never claimed. What the caller gains is control over how long every OTHER business's
-- webhooks wait - without limit, and without any special access. One tenant setting another
-- tenant's delivery latency is a tenant-isolation failure in the availability dimension, and the
-- table grows without bound while it happens.
--
-- The service now refuses a second test while one is waiting. This is the same rule at the layer
-- that cannot be bypassed, so it also holds against a direct writer holding the runtime role.
--
-- WHY A FUNCTION REPLACEMENT AND NOT A UNIQUE INDEX
--
-- A partial unique index - UNIQUE (destinationId) WHERE isTest AND status = 'PENDING' - would
-- express this more tersely, and it was rejected deliberately.
--
-- Migration 16 is being deployed to staging as this is written. A unique index is validated against
-- rows that ALREADY EXIST, so if anyone had queued two tests for one destination before this
-- migration ran, the migration would fail and the deployment would stop on data nobody did anything
-- wrong to create. A trigger rule constrains only what is written from now on: it cannot fail on
-- existing data, it takes no table lock, and it rewrites nothing.
--
-- Existing duplicate PENDING tests, if any exist on staging, are therefore left alone. They settle
-- normally through the ordinary retry path and no new pair can be created.
--
-- WHAT THIS DOES NOT DO
--
-- No table is created, altered, rewritten or locked. No row changes. No enum value is added,
-- renamed or removed. No index is created or dropped. Migrations 15 and 16 are NOT amended: both
-- are applied on staging and stay exactly as they are. Replacing a function body leaves the trigger
-- that references it pointing at the same function, so no trigger is dropped or recreated.
--
-- The whole of `walaaplus_webhook_delivery_guard` is reproduced below because that is what
-- CREATE OR REPLACE requires. Its body was copied from migration 16 rather than retyped; the only
-- change is the single INSERT-time rule marked in place.

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

    /*
     * ONE test delivery in flight per destination.
     *
     * LAST among the INSERT checks, deliberately. Placed before them it changed which sentence a
     * row breaking two rules at once reports - a forged-claim row that was also a duplicate test
     * said "a test is already queued" rather than "a new delivery is unclaimed". Both refuse, so
     * nothing was unsafe, but an existing rule's message is part of its identity and a new rule
     * should not repaint one.
     *
     * `claimDue` takes ten rows a minute ACROSS EVERY BUSINESS, ordered by when they became due,
     * and a test delivery is created due immediately. Without this rule an owner calling the test
     * endpoint in a loop puts thousands of their own rows at the front of a queue every other
     * tenant shares: nothing is exposed and no delivery is marked failed, but every other
     * business's webhooks wait behind them for as long as the caller keeps going. One tenant must
     * not be able to set another tenant's delivery latency.
     *
     * A destination that already has a test waiting does not need a second one, so outstanding
     * test deliveries are bounded by the number of destinations, which is itself bounded.
     *
     * Only TEST deliveries. A real one is already unique per (destination, event) by index, and
     * refusing a second real delivery here would drop an event nobody could get back.
     */
    IF NEW."isTest" AND EXISTS (
      SELECT 1 FROM "WebhookDelivery" d
       WHERE d."destinationId" = NEW."destinationId"
         AND d."isTest"
         AND d."status" = 'PENDING'
    ) THEN
      RAISE EXCEPTION 'WebhookDelivery: a test is already queued for this destination'
        USING ERRCODE = 'check_violation';
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
