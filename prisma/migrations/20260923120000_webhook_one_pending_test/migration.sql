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
-- WHAT ENFORCES IT, AND WHAT MERELY EXPLAINS IT
--
-- The first version of this migration used ONLY the trigger below, and claimed that made the rule
-- concurrency-safe. That claim was wrong, and it is worth writing down why so it is not made again.
--
-- A BEFORE INSERT trigger running `SELECT ... EXISTS` sees only COMMITTED rows. Under READ
-- COMMITTED - what this product runs - two overlapping transactions T1 and T2 can each run that
-- SELECT, each find nothing because the other's row is uncommitted, each pass the check, and each
-- commit. Two pending tests. A trigger that reads is a check, not a mutual exclusion.
--
-- The test that "proved" it was `Promise.all` of two Prisma creates. Prisma issued those as two
-- autocommit statements on a connection pool, so they serialized and the second genuinely saw the
-- first's committed row. It demonstrated sequential refusal and was read as concurrency safety.
--
-- So the guarantee is now a PARTIAL UNIQUE INDEX:
--
--   UNIQUE ("destinationId") WHERE "isTest" AND "status" = 'PENDING'
--
-- PostgreSQL serializes that: the second inserter blocks on the first transaction's uncommitted
-- index entry and, when the first commits, is refused with a unique violation. If the first rolls
-- back, the second proceeds. That is a real mutual exclusion and not an observation about timing.
--
-- The trigger rule is KEPT, and its job is now only to give the ordinary sequential case a sentence
-- that says what is wrong rather than a bare duplicate-key error. It no longer claims to be the
-- concurrency guarantee, because it is not one.
--
-- WHY THE TABLE IS LOCKED FIRST
--
-- The preflight and the index build must see the same table, and between them sits a window the
-- RUNNING APPLICATION can write through. Staging is live on a build that has no bound on test
-- deliveries at all: an owner pressing the test button twice in that window would insert the very
-- duplicate the preflight has just certified absent, and the index build would then fail - after
-- the migration had already reported the table clean.
--
-- So the first statement takes SHARE ROW EXCLUSIVE on "WebhookDelivery" and Prisma's
-- per-migration transaction holds it until commit. That mode blocks INSERT, UPDATE and DELETE -
-- including the running web and worker - while still allowing reads, which is the least authority
-- that makes the preflight's answer still true when the index is built. Readers are not blocked,
-- so the owner's screens and the delivery list keep working throughout.
--
-- The window is the preflight count plus one index build on a small table. Writers that arrive
-- during it wait rather than fail.
--
-- WHY A PREFLIGHT BLOCK, AND NOT A QUIET REPAIR
--
-- A unique index IS validated against rows that already exist, which is the reason the first
-- version avoided one. That was the wrong trade: it swapped a real guarantee for a convenient
-- deployment. The right answer is to keep the guarantee and make the failure legible.
--
-- The DO block below counts duplicate pending test rows BEFORE the index is built and, if it finds
-- any, stops the migration with the exact query an operator needs. It does NOT delete, settle,
-- re-point or rewrite a single delivery row: a delivery is a record that something was asked for,
-- and a migration that quietly disposed of one to make an index build would be destroying history
-- to save itself an error message.
--
-- Read-only preflight, safe to run against any environment before deploying (this takes no lock
-- and is the query to run by hand ahead of time; the migration takes the lock itself):
--
--   SELECT "destinationId", count(*) AS pending_tests
--     FROM "WebhookDelivery"
--    WHERE "isTest" AND "status" = 'PENDING'
--    GROUP BY "destinationId"
--   HAVING count(*) > 1;
--
-- Zero rows means this migration applies cleanly. If it returns anything, a human decides what to
-- do with those deliveries - let them settle through the ordinary retry path, or settle them
-- deliberately - and re-runs the migration afterwards.
--
-- Checked before writing this: the local development and test databases both return zero rows.
-- Freebuff reports staging has no created destinations, so it can have no deliveries; the query
-- above is the confirmation to run there rather than an assumption to carry.
--
-- WHAT THIS DOES NOT DO
--
-- No table is created, altered or rewritten. No row changes. No enum value is added, renamed or
-- removed. Migrations 15 and 16 are NOT amended: both are applied on staging and stay exactly as
-- they are. Replacing a function body leaves the trigger that references it pointing at the same
-- function.
--
-- The whole of `walaaplus_webhook_delivery_guard` is reproduced below because that is what
-- CREATE OR REPLACE requires. Its body was copied from migration 16 rather than retyped; the only
-- change is the single INSERT-time rule marked in place.

