-- Phase 2 Prompt 3 — campaign approval, audience snapshots, and no way to deliver either.
--
-- ONE migration. It adds two enums, three tables and four append-only triggers, and it changes one
-- existing enum in place. Nothing is dropped, nothing is backfilled, and every existing row keeps
-- its meaning.
--
-- ## The one existing thing that changes, and why it is a rename rather than a new value
--
-- `CampaignState` had `READY`, which Prompt 2 documented as "the merchant considers the wording
-- finished". That is precisely the moment a campaign is handed over for a decision, so this prompt
-- does not add a parallel `IN_REVIEW` beside it and leave two labels meaning one thing. `READY`
-- BECOMES `IN_REVIEW`.
--
-- The rename is done by rebuilding the type with an explicit CASE, rather than by
-- `ALTER TYPE ... RENAME VALUE` plus two `ADD VALUE`s, for one practical reason: `ADD VALUE` inside
-- a transaction is only safe when the new value is not used in the same transaction, and a future
-- reader editing this file should not have to know that rule. The CASE maps every stored row:
--
--     DRAFT    -> DRAFT
--     READY    -> IN_REVIEW        (the only value whose spelling moves)
--     ARCHIVED -> ARCHIVED
--
-- No row is deleted, no row changes meaning, and a campaign a merchant had marked ready is in
-- review afterwards — which is what they meant by marking it.
--
-- ## What approval is, in one sentence
--
-- An append-only decision row that names a person, a moment, one exact revision, one declared
-- intended channel, and one immutable audience snapshot. It is NOT permission to contact anybody:
-- see `src/server/campaigns/delivery.ts`, which is the only thing shaped like a delivery port in
-- this build and whose sole implementation refuses before it can resolve a recipient.

-- ── The state model ──────────────────────────────────────────────────────────

ALTER TYPE "CampaignState" RENAME TO "CampaignState_old";

-- DRAFT      being written; the only state in which content may change
-- IN_REVIEW  submitted for a decision; content frozen by convention, approval not yet given
-- APPROVED   an approval row exists for the CURRENT revision, with a snapshot behind it
-- WITHDRAWN  an approval was explicitly taken back. The decision history keeps both rows
-- ARCHIVED   put away. Cannot be approved and cannot be edited until it is restored
--
-- There is still no SENT, SCHEDULED, QUEUED or SENDING value, and adding one is not a schema change
-- somebody makes in passing: every state in this list is named in the API schema, in the UI message
-- files and in the tests.
CREATE TYPE "CampaignState" AS ENUM ('DRAFT', 'IN_REVIEW', 'APPROVED', 'WITHDRAWN', 'ARCHIVED');

ALTER TABLE "Campaign" ALTER COLUMN "state" DROP DEFAULT;
ALTER TABLE "Campaign" ALTER COLUMN "state" TYPE "CampaignState" USING (
  CASE "state"::text
    WHEN 'READY' THEN 'IN_REVIEW'
    ELSE "state"::text
  END
)::"CampaignState";
ALTER TABLE "Campaign" ALTER COLUMN "state" SET DEFAULT 'DRAFT';

DROP TYPE "CampaignState_old";

-- A decision is one of two verbs. There is no REJECT: a campaign a merchant does not want simply
-- goes back to draft, and inventing a rejection state would imply a review workflow with a second
-- person in it that this product does not have (see D12).
CREATE TYPE "CampaignDecision" AS ENUM ('APPROVED', 'WITHDRAWN');

-- ── The decision record ──────────────────────────────────────────────────────

-- APPEND-ONLY. An approval that can be edited afterwards is not a decision, it is a label.
CREATE TABLE "CampaignApproval" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    -- The EXACT revision the decision was made about. Approval never covers "the campaign"; it
    -- covers the words somebody actually read.
    "campaignRevisionId" TEXT NOT NULL,
    -- Denormalised so the decision history reads without a join, and so the number survives even if
    -- a later phase changes how revisions are addressed.
    "revisionNumber" INTEGER NOT NULL,
    "decision" "CampaignDecision" NOT NULL,
    -- The channel the approver was told this was intended for. Declared at the decision, not read
    -- from the draft afterwards: a merchant who approves an SMS and later flips the label to
    -- WhatsApp has not approved a WhatsApp message.
    "intendedChannel" "CampaignChannel" NOT NULL,
    -- The snapshot taken at this instant. Set on an approval; null on a withdrawal, which takes
    -- nothing new.
    "audienceSnapshotId" TEXT,
    -- Which approval a withdrawal takes back. Null on an approval.
    "withdrawsApprovalId" TEXT,
    "decidedByUserId" TEXT,
    "decidedAt" TIMESTAMP(3) NOT NULL,
    -- Free text from the approver. Never a phone number, never a customer name, never a token: the
    -- service caps it and the audit row does not repeat it.
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CampaignApproval_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CampaignApproval_campaignId_decidedAt_idx" ON "CampaignApproval"("campaignId", "decidedAt" DESC);
CREATE INDEX "CampaignApproval_businessId_decidedAt_idx" ON "CampaignApproval"("businessId", "decidedAt" DESC);

