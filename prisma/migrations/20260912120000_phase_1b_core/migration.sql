-- Phase 1b Prompt 1 — indexes for the paths this phase makes hot, and one new invariant.
--
-- Nothing here changes a column, a type or a row. Every statement is additive, so an old build and
-- a new build can both run against a database in either state — which is what makes it safe to
-- apply before the deploy rather than in lockstep with it.

-- ── 1. Phase 1a findings M-4 and M-5, now on real paths ──────────────────────
--
-- M-4: the scanner's phone lookup walks Customer -> CustomerBusinessProfile by customerId, and
-- there was no index on that column, so every counter lookup sequential-scanned the profile table.
-- It was sub-millisecond at a few thousand profiles and it is a first-class counter path.
CREATE INDEX IF NOT EXISTS "CustomerBusinessProfile_customerId_idx"
  ON "CustomerBusinessProfile"("customerId");

-- M-5: the customer list pages with WHERE "businessId" = $1 ORDER BY "id", which without this
-- degrades to an index scan plus a sort on every page as the number of tenants grows.
CREATE INDEX IF NOT EXISTS "CustomerBusinessProfile_businessId_id_idx"
  ON "CustomerBusinessProfile"("businessId", "id");

-- ── 2. The dashboard read models (Phase 1b Prompt 1) ─────────────────────────
--
-- Every metric is derived from the ledger over a date range, and the breakdowns group by template
-- and by location. (businessId, createdAt) already exists and drives the range; these two make the
-- per-program and per-card-issuance reads index-only rather than a filter over the whole range.
CREATE INDEX IF NOT EXISTS "LoyaltyOperation_businessId_templateId_createdAt_idx"
  ON "LoyaltyOperation"("businessId", "templateId", "createdAt");

CREATE INDEX IF NOT EXISTS "CustomerCard_businessId_issuedAt_idx"
  ON "CustomerCard"("businessId", "issuedAt");

-- ── 3. Reward tier names are unique within a version ─────────────────────────
--
-- A points program offers several rewards and the customer picks one by name. Two tiers called
-- "Free coffee" in one version make that a guess, and make a redemption record ambiguous to read
-- back later. The service already refuses it; this is the constraint underneath, so a future caller
-- that does not go through the service cannot create one either.
--
-- Safe on existing data: Phase 1a creates exactly one tier per version.
CREATE UNIQUE INDEX IF NOT EXISTS "RewardTier_programVersionId_name_key"
  ON "RewardTier"("programVersionId", "name");
