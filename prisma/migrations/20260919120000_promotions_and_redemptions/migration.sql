-- Phase 3A Prompt 3 — a coupon a member of staff types, and an entitlement a human hands over.
--
-- ONE additive migration. Three enums, two tables, five triggers. Nothing existing is changed,
-- dropped or backfilled.
--
-- ## What this is, and the exclusion that defines it
--
-- A redemption row says: **this customer is entitled to something, and a person will hand it over.**
-- There is no amount, percentage, currency, tax line, invoice, total, point or stamp anywhere in
-- either table, and no code path that touches a balance. The moment one appeared, this would be
-- payment processing with a coupon on the front, which is what `docs/PROMOTIONS-CAPABILITY-MATRIX.md`
-- was written to prevent rather than to describe afterwards.
--
-- ## The code is never stored
--
-- Only `codeDigest` = sha256(salt ‖ businessId ‖ normalised code), with a random 32-byte
-- `codeSalt` per promotion.
--
-- The salt is the load-bearing part, and the reason is worth stating because it differs from
-- `CardShareLink`. That table hashes a 32-byte random capability, where a plain digest is safe —
-- there is no dictionary to precompute. A coupon code is short, typed by a human and often a word:
-- an unsalted digest of `AUTUMN10` is a lookup, not a search. A per-promotion salt makes a stolen
-- database worth one offline attack per promotion instead of one for all of them.
--
-- A keyed HMAC would be stronger still, and needs a secret this phase may not introduce. So the salt
-- is the honest ceiling here, and it is written down rather than glossed.
--
-- Lookup is therefore tenant-scoped and per-candidate: the caller's own live promotions are read
-- (bounded by a per-business cap) and compared by digest. That is the cost of a salt, and at a few
-- dozen promotions it is nothing.
--
-- ## Two tables, two different mutabilities, both argued
--
-- `Promotion` is a definition with a LIFECYCLE, so UPDATE is unavoidable — a paused promotion is the
-- same promotion. It is `NO_DELETE`: the runtime role holds SELECT, INSERT and UPDATE, never DELETE
-- or TRUNCATE, and a trigger freezes the identity of the row (business, code digest, salt, creator,
-- creation time) while permitting only legal state transitions.
--
-- `PromotionRedemption` is a record of something that happened, so it is APPEND-ONLY. Voiding writes
-- a second row, as `CampaignApproval` and `ReferralAttribution` do.
--
-- ## One deliberate difference from ReferralAttribution
--
-- There, voiding does NOT free the slot: re-attributing afterwards would be retrospective
-- attribution. Here, voiding DOES free it. A voided redemption means "that did not happen", and a
-- customer whose coupon was redeemed by mistake should be able to use it. Two tables, two meanings,
-- both written down so neither is inferred from the other.

-- ── Enums ────────────────────────────────────────────────────────────────────

-- DRAFT     being written; not redeemable
-- ACTIVE    the only state a code redeems in
-- PAUSED    temporarily off, and reversible
-- EXPIRED   terminal. A promotion ends here and never comes back; a merchant who wants it again
--           makes a new one, because reviving an expired promotion silently re-honours every code
--           already out in the world.
CREATE TYPE "PromotionState" AS ENUM ('DRAFT', 'ACTIVE', 'PAUSED', 'EXPIRED');

-- What a redemption row asserts.
CREATE TYPE "RedemptionEntry" AS ENUM ('REDEEMED', 'VOIDED');

-- How the code reached the counter. One value, because one flow exists: a member of staff typed it.
-- There is deliberately no PUBLIC_CLAIM, no SELF_SERVICE, no QR and no IMPORT — each would be a
-- route that does not exist, named in a schema as though it might.
CREATE TYPE "RedemptionMethod" AS ENUM ('COUNTER_TYPED_CODE');

-- ── The promotion ────────────────────────────────────────────────────────────

