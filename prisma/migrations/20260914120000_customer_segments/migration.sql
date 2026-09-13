-- Phase 2 Prompt 1 — saved customer segments.
--
-- ONE additive migration. It creates a table and nothing else: no column is changed, no row is
-- written, no existing index is dropped. An old build ignores the table entirely, so this is safe
-- to apply before the deploy rather than in lockstep with it, and safe to leave in place if the
-- deploy is rolled back.
--
-- A segment is a DEFINITION, never a copy of a customer list. The rows it matches are derived on
-- read, from the same cards and ledger every other screen reads, so a segment cannot go stale and
-- cannot become a second copy of anybody's personal data sitting in a table of its own. That is
-- why there is no membership table here and why there will not be one.

CREATE TABLE "CustomerSegment" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    -- Lower-cased and whitespace-collapsed by the service. Stored rather than computed so the
    -- uniqueness rule is enforced by the database and not by whoever remembers to call the
    -- normaliser: "VIP", "vip" and "  VIP " are one name, and a merchant with two segments they
    -- cannot tell apart is a campaign sent to the wrong people later.
    "normalizedName" TEXT NOT NULL,
    -- The validated definition. Written only by the service, which parses it against an allowlist
    -- of fields and operators first; nothing here is ever executed as SQL or handed to Prisma raw.
    "definition" JSONB NOT NULL,
    -- The shape the definition was written in. A future shape can be added without rewriting the
    -- definitions already saved, which is the same reason program mechanics carry one.
    "definitionVersion" INTEGER NOT NULL DEFAULT 1,
    -- Archived, never deleted: a campaign in a later phase will reference a segment by id, and a
    -- row that disappeared would take its own history with it.
    "archivedAt" TIMESTAMP(3),
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerSegment_pkey" PRIMARY KEY ("id")
);

-- One name per business. Tenant-scoped, so two businesses may both have a "VIP".
CREATE UNIQUE INDEX "CustomerSegment_businessId_normalizedName_key"
  ON "CustomerSegment"("businessId", "normalizedName");

-- The list screen reads live segments for one business, newest first.
CREATE INDEX "CustomerSegment_businessId_archivedAt_idx"
  ON "CustomerSegment"("businessId", "archivedAt");

ALTER TABLE "CustomerSegment" ADD CONSTRAINT "CustomerSegment_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- SET NULL rather than CASCADE: who created a segment is useful history, and losing the segment
-- because a staff account was removed would be the wrong trade.
ALTER TABLE "CustomerSegment" ADD CONSTRAINT "CustomerSegment_createdByUserId_fkey"
  FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
