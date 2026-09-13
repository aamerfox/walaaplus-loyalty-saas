-- Phase 2 Prompt 2 — consent history, and campaign drafts that cannot send.
--
-- ONE additive migration. Three tables, three enums, two append-only triggers. No existing column
-- is changed, no existing row is written, nothing is dropped or backfilled. An old build ignores
-- all of it, so this is safe to apply before a deploy and safe to leave in place after a rollback.
--
-- ## Why nothing is backfilled
--
-- `CustomerBusinessProfile` already carries the enrolment consent: `marketingConsent`,
-- `privacyConsentAt` and `consentTextVersion`. It is tempting to copy those into a first
-- `ConsentRecord` row so the history is "complete". It is not done, for one reason: for every
-- enrolment taken before the consent version was wired up, `privacyConsentAt` is NULL. Writing a
-- history row would mean inventing the moment a customer agreed to something, and an invented
-- consent timestamp is worse than an honest gap — it is the one field a consent record exists to
-- hold.
--
-- So the enrolment fields stay exactly as they are, forever, as the ORIGIN record, and this table
-- holds every change after it. `src/server/consent/consent.ts` composes the two and reports
-- "unknown" where the origin cannot answer "when" and "to what".

-- ── Consent ──────────────────────────────────────────────────────────────────

-- The only scope the data supports today. The product asks one question at enrolment — "I agree to
-- receive offers from this business" — which is a general marketing permission with no channel
-- attached. A PUSH/SMS/EMAIL scope would be a permission nobody was ever asked for, and inventing
-- one is exactly how an opt-in gets manufactured.
CREATE TYPE "ConsentScope" AS ENUM ('MARKETING');

-- UNKNOWN is a first-class state, not a missing value. A profile that says `marketingConsent = true`
-- with no timestamp and no text version answers neither "when" nor "to what"; calling that GRANTED
-- would turn a data gap into a permission.
CREATE TYPE "ConsentState" AS ENUM ('GRANTED', 'WITHDRAWN', 'UNKNOWN');

-- How the record came to exist. There is deliberately no IMPORT and no API: the only ways a
-- preference can change today are the counter and an authorised staff action, and both have a
-- person behind them.
CREATE TYPE "ConsentCapture" AS ENUM ('ENROLMENT', 'STAFF_UPDATE');

CREATE TABLE "ConsentRecord" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "customerBusinessProfileId" TEXT NOT NULL,
    "scope" "ConsentScope" NOT NULL,
    "state" "ConsentState" NOT NULL,
    -- What the state was immediately before this row. Stored rather than derived so a single row
    -- is a complete, readable account of one change without joining to its neighbour.
    "previousState" "ConsentState" NOT NULL,
    "capturedVia" "ConsentCapture" NOT NULL,
    -- The revision of the consent text this refers to, when one applies. Null for a staff-recorded
    -- withdrawal, which refers to no text at all.
    "policyVersion" TEXT,
    -- When it happened, which is not always when the row was written.
    "recordedAt" TIMESTAMP(3) NOT NULL,
    -- The staff member, when a staff action is legitimately involved. Null when it is not.
    "actorUserId" TEXT,
    -- Free text from the merchant: "asked at the counter", "replied to stop". Never a phone number,
    -- never a token — the service caps and stores it, and the audit row does not repeat it.
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConsentRecord_pkey" PRIMARY KEY ("id")
);

-- The history of one customer, newest first. Also the shape the eligibility read uses.
CREATE INDEX "ConsentRecord_profile_scope_recordedAt_idx"
  ON "ConsentRecord"("customerBusinessProfileId", "scope", "recordedAt" DESC);
CREATE INDEX "ConsentRecord_businessId_recordedAt_idx" ON "ConsentRecord"("businessId", "recordedAt");

ALTER TABLE "ConsentRecord" ADD CONSTRAINT "ConsentRecord_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ConsentRecord" ADD CONSTRAINT "ConsentRecord_profile_fkey"
  FOREIGN KEY ("customerBusinessProfileId") REFERENCES "CustomerBusinessProfile"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ConsentRecord" ADD CONSTRAINT "ConsentRecord_actorUserId_fkey"
  FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- APPEND-ONLY, enforced in the database exactly as the ledger is. A consent history that the
