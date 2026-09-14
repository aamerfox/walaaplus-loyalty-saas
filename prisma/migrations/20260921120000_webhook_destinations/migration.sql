-- Phase 3B Prompt 2 — the one door out, and every lock on it.
--
-- ONE additive migration. Five enums, three tables, seven triggers. Nothing existing is changed,
-- dropped or backfilled.
--
-- ## What this is
--
-- A custom outbound webhook: the owner types an HTTPS URL, the product signs the `IntegrationEvent`
-- envelope built in Prompt 1 and posts it there. No named provider, no OAuth, no SDK, no inbound
-- route, and nothing in the body that Prompt 1's envelope did not already contain.
--
-- `docs/INTEGRATIONS-CAPABILITY-MATRIX.md` §7a is the security record this was written against, and
-- it was written first.
--
-- ## The three tables and why they are three
--
--   WebhookDestination      what the owner configured. Narrow UPDATEs: lifecycle and secret
--                           rotation, with identity and ciphertext-shape frozen by trigger.
--   WebhookDelivery         one row per (destination, event). A transactional OUTBOX: created in the
--                           same transaction as the event, so the worker only ever sees committed
--                           work and nothing is enqueued for an action that rolled back. Narrow
--                           UPDATEs, because delivery state genuinely changes.
--   WebhookDeliveryAttempt  APPEND-ONLY. One row per attempt, holding an outcome, a status code and
--                           an error class. Never a body, never a header, never a URL.
--
-- A delivery attempt never touches `IntegrationEvent`. The event said what happened; whether
-- somebody was told is a different fact, and conflating them would let a delivery failure rewrite
-- the record of a redemption.
--
-- ## What is encrypted, and what is deliberately not
--
-- The URL and the signing secret are AES-256-GCM ciphertext, each with its own random 96-bit nonce,
-- and the algorithm and key version are their own columns rather than something inferred from the
-- blob. There is no plaintext column for either and no fallback mode: a missing key means the
-- feature fails closed, not that it stores a secret in the clear.
--
-- The NAME and the HOSTNAME are plaintext, because the owner has to read their own list and neither
-- is a credential. The host is also what the unique index uses, so two destinations cannot quietly
-- be the same endpoint.
--
-- ## What no column here can hold
--
-- No response body, no request body, no headers, no full URL with a query, no raw error text, no
-- customer, card, phone, email, coupon code or digest, no wallet payload, no amount. There is no
-- JSON column anywhere in this migration. `tests/integration/webhook-integrity.test.ts` asserts the
-- column list of all three tables exactly and fails on any name that could hold one of those.

-- ── Enums ────────────────────────────────────────────────────────────────────

-- A destination is born DISABLED and receives nothing until the owner says so. REVOKED is terminal:
-- a destination that was switched off for cause never quietly starts working again.
CREATE TYPE "WebhookDestinationState" AS ENUM ('DISABLED', 'ENABLED', 'REVOKED');

-- PENDING is the only state the worker picks up. The other three are rest states.
--   DELIVERED  the receiver answered 2xx.
--   REFUSED    a permanent failure: 4xx, a redirect, TLS, or an unsafe address. Never retried.
--   FAILED     transient failures, retried to the cap and still failing.
CREATE TYPE "WebhookDeliveryStatus" AS ENUM ('PENDING', 'DELIVERED', 'REFUSED', 'FAILED');

-- What one attempt did. Deliberately coarse: a category a person can act on, not a diagnosis.
CREATE TYPE "WebhookAttemptOutcome" AS ENUM ('DELIVERED', 'RETRYABLE', 'PERMANENT');

