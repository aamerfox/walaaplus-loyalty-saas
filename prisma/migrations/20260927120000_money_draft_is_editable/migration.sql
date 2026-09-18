-- ════════════════════════════════════════════════════════════════════════════
-- Migration 22 — a money programme's DRAFT is configurable; everything live stays frozen
-- ════════════════════════════════════════════════════════════════════════════
--
-- WHAT THIS FIXES
--
-- Migration 21 froze `MonetaryRule` and `MonetaryTier` against UPDATE and DELETE UNCONDITIONALLY -
-- from the moment a row was inserted, rather than from the moment its version went live.
--
-- The invariant it was protecting is the one its own message states: a LIVE rate never changes,
-- because cards pin to a version. That is about ACTIVE versions. A DRAFT version has no cards
-- pinned to it - `CustomerCard.programVersionId` can only name a version that was ACTIVE when the
-- card was issued - so editing a draft changes nothing anybody agreed to.
--
-- Probed against the database before this migration was written:
--
--   UPDATE MonetaryTier rate on a DRAFT version   REFUSED  "MonetaryTier is frozen"
--   DELETE MonetaryTier on a DRAFT version        REFUSED  "MonetaryTier is frozen"
--   DELETE MonetaryRule on a DRAFT version        REFUSED  "MonetaryRule is frozen"
--
-- So an owner who mistyped a rate could not correct it and could not remove it. The only way out of
-- a typo was to publish it.
--
-- WHAT CHANGES
--
--   INSERT on a DRAFT version        allowed      (unchanged)
--   INSERT on ACTIVE or RETIRED      refused      (unchanged)
--   UPDATE/DELETE on a DRAFT         REFUSED -> ALLOWED, with the reassignment guards in §3
--   UPDATE/DELETE on ACTIVE/RETIRED  refused      (unchanged - same message, same SQLSTATE)
--   TRUNCATE on any money table      refused      (NEW: was privilege-only, now a trigger)
--   Activating a money version       NEW: refused unless its rule and tier set are complete
--
-- Every post-activation guarantee is identical and the tests red-prove it. `MonetaryOperation` is
-- not touched: the financial record stays append-only and nothing here lets a recorded operation
-- change. Migrations 14-21 are not amended.
--
-- WHY A DISCARDED DRAFT IS NOT DELETED
--
-- An earlier draft of this migration assumed the owner service would delete a money draft's tiers,
-- then its rule, then the version. **Program versions are retired, never deleted.** No DELETE on
-- `ProgramVersion` is granted here and no destructive path is added: a discarded money draft moves
-- to RETIRED through the ordinary lifecycle, and `walaaplus_protect_program_version` (migration 1)
-- already refuses RETIRED -> anything, so an abandoned draft can never be activated later.
--
-- WHY THE RUNTIME ROLE ALSO HAD TO CHANGE
--
-- A trigger that permits a DRAFT edit is irrelevant if the role cannot issue the statement.
-- `scripts/db-roles.mjs` classed these two tables as append-only, so `walaaplus_app` held
-- SELECT/INSERT only. PostgreSQL table privileges are not lifecycle-aware, so the grant has to be
-- UPDATE/DELETE at table level and **the triggers below are the lifecycle enforcement**. That split
-- is deliberate and is proved through the restricted runtime role, not through the migrator.

-- ── The rule: configurable while DRAFT, frozen the moment it is not ──────────

