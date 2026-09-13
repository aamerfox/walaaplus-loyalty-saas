-- Phase 1b Prompt 3 — the program-version lifecycle, made unambiguous.
--
-- ONE additive migration, as the prompt allows. Nothing here changes a column's type, drops
-- anything, or touches a row: an old build and a new build both run against a database in either
-- state, which is what makes it safe to apply before the deploy rather than in lockstep with it.
--
-- Everything ELSE this phase needs already existed. Drafts are not new: `ProgramVersionStatus`
-- has carried DRAFT since Phase 0, `walaaplus_protect_program_version` already freezes mechanics
-- the moment a version leaves DRAFT and already refuses to delete one that has, and
-- `ProgramVersion_one_active_per_template` already guarantees a single live version. The
-- lifecycle is therefore a set of services over constraints that were designed for it — which is
-- the point of having written them first.

-- ── 1. When a version stopped being the live one ─────────────────────────────
--
-- `activatedAt` records when a version went live. Nothing recorded when it stopped, and the
-- version history screen has to state both. It could be INFERRED from the successor's
-- `activatedAt`, and that inference is wrong in exactly the case a merchant is most likely to be
-- looking at the screen for: a program retired without a successor has no successor to read.
ALTER TABLE "ProgramVersion" ADD COLUMN IF NOT EXISTS "retiredAt" TIMESTAMP(3);

-- Backfill is deliberately NOT attempted. A version retired before this column existed has no
-- recorded retirement, and inventing one from a sibling row would put a fabricated timestamp in
-- front of a merchant. NULL means "not recorded", and the screen says so.

-- ── 2. At most one DRAFT per program ─────────────────────────────────────────
--
-- The owner UI talks about "the draft": create one from the live version, edit it, review the
-- change, publish it. Two drafts make every one of those sentences ambiguous, and two people
-- clicking "new draft" at the same moment is the ordinary way to get them. The service serialises
-- on the template row; this is the constraint underneath, so a caller that does not go through the
-- service cannot create a second one either.
--
-- Safe on existing data: every version created before this migration was activated inside the
-- transaction that created it, so no DRAFT rows exist to conflict.
CREATE UNIQUE INDEX IF NOT EXISTS "ProgramVersion_one_draft_per_template"
  ON "ProgramVersion" ("templateId")
  WHERE status = 'DRAFT';