-- Why it did that. A BOUNDED classification — the raw error string is never stored, because a
-- driver's error text can carry a URL, a hostname or, on some stacks, a header.
CREATE TYPE "WebhookErrorClass" AS ENUM (
  'NONE',
  'HTTP_CLIENT_ERROR',     -- 4xx other than 429
  'HTTP_RATE_LIMITED',     -- 429
  'HTTP_SERVER_ERROR',     -- 5xx
  'HTTP_REDIRECT',         -- 3xx: a misconfiguration, and following it is the SSRF bypass
  'TIMEOUT',
  'NETWORK',
  'TLS',
  'UNSAFE_ADDRESS',        -- the URL or its freshly resolved address failed validation. NEVER retried
  -- The environment key is absent or malformed. **Retryable**, and deliberately so: it is a
  -- deployment condition an operator corrects in minutes, and refusing every queued delivery
  -- permanently because a variable was briefly unset would turn a five-minute outage into data loss.
  -- Nothing is sent while it lasts; the delivery simply waits, and exhausts to FAILED like any other
  -- transient failure if nobody fixes it.
  'ENCRYPTION_UNAVAILABLE',
  -- The stored ciphertext did not decrypt under a key that IS present and well-formed: tampered, or
  -- written under a key that no longer exists. **Permanent.** A retry cannot make a row decrypt, and
  -- treating it as transient would hide a corrupted destination behind five quiet failures.
  'CIPHERTEXT_INVALID',
  -- The destination was disabled or revoked between queueing and dispatch, or a real event was
  -- queued for a destination that is not enabled. **Permanent**: the owner's decision is not a
  -- transient condition. Distinct from UNSAFE_ADDRESS, which used to absorb this and made an
  -- ordinary "switched it off" look like an attempted SSRF in the owner's history.
  'DESTINATION_NOT_ELIGIBLE'
);

-- Only AES-256-GCM exists. An enum rather than free text so a row cannot claim an algorithm nothing
-- in this codebase can read, and so adding one is a migration somebody reviews.
CREATE TYPE "WebhookCipher" AS ENUM ('AES_256_GCM');

-- ── The destination ──────────────────────────────────────────────────────────

