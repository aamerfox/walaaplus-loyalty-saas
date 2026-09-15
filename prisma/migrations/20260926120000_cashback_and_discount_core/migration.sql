-- ════════════════════════════════════════════════════════════════════════════
-- Migration 21 — cashback and discount: the money the product can actually hold
-- ════════════════════════════════════════════════════════════════════════════
--
-- Phase 4 Prompt 1. Domain and database only: no route, no screen, no provider.
--
-- READ `docs/PHASE-4-MONEY-MATRIX.md` §2 BEFORE ADDING ANYTHING HERE. Every
-- amount in these tables began as a number a member of staff typed at a till.
-- Nothing in this schema records a payment, a receipt, a tax event or verified
-- revenue, and no column may ever be named as though it does.
--
-- ── WHY BIGINT, AND WHY IT IS NOT OPTIONAL ──────────────────────────────────
--
-- Every existing monetary column in this product is `integer`. int4 holds at
-- most 2,147,483,647 minor units, which at exponent 2 is 21,474,836.47 SYP -
-- roughly USD 1,400-1,700 at recent rates. That is an ordinary large purchase,
-- and it is far below the figure the tiers in this subsystem actually depend
-- on: CUMULATIVE spend across a customer's lifetime.
--
-- So every amount here is BIGINT, and `CustomerCard.cashBalanceMinor` (int4,
-- commented "reserved: gift/cashback") is deliberately NOT used. The balance is
-- derived from the rows below instead, which is also what stops it drifting.
--
-- The pre-existing int4 ceiling on `LoyaltyOperation.purchaseAmountMinor`,
-- which IS live on the stamp and points path, is reported as D33 rather than
-- fixed here: widening a live column is a table rewrite and belongs in its own
-- change with its own window.
--
-- ── WHY TYPED TABLES AND NOT `ProgramVersion.mechanics` JSON ────────────────
--
-- A rate in a JSON blob is a rate nothing can constrain. `IntegrationEvent` was
-- built with typed columns and no JSON bag for exactly this reason, and money
-- deserves it more than an event does.

-- ── Supported currencies, with their exponents ──────────────────────────────
--
-- The product had NO exponent anywhere. `Business.currency` is unconstrained
-- `text` defaulting to 'SYP', set from a hardcoded constant at registration and
-- never written again, and "integer minor units" appears only in a comment.
--
-- An amount in minor units without an exponent is an amount without a unit, so
-- this table is the unit. It is a reference table rather than a CHECK list
-- because the exponent has to be looked up, not just validated, and rather than
-- a merchant-typed number because a wrong exponent silently multiplies or
-- divides every amount in that currency by ten.
--
-- The seed is deliberately small and deliberately NOT all exponent 2: JOD and
-- BHD are 3, JPY is 0. Code that assumes two decimal places is wrong here and
-- the tests use those currencies to prove it.
CREATE TABLE "SupportedCurrency" (
    "code"      TEXT     NOT NULL,
    "exponent"  SMALLINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupportedCurrency_pkey" PRIMARY KEY ("code"),
    -- ISO 4217 uses 0, 2 and 3; 4 exists (CLF). Anything else is a mistake.
    CONSTRAINT "SupportedCurrency_exponent_range" CHECK ("exponent" BETWEEN 0 AND 4),
    CONSTRAINT "SupportedCurrency_code_shape" CHECK ("code" ~ '^[A-Z]{3}$')
);

INSERT INTO "SupportedCurrency" ("code", "exponent") VALUES
    ('SYP', 2),  -- the product's default, and every business's currency today
    ('USD', 2),
    ('EUR', 2),
    ('TRY', 2),
    ('JOD', 3),  -- three minor digits
    ('KWD', 3),
    ('BHD', 3),
    ('JPY', 0);  -- none

-- ── Program types ───────────────────────────────────────────────────────────
--
-- Cashback and discount are separate program types, so a card pins to a version
-- exactly as a stamp or point card already does. Two statements because
-- PostgreSQL takes one value per ALTER, and neither value is USED in this
-- transaction - which is what makes this legal inside Prisma's migration
-- transaction on PG12+.
ALTER TYPE "CardType" ADD VALUE 'CASHBACK';
ALTER TYPE "CardType" ADD VALUE 'DISCOUNT';

CREATE TYPE "MonetaryRuleKind" AS ENUM ('CASHBACK', 'DISCOUNT');

CREATE TYPE "MonetaryOperationKind" AS ENUM (
    'CASHBACK_EARNED',
    'CASHBACK_REDEEMED',
    'DISCOUNT_APPLIED',
    'REVERSAL'
);