CREATE TABLE "Promotion" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    -- What a merchant calls it. Shown on their own screens; never on a customer surface.
    "name" TEXT NOT NULL,
    -- Lower-cased, whitespace-collapsed. Unique per business, so a merchant cannot create two
    -- promotions they cannot tell apart on their own list.
    "normalizedName" TEXT NOT NULL,
    -- What the customer gets, in the merchant's own words: "a free espresso", "10% off a bag of
    -- beans". **A sentence, not a calculation.** Nothing parses it, nothing computes from it, and
    -- nothing in this product turns it into money.
    "benefitDescription" TEXT NOT NULL,
    -- sha256(salt ‖ businessId ‖ normalised code), lower-case hex. The raw code is never stored.
    "codeDigest" TEXT NOT NULL,
    -- 32 random bytes, base64url. Frozen at insert with everything else that identifies the row.
    "codeSalt" TEXT NOT NULL,
    "state" "PromotionState" NOT NULL DEFAULT 'DRAFT',
    -- Optional window. Null means "no bound on that side", not "unbounded promotion".
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    -- Optional limits. Null means no limit; a positive integer is a ceiling counted over redemptions
    -- that have not been voided.
    "totalLimit" INTEGER,
    "perCustomerLimit" INTEGER,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Promotion_pkey" PRIMARY KEY ("id"),
    -- A limit of zero is not a limit, it is a closed promotion wearing one. Pause it instead.
    CONSTRAINT "Promotion_totalLimit_positive" CHECK ("totalLimit" IS NULL OR "totalLimit" > 0),
    CONSTRAINT "Promotion_perCustomerLimit_positive" CHECK ("perCustomerLimit" IS NULL OR "perCustomerLimit" > 0),
    -- A window that ends before it starts is a promotion nobody can ever use.
    CONSTRAINT "Promotion_window_ordered" CHECK ("startsAt" IS NULL OR "endsAt" IS NULL OR "startsAt" < "endsAt")
);

CREATE UNIQUE INDEX "Promotion_businessId_normalizedName_key" ON "Promotion"("businessId", "normalizedName");
-- One code, one answer. Tenant-scoped so two businesses may both use AUTUMN10 without colliding —
-- which they will, and which is none of each other's business.
CREATE UNIQUE INDEX "Promotion_businessId_codeDigest_key" ON "Promotion"("businessId", "codeDigest");
CREATE INDEX "Promotion_businessId_state_idx" ON "Promotion"("businessId", "state");

ALTER TABLE "Promotion" ADD CONSTRAINT "Promotion_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Promotion" ADD CONSTRAINT "Promotion_createdByUserId_fkey"
  FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── The redemption ───────────────────────────────────────────────────────────

-- APPEND-ONLY. One row per entitlement, and one more per withdrawal of one.
CREATE TABLE "PromotionRedemption" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "promotionId" TEXT NOT NULL,
    "entry" "RedemptionEntry" NOT NULL,
    "customerCardId" TEXT NOT NULL,
    "customerBusinessProfileId" TEXT NOT NULL,
    "method" "RedemptionMethod" NOT NULL,
    -- Set on a VOIDED row: which redemption it withdraws. Null on a REDEEMED row.
    "voidsRedemptionId" TEXT,
    -- Free text from whoever voided one. Never a code, a phone number or a name.
    "reason" TEXT,
    "recordedAt" TIMESTAMP(3) NOT NULL,
    "recordedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PromotionRedemption_pkey" PRIMARY KEY ("id")
);

-- One void per redemption. A second withdrawal of the same row would be a second opinion about a
-- fact, which is not a thing.
CREATE UNIQUE INDEX "PromotionRedemption_voids_key"
  ON "PromotionRedemption"("voidsRedemptionId")
  WHERE "voidsRedemptionId" IS NOT NULL;

-- The two questions the limits ask, and the only two this table is indexed for. There is no index
-- supporting "who redeemed what across the business", because no such screen exists.
CREATE INDEX "PromotionRedemption_promotionId_entry_idx" ON "PromotionRedemption"("promotionId", "entry");
CREATE INDEX "PromotionRedemption_promotionId_customerBusinessProfileId_idx"
  ON "PromotionRedemption"("promotionId", "customerBusinessProfileId");