CREATE TABLE "WebhookDestination" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    -- What the owner calls it. Their own screens only.
    "name" TEXT NOT NULL,
    -- Lower-cased hostname. Plaintext on purpose: the owner reads it, and it is not a credential.
    "endpointHost" TEXT NOT NULL,
    -- sha256 of the normalised URL with the business id mixed in. For the unique index only, so two
    -- destinations cannot be the same endpoint wearing different names.
    "endpointDigest" TEXT NOT NULL,
    -- AES-256-GCM over the full URL, which may carry a path or query token the receiver treats as
    -- authentication. Self-describing: nonce, tag and ciphertext, base64url, dot-separated.
    "endpointCipher" TEXT NOT NULL,
    -- AES-256-GCM over the signing secret. Shown to the owner once, at creation and at rotation,
    -- and never readable again through any route, selection or screen.
    "signingSecretCipher" TEXT NOT NULL,
    -- Explicit, not inferred from the blob. A future key writes version 2 beside version 1 rows.
    "cipherAlgorithm" "WebhookCipher" NOT NULL,
    "cipherKeyVersion" INTEGER NOT NULL,
    "state" "WebhookDestinationState" NOT NULL DEFAULT 'DISABLED',
    -- When the secret was last shown. A fact about disclosure, kept because it is one.
    "secretIssuedAt" TIMESTAMP(3) NOT NULL,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WebhookDestination_pkey" PRIMARY KEY ("id"),
    -- A key version is a counter, not a flag.
    CONSTRAINT "WebhookDestination_cipherKeyVersion_positive" CHECK ("cipherKeyVersion" > 0),
    -- The ciphertext shape, checked by the database as well as by the code that writes it: four
    -- dot-separated base64url parts, `v<n>.<nonce>.<tag>.<ciphertext>`. A plaintext URL cannot
    -- satisfy this, which is the point — there is no path by which one gets stored by accident.
    --
    -- The lengths are EXACT, not minimums: a 96-bit GCM nonce is 16 base64url characters and a
    -- 128-bit tag is 22. Pinning them here means a row cannot carry a truncated nonce or a
    -- shortened tag, which are the two ways an authenticated cipher quietly stops authenticating.
    CONSTRAINT "WebhookDestination_endpointCipher_shape"
      CHECK ("endpointCipher" ~ '^v[0-9]+\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]+$'),
    CONSTRAINT "WebhookDestination_signingSecretCipher_shape"
      CHECK ("signingSecretCipher" ~ '^v[0-9]+\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]+$'),
    -- Belt and braces on the one thing a reader will look for: the host is a hostname, never a URL,
    -- never a scheme, never an IP literal.
    CONSTRAINT "WebhookDestination_endpointHost_shape"
      CHECK ("endpointHost" ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'),
    -- The shape above is satisfied by `10.0.0.1`, because digits and dots make a legal-looking
    -- hostname \u2014 found by the integrity test, not by reading it. A real top-level domain always
    -- contains a letter, so requiring one in the LAST label refuses every IPv4 literal without
    -- refusing any name a merchant could actually own.
    CONSTRAINT "WebhookDestination_endpointHost_not_ip"
      CHECK ("endpointHost" ~ '\.[a-z][a-z0-9-]*$'),
    CONSTRAINT "WebhookDestination_endpointDigest_shape" CHECK ("endpointDigest" ~ '^[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX "WebhookDestination_businessId_endpointDigest_key"
  ON "WebhookDestination"("businessId", "endpointDigest");
CREATE UNIQUE INDEX "WebhookDestination_businessId_name_key"
  ON "WebhookDestination"("businessId", "name");
-- The fan-out query: this business's ENABLED destinations, at the moment an event is written.
CREATE INDEX "WebhookDestination_businessId_state_idx" ON "WebhookDestination"("businessId", "state");

ALTER TABLE "WebhookDestination" ADD CONSTRAINT "WebhookDestination_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WebhookDestination" ADD CONSTRAINT "WebhookDestination_createdByUserId_fkey"
  FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── The delivery: a transactional outbox ─────────────────────────────────────

CREATE TABLE "WebhookDelivery" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "destinationId" TEXT NOT NULL,
    -- Null for a test delivery, which describes no real event. Set for everything else.
    "integrationEventId" TEXT,
    -- A test delivery carries a fixed synthetic envelope and never a customer's anything.
    "isTest" BOOLEAN NOT NULL DEFAULT false,
    "status" "WebhookDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    -- When the worker may next pick it up. Null once the delivery is at rest.
    "nextAttemptAt" TIMESTAMP(3),
    "lastOutcome" "WebhookAttemptOutcome",
    "lastErrorClass" "WebhookErrorClass" NOT NULL DEFAULT 'NONE',
    "lastHttpStatus" INTEGER,
    "lastAttemptAt" TIMESTAMP(3),
    "settledAt" TIMESTAMP(3),
    /*
     * The LEASE. Three columns that move together or not at all.
     *
     * `claimDue` takes them in one `UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED)
     * RETURNING`, which is a single atomic statement: two workers, or two overlapping passes of one
     * worker, cannot both come away with the same row. The previous design read with `findMany` and
     * only wrote after sending, so an overlap sent the same webhook twice.
     *
     * `leaseExpiresAt` is what makes a crash recoverable. A worker that dies holding a claim leaves
     * the row untouched; once the lease passes, the row is eligible again and another pass takes it.
     * That is also precisely where **at-least-once** comes from: a process that dies after the
     * request reached the receiver but before the outcome was written will retry, and the receiver
     * de-duplicates by event id. Nothing here can make that exactly-once, and nothing pretends to.
     *
     * `claimToken` is a random uuid and nothing else. **No URL, no body, no secret, no response, no
     * error text** — a lease is a claim on a row, not a record of what was attempted.
     */
    "claimedAt" TIMESTAMP(3),
    "leaseExpiresAt" TIMESTAMP(3),
    "claimToken" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookDelivery_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "WebhookDelivery_attemptCount_nonnegative" CHECK ("attemptCount" >= 0),
    -- The retry cap, in the database as well as in `MAX_ATTEMPTS`. A caller that lost count cannot
    -- keep hammering a receiver, and a direct writer cannot set the counter past the ceiling to make
    -- room for more.
    CONSTRAINT "WebhookDelivery_attemptCount_capped" CHECK ("attemptCount" <= 5),
    -- All three lease columns, or none. A half-set lease is a row nobody can reason about.
    CONSTRAINT "WebhookDelivery_lease_coherent" CHECK (
      ("claimedAt" IS NULL AND "leaseExpiresAt" IS NULL AND "claimToken" IS NULL)
      OR ("claimedAt" IS NOT NULL AND "leaseExpiresAt" IS NOT NULL AND "claimToken" IS NOT NULL)
    ),
    -- A lease that expires before it starts is not a lease.
    CONSTRAINT "WebhookDelivery_lease_ordered"
      CHECK ("leaseExpiresAt" IS NULL OR "claimedAt" IS NULL OR "leaseExpiresAt" > "claimedAt"),
    -- A claim token is a uuid. Nothing longer fits, so nothing longer can be smuggled in.
    CONSTRAINT "WebhookDelivery_claimToken_shape"
      CHECK ("claimToken" IS NULL OR "claimToken" ~ '^[0-9a-f-]{36}$'),
    -- An HTTP status or nothing; never a made-up number.
    CONSTRAINT "WebhookDelivery_lastHttpStatus_range"
      CHECK ("lastHttpStatus" IS NULL OR ("lastHttpStatus" BETWEEN 100 AND 599)),
    -- A real delivery names an event; a test delivery names none. Never both, never neither.
    CONSTRAINT "WebhookDelivery_test_xor_event"
      CHECK (("isTest" AND "integrationEventId" IS NULL) OR (NOT "isTest" AND "integrationEventId" IS NOT NULL))
);

-- One delivery per destination per event, forever. A retry is an ATTEMPT, not a second delivery, so
-- a receiver cannot be handed two rows describing the same obligation.
CREATE UNIQUE INDEX "WebhookDelivery_destinationId_integrationEventId_key"
  ON "WebhookDelivery"("destinationId", "integrationEventId")
  WHERE "integrationEventId" IS NOT NULL;

-- The worker's only query: what is due.
-- The claim query's index: pending, due, and not currently leased.
CREATE INDEX "WebhookDelivery_status_nextAttemptAt_idx"
  ON "WebhookDelivery"("status", "nextAttemptAt", "leaseExpiresAt")
  WHERE "status" = 'PENDING';
CREATE INDEX "WebhookDelivery_businessId_createdAt_idx" ON "WebhookDelivery"("businessId", "createdAt" DESC);
CREATE INDEX "WebhookDelivery_destinationId_createdAt_idx" ON "WebhookDelivery"("destinationId", "createdAt" DESC);

ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_destinationId_fkey"
  FOREIGN KEY ("destinationId") REFERENCES "WebhookDestination"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_integrationEventId_fkey"
  FOREIGN KEY ("integrationEventId") REFERENCES "IntegrationEvent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── The attempt: append-only ─────────────────────────────────────────────────

CREATE TABLE "WebhookDeliveryAttempt" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "deliveryId" TEXT NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    -- Server-assigned, like every other event time in this product.
    "attemptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "outcome" "WebhookAttemptOutcome" NOT NULL,
    "errorClass" "WebhookErrorClass" NOT NULL,
    -- The status code and nothing else from the response. No body, no headers, no size, no timing
    -- fingerprint — and no column that could hold one.
    "httpStatus" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookDeliveryAttempt_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "WebhookDeliveryAttempt_attemptNumber_positive" CHECK ("attemptNumber" > 0),
    CONSTRAINT "WebhookDeliveryAttempt_httpStatus_range"
      CHECK ("httpStatus" IS NULL OR ("httpStatus" BETWEEN 100 AND 599))
);