CREATE OR REPLACE FUNCTION walaaplus_monetary_rule_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  declared SMALLINT;
  version_status TEXT;
  old_status TEXT;
  business_currency TEXT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    /*
     * A RULE MAY ONLY BE ATTACHED TO A DRAFT VERSION.
     *
     * A card pins to a version; if a rule could be attached to a version that is already ACTIVE, a
     * business could issue cards under a programme with no rate at all and then decide the rate
     * afterwards, with the cards' own pinning making it look retrospectively agreed.
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

    /*
     * THE CURRENCY IS THE BUSINESS'S, AND IS NOT THE MERCHANT'S TO CHOOSE.
     *
     * `docs/PHASE-4-MONEY-CONTRACT.md` §1.3: a programme is denominated in `Business.currency`, read
     * once and frozen, because there is no conversion layer anywhere in this product and no rate
     * source. A rule in a currency the till does not take is a balance nobody can spend.
     *
     * An earlier draft of migration 22 let a DRAFT rule's currency be edited, and a test asserted
     * that as correct. It was not: it would have let a merchant denominate a programme in USD while
     * their business trades in SYP, and supplying a matching exponent would have made it look valid.
     * The exponent check below is about the UNIT being right for the currency; this one is about the
     * CURRENCY being right for the business, and neither implies the other.
     */
    SELECT upper(btrim(b."currency")) INTO business_currency
      FROM "ProgramVersion" v
      JOIN "ProgramTemplate" t ON t."id" = v."templateId"
      JOIN "Business" b ON b."id" = t."businessId"
     WHERE v."id" = NEW."programVersionId";

    IF NEW."currency" IS DISTINCT FROM business_currency THEN
      RAISE EXCEPTION 'MonetaryRule: the currency is the business''s (%), not %', business_currency, NEW."currency"
        USING ERRCODE = 'check_violation',
              HINT = 'Currency comes from the business. There is no conversion anywhere in this product.';
    END IF;

    -- The exponent is not the caller's to choose: it must be the one this product records for that
    -- currency. A wrong exponent multiplies or divides every amount by ten and nothing downstream
    -- would notice.
    SELECT "exponent" INTO declared FROM "SupportedCurrency" WHERE "code" = NEW."currency";
    /*
     * NOT FOUND is deliberately NOT raised here. `MonetaryRule_currency_fkey` is the layer that
     * refuses a code this product records no exponent for, and it has to stay INDEPENDENTLY
     * load-bearing. A trigger raising first would make the foreign key unreachable: dropping the
     * key would then change nothing observable, and a layer whose removal changes nothing is not
     * a layer. Each one here must be able to fail on its own — see the per-layer proof in
     * docs/evidence/phase-4-prompt-2.md, where each is removed alone and the case it owns passes.
     */
    IF FOUND AND NEW."currencyExponent" IS DISTINCT FROM declared THEN
      RAISE EXCEPTION 'MonetaryRule: exponent for % is %, not %', NEW."currency", declared, NEW."currencyExponent"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  /*
   * UPDATE and DELETE: permitted ONLY while the owning version is still a DRAFT.
   *
   * The OLD side decides whether the row is editable at all. Checking only the NEW side would let a
   * live rule be edited by pointing it at a draft in the same statement.
   */
  SELECT "status"::text INTO old_status FROM "ProgramVersion" WHERE "id" = OLD."programVersionId";
  IF old_status IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'MonetaryRule is frozen; a rule change is a new program version'
      USING ERRCODE = 'restrict_violation',
            HINT = 'Cards pin to a version. Editing a live rule would change what past cards agreed to.';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  /*
   * NO MOVING CONFIGURATION AROUND THE FREEZE.
   *
   * Re-pointing a rule at a different version would carry a draft's configuration into a live
   * programme, or move a live rule out of reach of the check above - and across tenants, because a
   * version belongs to a template which belongs to a business. The identity of a rule is the version
   * it configures; changing that is not an edit, it is a different rule.
   */
  IF NEW."programVersionId" IS DISTINCT FROM OLD."programVersionId" THEN
    RAISE EXCEPTION 'MonetaryRule: a rule cannot be moved to a different program version'
      USING ERRCODE = 'restrict_violation',
            HINT = 'Configure a rule on the version it belongs to. Moving one would cross a lifecycle or a tenant boundary.';
  END IF;

  /*
   * THE CURRENCY IS THE BUSINESS'S, AND IS NOT THE MERCHANT'S TO CHOOSE.
   *
   * `docs/PHASE-4-MONEY-CONTRACT.md` §1.3: a programme is denominated in `Business.currency`, read
   * once and frozen, because there is no conversion layer anywhere in this product and no rate
   * source. A rule in a currency the till does not take is a balance nobody can spend.
   *
   * An earlier draft of migration 22 let a DRAFT rule's currency be edited, and a test asserted
   * that as correct. It was not: it would have let a merchant denominate a programme in USD while
   * their business trades in SYP, and supplying a matching exponent would have made it look valid.
   * The exponent check below is about the UNIT being right for the currency; this one is about the
   * CURRENCY being right for the business, and neither implies the other.
   */
  SELECT upper(btrim(b."currency")) INTO business_currency
    FROM "ProgramVersion" v
    JOIN "ProgramTemplate" t ON t."id" = v."templateId"
    JOIN "Business" b ON b."id" = t."businessId"
   WHERE v."id" = OLD."programVersionId";

  IF NEW."currency" IS DISTINCT FROM business_currency THEN
    RAISE EXCEPTION 'MonetaryRule: the currency is the business''s (%), not %', business_currency, NEW."currency"
      USING ERRCODE = 'check_violation',
            HINT = 'Currency comes from the business. There is no conversion anywhere in this product.';
  END IF;

  -- Re-validated on every edit, not only on insert: the exponent must still be the one this product
  -- records for the business's currency.
  SELECT "exponent" INTO declared FROM "SupportedCurrency" WHERE "code" = NEW."currency";
  /*
   * NOT FOUND is deliberately NOT raised here. `MonetaryRule_currency_fkey` is the layer that
   * refuses a code this product records no exponent for, and it has to stay INDEPENDENTLY
   * load-bearing. A trigger raising first would make the foreign key unreachable: dropping the
   * key would then change nothing observable, and a layer whose removal changes nothing is not
   * a layer. Each one here must be able to fail on its own — see the per-layer proof in
   * docs/evidence/phase-4-prompt-2.md, where each is removed alone and the case it owns passes.
   */
  IF FOUND AND NEW."currencyExponent" IS DISTINCT FROM declared THEN
    RAISE EXCEPTION 'MonetaryRule: exponent for % is %, not %', NEW."currency", declared, NEW."currencyExponent"
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$$;

