-- Phase 3B.1 Prompt 1 - API keys for the read-only public API.
--
-- Additive. A new table, two new enums, indexes and triggers. Nothing existing is altered, and
-- migrations 15, 16 and 17 are untouched - all three are applied on staging and immutable.
--
-- WHAT A KEY IS
--
-- A bearer credential this product issues to a business so it can read its OWN data. Only a
-- sha256 digest is stored; the value is 32 bytes of crypto.randomBytes, shown once and never
-- recoverable. That is the share-capability pattern (share-links.ts), not the coupon-code pattern:
-- a coupon code is short and human-chosen so it needs a per-row salt, while 256 bits of randomness
-- has no dictionary to precompute AND has to be found from the value alone in one indexed lookup,
-- before anything knows which business is involved. A per-row salt would mean hashing against every
-- row in the table, which is both slow and a timing oracle.
--
-- Nothing in this table is customer data. It is metadata about a credential.
--
-- THE ACTIVE-KEY CEILING, AND WHY IT IS A SLOT
--
-- A business may hold at most MAX_ACTIVE_KEYS_PER_BUSINESS active keys. Expressing that as a count
-- inside a BEFORE INSERT trigger would NOT work, and migration 17 exists because that lesson was
-- learned the hard way: a trigger running SELECT count(*) reads only COMMITTED rows, so two
-- overlapping transactions each count 4, each pass, and each commit - six active keys.
--
-- So the ceiling is a SLOT NUMBER and a partial unique index:
--
--   activeSlot INTEGER, 1..N while ACTIVE, NULL otherwise
--   UNIQUE ("businessId", "activeSlot") WHERE "activeSlot" IS NOT NULL
--
-- PostgreSQL serializes a unique index. Two transactions racing for the same slot: one blocks on
-- the other's uncommitted index entry and is refused when it commits. There are exactly N slots, so
-- there can be at most N active keys, and that holds against a direct writer as well as the service.
--
-- STATE, AND WHY IT NEVER GRANTS
--
-- ACTIVE / EXPIRED / REVOKED. Authentication requires state = 'ACTIVE' AND "expiresAt" > now(), and
-- the second half is the authority: a key one second past its expiry is refused whether or not
-- anything has got round to flipping its state yet. EXPIRED is bookkeeping - it frees the slot so a
-- business whose keys have lapsed is not locked out of issuing new ones. REVOKED is a decision.
-- Both are terminal.

CREATE TYPE "ApiScope" AS ENUM ('EVENTS_READ');
CREATE TYPE "ApiKeyState" AS ENUM ('ACTIVE', 'EXPIRED', 'REVOKED');

CREATE TABLE "ApiKey" (
    "id"              TEXT NOT NULL,
    "businessId"      TEXT NOT NULL,
    "name"            TEXT NOT NULL,
    -- `wpk_<8 hex>`. Public, and deliberately NOT part of the secret: it exists so an owner can
    -- tell two keys apart in a list, and revealing it reveals nothing.
    "keyPrefix"       TEXT NOT NULL,
    -- sha256 hex of the whole key string. 64 characters, lower case, enforced below.
    "keyDigest"       TEXT NOT NULL,
    "scope"           "ApiScope" NOT NULL,
    "state"           "ApiKeyState" NOT NULL DEFAULT 'ACTIVE',
    "activeSlot"      INTEGER,
    "issuedAt"        TIMESTAMP(3) NOT NULL,
    "expiresAt"       TIMESTAMP(3) NOT NULL,
    "revokedAt"       TIMESTAMP(3),
    "lastUsedAt"      TIMESTAMP(3),
    "rotatedFromId"   TEXT,
    "createdByUserId" TEXT,
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApiKey_pkey" PRIMARY KEY ("id"),

    -- A digest, not a key. 64 lower-case hex characters is what sha256 produces; anything else in
    -- this column is something other than a digest, and the likeliest something else is the key.
    CONSTRAINT "ApiKey_keyDigest_is_sha256"
      CHECK ("keyDigest" ~ '^[0-9a-f]{64}$'),

    -- The public identifier, and nothing longer. A prefix that could hold 43 base64url characters
    -- could hold the secret.
    CONSTRAINT "ApiKey_keyPrefix_shape"
      CHECK ("keyPrefix" ~ '^wpk_[0-9a-f]{8}$'),

    CONSTRAINT "ApiKey_name_not_blank"
      CHECK (length(btrim("name")) BETWEEN 1 AND 60),

    -- A key that expires before it was issued is not a key.
    CONSTRAINT "ApiKey_expires_after_issue"
      CHECK ("expiresAt" > "issuedAt"),

    -- The slot is held by an ACTIVE key and by nothing else. This is what makes the partial unique
    -- index below a ceiling rather than a coincidence.
    CONSTRAINT "ApiKey_slot_iff_active"
      CHECK (
        ("state" = 'ACTIVE'  AND "activeSlot" IS NOT NULL AND "activeSlot" BETWEEN 1 AND 5)
        OR ("state" <> 'ACTIVE' AND "activeSlot" IS NULL)
      ),

    -- A revocation time exists exactly when the key is revoked.
    CONSTRAINT "ApiKey_revoked_at_iff_revoked"
      CHECK (("state" = 'REVOKED') = ("revokedAt" IS NOT NULL))
);

