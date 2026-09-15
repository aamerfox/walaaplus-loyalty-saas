import { randomUUID } from "node:crypto";
import { OperationSource } from "@prisma/client";
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { earnCashback } from "@/server/monetary/engine";
import { codeDigest, newCodeSalt } from "@/server/promotions/codes";
import {
  createMonetaryShop,
  createStampCafe,
  enrolCustomer,
  enrolMonetaryCustomer,
  migratorPrisma,
  resetDatabase,
  uniqueSyrianPhone,
} from "../setup/fixtures";

/**
 * **Phase 4 must not weaken the Foundation Correction.**
 *
 * `20260925130000_integration_event_transaction_identity` replaced a defeatable TIMESTAMP(3)
 * comparison with an exact `pg_current_xact_id()` identity check, and it is DEPLOYED. Phase 4's
 * `20260926120000_cashback_and_discount_core` runs immediately after it.
 *
 * A migration that happened to `CREATE OR REPLACE walaaplus_validate_integration_event` — or that
 * dropped and recreated the `PromotionRedemption` validation trigger for its own reasons — would
 * silently undo that correction, and every existing test would still pass, because the old timestamp
 * rule usually refuses a cross-transaction write anyway. The failure would only show up as a
 * merchant's event feed containing something that never happened.
 *
 * Static review says Phase 4 does not touch either function. **This file does not take that on
 * trust.** It asserts, against a database with ALL migrations applied including Phase 4's, that the
 * guarantee is still exactly the one the correction installed — and its red proof simulates the
 * clobber to show these assertions would catch it.
 */

const NOT_SAME_TRANSACTION = /same transaction as the thing it describes/;

interface Cafe {
  businessId: string;
  promotionId: string;
  cardId: string;
  profileId: string;
}

async function buildCafe(name: string): Promise<Cafe> {
  const cafe = await createStampCafe({ name });
  const customer = await enrolCustomer(cafe, { phone: uniqueSyrianPhone(), firstName: "ليلى" });
  const salt = newCodeSalt();
  const promotion = await prisma.promotion.create({
    data: {
      businessId: cafe.businessId,
      name: `Offer for ${name}`,
      normalizedName: `offer for ${name}`.toLowerCase(),
      benefitDescription: "A free espresso",
      codeDigest: codeDigest(salt, cafe.businessId, "AUTUMN10"),
      codeSalt: salt,
    },
    select: { id: true },
  });
  await prisma.promotion.update({ where: { id: promotion.id }, data: { state: "ACTIVE" } });
  return {
    businessId: cafe.businessId,
    promotionId: promotion.id,
    cardId: customer.customerCardId,
    profileId: customer.customerBusinessProfileId,
  };
}

const redemptionData = (c: Cafe) => ({
  businessId: c.businessId,
  promotionId: c.promotionId,
  entry: "REDEEMED" as const,
  customerCardId: c.cardId,
  customerBusinessProfileId: c.profileId,
  method: "COUNTER_TYPED_CODE" as const,
});

const eventData = (c: Cafe, entityId: string) => ({
  id: randomUUID(),
  businessId: c.businessId,
  envelopeVersion: 1,
  eventType: "PROMOTION_REDEMPTION_RECORDED" as const,
  entityType: "PROMOTION_REDEMPTION" as const,
  entityId,
});

beforeEach(resetDatabase);

describe("with ALL migrations applied, including Phase 4's", () => {
  it("still runs the correction BEFORE the Phase 4 migration", async () => {
    // Ordering is what lets staging deploy the correction without incomplete Phase 4 work, and what
    // guarantees Phase 4 never runs against a database that lacks the column it must not disturb.
    const rows = await migratorPrisma().$queryRawUnsafe<{ migration_name: string }[]>(
      `SELECT migration_name FROM _prisma_migrations
        WHERE migration_name IN ('20260925130000_integration_event_transaction_identity',
                                 '20260926120000_cashback_and_discount_core')
        ORDER BY finished_at`,
    );
    expect(rows.map((r) => r.migration_name)).toEqual([
      "20260925130000_integration_event_transaction_identity",
      "20260926120000_cashback_and_discount_core",
    ]);
  });

  it("still has the xact-identity check in the LIVE function body", async () => {
    /*
     * Read back from the catalog, not from the migration file. This is what a `CREATE OR REPLACE` in
     * a later migration would change, and the only place the truth lives once everything is applied.
     */
    const [fn] = await migratorPrisma().$queryRawUnsafe<{ def: string }[]>(
      `SELECT pg_get_functiondef('walaaplus_validate_integration_event'::regproc) AS def`,
    );
    expect(fn.def).toContain("pg_current_xact_id()");
    expect(fn.def).toContain('redemption."writeXactId" IS DISTINCT FROM pg_current_xact_id()');
    // And the kept TIMESTAMP(3) rule, which the owner asked to retain alongside it.
    expect(fn.def).toContain('NEW."occurredAt" IS DISTINCT FROM redemption."recordedAt"');
  });

  it("still stamps writeXactId from the server in the LIVE redemption function", async () => {
    const [fn] = await migratorPrisma().$queryRawUnsafe<{ def: string }[]>(
      `SELECT pg_get_functiondef('walaaplus_validate_redemption'::regproc) AS def`,
    );
    expect(fn.def).toContain('NEW."writeXactId" := pg_current_xact_id()');
  });

  it("still has the writeXactId column, still nullable, still xid8", async () => {
    const [col] = await migratorPrisma().$queryRawUnsafe<{ data_type: string; is_nullable: string }[]>(
      `SELECT data_type, is_nullable FROM information_schema.columns
        WHERE table_name = 'PromotionRedemption' AND column_name = 'writeXactId'`,
    );
    expect(col).toBeDefined();
    expect(col.data_type).toBe("xid8");
    expect(col.is_nullable).toBe("YES");
  });
});