-- ── Hold the table still, so the preflight's answer is still true below ─────
--
-- SHARE ROW EXCLUSIVE: blocks every writer, allows every reader, and is self-exclusive so two
-- concurrent deployments cannot interleave here either. Held by Prisma's migration transaction
-- until it commits, which is what closes the window between the count and the index.

LOCK TABLE "WebhookDelivery" IN SHARE ROW EXCLUSIVE MODE;

-- ── Preflight: refuse to proceed rather than repair anything ─────────────────
--
-- Runs with the lock already held, so nothing can insert a duplicate between this count and the
-- CREATE UNIQUE INDEX below. If it raises, the whole migration transaction rolls back: the lock is
-- released, the index is not created, and NOT ONE ROW HAS BEEN MODIFIED.

DO $preflight$
DECLARE
  offenders INT;
BEGIN
  SELECT count(*) INTO offenders FROM (
    SELECT "destinationId"
      FROM "WebhookDelivery"
     WHERE "isTest" AND "status" = 'PENDING'
     GROUP BY "destinationId"
    HAVING count(*) > 1
  ) AS d;

  IF offenders > 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = format(
        'Migration 17 blocked: %s destination(s) already hold more than one PENDING test delivery.',
        offenders),
      DETAIL  = 'The partial unique index this migration creates cannot be built while they exist.',
      HINT    = 'Run: SELECT "destinationId", count(*) FROM "WebhookDelivery" WHERE "isTest" AND "status" = ''PENDING'' GROUP BY "destinationId" HAVING count(*) > 1; then let those deliveries settle through the normal retry path, or settle them deliberately. Nothing is deleted or rewritten automatically.';
  END IF;
END
$preflight$;

-- ── The guarantee ───────────────────────────────────────────────────────────
--
-- A partial unique index, so it constrains only what is waiting. A destination may have any number
-- of test deliveries over its life; it may have one WAITING.
--
-- Not CONCURRENTLY: Prisma runs each migration inside a transaction and CREATE INDEX CONCURRENTLY
-- cannot run in one - and CONCURRENTLY would also defeat the point, because it deliberately does
-- NOT hold the table still.
--
-- This build takes its own lock on top of the one already held, and writers stay blocked until the
-- migration commits. That is a real cost and is stated plainly rather than waved away: the table is
-- small because deliveries settle, and the preflight above has already established the build will
-- succeed, so the window is short and bounded.

CREATE UNIQUE INDEX "WebhookDelivery_one_pending_test_key"
  ON "WebhookDelivery"("destinationId")
  WHERE "isTest" AND "status" = 'PENDING';

-- ── The readable refusal ────────────────────────────────────────────────────

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
     * One test delivery in flight per destination - the READABLE half of the rule.
     *
     * **This check is not what makes the rule true.** It runs BEFORE INSERT and reads only
     * COMMITTED rows, so two overlapping transactions each see no pending test, each pass here, and
     * each insert one. The unique index below is what actually serializes them; this exists so the
     * ordinary sequential case - an owner pressing the button twice, a script looping - is refused
     * with a sentence that says what is wrong instead of a bare duplicate-key error.
     *
     * Placed LAST among the INSERT checks: placed first it changed which sentence a row breaking
     * two rules at once reports, and an existing rule's message is part of its identity.
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
