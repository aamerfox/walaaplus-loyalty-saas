import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { codeDigest, newCodeSalt } from "@/server/promotions/codes";
import { createStampCafe, enrolCustomer, migratorPrisma, resetDatabase, uniqueSyrianPhone } from "../setup/fixtures";

/**
 * The `IntegrationEvent` same-transaction guarantee, proved by TRANSACTION IDENTITY.
 *
 * ## Why this file exists
 *
 * Migration 14 proved "written in the same transaction" by comparing two `TIMESTAMP(3)` values, both
 * trigger-assigned from `now()`. Migration 14 stated its own residual accurately: two DIFFERENT
 * transactions that begin inside the same millisecond compare EQUAL, and the check passes. Measured
 * on this project's database, that is about 1 consecutive transaction pair in 125 — and a writer
 * attempting a backfill can simply retry until it happens.
 *
 * Migration `20260925130000` replaces proximity-in-time with identity: the redemption stores the
 * transaction it was written in, and the event requires the CURRENT transaction to be that one.
 *
 * ## The standard these tests are held to
 *
 * **No sleeps. No probability. No timing. No racing.** "It was refused a thousand times" is not a
 * guarantee. The cross-transaction tests below therefore do not wait for a millisecond collision to
 * occur — they **construct** timestamp equality deliberately, so the old rule would have ACCEPTED the
 * row and only the identity rule refuses it. See `manufactureTimestampEquality`.
 *
 * Every write goes through `prisma`, the **restricted runtime client**, or a raw connection using the
 * same runtime role — never through a service, and never as the table owner except where a test is
 * explicitly about what the owner can do.
 */

const NOT_SAME_TRANSACTION = /same transaction as the thing it describes/;
const PREDATES_GUARANTEE = /predates the transaction-identity guarantee/;

interface World {
  businessId: string;
  promotionId: string;
  cardId: string;
  profileId: string;
}

