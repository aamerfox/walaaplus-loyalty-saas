-- Phase 3A Prompt 2 — recording that a customer arrived with an invitation, and nothing else.
--
-- ONE additive migration. Two enums, one table, three triggers. No existing column is changed, no
-- existing row is written, nothing is dropped and nothing is backfilled — every customer enrolled
-- before this migration has no attribution and never will, because inventing one retrospectively is
-- exactly the thing this table exists to refuse.
--
-- ## What this records, and what it deliberately is not
--
-- One row: "this newly issued card was enrolled at a counter where a staff member saw a valid
-- invitation from that link". That is an ATTRIBUTION and not a reward. There is no amount, no
-- currency, no points, no expiry, no eligibility flag and no campaign reference, because no referral
-- reward policy exists (D15) and a column added now in anticipation of one would be a policy nobody
-- decided, written in a schema.
--
-- ## Internal ids only
--
-- The referring side is a `CardShareLink` id — never the capability that was presented, and never
-- its digest. The raw value is resolved in one request and discarded; nothing in this table, in any
-- audit row, or in any log can be used to reconstruct it or to confirm a guess at it.
--
-- No customer name, phone, card serial, balance, referral URL or monetary value is copied here
-- either. Everything a reader could legitimately need is reachable by joining, under the
-- authorization that governs those tables — which is the point of storing a reference rather than a
-- copy.
--
-- ## Every row has to make sense before it is written
--
-- Append-only protects history from being rewritten. It does nothing about a row that was wrong the
-- moment it was inserted — a void pointing at another void, an attribution carrying a withdrawal
-- reason, or a link, card and profile that belong to three different businesses. Foreign keys check
-- that each id EXISTS; nothing in a foreign key checks that they AGREE.
--
-- So `referral_attribution_validate` runs BEFORE INSERT and refuses a row whose parts contradict
-- each other. The service already declines to build such a row, and that is exactly why the trigger
-- matters: a guarantee that lives only in one service is a guarantee that ends the first time
-- somebody writes a second one, a backfill script, or a console session.
--
-- ## Append-only, with voiding as a second row
--
-- The same shape `CampaignApproval` uses, for the same reason: a record of what somebody decided is
-- worthless if it can be edited afterwards. An `ATTRIBUTED` row is never modified. Voiding one
-- writes a `VOIDED` row that points at it, and the effective status is derived from the pair.
--
-- That differs from `CardShareLink`, which permits one narrow UPDATE — and the difference is
-- deliberate. Revoking a capability has to change the thing that is looked up. Voiding an
-- attribution changes only what a reader concludes, so nothing needs to be mutable.

-- How the invitation reached the counter. One value, because one flow exists: a member of staff
-- saw it on the customer's phone. There is deliberately no SELF_SERVICE, no PUBLIC_CLAIM and no
-- IMPORT — each would be a route that does not exist, named in a schema as though it might.
CREATE TYPE "ReferralMethod" AS ENUM ('COUNTER_PRESENTED_INVITATION');

-- What a row asserts. `ATTRIBUTED` is the record; `VOIDED` is a later row withdrawing one.
CREATE TYPE "ReferralEntry" AS ENUM ('ATTRIBUTED', 'VOIDED');

CREATE TABLE "ReferralAttribution" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "entry" "ReferralEntry" NOT NULL,
    -- The invitation that was presented, by row id. Never the capability, never its digest.
    "referringShareLinkId" TEXT NOT NULL,
    -- The card that invitation belongs to. Denormalised from the link so the self-referral check and
    -- the integrity rules read one row, and so a later link revocation cannot change what this row
    -- says happened.
    "referringCustomerCardId" TEXT NOT NULL,
    -- The newly issued card, and the profile behind it. Both are internal ids.
    "enrolledCustomerCardId" TEXT NOT NULL,
    "enrolledProfileId" TEXT NOT NULL,
    "method" "ReferralMethod" NOT NULL,
    -- Set on a VOIDED row: which attribution it withdraws. Null on an ATTRIBUTED row.
    "voidsAttributionId" TEXT,
    -- Free text from the member of staff who voided one. Never a phone number, never a name: the
    -- service caps it and no audit row repeats it.
    "reason" TEXT,
    "recordedAt" TIMESTAMP(3) NOT NULL,
    "recordedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReferralAttribution_pkey" PRIMARY KEY ("id")
);