describe("the Foundation Correction still behaves correctly under Phase 4", () => {
  it("1. accepts a redemption and its event written in ONE transaction", async () => {
    const c = await buildCafe("Compat café");

    const eventId = await prisma.$transaction(async (tx) => {
      const r = await tx.promotionRedemption.create({ data: redemptionData(c), select: { id: true } });
      const e = await tx.integrationEvent.create({ data: eventData(c, r.id), select: { id: true } });
      return e.id;
    });

    expect(await prisma.integrationEvent.count({ where: { id: eventId } })).toBe(1);

    // The identity was stamped by the server, not left null.
    const [row] = await migratorPrisma().$queryRawUnsafe<{ x: string | null }[]>(
      `SELECT "writeXactId"::text AS x FROM "PromotionRedemption" WHERE "entry" = 'REDEEMED'`,
    );
    expect(row.x).toMatch(/^\d+$/);
  });

  it("2. refuses an event attached by a LATER transaction", async () => {
    const c = await buildCafe("Later café");
    const redemption = await prisma.promotionRedemption.create({ data: redemptionData(c), select: { id: true } });

    // Committed above; this is a different transaction, so the identities differ.
    await expect(prisma.integrationEvent.create({ data: eventData(c, redemption.id) })).rejects.toThrow(
      NOT_SAME_TRANSACTION,
    );
    expect(await prisma.integrationEvent.count()).toBe(0);
  });
});

describe("Phase 4 money operations still work with the correction applied", () => {
  it("3. records cashback against a card, unaffected by the transaction-identity rule", async () => {
    /*
     * The money engine writes `MonetaryOperation` rows and never `PromotionRedemption` or
     * `IntegrationEvent`, so the correction should be invisible to it. Asserted rather than assumed:
     * the two subsystems share a database, and the correction replaced a function used by one of
     * them.
     */
    const fx = await createMonetaryShop();
    const enrolled = await enrolMonetaryCustomer(fx);

    const result = await earnCashback(fx.ctx, {
      customerCardId: enrolled.customerCardId,
      grossAmountMinor: 100_000n,
      idempotencyKey: `compat-${randomUUID()}`,
      source: OperationSource.SCANNER,
    });

    expect(result.cashEffectMinor).toBe("5000");
    expect(result.cashBalanceAfterMinor).toBe("5000");
    expect(await prisma.monetaryOperation.count()).toBe(1);
  });

  it("3b. money and promotion subsystems coexist in one database without interfering", async () => {
    // Money rows and promotion rows in the SAME database, written through their own engines. The
    // correction replaced a function one subsystem uses; this asserts the other is unaffected and
    // that the correction still holds while money rows exist alongside.
    const fx = await createMonetaryShop();
    const enrolled = await enrolMonetaryCustomer(fx);
    await earnCashback(fx.ctx, {
      customerCardId: enrolled.customerCardId,
      grossAmountMinor: 50_000n,
      idempotencyKey: `compat-${randomUUID()}`,
      source: OperationSource.SCANNER,
    });

    const c = await buildCafe("Coexist café");

    // Same transaction: accepted, with money rows already in the database.
    await prisma.$transaction(async (tx) => {
      const r = await tx.promotionRedemption.create({ data: redemptionData(c), select: { id: true } });
      await tx.integrationEvent.create({ data: eventData(c, r.id) });
    });
    expect(await prisma.integrationEvent.count()).toBe(1);

    // Later transaction: still refused.
    const later = await prisma.promotionRedemption.create({ data: redemptionData(c), select: { id: true } });
    await expect(prisma.integrationEvent.create({ data: eventData(c, later.id) })).rejects.toThrow(NOT_SAME_TRANSACTION);

    // And the money row is untouched by any of it.
    expect(await prisma.monetaryOperation.count()).toBe(1);
  });
});
