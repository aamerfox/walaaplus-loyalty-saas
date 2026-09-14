-- Phase 3B Prompt 1 — an internal record that something happened, and nothing that leaves.
--
-- ONE additive migration. Three enums, one table, three triggers. Nothing existing is changed,
-- dropped or backfilled.
--
-- ## What this is
--
-- An append-only, tenant-isolated record of completed workflows, written in the same transaction as
-- the workflow itself. It is the INPUT to a future delivery mechanism and it is not one: there is no
-- endpoint column, no subscription table, no secret, no retry state, no delivery status, and no
-- outbound HTTP anywhere in the code that writes it.
--
-- ## What an event carries, and why it is this little
--
-- The business, the event type, the entity type and its internal id, the moment the DATABASE
-- assigned, and an envelope version. That is the whole envelope.
--
-- **There is deliberately no JSON metadata column.** A free-form bag is where a phone number ends up
-- eventually — not by malice but because somebody debugging a delivery failure will add "just the
-- recipient" to it. Typed columns and nothing else means the table has nowhere to put a contact
-- detail, a capability, a digest, a code, a secret or an amount, and a column-name check in
-- `tests/integration/integration-events-integrity.test.ts` fails if one is ever added.
--
-- A consumer that wants detail asks for it through an authorized read. That keeps the authorization
-- decision in one place instead of copying a customer's data into a row nobody re-checks.
--
-- ## Why the envelope is versioned
--
-- `envelopeVersion` is 1 and only 1 exists. A consumer written against version 1 that meets a
-- version 2 row should stop, not guess; a shape that cannot be identified is a shape that gets
-- mis-delivered. The trigger refuses any version this migration does not know about, so a row can
-- never claim a version nothing produces.
--
-- ## No backfill
--
-- Every redemption and void recorded before this migration has no event, on purpose. A backfilled
-- row would assert that a decision to publish was taken at a moment when it was not — and
-- `occurredAt` is assigned by the trigger from the server clock precisely so nobody can date one
-- into the past. See `docs/INTEGRATIONS-CAPABILITY-MATRIX.md` §7.

-- ── Enums ────────────────────────────────────────────────────────────────────

-- The two workflows this prompt covers, both already finished and both already safe. The reference
-- product has roughly forty event types; adding one is a decision about what a workflow may tell the
-- outside world, so they arrive one at a time with a reason each.
CREATE TYPE "IntegrationEventType" AS ENUM (
  'PROMOTION_REDEMPTION_RECORDED',
  'PROMOTION_REDEMPTION_VOIDED'
);

-- What `entityId` points at. One kind today. The trigger reads this to decide WHICH table to check
-- the entity against, which is why it is an enum rather than free text.
CREATE TYPE "IntegrationEntityType" AS ENUM ('PROMOTION_REDEMPTION');

-- ── The event ────────────────────────────────────────────────────────────────

-- APPEND-ONLY. One row per completed workflow, and never a second for the same one.
CREATE TABLE "IntegrationEvent" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    -- The envelope shape. 1 is the only version that exists; the trigger refuses anything else.
    "envelopeVersion" INTEGER NOT NULL DEFAULT 1,
    "eventType" "IntegrationEventType" NOT NULL,
    "entityType" "IntegrationEntityType" NOT NULL,
    -- An internal row id in this business, and nothing else. Not a serial, not a share token, not a
    -- card number, not a phone number: a uuid that means nothing outside this database.
    "entityId" TEXT NOT NULL,
    -- When it happened, ACCORDING TO THE SERVER. `walaaplus_validate_integration_event` overwrites
    -- whatever arrives. A caller-chosen occurrence time is a caller-chosen answer to "in what order
    -- did these happen?", and ordering is the one thing a future consumer will trust.
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IntegrationEvent_pkey" PRIMARY KEY ("id"),
    -- Version 1 is the only shape this migration knows how to produce or read.
    CONSTRAINT "IntegrationEvent_envelopeVersion_known" CHECK ("envelopeVersion" = 1)
);

-- One event per entity per type, forever. This is what makes emission idempotent: a retry, a second
-- service, or a backfill script that ran twice all collide here rather than producing two rows a
-- future consumer would deliver twice.
CREATE UNIQUE INDEX "IntegrationEvent_eventType_entityId_key"
  ON "IntegrationEvent"("eventType", "entityId");

-- The read view's only query: this business's events, newest first.
CREATE INDEX "IntegrationEvent_businessId_occurredAt_idx"
  ON "IntegrationEvent"("businessId", "occurredAt" DESC);

ALTER TABLE "IntegrationEvent" ADD CONSTRAINT "IntegrationEvent_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── Append-only ──────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION walaaplus_reject_integration_event_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'IntegrationEvent is append-only; % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation',
          HINT = 'An event is a statement that something happened. Record another; do not edit one.';
END
$$;

CREATE TRIGGER integration_event_append_only
  BEFORE UPDATE OR DELETE ON "IntegrationEvent"
  FOR EACH ROW EXECUTE FUNCTION walaaplus_reject_integration_event_mutation();

CREATE TRIGGER integration_event_no_truncate
  BEFORE TRUNCATE ON "IntegrationEvent"
  FOR EACH STATEMENT EXECUTE FUNCTION walaaplus_reject_integration_event_mutation();

-- ── Every row has to mean something before it is written ─────────────────────
--
-- The foreign key on `businessId` checks that the business EXISTS. Nothing in a foreign key checks
-- that the entity belongs to it, that the entity is the kind the event type claims, or that the
-- event is describing something that actually happened. The service checks all of it; this is here
-- because a guarantee that lives in one service ends the first time somebody writes a second one, a
-- backfill script, or a console session.
--
-- There is deliberately no foreign key on `entityId`. A foreign key would bind the column to one
-- table forever, and the next event type will point somewhere else; the lookup below is dispatched
-- on `entityType`, which is both more extensible and strictly stronger — a foreign key would not
-- have caught a redemption belonging to another tenant, and this does.

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

    RETURN NEW;
  END IF;

  -- Unreachable while one entity type exists, and deliberately fatal rather than permissive when a
  -- second one is added without a rule to go with it.
  RAISE EXCEPTION 'IntegrationEvent: no integrity rule exists for entity type %', NEW."entityType"
    USING ERRCODE = 'check_violation';
END
$$;

CREATE TRIGGER integration_event_validate
  BEFORE INSERT ON "IntegrationEvent"
  FOR EACH ROW EXECUTE FUNCTION walaaplus_validate_integration_event();