-- ── The audience snapshot ────────────────────────────────────────────────────

-- APPEND-ONLY. The counts a merchant was shown when they approved, frozen at that instant.
--
-- A segment is a LIVE definition: its membership changes as customers earn, spend and enrol. That
-- is right for a segment and wrong for a decision, because "you approved this for 412 people" has
-- to still be true next week. The snapshot is the only place in this product where audience
-- membership is stored at all.
CREATE TABLE "CampaignAudienceSnapshot" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "campaignRevisionId" TEXT NOT NULL,
    "segmentId" TEXT NOT NULL,
    -- The segment's name AT THE MOMENT of the snapshot. A business's own label for a group, not
    -- customer data, and kept so a renamed segment does not rewrite the history of a decision.
    "segmentName" TEXT NOT NULL,
    "takenAt" TIMESTAMP(3) NOT NULL,
    -- Everyone the segment matched.
    "matchedCount" INTEGER NOT NULL,
    -- Of those, the ones with an explicit, dated, versioned permission. This is the number of rows
    -- in CampaignAudienceMember, stored so the header alone is a complete answer.
    "eligibleCount" INTEGER NOT NULL,
    -- The two exclusion reasons, as COUNTS ONLY. No row is written for an excluded customer: a
    -- person who never agreed to be contacted has not agreed to be listed in a marketing artefact
    -- either, and nothing a future delivery phase does needs them.
    "unknownCount" INTEGER NOT NULL,
    "withdrawnCount" INTEGER NOT NULL,
    "takenByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CampaignAudienceSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CampaignAudienceSnapshot_campaignId_takenAt_idx" ON "CampaignAudienceSnapshot"("campaignId", "takenAt" DESC);
CREATE INDEX "CampaignAudienceSnapshot_businessId_idx" ON "CampaignAudienceSnapshot"("businessId");

