-- Phase 3A Prompt 1 — the invitation capability behind a wallet pass's web link.
--
-- ONE additive migration. One table, two triggers, no change to any existing column or row.
--
-- ## What this stores, and what it deliberately cannot
--
-- A card's invitation link is a capability: whoever holds it can open the public invitation page
-- for that business. It is drawn SEPARATELY from every other secret a card carries — the scanner
-- `qrToken`, the card-page `shareToken`, the serial number and the enrolment source token — so that
-- holding one never yields another. A cashier who scans a card cannot open its page; whoever
-- receives an invitation link cannot open the card, cannot see a balance, and cannot find out
-- whose card it came from.
--
-- **The raw value is never stored.** Only `tokenDigest`, a SHA-256 of the token, which is what the
-- verification endpoint looks up. There is no salt and no keyed HMAC, deliberately: the input is 32
-- bytes of `crypto.randomBytes`, so there is no dictionary to precompute and a keyed digest would
-- require a secret that this phase is not allowed to introduce. A database copy therefore yields
-- nobody a working link.
--
-- ## Why this table is not strictly append-only
--
-- Every other protected table here (the ledger, consent history, campaign revisions, approvals,
-- snapshots) refuses UPDATE outright. This one cannot: revoking a capability IS a state change, and
-- the alternative — a second tombstone table, or a superseding row with no digest — would express
-- the same fact less clearly and give the lookup two places to be wrong.
--
-- So it is append-only in every direction that matters, enforced by trigger:
--
--   * DELETE and TRUNCATE are refused absolutely. An issued capability is a fact about what was
--     given out, and a revocation that erased the row would leave nothing to audit;
--   * UPDATE may change `revokedAt` and nothing else, and only from NULL to a value. The digest,
--     the card, the business, the issuance time and the issuer are frozen at INSERT, and a
--     revocation cannot be undone by rewriting it back to NULL.
--
-- `scripts/db-roles.mjs` therefore lists this table under `NO_DELETE_TABLES` rather than
-- `APPEND_ONLY_TABLES`: the runtime role holds SELECT, INSERT and UPDATE, and never DELETE or
-- TRUNCATE. The trigger is the second line for anyone connecting with more rights than the app.

CREATE TABLE "CardShareLink" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "customerCardId" TEXT NOT NULL,
    -- SHA-256 of the raw capability, lower-case hex. The raw value exists only in the response that
    -- minted it and in the wallet pass built from it; nothing reads it back, ever.
    "tokenDigest" TEXT NOT NULL,
    -- Which pass issuance minted this. A label for the audit trail, never a route to anything.
    "issuedFor" TEXT NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL,
    "issuedByUserId" TEXT,
    -- NULL while live. Set once, by the trigger's rule, and never cleared.
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CardShareLink_pkey" PRIMARY KEY ("id")
);

-- The verification lookup, and the reason a digest collision is a constraint error rather than a
-- silent cross-card match.
CREATE UNIQUE INDEX "CardShareLink_tokenDigest_key" ON "CardShareLink"("tokenDigest");

-- "Is there a live link for this card, and which one" — the question issuance and revocation both
-- ask. Partial, because a card accumulates revoked rows forever and none of them is ever the
-- answer.
CREATE UNIQUE INDEX "CardShareLink_liveForCard_key"
  ON "CardShareLink"("customerCardId")
  WHERE "revokedAt" IS NULL;

CREATE INDEX "CardShareLink_businessId_issuedAt_idx" ON "CardShareLink"("businessId", "issuedAt" DESC);

ALTER TABLE "CardShareLink" ADD CONSTRAINT "CardShareLink_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CardShareLink" ADD CONSTRAINT "CardShareLink_customerCardId_fkey"
  FOREIGN KEY ("customerCardId") REFERENCES "CustomerCard"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CardShareLink" ADD CONSTRAINT "CardShareLink_issuedByUserId_fkey"
  FOREIGN KEY ("issuedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── The one permitted mutation ───────────────────────────────────────────────

CREATE OR REPLACE FUNCTION walaaplus_share_link_revoke_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."businessId" IS DISTINCT FROM OLD."businessId"
     OR NEW."customerCardId" IS DISTINCT FROM OLD."customerCardId"
     OR NEW."tokenDigest" IS DISTINCT FROM OLD."tokenDigest"
     OR NEW."issuedFor" IS DISTINCT FROM OLD."issuedFor"
     OR NEW."issuedAt" IS DISTINCT FROM OLD."issuedAt"
     OR NEW."issuedByUserId" IS DISTINCT FROM OLD."issuedByUserId"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
  THEN
    RAISE EXCEPTION 'CardShareLink is issue-once; only revokedAt may change'
      USING ERRCODE = 'restrict_violation',
            HINT = 'Issue a new link instead of rewriting the one that was already handed out.';
  END IF;

  IF OLD."revokedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'CardShareLink revocation is final; % is not permitted', TG_OP
      USING ERRCODE = 'restrict_violation',
            HINT = 'A revoked link stays revoked. Issue a new one.';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER card_share_link_revoke_only
  BEFORE UPDATE ON "CardShareLink"
  FOR EACH ROW EXECUTE FUNCTION walaaplus_share_link_revoke_only();

CREATE OR REPLACE FUNCTION walaaplus_share_link_no_removal() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'CardShareLink is never removed; % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation',
          HINT = 'Revoke the link. What was handed out stays on the record.';
END
$$;

CREATE TRIGGER card_share_link_no_delete
  BEFORE DELETE ON "CardShareLink"
  FOR EACH ROW EXECUTE FUNCTION walaaplus_share_link_no_removal();

CREATE TRIGGER card_share_link_no_truncate
  BEFORE TRUNCATE ON "CardShareLink"
  FOR EACH STATEMENT EXECUTE FUNCTION walaaplus_share_link_no_removal();