-- application could rewrite is not a history; it is a current value with extra rows. Withdrawing
-- consent appends a WITHDRAWN row, and the GRANTED row above it stays readable forever.
CREATE OR REPLACE FUNCTION walaaplus_reject_consent_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ConsentRecord is append-only; % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation',
          HINT = 'Append a new record describing the change instead of editing the old one.';
END
$$;

CREATE TRIGGER consent_record_append_only
  BEFORE UPDATE OR DELETE ON "ConsentRecord"
  FOR EACH ROW EXECUTE FUNCTION walaaplus_reject_consent_mutation();

CREATE TRIGGER consent_record_no_truncate
  BEFORE TRUNCATE ON "ConsentRecord"
  FOR EACH STATEMENT EXECUTE FUNCTION walaaplus_reject_consent_mutation();

-- ── Campaign drafts ──────────────────────────────────────────────────────────

-- The channel a draft is INTENDED for. It is a label on a draft and nothing reads it to deliver
-- anything: no provider, no queue, no worker exists in this build.
CREATE TYPE "CampaignChannel" AS ENUM ('PUSH', 'SMS', 'WHATSAPP', 'EMAIL');

-- Three states, and none of them sends. There is deliberately no SENT, SCHEDULED, QUEUED or
-- SENDING value in this type: a state that cannot be reached is still a promise that it will be,
-- and the delivery design belongs with the phase that builds a provider and an audit trail for it.
-- `PushMessageStatus` — the reserved delivery model from Phase 0 — is untouched and separate.
CREATE TYPE "CampaignState" AS ENUM ('DRAFT', 'READY', 'ARCHIVED');

CREATE TABLE "Campaign" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    -- Lower-cased, whitespace-collapsed by the service, as segments are. One name per business.
    "normalizedName" TEXT NOT NULL,
    -- Which language the content is written in. A draft is one locale; a merchant writing in two
    -- writes two drafts, because a half-translated message is worse than an untranslated one.
    "locale" TEXT NOT NULL,
    "channel" "CampaignChannel" NOT NULL,
    "state" "CampaignState" NOT NULL DEFAULT 'DRAFT',
    -- The intended audience. A REFERENCE to a live segment definition, never a copy of who it
    -- matched: membership is re-derived every time anybody asks.
    "segmentId" TEXT,
    "createdByUserId" TEXT,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Campaign_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Campaign_businessId_normalizedName_key" ON "Campaign"("businessId", "normalizedName");
CREATE INDEX "Campaign_businessId_archivedAt_idx" ON "Campaign"("businessId", "archivedAt");

ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- RESTRICT: a segment a draft points at cannot be removed out from under it. Segments are archived
-- rather than deleted anyway, so this is a second lock on a door that is already shut.
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_segmentId_fkey"
  FOREIGN KEY ("segmentId") REFERENCES "CustomerSegment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_createdByUserId_fkey"
  FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Every edit is a new revision. The content of a draft is therefore immutable once written, and
-- "what did this say last Tuesday" is a question with an answer.
CREATE TABLE "CampaignRevision" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "revisionNumber" INTEGER NOT NULL,
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CampaignRevision_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CampaignRevision_campaignId_revisionNumber_key"
  ON "CampaignRevision"("campaignId", "revisionNumber");

ALTER TABLE "CampaignRevision" ADD CONSTRAINT "CampaignRevision_campaignId_fkey"
  FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CampaignRevision" ADD CONSTRAINT "CampaignRevision_createdByUserId_fkey"
  FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Revisions are append-only for the same reason consent is: a revision history the application can
-- rewrite is a draft with extra rows.
CREATE OR REPLACE FUNCTION walaaplus_reject_revision_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'CampaignRevision is append-only; % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation',
          HINT = 'Write a new revision instead of editing an existing one.';
END
$$;

CREATE TRIGGER campaign_revision_append_only
  BEFORE UPDATE OR DELETE ON "CampaignRevision"
  FOR EACH ROW EXECUTE FUNCTION walaaplus_reject_revision_mutation();

CREATE TRIGGER campaign_revision_no_truncate
  BEFORE TRUNCATE ON "CampaignRevision"
  FOR EACH STATEMENT EXECUTE FUNCTION walaaplus_reject_revision_mutation();