-- ── The tiers: same window, same reassignment guard, same validations ────────

CREATE OR REPLACE FUNCTION walaaplus_monetary_tier_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  lower_rate BIGINT;
  higher_rate BIGINT;
  base_count INTEGER;
  version_status TEXT;
  old_status TEXT;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    /*
     * UPDATE and DELETE: permitted ONLY while the owning version is still a DRAFT. The OLD side
     * decides, for the same reason as the rule guard above.
     */
    SELECT v."status"::text INTO old_status
      FROM "MonetaryRule" r JOIN "ProgramVersion" v ON v."id" = r."programVersionId"
     WHERE r."id" = OLD."monetaryRuleId";

    IF old_status IS DISTINCT FROM 'DRAFT' THEN
      RAISE EXCEPTION 'MonetaryTier is frozen; a tier change is a new program version'
        USING ERRCODE = 'restrict_violation';
    END IF;

    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;

    -- No moving a tier between rules: that would carry a draft's rate into a live rate table, or
    -- across tenants, without either guard above ever seeing it.
    IF NEW."monetaryRuleId" IS DISTINCT FROM OLD."monetaryRuleId" THEN
      RAISE EXCEPTION 'MonetaryTier: a tier cannot be moved to a different rule'
        USING ERRCODE = 'restrict_violation',
              HINT = 'A tier belongs to the rule it was configured on. Moving one would cross a lifecycle or a tenant boundary.';
    END IF;
    -- Falls through to the same ordering validations an INSERT runs, below.
  ELSE
    /*
     * TIERS MAY ONLY BE ADDED WHILE THE VERSION IS A DRAFT.
     *
     * Freezing UPDATE and DELETE is not enough on its own: without this, a business could ADD a tier
     * to a live programme - a new top rate, or a new threshold that moves existing customers into a
     * worse band - and every card already pinned to that version would silently start earning at a
     * rate its holder never agreed to.
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
  END IF;

  /*
   * Tier 0 must start at zero.
   *
   * Without it a card with no spend yet would fall through every threshold and have no rate at all -
   * which the service would then have to invent a default for, and an invented rate is exactly the
   * ambiguity this table exists to remove.
   */
  IF NEW."tierIndex" = 0 AND NEW."minCumulativeSpendMinor" <> 0 THEN
    RAISE EXCEPTION 'MonetaryTier: the first tier starts at zero spend'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."tierIndex" > 0 THEN
    -- Contiguous indexes, so "tier 3" cannot exist without tier 2.
    SELECT count(*) INTO base_count FROM "MonetaryTier"
      WHERE "monetaryRuleId" = NEW."monetaryRuleId" AND "tierIndex" = NEW."tierIndex" - 1
        AND "id" <> NEW."id";
    IF base_count = 0 THEN
      RAISE EXCEPTION 'MonetaryTier: tier % has no tier % below it', NEW."tierIndex", NEW."tierIndex" - 1
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  /*
   * Thresholds rise with the index, in both directions.
   *
   * Checked against neighbours on BOTH sides because rows may arrive in any order: a lower index
   * must not have a higher-or-equal threshold, and a higher index must not have a lower-or-equal
   * one. Equality is already refused by the unique index; this is about ORDER matching the index,
   * which is what makes "the highest threshold at or below spend" a well-defined selection.
   */
  SELECT max("minCumulativeSpendMinor") INTO lower_rate FROM "MonetaryTier"
    WHERE "monetaryRuleId" = NEW."monetaryRuleId" AND "tierIndex" < NEW."tierIndex" AND "id" <> NEW."id";
  IF lower_rate IS NOT NULL AND lower_rate >= NEW."minCumulativeSpendMinor" THEN
    RAISE EXCEPTION 'MonetaryTier: threshold % is not above the tier below it', NEW."minCumulativeSpendMinor"
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT min("minCumulativeSpendMinor") INTO higher_rate FROM "MonetaryTier"
    WHERE "monetaryRuleId" = NEW."monetaryRuleId" AND "tierIndex" > NEW."tierIndex" AND "id" <> NEW."id";
  IF higher_rate IS NOT NULL AND higher_rate <= NEW."minCumulativeSpendMinor" THEN
    RAISE EXCEPTION 'MonetaryTier: threshold % is not below the tier above it', NEW."minCumulativeSpendMinor"
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$$;