CREATE UNIQUE INDEX "WebhookDeliveryAttempt_deliveryId_attemptNumber_key"
  ON "WebhookDeliveryAttempt"("deliveryId", "attemptNumber");
CREATE INDEX "WebhookDeliveryAttempt_businessId_attemptedAt_idx"
  ON "WebhookDeliveryAttempt"("businessId", "attemptedAt" DESC);

ALTER TABLE "WebhookDeliveryAttempt" ADD CONSTRAINT "WebhookDeliveryAttempt_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WebhookDeliveryAttempt" ADD CONSTRAINT "WebhookDeliveryAttempt_deliveryId_fkey"
  FOREIGN KEY ("deliveryId") REFERENCES "WebhookDelivery"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── Destination: no removal, and only a legal change ─────────────────────────

CREATE OR REPLACE FUNCTION walaaplus_webhook_destination_no_removal() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'WebhookDestination is never removed; % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation',
          HINT = 'Revoke the destination. What this business sent, and to whom, is part of the record.';
END
$$;

CREATE TRIGGER webhook_destination_no_delete
  BEFORE DELETE ON "WebhookDestination"
  FOR EACH ROW EXECUTE FUNCTION walaaplus_webhook_destination_no_removal();

CREATE TRIGGER webhook_destination_no_truncate
  BEFORE TRUNCATE ON "WebhookDestination"
  FOR EACH STATEMENT EXECUTE FUNCTION walaaplus_webhook_destination_no_removal();

