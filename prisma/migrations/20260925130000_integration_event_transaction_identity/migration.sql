-- ════════════════════════════════════════════════════════════════════════════
-- Foundation correction - IntegrationEvent transaction identity
-- ════════════════════════════════════════════════════════════════════════════
--
-- WHAT THIS FIXES
--
-- Migration 14 (20260920120000_integration_events) proves that an event was written in the SAME
-- TRANSACTION as the action it describes by comparing two TIMESTAMP(3) values. Migration 14 states
-- its own residual accurately: two DIFFERENT transactions that begin inside the same millisecond
-- compare EQUAL, and the check passes.
--
-- That is not theoretical. Measured on this project's own database, 3 of 399 consecutive separate
-- transactions shared a TIMESTAMP(3) - about 1 in 125 - and a writer attempting a backfill can
-- simply retry. The rule stopped accidental backfill of OLD rows completely, and stopped a
-- deliberate writer not at all.
--
-- It was found by a FAILED Phase 4 engineering gate, not by review: the integrity test that asserts
-- the rule fails at exactly the rate the window opens.
--
-- WHY THIS MIGRATION IS ORDERED HERE
--
-- Named to sort after deployed migration 19 (20260925120000_api_key_name_active_only) and BEFORE
-- the in-progress Phase 4 migration (20260926120000_cashback_and_discount_core), so staging can
-- deploy this correction WITHOUT deploying incomplete Phase 4 work.
--
-- Migrations 14-19 are byte-for-byte unchanged. Both functions below are replaced with
-- CREATE OR REPLACE; no applied migration file is edited, so no checksum moves.
--
-- WHAT IS AND IS NOT TOUCHED
--
--   * ADDS one nullable column. No row is rewritten, deleted, backfilled, reset or seeded.
--   * REPLACES two trigger FUNCTIONS. The triggers themselves, the append-only triggers and the
--     no-truncate triggers are untouched.
--   * Every migration-14 validation rule is preserved: the server-assigned `occurredAt`, the event
--     type to entry-kind mapping, "the redemption does not exist", the tenant check, the entry-kind
--     check, and the fatal fallthrough for an unknown entityType. The function bodies below were
--     EXTRACTED from the applied migrations and edited in place rather than retyped, and the diff
--     is recorded in the evidence.

-- ── The column ───────────────────────────────────────────────────────────────
--
-- NULLABLE, and it must stay that way. Redemptions already exist; giving them an invented identity
-- would be a fabricated claim about when they were written. NULL means "predates the guarantee",
-- and the event rule refuses it - see the note in the function below.
--
-- `xid8` rather than `xid`: 64-bit and wraparound-free, so a stored value cannot come to mean a
-- different transaction later.

ALTER TABLE "PromotionRedemption" ADD COLUMN "writeXactId" xid8;

-- ── The redemption trigger also stamps the identity ──────────────────────────

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
  /*
   * The moment is the server's, and only the server's.
   *
   * Everything below that asks "was this promotion running then?" reads `recordedAt`, so a caller
   * that chooses it chooses the answer: a row dated last month redeems a promotion that ended last
   * week, and a row dated next year redeems one that has not started. Overwriting here closes that
   * for the service AND for any direct writer, which is the only way it stays closed.
   *
   * `now()` is the transaction's start time, so a redemption and the audit row written beside it
   * agree. `AT TIME ZONE 'UTC'` is explicit because the column is a bare TIMESTAMP(3) holding UTC:
   * an implicit cast would be right only while the session's TimeZone happens to be UTC.
   *
   * This is deliberately not conditional on the entry kind. A backdated VOIDED row would be a
   * falsified withdrawal, which is the same problem wearing the other hat.
   */
  NEW."recordedAt" := (now() AT TIME ZONE 'UTC');

  /*
   * THE TRANSACTION IDENTITY, assigned by the server exactly as the moment above is.
   *
   * `pg_current_xact_id()` returns this transaction's id - the TOP-LEVEL one, identical at every
   * savepoint depth, which is the property the whole correction rests on. Whatever a caller
   * supplied is discarded here, so the identity can no more be chosen than `recordedAt` can.
   *
   * It is `xid8`: 64-bit and wraparound-free, which is what makes it safe to persist and compare
   * later. The 32-bit `xid` type would eventually reuse values and is not usable for this.
   */
  NEW."writeXactId" := pg_current_xact_id();

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