-- ── TRUNCATE is refused for every money table, for the OWNER too ─────────────
--
-- Migration 21 gave `MonetaryOperation` a no-truncate trigger. The other three were protected only
-- by the absence of a privilege, which stops the runtime role and not the table owner. A truncated
-- rate table would silently remove the rates live cards are pinned to.

CREATE OR REPLACE FUNCTION walaaplus_reject_money_truncate() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is money configuration; TRUNCATE is not permitted', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation',
          HINT = 'Rates live cards are pinned to are not removable in bulk.';
END
$$;

CREATE TRIGGER monetary_rule_no_truncate
  BEFORE TRUNCATE ON "MonetaryRule"
  FOR EACH STATEMENT EXECUTE FUNCTION walaaplus_reject_money_truncate();

CREATE TRIGGER monetary_tier_no_truncate
  BEFORE TRUNCATE ON "MonetaryTier"
  FOR EACH STATEMENT EXECUTE FUNCTION walaaplus_reject_money_truncate();

CREATE TRIGGER supported_currency_no_truncate
  BEFORE TRUNCATE ON "SupportedCurrency"
  FOR EACH STATEMENT EXECUTE FUNCTION walaaplus_reject_money_truncate();

-- ── A money version cannot go live half-configured ───────────────────────────
--
-- Until now, "the rate table is complete" was a service promise. A direct writer could activate a
-- CASHBACK version with no rule, no tiers, or a tier set that no longer makes "which tier applies" a
-- well-defined question - and every card issued afterwards would pin to it.
--
-- The per-row tier guard cannot see this: it validates one row against its neighbours at write time,
-- and says nothing about whether the SET is complete at the moment of activation. This does.
--
-- It runs as its own trigger rather than by replacing `walaaplus_protect_program_version`, which is
-- migration 1's and is shared by every card type. Both are BEFORE UPDATE and both must pass.