-- ── The rule, pinned to one program version ─────────────────────────────────
CREATE TABLE "MonetaryRule" (
    "id"               TEXT NOT NULL,
    "programVersionId" TEXT NOT NULL,
    "kind"             "MonetaryRuleKind" NOT NULL,
    -- Copied from the business at creation and FROZEN. A row that read the
    -- currency live would change meaning if the business's currency changed.
    "currency"         TEXT NOT NULL,
    -- Copied from "SupportedCurrency" at creation and frozen with it. Carried
    -- so that rendering and validation never have to re-derive the unit.
    "currencyExponent" SMALLINT NOT NULL,
    "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MonetaryRule_pkey" PRIMARY KEY ("id")
);

-- One rule per version: a version is either a cashback program or a discount
-- program or neither, never both.
CREATE UNIQUE INDEX "MonetaryRule_programVersionId_key" ON "MonetaryRule"("programVersionId");

ALTER TABLE "MonetaryRule" ADD CONSTRAINT "MonetaryRule_programVersionId_fkey"
    FOREIGN KEY ("programVersionId") REFERENCES "ProgramVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MonetaryRule" ADD CONSTRAINT "MonetaryRule_currency_fkey"
    FOREIGN KEY ("currency") REFERENCES "SupportedCurrency"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── The tiers ───────────────────────────────────────────────────────────────
CREATE TABLE "MonetaryTier" (
    "id"                      TEXT NOT NULL,
    "monetaryRuleId"          TEXT NOT NULL,
    -- 0-based, contiguous, ordered by threshold. Checked by trigger.
    "tierIndex"               INTEGER NOT NULL,
    -- Cumulative qualified spend at or above which this tier applies.
    "minCumulativeSpendMinor" BIGINT NOT NULL,
    -- 0..10000 = 0%..100%. Dimensionless, so no currency is involved.
    "rateBasisPoints"         INTEGER NOT NULL,
    "createdAt"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MonetaryTier_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "MonetaryTier_rate_range" CHECK ("rateBasisPoints" BETWEEN 0 AND 10000),
    CONSTRAINT "MonetaryTier_threshold_non_negative" CHECK ("minCumulativeSpendMinor" >= 0),
    CONSTRAINT "MonetaryTier_threshold_bounded" CHECK ("minCumulativeSpendMinor" <= 1000000000000000),
    CONSTRAINT "MonetaryTier_index_non_negative" CHECK ("tierIndex" >= 0)
);

-- Two tiers cannot share an index, and two cannot share a threshold: either
-- would make "which tier applies" ambiguous.
CREATE UNIQUE INDEX "MonetaryTier_monetaryRuleId_tierIndex_key" ON "MonetaryTier"("monetaryRuleId", "tierIndex");
CREATE UNIQUE INDEX "MonetaryTier_monetaryRuleId_minCumulativeSpendMinor_key" ON "MonetaryTier"("monetaryRuleId", "minCumulativeSpendMinor");
CREATE INDEX "MonetaryTier_monetaryRuleId_minCumulativeSpendMinor_idx" ON "MonetaryTier"("monetaryRuleId", "minCumulativeSpendMinor" DESC);

ALTER TABLE "MonetaryTier" ADD CONSTRAINT "MonetaryTier_monetaryRuleId_fkey"
    FOREIGN KEY ("monetaryRuleId") REFERENCES "MonetaryRule"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── The financial record ────────────────────────────────────────────────────