CREATE OR REPLACE FUNCTION walaaplus_webhook_destination_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- A destination is born disabled. One that could be created already receiving would skip the
    -- only moment the owner reads back the URL they typed.
    IF NEW."state" <> 'DISABLED' THEN
      RAISE EXCEPTION 'WebhookDestination: a new destination starts disabled'
        USING ERRCODE = 'check_violation';
    END IF;
    -- Nothing in this codebase writes another algorithm, so nothing may claim one.
    IF NEW."cipherAlgorithm" <> 'AES_256_GCM' THEN
      RAISE EXCEPTION 'WebhookDestination: unsupported cipher' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  -- What a destination IS cannot change. A URL that could be edited under a live destination would
  -- redirect an existing stream of a merchant's activity somewhere else without a new decision.
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."businessId" IS DISTINCT FROM OLD."businessId"
     OR NEW."endpointHost" IS DISTINCT FROM OLD."endpointHost"
     OR NEW."endpointDigest" IS DISTINCT FROM OLD."endpointDigest"
     OR NEW."endpointCipher" IS DISTINCT FROM OLD."endpointCipher"
     OR NEW."createdByUserId" IS DISTINCT FROM OLD."createdByUserId"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
  THEN
    RAISE EXCEPTION 'WebhookDestination: the endpoint and the identity of a destination are frozen'
      USING ERRCODE = 'check_violation',
            HINT = 'Revoke this destination and create another. A different URL is a different decision.';
  END IF;

  -- The lifecycle.
  --   DISABLED → ENABLED | REVOKED
  --   ENABLED  → DISABLED | REVOKED
  --   REVOKED  → nothing. Terminal, so a destination switched off for cause never restarts.
  IF NEW."state" IS DISTINCT FROM OLD."state" THEN
    IF NOT (
         (OLD."state" = 'DISABLED' AND NEW."state" IN ('ENABLED', 'REVOKED'))
      OR (OLD."state" = 'ENABLED'  AND NEW."state" IN ('DISABLED', 'REVOKED'))
    ) THEN
      RAISE EXCEPTION 'WebhookDestination: % cannot become %', OLD."state", NEW."state"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- A revoked destination is finished, including its settings.
  IF OLD."state" = 'REVOKED' AND (
       NEW."name" IS DISTINCT FROM OLD."name"
    OR NEW."signingSecretCipher" IS DISTINCT FROM OLD."signingSecretCipher"
    OR NEW."cipherKeyVersion" IS DISTINCT FROM OLD."cipherKeyVersion"
    OR NEW."secretIssuedAt" IS DISTINCT FROM OLD."secretIssuedAt"
  ) THEN
    RAISE EXCEPTION 'WebhookDestination: a revoked destination cannot be edited'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Rotating the secret and re-stamping the disclosure time are the same act. One without the other
  -- would leave a row claiming the owner saw a value they never did.
  IF (NEW."signingSecretCipher" IS DISTINCT FROM OLD."signingSecretCipher")
     <> (NEW."secretIssuedAt" IS DISTINCT FROM OLD."secretIssuedAt") THEN
    RAISE EXCEPTION 'WebhookDestination: a rotated secret and its disclosure time move together'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER webhook_destination_guard
  BEFORE INSERT OR UPDATE ON "WebhookDestination"
  FOR EACH ROW EXECUTE FUNCTION walaaplus_webhook_destination_guard();

-- ── Delivery: every row has to mean something, and state moves one way ───────
--
-- Foreign keys check that each id EXISTS. Nothing in a foreign key checks that they AGREE, that the
-- destination is this business's, that the event is, or that an attempt count only ever goes up.

CREATE OR REPLACE FUNCTION walaaplus_webhook_delivery_no_removal() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'WebhookDelivery is never removed; % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation',
          HINT = 'A delivery that failed is a fact about what this business tried to send.';
END
$$;

CREATE TRIGGER webhook_delivery_no_delete
  BEFORE DELETE ON "WebhookDelivery"
  FOR EACH ROW EXECUTE FUNCTION walaaplus_webhook_delivery_no_removal();