CREATE OR REPLACE FUNCTION walaaplus_validate_money_version_activation() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  card_type   TEXT;
  rule        "MonetaryRule"%ROWTYPE;
  rule_count  INTEGER;
  tier_count  INTEGER;
  declared    SMALLINT;
  expected_kind TEXT;
  bad_index   INTEGER;
BEGIN
  -- Only the transition INTO active matters. Retiring, or an unrelated column changing on a row that
  -- is already ACTIVE, is somebody else's rule.
  IF NEW."status"::text <> 'ACTIVE' OR OLD."status"::text = 'ACTIVE' THEN
    RETURN NEW;
  END IF;

  SELECT t."cardType"::text INTO card_type
    FROM "ProgramTemplate" t WHERE t."id" = NEW."templateId";

  SELECT count(*) INTO rule_count FROM "MonetaryRule" WHERE "programVersionId" = NEW."id";

  IF card_type NOT IN ('CASHBACK', 'DISCOUNT') THEN
    /*
     * A stamp or points version must carry NO money rule. The reverse of the check below, and worth
     * making explicit: a rule attached to a stamp version would be unreachable configuration that
     * looks authoritative.
     */
    IF rule_count > 0 THEN
      RAISE EXCEPTION 'ProgramVersion: a % version cannot carry a monetary rule', card_type
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  expected_kind := card_type;

  IF rule_count <> 1 THEN
    RAISE EXCEPTION 'ProgramVersion: a % version needs exactly one monetary rule to be activated, found %',
      card_type, rule_count USING ERRCODE = 'check_violation',
      HINT = 'Configure the rate table on the draft before publishing it.';
  END IF;

  SELECT * INTO rule FROM "MonetaryRule" WHERE "programVersionId" = NEW."id";

  IF rule."kind"::text <> expected_kind THEN
    RAISE EXCEPTION 'ProgramVersion: a % version carries a % rule', card_type, rule."kind"
      USING ERRCODE = 'check_violation';
  END IF;

  -- The unit, re-checked at the moment it becomes real for customers.
  SELECT "exponent" INTO declared FROM "SupportedCurrency" WHERE "code" = rule."currency";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ProgramVersion: % is not a supported currency', rule."currency"
      USING ERRCODE = 'check_violation';
  END IF;
  IF rule."currencyExponent" IS DISTINCT FROM declared THEN
    RAISE EXCEPTION 'ProgramVersion: exponent for % is %, not %', rule."currency", declared, rule."currencyExponent"
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT count(*) INTO tier_count FROM "MonetaryTier" WHERE "monetaryRuleId" = rule."id";
  IF tier_count = 0 THEN
    RAISE EXCEPTION 'ProgramVersion: a % version needs at least one rate to be activated', card_type
      USING ERRCODE = 'check_violation',
      HINT = 'Configure the rate table on the draft before publishing it.';
  END IF;

  -- Tier 0 at threshold 0, so a card with no history always has a rate.
  IF NOT EXISTS (
    SELECT 1 FROM "MonetaryTier"
     WHERE "monetaryRuleId" = rule."id" AND "tierIndex" = 0 AND "minCumulativeSpendMinor" = 0
  ) THEN
    RAISE EXCEPTION 'ProgramVersion: the first rate must start at zero spend'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Contiguous 0..n-1. `max(index) = count - 1` together with the unique index on (rule, index) is
  -- exactly contiguity: n distinct indexes, none negative, the largest being n-1.
  SELECT max("tierIndex") INTO bad_index FROM "MonetaryTier" WHERE "monetaryRuleId" = rule."id";
  IF bad_index <> tier_count - 1 THEN
    RAISE EXCEPTION 'ProgramVersion: the rate table has a gap; % rates but the highest index is %',
      tier_count, bad_index USING ERRCODE = 'check_violation';
  END IF;

  -- Strictly increasing with the index, so "the highest threshold at or below spend" is well defined.
  IF EXISTS (
    SELECT 1
      FROM "MonetaryTier" a JOIN "MonetaryTier" b
        ON a."monetaryRuleId" = b."monetaryRuleId" AND b."tierIndex" = a."tierIndex" + 1
     WHERE a."monetaryRuleId" = rule."id"
       AND b."minCumulativeSpendMinor" <= a."minCumulativeSpendMinor"
  ) THEN
    RAISE EXCEPTION 'ProgramVersion: rate thresholds must increase with the tier'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Rates in range. The column CHECK already says this; restating it here means activation cannot
  -- succeed against a row written before that CHECK existed.
  IF EXISTS (
    SELECT 1 FROM "MonetaryTier"
     WHERE "monetaryRuleId" = rule."id" AND ("rateBasisPoints" < 0 OR "rateBasisPoints" > 10000)
  ) THEN
    RAISE EXCEPTION 'ProgramVersion: every rate must be between 0 and 10000 basis points'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER program_version_validate_money_activation
  BEFORE UPDATE ON "ProgramVersion"
  FOR EACH ROW EXECUTE FUNCTION walaaplus_validate_money_version_activation();