--
-- Append-only. One row per counter operation, plus one row per reversal. No
-- amount, tier, balance or invoice total is ever edited: a mistake is undone by
-- a linked reversal and both rows stay visible.
CREATE TABLE "MonetaryOperation" (
    "id"                        TEXT NOT NULL,
    -- Groups rows written by one counter action, matching `LoyaltyOperation`.
    "transactionGroupId"        TEXT NOT NULL,

    "businessId"                TEXT NOT NULL,
    "locationId"                TEXT NOT NULL,
    "customerBusinessProfileId" TEXT NOT NULL,
    "customerCardId"            TEXT NOT NULL,
    "templateId"                TEXT NOT NULL,
    "programVersionId"          TEXT NOT NULL,
    "monetaryRuleId"            TEXT NOT NULL,
    -- The tier that produced the rate. NULL on redemption and reversal, which
    -- are not rate-driven.
    "monetaryTierId"            TEXT,

    "kind"                      "MonetaryOperationKind" NOT NULL,

    -- Frozen per row, so history cannot be reinterpreted by a later change.
    "currency"                  TEXT NOT NULL,
    "currencyExponent"          SMALLINT NOT NULL,

    -- **A STAFF ASSERTION.** The pre-discount invoice total as typed at the
    -- counter. Not a receipt, not verified, not revenue. 0 on a reversal,
    -- which asserts no new invoice.
    "grossAmountMinor"          BIGINT NOT NULL,
    -- What the staff member asked to redeem, before capping. Redemption only.
    "requestedRedemptionMinor"  BIGINT,
    -- Signed effect on the card's cashback balance: + earned, - redeemed,
    -- the exact inverse on a reversal, 0 for a discount.
    "cashEffectMinor"           BIGINT NOT NULL,
    -- The discount produced by the rate. Discount rows only.
    "discountMinor"             BIGINT,
    -- What the staff member was told to collect. Calculated, never entered.
    "netCounterAmountMinor"     BIGINT NOT NULL,
    -- The rate applied, copied from the tier so the row survives the tier.
    "rateBasisPoints"           INTEGER,

    -- The card's cashback balance after this row. Chained and checked by
    -- trigger against the previous row, so the chain cannot be forged.
    "cashBalanceAfterMinor"     BIGINT NOT NULL,
    -- Per-card monotonic position. The UNIQUE index below is what serializes
    -- two concurrent writers for one card - see the note on it.
    "cardSequence"              BIGINT NOT NULL,

    "reversalOfId"              TEXT,
    "reason"                    TEXT,
    "performedByUserId"         TEXT,
    "createdAt"                 TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MonetaryOperation_pkey" PRIMARY KEY ("id"),

    -- Nothing is negative, and everything is bounded three orders of magnitude
    -- below int8 so that sums of valid rows stay valid.
    CONSTRAINT "MonetaryOperation_gross_non_negative" CHECK ("grossAmountMinor" >= 0),
    CONSTRAINT "MonetaryOperation_gross_bounded" CHECK ("grossAmountMinor" <= 1000000000000000),
    CONSTRAINT "MonetaryOperation_requested_non_negative" CHECK ("requestedRedemptionMinor" IS NULL OR "requestedRedemptionMinor" >= 0),
    CONSTRAINT "MonetaryOperation_requested_bounded" CHECK ("requestedRedemptionMinor" IS NULL OR "requestedRedemptionMinor" <= 1000000000000000),
    CONSTRAINT "MonetaryOperation_discount_non_negative" CHECK ("discountMinor" IS NULL OR "discountMinor" >= 0),
    CONSTRAINT "MonetaryOperation_net_non_negative" CHECK ("netCounterAmountMinor" >= 0),
    CONSTRAINT "MonetaryOperation_effect_bounded" CHECK ("cashEffectMinor" BETWEEN -1000000000000000 AND 1000000000000000),
    CONSTRAINT "MonetaryOperation_balance_non_negative" CHECK ("cashBalanceAfterMinor" >= 0),
    CONSTRAINT "MonetaryOperation_balance_bounded" CHECK ("cashBalanceAfterMinor" <= 1000000000000000),
    CONSTRAINT "MonetaryOperation_rate_range" CHECK ("rateBasisPoints" IS NULL OR "rateBasisPoints" BETWEEN 0 AND 10000),
    CONSTRAINT "MonetaryOperation_sequence_positive" CHECK ("cardSequence" >= 1),

    -- **A discount can never exceed the invoice.** Stated as a CHECK as well as
    -- in the service, because this is the one that turns a typo into free money.
    CONSTRAINT "MonetaryOperation_discount_within_gross" CHECK ("discountMinor" IS NULL OR "discountMinor" <= "grossAmountMinor"),
    -- And a redemption can never exceed the invoice either. The other half of
    -- the cap - against the BALANCE - is the chain check in the trigger, since
    -- a CHECK cannot see other rows.
    CONSTRAINT "MonetaryOperation_redemption_within_gross" CHECK ("requestedRedemptionMinor" IS NULL OR -"cashEffectMinor" <= "grossAmountMinor"),
    -- The amount collected is what is left of the invoice.
    CONSTRAINT "MonetaryOperation_net_within_gross" CHECK ("netCounterAmountMinor" <= "grossAmountMinor")
);

-- One reversal per operation, enforced by the database rather than by a check
-- the service performs and a concurrent caller skips.
CREATE UNIQUE INDEX "MonetaryOperation_reversalOfId_key" ON "MonetaryOperation"("reversalOfId") WHERE "reversalOfId" IS NOT NULL;

/*
 * The per-card chain, and the serialization point.
 *
 * `cardSequence` is checked by the trigger to be exactly one more than the card's
 * current maximum, so two concurrent writers both computing N collide here: the
 * second blocks on the first's uncommitted index entry and is refused 23505 when
 * the first commits. That is a real mutual exclusion rather than a read-then-write
 * check, for the same reason the API-key slot ceiling is an index and not a
 * trigger - a trigger that SELECTs sees only committed rows.
 */