CREATE TRIGGER webhook_delivery_no_truncate
  BEFORE TRUNCATE ON "WebhookDelivery"
  FOR EACH STATEMENT EXECUTE FUNCTION walaaplus_webhook_delivery_no_removal();

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
    IF NEW."status" = 'DELIVERED' AND NEW."lastErrorClass" <> 'NONE' THEN
      RAISE EXCEPTION 'WebhookDelivery: a delivered delivery carries no error class'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" = 'DELIVERED' AND (NEW."lastHttpStatus" IS NULL OR NEW."lastHttpStatus" >= 300) THEN
      RAISE EXCEPTION 'WebhookDelivery: delivered means the receiver answered 2xx'
        USING ERRCODE = 'check_violation';
    END IF;
    -- The permanent classes are never retried, so none of them can be the reason a delivery ran out
    -- of attempts. Each settles REFUSED, immediately.
    IF NEW."status" = 'FAILED'
       AND NEW."lastErrorClass" IN ('UNSAFE_ADDRESS', 'CIPHERTEXT_INVALID', 'DESTINATION_NOT_ELIGIBLE') THEN
      RAISE EXCEPTION 'WebhookDelivery: % is refused, never retried to exhaustion', NEW."lastErrorClass"
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

CREATE TRIGGER webhook_delivery_guard
  BEFORE INSERT OR UPDATE ON "WebhookDelivery"
  FOR EACH ROW EXECUTE FUNCTION walaaplus_webhook_delivery_guard();

-- ── Attempt: append-only, and it has to match its delivery ───────────────────

CREATE OR REPLACE FUNCTION walaaplus_reject_webhook_attempt_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'WebhookDeliveryAttempt is append-only; % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation',
          HINT = 'An attempt is a statement that something was tried. Record another; do not edit one.';
END
$$;

CREATE TRIGGER webhook_attempt_append_only
  BEFORE UPDATE OR DELETE ON "WebhookDeliveryAttempt"
  FOR EACH ROW EXECUTE FUNCTION walaaplus_reject_webhook_attempt_mutation();

CREATE TRIGGER webhook_attempt_no_truncate
  BEFORE TRUNCATE ON "WebhookDeliveryAttempt"
  FOR EACH STATEMENT EXECUTE FUNCTION walaaplus_reject_webhook_attempt_mutation();

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
  IF NEW."outcome" = 'DELIVERED' AND NEW."errorClass" <> 'NONE' THEN
    RAISE EXCEPTION 'WebhookDeliveryAttempt: a delivered attempt carries no error class'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."outcome" <> 'DELIVERED' AND NEW."errorClass" = 'NONE' THEN
    RAISE EXCEPTION 'WebhookDeliveryAttempt: a failed attempt says why' USING ERRCODE = 'check_violation';
  END IF;
  -- The three permanent classes. Classifying an unsafe address retryable is what would make the
  -- product attempt an SSRF a second time; the other two are permanent because no amount of waiting
  -- changes them.
  IF NEW."errorClass" IN ('UNSAFE_ADDRESS', 'CIPHERTEXT_INVALID', 'DESTINATION_NOT_ELIGIBLE')
     AND NEW."outcome" <> 'PERMANENT' THEN
    RAISE EXCEPTION 'WebhookDeliveryAttempt: % is permanent', NEW."errorClass"
      USING ERRCODE = 'check_violation';
  END IF;
  /*
   * And the one that must NOT be permanent.
   *
   * A missing environment key is a deployment condition an operator corrects, so a delivery that met
   * one waits and tries again. Recording it as permanent would quietly discard every queued webhook
   * because a variable was unset for five minutes — which is the gap this rule exists to close.
   */
  IF NEW."errorClass" = 'ENCRYPTION_UNAVAILABLE' AND NEW."outcome" <> 'RETRYABLE' THEN
    RAISE EXCEPTION 'WebhookDeliveryAttempt: an unavailable key is retryable, not permanent'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER webhook_attempt_validate
  BEFORE INSERT ON "WebhookDeliveryAttempt"
  FOR EACH ROW EXECUTE FUNCTION walaaplus_validate_webhook_attempt();