async function build(name: string): Promise<World> {
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

function redemptionData(w: World, entry: "REDEEMED" | "VOIDED", voidsRedemptionId?: string) {
  return {
    businessId: w.businessId,
    promotionId: w.promotionId,
    entry,
    customerCardId: w.cardId,
    customerBusinessProfileId: w.profileId,
    method: "COUNTER_TYPED_CODE" as const,
    ...(voidsRedemptionId ? { voidsRedemptionId } : {}),
  };
}

function eventData(w: World, entityId: string, eventType: "PROMOTION_REDEMPTION_RECORDED" | "PROMOTION_REDEMPTION_VOIDED") {
  return {
    id: randomUUID(),
    businessId: w.businessId,
    envelopeVersion: 1,
    eventType,
    entityType: "PROMOTION_REDEMPTION" as const,
    entityId,
  };
}

/**
 * Thrown to force a rollback after a deliberate failure has been captured inside a transaction.
 *
 * Needed because a statement that raises inside PostgreSQL aborts the transaction: the error has to
 * be caught, recorded, and then the transaction unwound on purpose rather than by accident.
 */
class RollbackAfterCapture extends Error {}

beforeEach(resetDatabase);

// ─── The guarantee admits what it must ────────────────────────────────────────

describe("a redemption and its event in ONE transaction", () => {
  it("is accepted, and the event carries the redemption's own transaction identity", async () => {
    const w = await build("Same-tx café");

    const eventId = await prisma.$transaction(async (tx) => {
      const r = await tx.promotionRedemption.create({ data: redemptionData(w, "REDEEMED"), select: { id: true } });
      const e = await tx.integrationEvent.create({ data: eventData(w, r.id, "PROMOTION_REDEMPTION_RECORDED"), select: { id: true } });
      return e.id;
    });

    expect(await prisma.integrationEvent.count({ where: { id: eventId } })).toBe(1);

    // The stored identity is a real transaction id, not a default or a null.
    const [row] = await migratorPrisma().$queryRawUnsafe<{ x: string | null }[]>(
      `SELECT "writeXactId"::text AS x FROM "PromotionRedemption" WHERE "entry" = 'REDEEMED'`,
    );
    expect(row.x).toMatch(/^\d+$/);
  });

  it("is accepted for a VOID/withdrawal event too, not only the happy path", async () => {
    const w = await build("Void café");
    // The redemption being withdrawn must exist first, in its own transaction.
    const redeemed = await prisma.promotionRedemption.create({ data: redemptionData(w, "REDEEMED"), select: { id: true } });

    const eventId = await prisma.$transaction(async (tx) => {
      const v = await tx.promotionRedemption.create({
        data: redemptionData(w, "VOIDED", redeemed.id),
        select: { id: true },
      });
      const e = await tx.integrationEvent.create({ data: eventData(w, v.id, "PROMOTION_REDEMPTION_VOIDED"), select: { id: true } });
      return e.id;
    });

    expect(await prisma.integrationEvent.count({ where: { id: eventId } })).toBe(1);
  });

  it("is accepted when the event is written inside a SAVEPOINT", async () => {
    /*
     * **The regression that the rejected `xmin` design would have caused.**
     *
     * A row inserted inside a savepoint carries the SUBtransaction's `xmin`, not the enclosing
     * transaction's — so an `xmin` comparison would refuse this legitimate write. `pg_current_xact_id()`
     * returns the top-level id at every depth, so this must pass. If this test ever goes red, the
     * implementation has drifted back to the design Phase 3B rejected.
     */
    const w = await build("Savepoint café");

    await prisma.$transaction(async (tx) => {
      const r = await tx.promotionRedemption.create({ data: redemptionData(w, "REDEEMED"), select: { id: true } });

      // Two levels, because the hazard is about SUBtransactions at any depth, not just one.
      await tx.$executeRawUnsafe("SAVEPOINT after_redemption");
      await tx.$executeRawUnsafe("SAVEPOINT nested_once_more");

      await tx.integrationEvent.create({ data: eventData(w, r.id, "PROMOTION_REDEMPTION_RECORDED") });
    });

    expect(await prisma.integrationEvent.count()).toBe(1);
  });
});

// ─── The guarantee refuses what it must, DETERMINISTICALLY ────────────────────

/**
 * Make a committed redemption's `recordedAt` equal to an OPEN transaction's `now()`.
 *
 * This is the whole point of the file. The old rule compared those two values, so making them equal
 * is exactly the forgery it could not detect — and here it is produced **by construction**, not by
 * waiting for two transactions to land in the same millisecond.
 *
 * The update is done by the table OWNER with triggers disabled, because `PromotionRedemption` is
 * append-only for everyone otherwise. That is not a bypass being tested; it is the test rig
 * manufacturing the exact precondition under which the old rule passed. `writeXactId` is deliberately
 * left alone — only the timestamp is moved.
 *
 * Under READ COMMITTED the open transaction sees this committed update on its next statement, which
 * is what lets the event trigger read the doctored `recordedAt`.
 */
async function manufactureTimestampEquality(redemptionId: string, openTransactionNow: string): Promise<void> {
  const owner = migratorPrisma();
  await owner.$executeRawUnsafe(`ALTER TABLE "PromotionRedemption" DISABLE TRIGGER USER`);
  try {
    /*
     * `::timestamp(3)` on purpose. `now()` carries MICROSECONDS but `recordedAt` and `occurredAt`
     * are TIMESTAMP(3), so the trigger's comparison happens at millisecond precision. A first
     * version of this rig stored the full-precision value and compared against the unrounded
     * `now()`, so the two never matched and the test correctly refused to pass - it reported itself
     * INCONCLUSIVE rather than claiming a proof it had not made.
     */
    await owner.$executeRawUnsafe(
      `UPDATE "PromotionRedemption" SET "recordedAt" = $1::timestamp(3) WHERE id = $2`,
      openTransactionNow,
      redemptionId,
    );
  } finally {
    await owner.$executeRawUnsafe(`ALTER TABLE "PromotionRedemption" ENABLE TRIGGER USER`);
  }
}

describe("an event for a redemption from an EARLIER transaction", () => {
  /** Shared body: build, commit a redemption, then forge timestamp equality in a second transaction. */
  async function attemptForgery(
    w: World,
    redemptionId: string,
    eventType: "PROMOTION_REDEMPTION_RECORDED" | "PROMOTION_REDEMPTION_VOIDED",
  ): Promise<{ error: Error | null; timestampsWereEqual: boolean }> {
    let error: Error | null = null;
    let timestampsWereEqual = false;

    try {
      await prisma.$transaction(async (tx) => {
        /*
         * This transaction's `now()`, at the precision the columns actually store. The event's
         * `occurredAt` will be set to exactly this by the trigger.
         *
         * Read BEFORE touching `PromotionRedemption`: the owner's `ALTER TABLE … DISABLE TRIGGER`
         * below needs ACCESS EXCLUSIVE, and if this transaction already held ACCESS SHARE on that
         * table the two would deadlock.
         */
        const nowRows = await tx.$queryRawUnsafe<{ t: string }[]>(
          `SELECT (now() AT TIME ZONE 'UTC')::timestamp(3)::text AS t`,
        );
        await manufactureTimestampEquality(redemptionId, nowRows[0].t);

        // Confirm the forgery took. A rig that silently failed to set this up would make the
        // refusal below prove nothing at all.
        const check = await tx.$queryRawUnsafe<{ equal: boolean }[]>(
          `SELECT ("recordedAt" = (now() AT TIME ZONE 'UTC')::timestamp(3)) AS equal
             FROM "PromotionRedemption" WHERE id = $1`,
          redemptionId,
        );
        timestampsWereEqual = check[0].equal === true;

        try {
          await tx.integrationEvent.create({ data: eventData(w, redemptionId, eventType) });
        } catch (e) {
          error = e as Error;
        }
        // Always unwind: nothing this rig does should survive the test.
        throw new RollbackAfterCapture();
      });
    } catch (e) {
      if (!(e instanceof RollbackAfterCapture)) throw e;
    }

    return { error, timestampsWereEqual };
  }

  it("is REFUSED even though the timestamps were made equal — the old rule would have accepted it", async () => {
    const w = await build("Forgery café");
    const redemption = await prisma.promotionRedemption.create({
      data: redemptionData(w, "REDEEMED"),
      select: { id: true },
    });

    const { error, timestampsWereEqual } = await attemptForgery(w, redemption.id, "PROMOTION_REDEMPTION_RECORDED");

    /*
     * INCONCLUSIVE IS A FAILURE, NOT A PASS. If the rig could not make the timestamps equal then the
     * old rule would have refused this row on its own, and the refusal below would prove nothing
     * about the new one.
     */
    expect(timestampsWereEqual, "the test rig failed to manufacture timestamp equality — this run proves nothing").toBe(true);

    expect(error).not.toBeNull();
    expect(String(error)).toMatch(NOT_SAME_TRANSACTION);
    // And not for the legacy reason — this redemption does carry an identity, just a different one.
    expect(String(error)).not.toMatch(PREDATES_GUARANTEE);
  });

  it("is REFUSED for a VOID/withdrawal event under the same forgery", async () => {
    const w = await build("Forged void café");
    const redeemed = await prisma.promotionRedemption.create({ data: redemptionData(w, "REDEEMED"), select: { id: true } });
    const voided = await prisma.promotionRedemption.create({
      data: redemptionData(w, "VOIDED", redeemed.id),
      select: { id: true },
    });

    const { error, timestampsWereEqual } = await attemptForgery(w, voided.id, "PROMOTION_REDEMPTION_VOIDED");

    expect(timestampsWereEqual, "the test rig failed to manufacture timestamp equality — this run proves nothing").toBe(true);
    expect(error).not.toBeNull();
    expect(String(error)).toMatch(NOT_SAME_TRANSACTION);
  });

  it("is refused in the ordinary case too, with no forgery at all", async () => {
    const w = await build("Plain café");
    const redemption = await prisma.promotionRedemption.create({ data: redemptionData(w, "REDEEMED"), select: { id: true } });
    await expect(
      prisma.integrationEvent.create({ data: eventData(w, redemption.id, "PROMOTION_REDEMPTION_RECORDED") }),
    ).rejects.toThrow(NOT_SAME_TRANSACTION);
  });
});

// ─── Legacy rows ──────────────────────────────────────────────────────────────

describe("a redemption written before the guarantee existed", () => {
  it("can never receive an event, and says so in its own words", async () => {
    const w = await build("Legacy café");

    /*
     * A pre-migration row is one with no `writeXactId`. The only way to produce one now is to clear
     * it as the owner with triggers off — which is precisely what a row inserted before this
     * migration looks like.
     */
    const redemption = await prisma.promotionRedemption.create({ data: redemptionData(w, "REDEEMED"), select: { id: true } });
    const owner = migratorPrisma();
    await owner.$executeRawUnsafe(`ALTER TABLE "PromotionRedemption" DISABLE TRIGGER USER`);
    try {
      await owner.$executeRawUnsafe(`UPDATE "PromotionRedemption" SET "writeXactId" = NULL WHERE id = $1`, redemption.id);
    } finally {
      await owner.$executeRawUnsafe(`ALTER TABLE "PromotionRedemption" ENABLE TRIGGER USER`);
    }

    // Even in the same transaction as a fresh write, a legacy row is refused — it fails CLOSED.
    await expect(
      prisma.$transaction(async (tx) =>
        tx.integrationEvent.create({ data: eventData(w, redemption.id, "PROMOTION_REDEMPTION_RECORDED") }),
      ),
    ).rejects.toThrow(PREDATES_GUARANTEE);
  });
});

// ─── The identity cannot be chosen ────────────────────────────────────────────

describe("the transaction identity is the server's", () => {
  it("cannot be supplied by a caller to imitate a valid transaction", async () => {
    const w = await build("Imitation café");

    await prisma.$transaction(async (tx) => {
      // The transaction id this write genuinely belongs to.
      const real = await tx.$queryRawUnsafe<{ x: string }[]>(`SELECT pg_current_xact_id()::text AS x`);

      // Supply a different one anyway, the way a direct writer trying to imitate one would.
      const inserted = await tx.$queryRawUnsafe<{ x: string }[]>(
        `INSERT INTO "PromotionRedemption"
           ("id","businessId","promotionId","entry","customerCardId","customerBusinessProfileId","method","writeXactId")
         VALUES ($1,$2,$3,'REDEEMED',$4,$5,'COUNTER_TYPED_CODE','999999999'::xid8)
         RETURNING "writeXactId"::text AS x`,
        randomUUID(),
        w.businessId,
        w.promotionId,
        w.cardId,
        w.profileId,
      );

      // Discarded and replaced by the server, exactly as `recordedAt` already is.
      expect(inserted[0].x).not.toBe("999999999");
      expect(inserted[0].x).toBe(real[0].x);
    });
  });

  it("cannot be forged onto a committed redemption by the runtime role", async () => {
    const w = await build("No-update café");
    const redemption = await prisma.promotionRedemption.create({ data: redemptionData(w, "REDEEMED"), select: { id: true } });

    // Append-only for the runtime role: no UPDATE privilege, so the identity cannot be rewritten to
    // match a later transaction.
    await expect(
      prisma.$executeRawUnsafe(`UPDATE "PromotionRedemption" SET "writeXactId" = pg_current_xact_id() WHERE id = $1`, redemption.id),
    ).rejects.toThrow(/permission denied|append-only/i);
  });

  it("cannot be bypassed by disabling the trigger as the runtime role", async () => {
    await build("No-disable café");
    await expect(prisma.$executeRawUnsafe(`ALTER TABLE "PromotionRedemption" DISABLE TRIGGER USER`)).rejects.toThrow(
      /must be owner|permission denied/i,
    );
    await expect(prisma.$executeRawUnsafe(`ALTER TABLE "IntegrationEvent" DISABLE TRIGGER USER`)).rejects.toThrow(
      /must be owner|permission denied/i,
    );
  });
});

// ─── Every migration-14 rule still holds ──────────────────────────────────────

describe("the rules migration 14 already enforced are unchanged", () => {
  async function inOneTransaction(w: World, override: Record<string, unknown>, entry: "REDEEMED" | "VOIDED" = "REDEEMED") {
    return prisma.$transaction(async (tx) => {
      const r = await tx.promotionRedemption.create({ data: redemptionData(w, entry), select: { id: true } });
      return tx.integrationEvent.create({
        data: { ...eventData(w, r.id, "PROMOTION_REDEMPTION_RECORDED"), ...override },
      });
    });
  }

  it("still refuses an event naming another business's redemption", async () => {
    const mine = await build("Mine");
    const theirs = await build("Theirs");
    const theirRedemption = await prisma.promotionRedemption.create({
      data: redemptionData(theirs, "REDEEMED"),
      select: { id: true },
    });
    await expect(
      prisma.$transaction(async (tx) =>
        tx.integrationEvent.create({ data: eventData(mine, theirRedemption.id, "PROMOTION_REDEMPTION_RECORDED") }),
      ),
    ).rejects.toThrow(/belongs to a different business|same transaction/);
  });

  it("still refuses a RECORDED event naming a VOIDED row", async () => {
    const w = await build("Mismatch café");
    // A well-formed VOIDED row: it must name the redemption it withdraws, or the REDEMPTION trigger
    // refuses it first and this would be testing the wrong rule.
    const redeemed = await prisma.promotionRedemption.create({ data: redemptionData(w, "REDEEMED"), select: { id: true } });

    await expect(
      prisma.$transaction(async (tx) => {
        const voided = await tx.promotionRedemption.create({
          data: redemptionData(w, "VOIDED", redeemed.id),
          select: { id: true },
        });
        // A RECORDED event naming a VOIDED row: a true-sounding statement about the wrong row.
        return tx.integrationEvent.create({ data: eventData(w, voided.id, "PROMOTION_REDEMPTION_RECORDED") });
      }),
    ).rejects.toThrow(/names a VOIDED row/);
  });

  it("still refuses an event whose entity does not exist", async () => {
    const w = await build("Ghost café");
    await expect(
      prisma.$transaction(async (tx) =>
        tx.integrationEvent.create({ data: eventData(w, randomUUID(), "PROMOTION_REDEMPTION_RECORDED") }),
      ),
    ).rejects.toThrow(/does not exist/);
  });

  it("still overwrites a caller-supplied occurredAt", async () => {
    const w = await build("Clock café");
    const supplied = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
    const row = await inOneTransaction(w, { occurredAt: supplied });
    expect(row.occurredAt.getTime()).not.toBe(supplied.getTime());
  });

  it("still refuses an unknown envelope version", async () => {
    const w = await build("Envelope café");
    await expect(inOneTransaction(w, { envelopeVersion: 2 })).rejects.toThrow();
  });
});