-- ── The event trigger proves identity, not proximity ─────────────────────────

CREATE OR REPLACE FUNCTION walaaplus_validate_integration_event() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  redemption "PromotionRedemption"%ROWTYPE;
  expected_entry "RedemptionEntry";
BEGIN
  /*
   * The moment is the server's. See the note on the column.
   *
   * `now()` is the transaction's start time, so an event and the row it describes agree exactly —
   * which is the point, since they are written in one transaction. `AT TIME ZONE 'UTC'` is explicit
   * because the column is a bare TIMESTAMP(3) holding UTC; an implicit cast would be right only
   * while the session's TimeZone happened to be UTC.
   */
  NEW."occurredAt" := (now() AT TIME ZONE 'UTC');

  IF NEW."entityType" = 'PROMOTION_REDEMPTION' THEN
    -- The event type decides which kind of redemption row is a valid subject. A "recorded" event
    -- naming a void, or a "voided" event naming a live redemption, would each be a true-sounding
    -- statement about the wrong row.
    IF NEW."eventType" = 'PROMOTION_REDEMPTION_RECORDED' THEN
      expected_entry := 'REDEEMED';
    ELSIF NEW."eventType" = 'PROMOTION_REDEMPTION_VOIDED' THEN
      expected_entry := 'VOIDED';
    ELSE
      RAISE EXCEPTION 'IntegrationEvent: % does not describe a promotion redemption', NEW."eventType"
        USING ERRCODE = 'check_violation';
    END IF;

    SELECT * INTO redemption FROM "PromotionRedemption" WHERE "id" = NEW."entityId";
    IF NOT FOUND THEN
      RAISE EXCEPTION 'IntegrationEvent: the redemption it names does not exist'
        USING ERRCODE = 'check_violation',
              HINT = 'An event describes something that happened. Write it in the same transaction.';
    END IF;

    -- The tenant rule, and the reason this is a trigger rather than a service check: a row that
    -- named another business's redemption would publish one merchant's activity into another's feed.
    IF redemption."businessId" IS DISTINCT FROM NEW."businessId" THEN
      RAISE EXCEPTION 'IntegrationEvent: the redemption belongs to a different business'
        USING ERRCODE = 'check_violation';
    END IF;

    IF redemption."entry" IS DISTINCT FROM expected_entry THEN
      RAISE EXCEPTION 'IntegrationEvent: % names a % row', NEW."eventType", redemption."entry"
        USING ERRCODE = 'check_violation';
    END IF;

    /*
     * WRITTEN WITH THE ACTION, proved by TRANSACTION IDENTITY rather than by proximity in time.
     *
     * Everything above establishes that the redemption exists, is this business's, and is the kind
     * the event type claims. None of it establishes WHEN the event was written - so a direct writer
     * could pick any old redemption that has no event and manufacture one for it, which is exactly
     * the backfill this rule refuses.
     *
     * ── WHAT THIS REPLACES, AND WHY ──────────────────────────────────────────
     *
     * Migration 14 proved "same transaction" by comparing `occurredAt` with `recordedAt`. Both are
     * trigger-assigned from `now()` - the transaction's start time - so within one transaction they
     * agree exactly, and across transactions they usually differ. Migration 14 stated its own
     * residual honestly: the columns are TIMESTAMP(3), so two DIFFERENT transactions beginning
     * inside the same millisecond compare EQUAL and the check passes.
     *
     * Measured on this project's own database: 3 of 399 consecutive separate transactions shared a
     * TIMESTAMP(3) - about 1 in 125. A writer performing a backfill is not limited to one attempt,
     * so retrying reaches near-certainty in a few hundred tries. Against a deliberate direct writer
     * the timestamp rule was therefore not a guarantee. It did fully prevent what it was written
     * for - an OLD redemption can never be matched - and that part is unchanged.
     *
     * ── WHY xid8 AND NOT xmin ────────────────────────────────────────────────
     *
     * A transaction-id comparison was proposed once before and rightly rejected, because savepoint
     * behaviour had not been proven safe. Proven now, on PostgreSQL 15:
     *
     *   pg_current_xact_id() inside a SAVEPOINT      -> the SAME top-level id
     *   xmin of a row inserted inside a SAVEPOINT    -> a DIFFERENT id (the SUBtransaction's)
     *   xmin inside a plpgsql EXCEPTION block        -> a DIFFERENT id (also a subtransaction)
     *
     * So `xmin` would have REFUSED legitimate same-transaction writes the moment anything opened a
     * savepoint - a retry helper, a nested write, a future Prisma release - and the failure would
     * have been rejecting real work in production. `pg_current_xact_id()` has no such behaviour:
     * both sides of the comparison below are produced by it, at whatever depth, so the rule holds
     * under savepoints by construction rather than by luck.
     *
     * ── LEGACY ROWS FAIL CLOSED ──────────────────────────────────────────────
     *
     * `writeXactId` is nullable because redemptions already existed when this migration ran and
     * NOTHING may be backfilled - a guessed identity would be a fabricated claim about when
     * something happened. A NULL therefore means "this row predates the guarantee", and it is
     * REFUSED, with its own message so the reason is never mistaken for the general one.
     *
     * That is not a regression. Such a redemption could only ever have received an event inside its
     * own transaction, and that transaction ended before this migration existed.
     */
    IF redemption."writeXactId" IS NULL THEN
      RAISE EXCEPTION 'IntegrationEvent: the redemption predates the transaction-identity guarantee and can never receive an event'
        USING ERRCODE = 'check_violation',
              HINT = 'Rows written before migration 20260925130000 carry no transaction identity. Events are never backfilled.';
    END IF;

    IF redemption."writeXactId" IS DISTINCT FROM pg_current_xact_id() THEN
      RAISE EXCEPTION 'IntegrationEvent: an event must be written in the same transaction as the thing it describes'
        USING ERRCODE = 'check_violation',
              HINT = 'Call emitIntegrationEvent inside the transaction that performed the action. Events are never backfilled.';
    END IF;

    /*
     * The migration-14 timestamp rule, KEPT.
     *
     * It is now implied by the identity check above - one transaction has one `now()` - so this can
     * only fire if something has gone wrong in a way that would otherwise be silent. Keeping a
     * working rule while adding a stronger one costs nothing; removing it would make this a larger
     * change than it needs to be, and would discard a second independent statement of the same fact.
     */
    IF NEW."occurredAt" IS DISTINCT FROM redemption."recordedAt" THEN
      RAISE EXCEPTION 'IntegrationEvent: an event must be written in the same transaction as the thing it describes'
        USING ERRCODE = 'check_violation',
              HINT = 'Call emitIntegrationEvent inside the transaction that performed the action. Events are never backfilled.';
    END IF;

    RETURN NEW;
  END IF;

  -- Unreachable while one entity type exists, and deliberately fatal rather than permissive when a
  -- second one is added without a rule to go with it.
  RAISE EXCEPTION 'IntegrationEvent: no integrity rule exists for entity type %', NEW."entityType"
    USING ERRCODE = 'check_violation';
END
$$;

-- The triggers themselves are NOT recreated: `CREATE OR REPLACE FUNCTION` re-points the existing
-- `promotion_redemption_validate` and `integration_event_validate` triggers at the new bodies, with
-- no window in which either table is unprotected and no lock beyond the function replacement.