-- **One attribution per newly enrolled card, ever.** Partial, so a VOIDED row does not occupy the
-- slot — and note what that means: voiding does NOT free a card to be attributed again, because the
-- ATTRIBUTED row it withdrew is still there. That is intentional. Re-attributing a card after the
-- fact is retrospective attribution, which this phase refuses to invent.
CREATE UNIQUE INDEX "ReferralAttribution_enrolledCard_key"
  ON "ReferralAttribution"("enrolledCustomerCardId")
  WHERE "entry" = 'ATTRIBUTED';

-- One void per attribution. A second withdrawal of the same row would be a second opinion about a
-- fact, which is not a thing.
CREATE UNIQUE INDEX "ReferralAttribution_voids_key"
  ON "ReferralAttribution"("voidsAttributionId")
  WHERE "voidsAttributionId" IS NOT NULL;

-- The owner-facing count: attributions for one business over a period. Aggregate only — there is no
-- index here supporting "list who referred whom", because no such screen exists.
CREATE INDEX "ReferralAttribution_businessId_recordedAt_idx"
  ON "ReferralAttribution"("businessId", "recordedAt" DESC);
CREATE INDEX "ReferralAttribution_referringShareLinkId_idx"
  ON "ReferralAttribution"("referringShareLinkId");

ALTER TABLE "ReferralAttribution" ADD CONSTRAINT "ReferralAttribution_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ReferralAttribution" ADD CONSTRAINT "ReferralAttribution_referringShareLinkId_fkey"
  FOREIGN KEY ("referringShareLinkId") REFERENCES "CardShareLink"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ReferralAttribution" ADD CONSTRAINT "ReferralAttribution_referringCustomerCardId_fkey"
  FOREIGN KEY ("referringCustomerCardId") REFERENCES "CustomerCard"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ReferralAttribution" ADD CONSTRAINT "ReferralAttribution_enrolledCustomerCardId_fkey"
  FOREIGN KEY ("enrolledCustomerCardId") REFERENCES "CustomerCard"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ReferralAttribution" ADD CONSTRAINT "ReferralAttribution_enrolledProfileId_fkey"
  FOREIGN KEY ("enrolledProfileId") REFERENCES "CustomerBusinessProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ReferralAttribution" ADD CONSTRAINT "ReferralAttribution_voidsAttributionId_fkey"
  FOREIGN KEY ("voidsAttributionId") REFERENCES "ReferralAttribution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ReferralAttribution" ADD CONSTRAINT "ReferralAttribution_recordedByUserId_fkey"
  FOREIGN KEY ("recordedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── Append-only enforcement ──────────────────────────────────────────────────
--
-- Second line of defence. `scripts/db-roles.mjs` lists this table under APPEND_ONLY_TABLES, so the
-- runtime role holds only SELECT and INSERT and is refused on privilege before a trigger runs.

CREATE OR REPLACE FUNCTION walaaplus_reject_referral_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ReferralAttribution is append-only; % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation',
          HINT = 'Record a void entry instead of editing or removing an attribution.';
END
$$;

CREATE TRIGGER referral_attribution_append_only
  BEFORE UPDATE OR DELETE ON "ReferralAttribution"
  FOR EACH ROW EXECUTE FUNCTION walaaplus_reject_referral_mutation();

CREATE TRIGGER referral_attribution_no_truncate
  BEFORE TRUNCATE ON "ReferralAttribution"
  FOR EACH STATEMENT EXECUTE FUNCTION walaaplus_reject_referral_mutation();

-- ── Row-level validation ─────────────────────────────────────────────────────
--
-- BEFORE INSERT only. UPDATE and DELETE are already refused outright, so an inserted row is the only
-- row there will ever be and validating it once is validating it forever.
--
-- Every failure raises `check_violation` (23514) with a message naming the rule, because a
-- constraint that fires with "new row violates constraint" tells whoever hits it nothing about what
-- they got wrong.

CREATE OR REPLACE FUNCTION walaaplus_validate_referral_attribution() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  link_business   TEXT;
  link_card       TEXT;
  ref_business    TEXT;
  enr_business    TEXT;
  enr_profile     TEXT;
  profile_business TEXT;
  target          "ReferralAttribution"%ROWTYPE;
BEGIN
  -- 1. The referring side agrees with itself: the link belongs to this business AND to the card
  --    this row names, and that card belongs to this business too.
  SELECT "businessId", "customerCardId" INTO link_business, link_card
    FROM "CardShareLink" WHERE "id" = NEW."referringShareLinkId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ReferralAttribution: referring share link does not exist'
      USING ERRCODE = 'check_violation';
  END IF;
  IF link_business IS DISTINCT FROM NEW."businessId" THEN
    RAISE EXCEPTION 'ReferralAttribution: the share link belongs to a different business'
      USING ERRCODE = 'check_violation';
  END IF;
  IF link_card IS DISTINCT FROM NEW."referringCustomerCardId" THEN
    RAISE EXCEPTION 'ReferralAttribution: the share link belongs to a different card'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT "businessId" INTO ref_business FROM "CustomerCard" WHERE "id" = NEW."referringCustomerCardId";
  IF ref_business IS DISTINCT FROM NEW."businessId" THEN
    RAISE EXCEPTION 'ReferralAttribution: the referring card belongs to a different business'
      USING ERRCODE = 'check_violation';
  END IF;

  -- 2. The enrolled side agrees with itself: the card belongs to this business AND to the profile
  --    this row names, and that profile belongs to this business too.
  SELECT "businessId", "customerBusinessProfileId" INTO enr_business, enr_profile
    FROM "CustomerCard" WHERE "id" = NEW."enrolledCustomerCardId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ReferralAttribution: enrolled card does not exist'
      USING ERRCODE = 'check_violation';
  END IF;
  IF enr_business IS DISTINCT FROM NEW."businessId" THEN
    RAISE EXCEPTION 'ReferralAttribution: the enrolled card belongs to a different business'
      USING ERRCODE = 'check_violation';
  END IF;
  IF enr_profile IS DISTINCT FROM NEW."enrolledProfileId" THEN
    RAISE EXCEPTION 'ReferralAttribution: the enrolled card belongs to a different profile'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT "businessId" INTO profile_business
    FROM "CustomerBusinessProfile" WHERE "id" = NEW."enrolledProfileId";
  IF profile_business IS DISTINCT FROM NEW."businessId" THEN
    RAISE EXCEPTION 'ReferralAttribution: the enrolled profile belongs to a different business'
      USING ERRCODE = 'check_violation';
  END IF;

  -- 3. An ATTRIBUTED row is a record of an arrival. It withdraws nothing, so it points at nothing
  --    and explains nothing: a reason on one would be a withdrawal note attached to a record that
  --    was never withdrawn.
  IF NEW."entry" = 'ATTRIBUTED' THEN
    IF NEW."voidsAttributionId" IS NOT NULL THEN
      RAISE EXCEPTION 'ReferralAttribution: an ATTRIBUTED row voids nothing'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."reason" IS NOT NULL THEN
      RAISE EXCEPTION 'ReferralAttribution: an ATTRIBUTED row carries no void reason'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- 4. A VOIDED row is a withdrawal OF something, and it has to be a complete, faithful account of
  --    the row it withdraws. Copying the fields rather than joining for them is what lets one row be
  --    read on its own; this is what makes the copy true.
  IF NEW."entry" = 'VOIDED' THEN
    IF NEW."voidsAttributionId" IS NULL THEN
      RAISE EXCEPTION 'ReferralAttribution: a VOIDED row must name the attribution it withdraws'
        USING ERRCODE = 'check_violation';
    END IF;

    SELECT * INTO target FROM "ReferralAttribution" WHERE "id" = NEW."voidsAttributionId";
    IF NOT FOUND THEN
      RAISE EXCEPTION 'ReferralAttribution: the attribution being withdrawn does not exist'
        USING ERRCODE = 'check_violation';
    END IF;
    IF target."entry" <> 'ATTRIBUTED' THEN
      RAISE EXCEPTION 'ReferralAttribution: only an ATTRIBUTED row can be withdrawn'
        USING ERRCODE = 'check_violation';
    END IF;
    IF target."businessId" IS DISTINCT FROM NEW."businessId" THEN
      RAISE EXCEPTION 'ReferralAttribution: cannot withdraw another business''s attribution'
        USING ERRCODE = 'check_violation';
    END IF;
    IF target."referringShareLinkId" IS DISTINCT FROM NEW."referringShareLinkId"
       OR target."referringCustomerCardId" IS DISTINCT FROM NEW."referringCustomerCardId"
       OR target."enrolledCustomerCardId" IS DISTINCT FROM NEW."enrolledCustomerCardId"
       OR target."enrolledProfileId" IS DISTINCT FROM NEW."enrolledProfileId"
       OR target."method" IS DISTINCT FROM NEW."method"
    THEN
      RAISE EXCEPTION 'ReferralAttribution: a VOIDED row must repeat the attribution it withdraws, exactly'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER referral_attribution_validate
  BEFORE INSERT ON "ReferralAttribution"
  FOR EACH ROW EXECUTE FUNCTION walaaplus_validate_referral_attribution();