-- APPEND-ONLY. One row per customer who MAY be contacted, and the smallest row that can be.
--
-- What is deliberately NOT here: no phone, no name, no email, no card id, no serial, no card URL,
-- no QR token, no share token, no source token, and no rendered message. A future delivery phase
-- resolves a contact detail from the profile reference at the moment it needs one, under whatever
-- authorization that phase has to argue for — it does not inherit a contact list from this table.
CREATE TABLE "CampaignAudienceMember" (
    "id" TEXT NOT NULL,
    "snapshotId" TEXT NOT NULL,
    -- An internal reference. Meaningless outside this database and this tenant.
    "customerBusinessProfileId" TEXT NOT NULL,
    -- The state observed at the instant of the snapshot. Always GRANTED today, stored explicitly so
    -- a future rule change cannot silently reinterpret an old snapshot.
    "consentState" "ConsentState" NOT NULL,
    -- The record that decided it, when one exists. NULL means the permission came from the
    -- enrolment answer itself, which is a fact worth being able to tell apart later.
    "consentRecordId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CampaignAudienceMember_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CampaignAudienceMember_snapshotId_customerBusinessProfileId_key"
  ON "CampaignAudienceMember"("snapshotId", "customerBusinessProfileId");
CREATE INDEX "CampaignAudienceMember_snapshotId_idx" ON "CampaignAudienceMember"("snapshotId");

-- ── What the campaign row remembers about its own approval ───────────────────

-- Nullable, additive, and derivable — kept on the row so the drafts list does not need a
-- correlated subquery per campaign to answer "is the thing on screen the thing that was approved".
-- Cleared by the same transaction that invalidates an approval, never separately.
ALTER TABLE "Campaign" ADD COLUMN "approvedRevisionNumber" INTEGER;
ALTER TABLE "Campaign" ADD COLUMN "approvedSnapshotId" TEXT;
ALTER TABLE "Campaign" ADD COLUMN "approvedAt" TIMESTAMP(3);

-- ── Foreign keys ─────────────────────────────────────────────────────────────

ALTER TABLE "CampaignApproval" ADD CONSTRAINT "CampaignApproval_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CampaignApproval" ADD CONSTRAINT "CampaignApproval_campaignId_fkey"
  FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CampaignApproval" ADD CONSTRAINT "CampaignApproval_campaignRevisionId_fkey"
  FOREIGN KEY ("campaignRevisionId") REFERENCES "CampaignRevision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CampaignApproval" ADD CONSTRAINT "CampaignApproval_audienceSnapshotId_fkey"
  FOREIGN KEY ("audienceSnapshotId") REFERENCES "CampaignAudienceSnapshot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CampaignApproval" ADD CONSTRAINT "CampaignApproval_withdrawsApprovalId_fkey"
  FOREIGN KEY ("withdrawsApprovalId") REFERENCES "CampaignApproval"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CampaignApproval" ADD CONSTRAINT "CampaignApproval_decidedByUserId_fkey"
  FOREIGN KEY ("decidedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "CampaignAudienceSnapshot" ADD CONSTRAINT "CampaignAudienceSnapshot_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CampaignAudienceSnapshot" ADD CONSTRAINT "CampaignAudienceSnapshot_campaignId_fkey"
  FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CampaignAudienceSnapshot" ADD CONSTRAINT "CampaignAudienceSnapshot_campaignRevisionId_fkey"
  FOREIGN KEY ("campaignRevisionId") REFERENCES "CampaignRevision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CampaignAudienceSnapshot" ADD CONSTRAINT "CampaignAudienceSnapshot_segmentId_fkey"
  FOREIGN KEY ("segmentId") REFERENCES "CustomerSegment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CampaignAudienceSnapshot" ADD CONSTRAINT "CampaignAudienceSnapshot_takenByUserId_fkey"
  FOREIGN KEY ("takenByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "CampaignAudienceMember" ADD CONSTRAINT "CampaignAudienceMember_snapshotId_fkey"
  FOREIGN KEY ("snapshotId") REFERENCES "CampaignAudienceSnapshot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CampaignAudienceMember" ADD CONSTRAINT "CampaignAudienceMember_customerBusinessProfileId_fkey"
  FOREIGN KEY ("customerBusinessProfileId") REFERENCES "CustomerBusinessProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CampaignAudienceMember" ADD CONSTRAINT "CampaignAudienceMember_consentRecordId_fkey"
  FOREIGN KEY ("consentRecordId") REFERENCES "ConsentRecord"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_approvedSnapshotId_fkey"
  FOREIGN KEY ("approvedSnapshotId") REFERENCES "CampaignAudienceSnapshot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── Append-only enforcement ──────────────────────────────────────────────────
--
-- The same shape as the ledger, consent history and revision tables. Note that this is the SECOND
-- line of defence, not the first: `scripts/db-roles.mjs` lists all three of these tables, so the
-- runtime role holds only SELECT and INSERT on them and is refused on privilege before a trigger
-- ever runs.

CREATE OR REPLACE FUNCTION walaaplus_reject_approval_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'CampaignApproval is append-only; % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation',
          HINT = 'Record a withdrawal instead of editing or removing an approval.';
END
$$;

CREATE TRIGGER campaign_approval_append_only
  BEFORE UPDATE OR DELETE ON "CampaignApproval"
  FOR EACH ROW EXECUTE FUNCTION walaaplus_reject_approval_mutation();

CREATE TRIGGER campaign_approval_no_truncate
  BEFORE TRUNCATE ON "CampaignApproval"
  FOR EACH STATEMENT EXECUTE FUNCTION walaaplus_reject_approval_mutation();

CREATE OR REPLACE FUNCTION walaaplus_reject_snapshot_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'A campaign audience snapshot is append-only; % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation',
          HINT = 'Approve again to take a new snapshot; an old one is the record of an old decision.';
END
$$;

CREATE TRIGGER campaign_snapshot_append_only
  BEFORE UPDATE OR DELETE ON "CampaignAudienceSnapshot"
  FOR EACH ROW EXECUTE FUNCTION walaaplus_reject_snapshot_mutation();

CREATE TRIGGER campaign_snapshot_no_truncate
  BEFORE TRUNCATE ON "CampaignAudienceSnapshot"
  FOR EACH STATEMENT EXECUTE FUNCTION walaaplus_reject_snapshot_mutation();

CREATE TRIGGER campaign_audience_member_append_only
  BEFORE UPDATE OR DELETE ON "CampaignAudienceMember"
  FOR EACH ROW EXECUTE FUNCTION walaaplus_reject_snapshot_mutation();

CREATE TRIGGER campaign_audience_member_no_truncate
  BEFORE TRUNCATE ON "CampaignAudienceMember"
  FOR EACH STATEMENT EXECUTE FUNCTION walaaplus_reject_snapshot_mutation();
