-- Phase 3A Prompt 2 — recording that a customer arrived with an invitation, and nothing else.
--
-- ONE additive migration. Two enums, one table, two triggers. No existing column is changed, no
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