-- One indexed lookup, from the value alone, before anything knows the business.
CREATE UNIQUE INDEX "ApiKey_keyDigest_key" ON "ApiKey"("keyDigest");

-- THE CEILING. Five slots per business, so at most five active keys, enforced by PostgreSQL rather
-- than by a count somebody hopes is still true by the time the insert lands.
CREATE UNIQUE INDEX "ApiKey_businessId_activeSlot_key"
  ON "ApiKey"("businessId", "activeSlot")
  WHERE "activeSlot" IS NOT NULL;

-- An owner's own label is unique within their business, so two keys are never confusable.
CREATE UNIQUE INDEX "ApiKey_businessId_name_key" ON "ApiKey"("businessId", "name");

CREATE INDEX "ApiKey_businessId_state_idx" ON "ApiKey"("businessId", "state");

ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_createdByUserId_fkey"
  FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── What a key IS cannot change; only how it is going ────────────────────────

CREATE OR REPLACE FUNCTION walaaplus_api_key_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Server-assigned, like every other issue time in this product. A caller-chosen issue time is a
    -- caller-chosen answer to "how long has this credential been valid?".
    NEW."issuedAt" := (now() AT TIME ZONE 'UTC');

    -- A key begins usable and unused. One created already revoked, already expired, or with a
    -- last-used time would be a credential with a history nobody can account for.
    IF NEW."state" <> 'ACTIVE' THEN
      RAISE EXCEPTION 'ApiKey: a new key is active' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."revokedAt" IS NOT NULL OR NEW."lastUsedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'ApiKey: a new key has not been used or revoked' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."expiresAt" <= (now() AT TIME ZONE 'UTC') THEN
      RAISE EXCEPTION 'ApiKey: a new key expires in the future' USING ERRCODE = 'check_violation';
    END IF;

    -- Provenance, if this key replaced another: the predecessor must exist and belong to the same
    -- business. A rotation that pointed at somebody else's key would be a claim about their data.
    IF NEW."rotatedFromId" IS NOT NULL THEN
      IF NOT EXISTS (
        SELECT 1 FROM "ApiKey" p
         WHERE p."id" = NEW."rotatedFromId" AND p."businessId" = NEW."businessId"
      ) THEN
        RAISE EXCEPTION 'ApiKey: the rotated-from key does not belong to this business'
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  -- ── UPDATE ────────────────────────────────────────────────────────────────

  -- What the credential IS is frozen. Re-pointing a key at another business is the escalation this
  -- table exists to make impossible; changing its digest would silently replace the secret.
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."businessId" IS DISTINCT FROM OLD."businessId"
     OR NEW."keyDigest" IS DISTINCT FROM OLD."keyDigest"
     OR NEW."keyPrefix" IS DISTINCT FROM OLD."keyPrefix"
     OR NEW."scope" IS DISTINCT FROM OLD."scope"
     OR NEW."name" IS DISTINCT FROM OLD."name"
     OR NEW."issuedAt" IS DISTINCT FROM OLD."issuedAt"
     OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt"
     OR NEW."rotatedFromId" IS DISTINCT FROM OLD."rotatedFromId"
     OR NEW."createdByUserId" IS DISTINCT FROM OLD."createdByUserId"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
  THEN
    RAISE EXCEPTION 'ApiKey: what a key is cannot change, only how it is going'
      USING ERRCODE = 'check_violation';
  END IF;

  -- ACTIVE may become EXPIRED or REVOKED. Both are terminal: a revoked key is never un-revoked,
  -- and an expired one never becomes valid again. Rotation issues a NEW key; it does not revive one.
  IF OLD."state" <> 'ACTIVE' AND NEW."state" IS DISTINCT FROM OLD."state" THEN
    RAISE EXCEPTION 'ApiKey: % is a rest state', OLD."state" USING ERRCODE = 'check_violation';
  END IF;

  -- Revocation happens once, and stamps its own time.
  IF NEW."state" = 'REVOKED' AND OLD."state" <> 'REVOKED' THEN
    NEW."revokedAt" := (now() AT TIME ZONE 'UTC');
  END IF;
  IF OLD."revokedAt" IS NOT NULL AND NEW."revokedAt" IS DISTINCT FROM OLD."revokedAt" THEN
    RAISE EXCEPTION 'ApiKey: a revocation time is written once' USING ERRCODE = 'check_violation';
  END IF;

  -- A key that leaves ACTIVE releases its slot; one that stays ACTIVE keeps the slot it had.
  IF NEW."state" <> 'ACTIVE' AND NEW."activeSlot" IS NOT NULL THEN
    RAISE EXCEPTION 'ApiKey: a key that is not active holds no slot' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."state" = 'ACTIVE' AND NEW."activeSlot" IS DISTINCT FROM OLD."activeSlot" THEN
    RAISE EXCEPTION 'ApiKey: an active key keeps the slot it was issued' USING ERRCODE = 'check_violation';
  END IF;

  /*
   * `lastUsedAt` moves FORWARD only.
   *
   * It is the one column a request may write, and it is the one an attacker would want to move
   * backwards - a key used minutes ago that appears unused for a month is a key an owner leaves
   * alone. Monotonic means the record of use can only ever understate how recently it happened.
   */
  IF NEW."lastUsedAt" IS DISTINCT FROM OLD."lastUsedAt" THEN
    IF NEW."lastUsedAt" IS NULL THEN
      RAISE EXCEPTION 'ApiKey: a use is never unrecorded' USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."lastUsedAt" IS NOT NULL AND NEW."lastUsedAt" < OLD."lastUsedAt" THEN
      RAISE EXCEPTION 'ApiKey: last use moves forward only' USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER api_key_guard
  BEFORE INSERT OR UPDATE ON "ApiKey"
  FOR EACH ROW EXECUTE FUNCTION walaaplus_api_key_guard();

-- ── Never removed ───────────────────────────────────────────────────────────
--
-- A key row is the record that a business held a credential between two dates. Deleting one erases
-- that; revoking one ends it and keeps it. The retention period, and what happens to the record
-- when a business closes, is an open owner decision (D31) and is deliberately not guessed here.

CREATE OR REPLACE FUNCTION walaaplus_reject_api_key_removal() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ApiKey is never removed; % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation',
          HINT = 'Revoke the key. The row is the record that it existed.';
END
$$;

CREATE TRIGGER api_key_no_delete
  BEFORE DELETE ON "ApiKey"
  FOR EACH ROW EXECUTE FUNCTION walaaplus_reject_api_key_removal();

CREATE TRIGGER api_key_no_truncate
  BEFORE TRUNCATE ON "ApiKey"
  FOR EACH STATEMENT EXECUTE FUNCTION walaaplus_reject_api_key_removal();