CREATE INDEX "PromotionRedemption_businessId_recordedAt_idx" ON "PromotionRedemption"("businessId", "recordedAt" DESC);

ALTER TABLE "PromotionRedemption" ADD CONSTRAINT "PromotionRedemption_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PromotionRedemption" ADD CONSTRAINT "PromotionRedemption_promotionId_fkey"
  FOREIGN KEY ("promotionId") REFERENCES "Promotion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PromotionRedemption" ADD CONSTRAINT "PromotionRedemption_customerCardId_fkey"
  FOREIGN KEY ("customerCardId") REFERENCES "CustomerCard"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PromotionRedemption" ADD CONSTRAINT "PromotionRedemption_customerBusinessProfileId_fkey"
  FOREIGN KEY ("customerBusinessProfileId") REFERENCES "CustomerBusinessProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PromotionRedemption" ADD CONSTRAINT "PromotionRedemption_voidsRedemptionId_fkey"
  FOREIGN KEY ("voidsRedemptionId") REFERENCES "PromotionRedemption"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PromotionRedemption" ADD CONSTRAINT "PromotionRedemption_recordedByUserId_fkey"
  FOREIGN KEY ("recordedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── Promotion: no removal, and only a legal change ───────────────────────────

CREATE OR REPLACE FUNCTION walaaplus_promotion_no_removal() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Promotion is never removed; % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation',
          HINT = 'Expire the promotion. Codes already handed out are part of the record.';
END
$$;

CREATE TRIGGER promotion_no_delete
  BEFORE DELETE ON "Promotion"
  FOR EACH ROW EXECUTE FUNCTION walaaplus_promotion_no_removal();

CREATE TRIGGER promotion_no_truncate
  BEFORE TRUNCATE ON "Promotion"
  FOR EACH STATEMENT EXECUTE FUNCTION walaaplus_promotion_no_removal();

CREATE OR REPLACE FUNCTION walaaplus_promotion_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- A promotion is born as a draft. Creating one already ACTIVE would skip the only moment a
    -- merchant reads back what they typed before a code goes out.
    IF NEW."state" <> 'DRAFT' THEN
      RAISE EXCEPTION 'Promotion: a new promotion starts as a draft'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  -- What a promotion IS cannot change. Only what it is currently doing.
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."businessId" IS DISTINCT FROM OLD."businessId"
     OR NEW."codeDigest" IS DISTINCT FROM OLD."codeDigest"
     OR NEW."codeSalt" IS DISTINCT FROM OLD."codeSalt"
     OR NEW."createdByUserId" IS DISTINCT FROM OLD."createdByUserId"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
  THEN
    RAISE EXCEPTION 'Promotion: the code and the identity of a promotion are frozen'
      USING ERRCODE = 'check_violation',
            HINT = 'Expire this promotion and create another; every code already printed still names this one.';
  END IF;

  -- The lifecycle, as a table rather than as scattered conditions.
  --   DRAFT   → ACTIVE | EXPIRED
  --   ACTIVE  → PAUSED | EXPIRED
  --   PAUSED  → ACTIVE | EXPIRED
  --   EXPIRED → nothing. Terminal, so a code that stopped working never starts again.
  IF NEW."state" IS DISTINCT FROM OLD."state" THEN
    IF NOT (
         (OLD."state" = 'DRAFT'  AND NEW."state" IN ('ACTIVE', 'EXPIRED'))
      OR (OLD."state" = 'ACTIVE' AND NEW."state" IN ('PAUSED', 'EXPIRED'))
      OR (OLD."state" = 'PAUSED' AND NEW."state" IN ('ACTIVE', 'EXPIRED'))
    ) THEN
      RAISE EXCEPTION 'Promotion: % cannot become %', OLD."state", NEW."state"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- An expired promotion is finished, including its settings. Editing the window or the limits of
  -- one would change what a closed record says happened.
  IF OLD."state" = 'EXPIRED' AND (
       NEW."name" IS DISTINCT FROM OLD."name"
    OR NEW."benefitDescription" IS DISTINCT FROM OLD."benefitDescription"
    OR NEW."startsAt" IS DISTINCT FROM OLD."startsAt"
    OR NEW."endsAt" IS DISTINCT FROM OLD."endsAt"
    OR NEW."totalLimit" IS DISTINCT FROM OLD."totalLimit"
    OR NEW."perCustomerLimit" IS DISTINCT FROM OLD."perCustomerLimit"
  ) THEN
    RAISE EXCEPTION 'Promotion: an expired promotion cannot be edited'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER promotion_guard
  BEFORE INSERT OR UPDATE ON "Promotion"
  FOR EACH ROW EXECUTE FUNCTION walaaplus_promotion_guard();

-- ── Redemption: append-only ──────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION walaaplus_reject_redemption_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'PromotionRedemption is append-only; % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation',
          HINT = 'Record a void entry instead of editing or removing a redemption.';
END
$$;

CREATE TRIGGER promotion_redemption_append_only
  BEFORE UPDATE OR DELETE ON "PromotionRedemption"
  FOR EACH ROW EXECUTE FUNCTION walaaplus_reject_redemption_mutation();

CREATE TRIGGER promotion_redemption_no_truncate
  BEFORE TRUNCATE ON "PromotionRedemption"
  FOR EACH STATEMENT EXECUTE FUNCTION walaaplus_reject_redemption_mutation();

-- ── Redemption: every row has to make sense before it is written ─────────────
--
-- Foreign keys check that each id EXISTS. Nothing in a foreign key checks that they AGREE, that a
-- promotion was redeemable at the moment it was redeemed, or that a limit was respected. The service
-- checks all of it; this is here because a guarantee that lives in one service ends the first time
-- somebody writes a second one, a backfill script, or a console session.
--
-- Counting inside a BEFORE INSERT trigger is safe because the service takes a row lock on the
-- promotion first, so concurrent redemptions of the same promotion are serialised and this count
-- cannot be stale. A caller that skips the lock races with itself and gets a limit enforced at the
-- last honest moment rather than not at all.

CREATE OR REPLACE FUNCTION walaaplus_validate_redemption() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  promo        "Promotion"%ROWTYPE;
  card_business TEXT;
  card_profile  TEXT;
  profile_business TEXT;
  used_total   INTEGER;
  used_customer INTEGER;
  target       "PromotionRedemption"%ROWTYPE;
BEGIN
  SELECT * INTO promo FROM "Promotion" WHERE "id" = NEW."promotionId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PromotionRedemption: the promotion does not exist' USING ERRCODE = 'check_violation';
  END IF;
  IF promo."businessId" IS DISTINCT FROM NEW."businessId" THEN
    RAISE EXCEPTION 'PromotionRedemption: the promotion belongs to a different business'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT "businessId", "customerBusinessProfileId" INTO card_business, card_profile
    FROM "CustomerCard" WHERE "id" = NEW."customerCardId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PromotionRedemption: the card does not exist' USING ERRCODE = 'check_violation';
  END IF;
  IF card_business IS DISTINCT FROM NEW."businessId" THEN
    RAISE EXCEPTION 'PromotionRedemption: the card belongs to a different business'
      USING ERRCODE = 'check_violation';
  END IF;
  IF card_profile IS DISTINCT FROM NEW."customerBusinessProfileId" THEN
    RAISE EXCEPTION 'PromotionRedemption: the card belongs to a different customer'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT "businessId" INTO profile_business
    FROM "CustomerBusinessProfile" WHERE "id" = NEW."customerBusinessProfileId";
  IF profile_business IS DISTINCT FROM NEW."businessId" THEN
    RAISE EXCEPTION 'PromotionRedemption: the customer belongs to a different business'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."entry" = 'REDEEMED' THEN
    IF NEW."voidsRedemptionId" IS NOT NULL THEN
      RAISE EXCEPTION 'PromotionRedemption: a REDEEMED row voids nothing' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."reason" IS NOT NULL THEN
      RAISE EXCEPTION 'PromotionRedemption: a REDEEMED row carries no void reason' USING ERRCODE = 'check_violation';
    END IF;

    -- Only an ACTIVE promotion redeems. A draft has not been published, a paused one has been
    -- switched off on purpose, and an expired one is finished.
    IF promo."state" <> 'ACTIVE' THEN
      RAISE EXCEPTION 'PromotionRedemption: the promotion is not active' USING ERRCODE = 'check_violation';
    END IF;
    IF promo."startsAt" IS NOT NULL AND NEW."recordedAt" < promo."startsAt" THEN
      RAISE EXCEPTION 'PromotionRedemption: the promotion has not started' USING ERRCODE = 'check_violation';
    END IF;
    IF promo."endsAt" IS NOT NULL AND NEW."recordedAt" >= promo."endsAt" THEN
      RAISE EXCEPTION 'PromotionRedemption: the promotion has ended' USING ERRCODE = 'check_violation';
    END IF;

    /*
     * Limits, counted over redemptions that have NOT been voided.
     *
     * A void here means "that did not happen", so it frees the slot and the customer can use their
     * coupon. That is the opposite of ReferralAttribution, where voiding does not free a slot
     * because re-attributing would be retrospective. Two tables, two meanings, both deliberate.
     */
    IF promo."totalLimit" IS NOT NULL THEN
      SELECT count(*) INTO used_total FROM "PromotionRedemption" r
       WHERE r."promotionId" = NEW."promotionId" AND r."entry" = 'REDEEMED'
         AND NOT EXISTS (SELECT 1 FROM "PromotionRedemption" v WHERE v."voidsRedemptionId" = r."id");
      IF used_total >= promo."totalLimit" THEN
        RAISE EXCEPTION 'PromotionRedemption: the promotion is fully redeemed' USING ERRCODE = 'check_violation';
      END IF;
    END IF;

    IF promo."perCustomerLimit" IS NOT NULL THEN
      SELECT count(*) INTO used_customer FROM "PromotionRedemption" r
       WHERE r."promotionId" = NEW."promotionId"
         AND r."customerBusinessProfileId" = NEW."customerBusinessProfileId"
         AND r."entry" = 'REDEEMED'
         AND NOT EXISTS (SELECT 1 FROM "PromotionRedemption" v WHERE v."voidsRedemptionId" = r."id");
      IF used_customer >= promo."perCustomerLimit" THEN
        RAISE EXCEPTION 'PromotionRedemption: this customer has used this promotion already'
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;

  IF NEW."entry" = 'VOIDED' THEN
    IF NEW."voidsRedemptionId" IS NULL THEN
      RAISE EXCEPTION 'PromotionRedemption: a VOIDED row must name the redemption it withdraws'
        USING ERRCODE = 'check_violation';
    END IF;

    SELECT * INTO target FROM "PromotionRedemption" WHERE "id" = NEW."voidsRedemptionId";
    IF NOT FOUND THEN
      RAISE EXCEPTION 'PromotionRedemption: the redemption being withdrawn does not exist'
        USING ERRCODE = 'check_violation';
    END IF;
    IF target."entry" <> 'REDEEMED' THEN
      RAISE EXCEPTION 'PromotionRedemption: only a REDEEMED row can be withdrawn' USING ERRCODE = 'check_violation';
    END IF;
    IF target."businessId" IS DISTINCT FROM NEW."businessId" THEN
      RAISE EXCEPTION 'PromotionRedemption: cannot withdraw another business''s redemption'
        USING ERRCODE = 'check_violation';
    END IF;
    IF target."promotionId" IS DISTINCT FROM NEW."promotionId"
       OR target."customerCardId" IS DISTINCT FROM NEW."customerCardId"
       OR target."customerBusinessProfileId" IS DISTINCT FROM NEW."customerBusinessProfileId"
       OR target."method" IS DISTINCT FROM NEW."method"
    THEN
      RAISE EXCEPTION 'PromotionRedemption: a VOIDED row must repeat the redemption it withdraws, exactly'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER promotion_redemption_validate
  BEFORE INSERT ON "PromotionRedemption"
  FOR EACH ROW EXECUTE FUNCTION walaaplus_validate_redemption();