-- ── A money program version is never DELETED, only retired ───────────────────
--
-- `walaaplus_protect_program_version` (migration 1) permits deleting a DRAFT version, and the
-- runtime role holds DELETE on `ProgramVersion` from the Phase 0 blanket grant. For stamp and points
-- that is the existing discard flow and it is deliberately left alone.
--
-- For money it is a hole, and it opened the moment this migration made a draft's rule and tiers
-- removable. Reproduced through the RESTRICTED RUNTIME ROLE before this guard was written:
--
--   DELETE MonetaryRule (draft)        -> ALLOWED   (correct: §1 of this migration)
--   DELETE ProgramVersion (CASHBACK)   -> ALLOWED   <-- the gap; the FK was the only thing stopping it
--
-- The foreign key from `MonetaryRule` was doing the protecting by accident, and once the rule was
-- legitimately removed the version could be destroyed - taking with it the record that a programme
-- version ever existed, and the version number a future card might otherwise have referenced.
--
-- A money draft is discarded by moving it to RETIRED. It stays immutable there: migration 1 already
-- refuses RETIRED -> anything, so an abandoned draft can never be activated later.
--
-- The blanket privilege is NOT revoked, because revoking it would break the stamp and points discard
-- flow, which is unrelated to this work. The guard is narrowed to the two money card types instead,
-- and a positive control in the tests proves stamp and points still delete exactly as before.

CREATE OR REPLACE FUNCTION walaaplus_protect_money_program_version() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  card_type TEXT;
BEGIN
  SELECT t."cardType"::text INTO card_type FROM "ProgramTemplate" t WHERE t."id" = OLD."templateId";

  IF card_type IN ('CASHBACK', 'DISCOUNT') THEN
    RAISE EXCEPTION 'ProgramVersion: a % version is retired, never deleted', card_type
      USING ERRCODE = 'restrict_violation',
            HINT = 'Discard a money draft by retiring it. A retired version stays immutable and cannot be activated.';
  END IF;

  RETURN OLD;
END
$$;

CREATE TRIGGER program_version_protect_money_delete
  BEFORE DELETE ON "ProgramVersion"
  FOR EACH ROW EXECUTE FUNCTION walaaplus_protect_money_program_version();

-- The `monetary_rule_guard` and `monetary_tier_guard` triggers are NOT recreated: `CREATE OR REPLACE
-- FUNCTION` re-points them at the new bodies, so neither table is ever unprotected.