CREATE UNIQUE INDEX "MonetaryOperation_customerCardId_cardSequence_key" ON "MonetaryOperation"("customerCardId", "cardSequence");

CREATE INDEX "MonetaryOperation_businessId_createdAt_idx" ON "MonetaryOperation"("businessId", "createdAt");
CREATE INDEX "MonetaryOperation_customerCardId_createdAt_idx" ON "MonetaryOperation"("customerCardId", "createdAt");
CREATE INDEX "MonetaryOperation_transactionGroupId_idx" ON "MonetaryOperation"("transactionGroupId");

ALTER TABLE "MonetaryOperation" ADD CONSTRAINT "MonetaryOperation_businessId_fkey"
    FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MonetaryOperation" ADD CONSTRAINT "MonetaryOperation_locationId_fkey"
    FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MonetaryOperation" ADD CONSTRAINT "MonetaryOperation_customerBusinessProfileId_fkey"
    FOREIGN KEY ("customerBusinessProfileId") REFERENCES "CustomerBusinessProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MonetaryOperation" ADD CONSTRAINT "MonetaryOperation_customerCardId_fkey"
    FOREIGN KEY ("customerCardId") REFERENCES "CustomerCard"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MonetaryOperation" ADD CONSTRAINT "MonetaryOperation_templateId_fkey"
    FOREIGN KEY ("templateId") REFERENCES "ProgramTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MonetaryOperation" ADD CONSTRAINT "MonetaryOperation_programVersionId_fkey"
    FOREIGN KEY ("programVersionId") REFERENCES "ProgramVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MonetaryOperation" ADD CONSTRAINT "MonetaryOperation_monetaryRuleId_fkey"
    FOREIGN KEY ("monetaryRuleId") REFERENCES "MonetaryRule"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MonetaryOperation" ADD CONSTRAINT "MonetaryOperation_monetaryTierId_fkey"
    FOREIGN KEY ("monetaryTierId") REFERENCES "MonetaryTier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MonetaryOperation" ADD CONSTRAINT "MonetaryOperation_performedByUserId_fkey"
    FOREIGN KEY ("performedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "MonetaryOperation" ADD CONSTRAINT "MonetaryOperation_reversalOfId_fkey"
    FOREIGN KEY ("reversalOfId") REFERENCES "MonetaryOperation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ════════════════════════════════════════════════════════════════════════════
-- Integrity the service cannot be trusted with alone
-- ════════════════════════════════════════════════════════════════════════════

-- ── The rule and its tiers are frozen once written ──────────────────────────
CREATE OR REPLACE FUNCTION walaaplus_monetary_rule_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  declared SMALLINT;
  version_status TEXT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    /*
     * A RULE MAY ONLY BE ATTACHED TO A DRAFT VERSION.
     *
     * The same rule `reward_tier_protect` enforces for points tiers, and for a
     * stronger reason. A card pins to a version; if a rule could be attached to
     * a version that is already ACTIVE, a business could issue cards under a
     * programme with no rate at all and then decide the rate afterwards, with
     * the cards' own pinning making it look retrospectively agreed.
     *
     * Configuration happens on a DRAFT and is frozen by activation. After that,
     * a rate change is a new version - which is what the customer-facing
     * promise "your card keeps the deal it was sold under" actually means.
     */
    SELECT "status"::text INTO version_status FROM "ProgramVersion" WHERE "id" = NEW."programVersionId";
    IF NOT FOUND THEN
      RAISE EXCEPTION 'MonetaryRule: the program version does not exist' USING ERRCODE = 'check_violation';
    END IF;
    IF version_status <> 'DRAFT' THEN
      RAISE EXCEPTION 'MonetaryRule: a rule is configured on a DRAFT version, not a % one', version_status
        USING ERRCODE = 'restrict_violation',
              HINT = 'Cards pin to a version. A rate change is a new version.';
    END IF;

    -- The exponent is not the caller's to choose: it must be the one this
    -- product records for that currency. A wrong exponent multiplies or divides
    -- every amount in the currency by ten and nothing downstream would notice.
    SELECT "exponent" INTO declared FROM "SupportedCurrency" WHERE "code" = NEW."currency";
    IF NOT FOUND THEN
      RAISE EXCEPTION 'MonetaryRule: % is not a supported currency', NEW."currency"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."currencyExponent" IS DISTINCT FROM declared THEN
      RAISE EXCEPTION 'MonetaryRule: exponent for % is %, not %', NEW."currency", declared, NEW."currencyExponent"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'MonetaryRule is frozen; a rule change is a new program version'
    USING ERRCODE = 'restrict_violation',
          HINT = 'Cards pin to a version. Editing a live rule would change what past cards agreed to.';
END
$$;

CREATE TRIGGER monetary_rule_guard
  BEFORE INSERT OR UPDATE OR DELETE ON "MonetaryRule"
  FOR EACH ROW EXECUTE FUNCTION walaaplus_monetary_rule_guard();

CREATE OR REPLACE FUNCTION walaaplus_monetary_tier_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  lower_rate BIGINT;
  higher_rate BIGINT;
  base_count INTEGER;
  version_status TEXT;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'MonetaryTier is frozen; a tier change is a new program version'
      USING ERRCODE = 'restrict_violation';
  END IF;

  /*
   * TIERS MAY ONLY BE ADDED WHILE THE VERSION IS A DRAFT.
   *
   * Freezing UPDATE and DELETE is not enough on its own: without this, a
   * business could ADD a tier to a live programme - a new top rate, or a new
   * threshold that moves existing customers into a worse band - and every card
   * already pinned to that version would silently start earning at a rate its
   * holder never agreed to. Append-only is not the same as immutable, and for
   * a rate table it is the weaker of the two.
   */
  SELECT v."status"::text INTO version_status
    FROM "MonetaryRule" r JOIN "ProgramVersion" v ON v."id" = r."programVersionId"
   WHERE r."id" = NEW."monetaryRuleId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MonetaryTier: the rule does not exist' USING ERRCODE = 'check_violation';
  END IF;
  IF version_status <> 'DRAFT' THEN
    RAISE EXCEPTION 'MonetaryTier: tiers are configured on a DRAFT version, not a % one', version_status
      USING ERRCODE = 'restrict_violation',
            HINT = 'Cards pin to a version. A rate change is a new version.';
  END IF;

  /*
   * Tier 0 must start at zero.
   *
   * Without it a card with no spend yet would fall through every threshold and
   * have no rate at all - which the service would then have to invent a default
   * for, and an invented rate is exactly the ambiguity this table exists to
   * remove.
   */
  IF NEW."tierIndex" = 0 AND NEW."minCumulativeSpendMinor" <> 0 THEN
    RAISE EXCEPTION 'MonetaryTier: the first tier starts at zero spend'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."tierIndex" > 0 THEN
    -- Contiguous indexes, so "tier 3" cannot exist without tier 2.
    SELECT count(*) INTO base_count FROM "MonetaryTier"
      WHERE "monetaryRuleId" = NEW."monetaryRuleId" AND "tierIndex" = NEW."tierIndex" - 1;
    IF base_count = 0 THEN
      RAISE EXCEPTION 'MonetaryTier: tier % has no tier % below it', NEW."tierIndex", NEW."tierIndex" - 1
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  /*
   * Thresholds rise with the index, in both directions.
   *
   * Checked against neighbours on BOTH sides because rows may arrive in any
   * order: a lower index must not have a higher-or-equal threshold, and a
   * higher index must not have a lower-or-equal one. Equality is already
   * refused by the unique index; this is about ORDER matching the index, which
   * is what makes "the highest threshold at or below spend" a well-defined
   * selection.
   */
  SELECT max("minCumulativeSpendMinor") INTO lower_rate FROM "MonetaryTier"
    WHERE "monetaryRuleId" = NEW."monetaryRuleId" AND "tierIndex" < NEW."tierIndex";
  IF lower_rate IS NOT NULL AND lower_rate >= NEW."minCumulativeSpendMinor" THEN
    RAISE EXCEPTION 'MonetaryTier: threshold % is not above the tier below it', NEW."minCumulativeSpendMinor"
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT min("minCumulativeSpendMinor") INTO higher_rate FROM "MonetaryTier"
    WHERE "monetaryRuleId" = NEW."monetaryRuleId" AND "tierIndex" > NEW."tierIndex";
  IF higher_rate IS NOT NULL AND higher_rate <= NEW."minCumulativeSpendMinor" THEN
    RAISE EXCEPTION 'MonetaryTier: threshold % is not below the tier above it', NEW."minCumulativeSpendMinor"
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER monetary_tier_guard
  BEFORE INSERT OR UPDATE OR DELETE ON "MonetaryTier"
  FOR EACH ROW EXECUTE FUNCTION walaaplus_monetary_tier_guard();

-- ── The financial record: append-only, coherent, and chained ────────────────
CREATE OR REPLACE FUNCTION walaaplus_reject_monetary_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'MonetaryOperation is append-only; % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation',
          HINT = 'Undo a mistake with a linked reversal. Both rows stay visible.';
END
$$;

CREATE TRIGGER monetary_operation_append_only
  BEFORE UPDATE OR DELETE ON "MonetaryOperation"
  FOR EACH ROW EXECUTE FUNCTION walaaplus_reject_monetary_mutation();

CREATE TRIGGER monetary_operation_no_truncate
  BEFORE TRUNCATE ON "MonetaryOperation"
  FOR EACH STATEMENT EXECUTE FUNCTION walaaplus_reject_monetary_mutation();

CREATE OR REPLACE FUNCTION walaaplus_validate_monetary_operation() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  card        "CustomerCard"%ROWTYPE;
  rule        "MonetaryRule"%ROWTYPE;
  tier        "MonetaryTier"%ROWTYPE;
  original    "MonetaryOperation"%ROWTYPE;
  prev_balance BIGINT;
  prev_seq     BIGINT;
  loc_business TEXT;
BEGIN
  -- ── Tenancy, pinning and provenance ───────────────────────────────────────
  SELECT * INTO card FROM "CustomerCard" WHERE "id" = NEW."customerCardId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MonetaryOperation: the card does not exist' USING ERRCODE = 'check_violation';
  END IF;

  IF card."businessId" IS DISTINCT FROM NEW."businessId" THEN
    RAISE EXCEPTION 'MonetaryOperation: the card belongs to a different business'
      USING ERRCODE = 'check_violation';
  END IF;
  IF card."customerBusinessProfileId" IS DISTINCT FROM NEW."customerBusinessProfileId" THEN
    RAISE EXCEPTION 'MonetaryOperation: the card belongs to a different customer'
      USING ERRCODE = 'check_violation';
  END IF;
  IF card."templateId" IS DISTINCT FROM NEW."templateId" THEN
    RAISE EXCEPTION 'MonetaryOperation: the card belongs to a different program'
      USING ERRCODE = 'check_violation';
  END IF;
  /*
   * THE PINNING RULE. The version on the row must be the version the card is
   * pinned to - not the template's current live version. A card agreed to the
   * rates in ITS version, and reading a newer one would silently change the
   * deal after the fact.
   */
  IF card."programVersionId" IS DISTINCT FROM NEW."programVersionId" THEN
    RAISE EXCEPTION 'MonetaryOperation: the card is pinned to a different program version'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT "businessId" INTO loc_business FROM "Location" WHERE "id" = NEW."locationId";
  IF loc_business IS DISTINCT FROM NEW."businessId" THEN
    RAISE EXCEPTION 'MonetaryOperation: the location belongs to a different business'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO rule FROM "MonetaryRule" WHERE "id" = NEW."monetaryRuleId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MonetaryOperation: the rule does not exist' USING ERRCODE = 'check_violation';
  END IF;
  IF rule."programVersionId" IS DISTINCT FROM NEW."programVersionId" THEN
    RAISE EXCEPTION 'MonetaryOperation: the rule belongs to a different program version'
      USING ERRCODE = 'check_violation';
  END IF;

  -- The unit is the rule's unit, and both halves of it must match.
  IF rule."currency" IS DISTINCT FROM NEW."currency" OR rule."currencyExponent" IS DISTINCT FROM NEW."currencyExponent" THEN
    RAISE EXCEPTION 'MonetaryOperation: currency must match the rule exactly'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."monetaryTierId" IS NOT NULL THEN
    SELECT * INTO tier FROM "MonetaryTier" WHERE "id" = NEW."monetaryTierId";
    IF tier."monetaryRuleId" IS DISTINCT FROM NEW."monetaryRuleId" THEN
      RAISE EXCEPTION 'MonetaryOperation: the tier belongs to a different rule'
        USING ERRCODE = 'check_violation';
    END IF;
    -- The rate on the row is the tier's rate. Copying it is what lets the row
    -- outlive the tier; disagreeing with it would be a forged rate.
    IF NEW."rateBasisPoints" IS DISTINCT FROM tier."rateBasisPoints" THEN
      RAISE EXCEPTION 'MonetaryOperation: the rate does not match the tier'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- ── Per-kind coherence ────────────────────────────────────────────────────
  IF NEW."kind"::text = 'CASHBACK_EARNED' THEN
    IF rule."kind"::text <> 'CASHBACK' THEN
      RAISE EXCEPTION 'MonetaryOperation: earning cashback needs a cashback rule' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."monetaryTierId" IS NULL OR NEW."rateBasisPoints" IS NULL THEN
      RAISE EXCEPTION 'MonetaryOperation: a cashback award names the tier that produced it' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."cashEffectMinor" < 0 THEN
      RAISE EXCEPTION 'MonetaryOperation: earning cashback does not reduce a balance' USING ERRCODE = 'check_violation';
    END IF;
    -- Earning does not change what the customer pays today.
    IF NEW."netCounterAmountMinor" IS DISTINCT FROM NEW."grossAmountMinor" THEN
      RAISE EXCEPTION 'MonetaryOperation: earning cashback does not change the amount collected' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."requestedRedemptionMinor" IS NOT NULL OR NEW."discountMinor" IS NOT NULL THEN
      RAISE EXCEPTION 'MonetaryOperation: an earning row carries no redemption or discount' USING ERRCODE = 'check_violation';
    END IF;
    -- The amount is the rate applied to the invoice, rounded half-up. Recomputed
    -- here so a service bug cannot write a number the rules do not produce.
    IF NEW."cashEffectMinor" IS DISTINCT FROM ((NEW."grossAmountMinor" * NEW."rateBasisPoints" + 5000) / 10000) THEN
      RAISE EXCEPTION 'MonetaryOperation: cashback % is not % basis points of % rounded half-up',
        NEW."cashEffectMinor", NEW."rateBasisPoints", NEW."grossAmountMinor" USING ERRCODE = 'check_violation';
    END IF;

  ELSIF NEW."kind"::text = 'CASHBACK_REDEEMED' THEN
    IF rule."kind"::text <> 'CASHBACK' THEN
      RAISE EXCEPTION 'MonetaryOperation: redeeming cashback needs a cashback rule' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."requestedRedemptionMinor" IS NULL THEN
      RAISE EXCEPTION 'MonetaryOperation: a redemption records what was asked for' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."cashEffectMinor" > 0 THEN
      RAISE EXCEPTION 'MonetaryOperation: redeeming cashback does not add to a balance' USING ERRCODE = 'check_violation';
    END IF;
    IF -NEW."cashEffectMinor" > NEW."requestedRedemptionMinor" THEN
      RAISE EXCEPTION 'MonetaryOperation: more was redeemed than was asked for' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."netCounterAmountMinor" IS DISTINCT FROM NEW."grossAmountMinor" + NEW."cashEffectMinor" THEN
      RAISE EXCEPTION 'MonetaryOperation: the amount collected is the invoice less the redemption' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."discountMinor" IS NOT NULL OR NEW."monetaryTierId" IS NOT NULL OR NEW."rateBasisPoints" IS NOT NULL THEN
      RAISE EXCEPTION 'MonetaryOperation: a redemption is not rate-driven' USING ERRCODE = 'check_violation';
    END IF;

  ELSIF NEW."kind"::text = 'DISCOUNT_APPLIED' THEN
    IF rule."kind"::text <> 'DISCOUNT' THEN
      RAISE EXCEPTION 'MonetaryOperation: a discount needs a discount rule' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."monetaryTierId" IS NULL OR NEW."rateBasisPoints" IS NULL OR NEW."discountMinor" IS NULL THEN
      RAISE EXCEPTION 'MonetaryOperation: a discount names the tier, the rate and the amount' USING ERRCODE = 'check_violation';
    END IF;
    -- A discount is not cashback: it must not move the balance.
    IF NEW."cashEffectMinor" <> 0 THEN
      RAISE EXCEPTION 'MonetaryOperation: a discount does not change the cashback balance' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."netCounterAmountMinor" IS DISTINCT FROM NEW."grossAmountMinor" - NEW."discountMinor" THEN
      RAISE EXCEPTION 'MonetaryOperation: the amount collected is the invoice less the discount' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."requestedRedemptionMinor" IS NOT NULL THEN
      RAISE EXCEPTION 'MonetaryOperation: a discount row carries no redemption' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."discountMinor" IS DISTINCT FROM ((NEW."grossAmountMinor" * NEW."rateBasisPoints" + 5000) / 10000) THEN
      RAISE EXCEPTION 'MonetaryOperation: discount % is not % basis points of % rounded half-up',
        NEW."discountMinor", NEW."rateBasisPoints", NEW."grossAmountMinor" USING ERRCODE = 'check_violation';
    END IF;

  ELSIF NEW."kind"::text = 'REVERSAL' THEN
    IF NEW."reversalOfId" IS NULL THEN
      RAISE EXCEPTION 'MonetaryOperation: a reversal names what it reverses' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."reason" IS NULL OR btrim(NEW."reason") = '' THEN
      RAISE EXCEPTION 'MonetaryOperation: a reversal records why' USING ERRCODE = 'check_violation';
    END IF;

    SELECT * INTO original FROM "MonetaryOperation" WHERE "id" = NEW."reversalOfId";
    IF NOT FOUND THEN
      RAISE EXCEPTION 'MonetaryOperation: the reversed operation does not exist' USING ERRCODE = 'check_violation';
    END IF;
    -- A reversal cannot be reversed: undoing an undo is a new operation, not a
    -- second negation, and allowing it makes the chain ambiguous.
    IF original."kind"::text = 'REVERSAL' THEN
      RAISE EXCEPTION 'MonetaryOperation: a reversal cannot itself be reversed' USING ERRCODE = 'check_violation';
    END IF;
    IF original."customerCardId" IS DISTINCT FROM NEW."customerCardId" THEN
      RAISE EXCEPTION 'MonetaryOperation: a reversal belongs to the same card' USING ERRCODE = 'check_violation';
    END IF;
    IF original."currency" IS DISTINCT FROM NEW."currency" THEN
      RAISE EXCEPTION 'MonetaryOperation: a reversal is in the same currency' USING ERRCODE = 'check_violation';
    END IF;
    -- The exact inverse, not an amount somebody chose.
    IF NEW."cashEffectMinor" IS DISTINCT FROM -original."cashEffectMinor" THEN
      RAISE EXCEPTION 'MonetaryOperation: a reversal undoes exactly what was done' USING ERRCODE = 'check_violation';
    END IF;
    -- A reversal asserts no invoice of its own.
    IF NEW."grossAmountMinor" <> 0 OR NEW."netCounterAmountMinor" <> 0
       OR NEW."discountMinor" IS NOT NULL OR NEW."requestedRedemptionMinor" IS NOT NULL THEN
      RAISE EXCEPTION 'MonetaryOperation: a reversal carries no invoice of its own' USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    RAISE EXCEPTION 'MonetaryOperation: no rule exists for kind %', NEW."kind" USING ERRCODE = 'check_violation';
  END IF;

  -- ── The chain ─────────────────────────────────────────────────────────────
  /*
   * The balance is not a column somebody sets; it is the previous row's balance
   * plus this row's effect, and the sequence is the previous row's plus one.
   *
   * This is what makes the history tamper-evident: a forged balance cannot be
   * inserted without disagreeing with the row before it, and a row cannot be
   * slipped in out of order. The unique index on (card, sequence) is what makes
   * it safe under concurrency - two writers computing the same next sequence
   * collide there rather than both succeeding.
   */
  SELECT "cashBalanceAfterMinor", "cardSequence" INTO prev_balance, prev_seq
    FROM "MonetaryOperation"
   WHERE "customerCardId" = NEW."customerCardId"
   ORDER BY "cardSequence" DESC
   LIMIT 1;

  IF NOT FOUND THEN
    prev_balance := 0;
    prev_seq := 0;
  END IF;

  IF NEW."cardSequence" IS DISTINCT FROM prev_seq + 1 THEN
    RAISE EXCEPTION 'MonetaryOperation: sequence % does not follow %', NEW."cardSequence", prev_seq
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."cashBalanceAfterMinor" IS DISTINCT FROM prev_balance + NEW."cashEffectMinor" THEN
    RAISE EXCEPTION 'MonetaryOperation: balance % does not follow % with effect %',
      NEW."cashBalanceAfterMinor", prev_balance, NEW."cashEffectMinor" USING ERRCODE = 'check_violation';
  END IF;

  /*
   * **The balance cap, which a CHECK cannot express.** A redemption may not take
   * the balance below zero, and the non-negative CHECK on the column is what
   * catches it - but stating it here names the rule rather than leaving it as a
   * side effect of a bound.
   */
  IF NEW."cashBalanceAfterMinor" < 0 THEN
    RAISE EXCEPTION 'MonetaryOperation: redeeming % would overdraw a balance of %',
      -NEW."cashEffectMinor", prev_balance USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER monetary_operation_validate
  BEFORE INSERT ON "MonetaryOperation"
  FOR EACH ROW EXECUTE FUNCTION walaaplus_validate_monetary_operation();

-- Reference data is not the application's to change.
CREATE OR REPLACE FUNCTION walaaplus_reject_currency_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'SupportedCurrency is reference data; % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation',
          HINT = 'Changing an exponent would reinterpret every historical amount in that currency.';
END
$$;

CREATE TRIGGER supported_currency_frozen
  BEFORE UPDATE OR DELETE ON "SupportedCurrency"
  FOR EACH ROW EXECUTE FUNCTION walaaplus_reject_currency_mutation();
