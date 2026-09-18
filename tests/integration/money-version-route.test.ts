/**
 * `POST /api/staff/money-version` — the rate-table draft lifecycle over HTTP.
 *
 * Only the SESSION is mocked, as everywhere else in this suite: membership resolution, permissions,
 * the services and the database are real, because the authorisation boundary is part of what is
 * under test.
 *
 * The cases that matter most here are the ones about what the route will NOT accept. A programme is
 * denominated in the business's currency, and the route must not offer a way to say otherwise —
 * not silently ignored, REFUSED, so a client sending one learns it was wrong instead of believing it
 * worked.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const session = vi.hoisted(() => ({ userId: null as string | null }));

vi.mock("@/server/auth/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/auth/session")>();
  const { UnauthorizedError } = await import("@/server/errors");
  return {
    ...actual,
    getCurrentUserId: async () => session.userId,
    requireUserId: async () => {
      if (!session.userId) throw new UnauthorizedError();
      return session.userId;
    },
  };
});

import { POST as moneyVersionRoute } from "@/app/api/staff/money-version/route";
import { prisma } from "@/server/db";
import { createMonetaryShop, createStaff, migratorPrisma, resetDatabase, type MonetaryShopFixture } from "../setup/fixtures";
import { MembershipRole } from "@prisma/client";

interface Answer {
  status: number;
  body: Record<string, unknown>;
}

async function call(body: unknown): Promise<Answer> {
  const res = await moneyVersionRoute(
    new Request("http://localhost/api/staff/money-version", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

let fx: MonetaryShopFixture;

beforeEach(async () => {
  await resetDatabase();
  fx = await createMonetaryShop({ tiers: [{ minCumulativeSpendMinor: 0, rateBasisPoints: 500 }] });
  session.userId = fx.userId;
});

describe("the lifecycle over HTTP", () => {
  it("opens a draft, edits the table, and publishes it", async () => {
    const opened = await call({ action: "createDraft", templateId: fx.program.templateId });
    expect(opened.status).toBe(201);
    expect(opened.body.versionNumber).toBe(2);

    const edited = await call({
      action: "updateRateTable",
      templateId: fx.program.templateId,
      tiers: [
        { minCumulativeSpendMinor: 0, rateBasisPoints: 250 },
        { minCumulativeSpendMinor: 1_000_000, rateBasisPoints: 600 },
      ],
    });
    expect(edited.status).toBe(200);
    expect(edited.body.tiers).toEqual([
      { tierIndex: 0, minCumulativeSpendMinor: "0", rateBasisPoints: 250 },
      { tierIndex: 1, minCumulativeSpendMinor: "1000000", rateBasisPoints: 600 },
    ]);

    const published = await call({ action: "publish", templateId: fx.program.templateId, expectedVersionNumber: 2 });
    expect(published.status).toBe(200);
    expect(published.body).toMatchObject({ publishedVersionNumber: 2, retiredVersionNumber: 1 });
  });

  it("sends amounts as decimal STRINGS, never as JavaScript numbers", async () => {
    /*
     * The wire type is the point, not this particular value. A minor amount is an integer domain
     * value; a JSON number is a double, and `bigint` does not survive `JSON.stringify` at all. The
     * product ceiling (`MAX_MINOR_AMOUNT`, 10^15) happens to sit below 2^53 today, so no amount this
     * route accepts would lose precision as a double - but the contract must not depend on that
     * coincidence surviving a later change to the ceiling.
     */
    await call({ action: "createDraft", templateId: fx.program.templateId });
    const edited = await call({
      action: "updateRateTable",
      templateId: fx.program.templateId,
      // Tier 0 must start at zero - the first tier is the one that applies to a card with no history,
      // so the large value goes on tier 1. That is a rate-table rule, not a wire-format concession.
      tiers: [
        { minCumulativeSpendMinor: 0, rateBasisPoints: 100 },
        { minCumulativeSpendMinor: 999_999_999_999_999, rateBasisPoints: 200 },
      ],
    });
    expect(edited.status).toBe(200);
    const tiers = edited.body.tiers as { minCumulativeSpendMinor: unknown }[];
    expect(typeof tiers[1].minCumulativeSpendMinor).toBe("string");
    expect(tiers[1].minCumulativeSpendMinor).toBe("999999999999999");
  });

  it("discards a draft by RETIRING it, and says so", async () => {
    await call({ action: "createDraft", templateId: fx.program.templateId });
    const discarded = await call({ action: "discardDraft", templateId: fx.program.templateId });

    expect(discarded.status).toBe(200);
    expect(discarded.body).toMatchObject({ ok: true, disposition: "RETIRED" });
    const retired = await prisma.programVersion.count({
      where: { templateId: fx.program.templateId, status: "RETIRED" },
    });
    expect(retired).toBe(1);
  });

  it("reads the live table and the open draft together", async () => {
    await call({ action: "createDraft", templateId: fx.program.templateId });
    await call({
      action: "updateRateTable",
      templateId: fx.program.templateId,
      tiers: [{ minCumulativeSpendMinor: 0, rateBasisPoints: 900 }],
    });

    const read = await call({ action: "read", templateId: fx.program.templateId });
    const live = read.body.live as { tiers: { rateBasisPoints: number }[]; versionNumber: number };
    const draft = read.body.draft as { tiers: { rateBasisPoints: number }[]; versionNumber: number };
    expect(live.versionNumber).toBe(1);
    expect(live.tiers[0].rateBasisPoints).toBe(500);
    expect(draft.versionNumber).toBe(2);
    expect(draft.tiers[0].rateBasisPoints).toBe(900);
  });
});

describe("the currency is not something this route accepts", () => {
  it("REFUSES a body carrying a currency, rather than ignoring it", async () => {
    await call({ action: "createDraft", templateId: fx.program.templateId });
    const answer = await call({
      action: "updateRateTable",
      templateId: fx.program.templateId,
      currency: "USD",
      tiers: [{ minCumulativeSpendMinor: 0, rateBasisPoints: 500 }],
    });

    // Refused at the boundary. Ignoring it would let a client believe it had set something.
    expect(answer.status).toBe(400);
    const rule = await prisma.monetaryRule.findFirstOrThrow({
      where: { programVersion: { templateId: fx.program.templateId, status: "DRAFT" } },
      select: { currency: true },
    });
    expect(rule.currency).toBe("SYP");
  });

  it("REFUSES a currencyExponent too, and a per-tier currency", async () => {
    await call({ action: "createDraft", templateId: fx.program.templateId });

    const withExponent = await call({
      action: "updateRateTable",
      templateId: fx.program.templateId,
      currencyExponent: 3,
      tiers: [{ minCumulativeSpendMinor: 0, rateBasisPoints: 500 }],
    });
    expect(withExponent.status).toBe(400);

    const perTier = await call({
      action: "updateRateTable",
      templateId: fx.program.templateId,
      tiers: [{ minCumulativeSpendMinor: 0, rateBasisPoints: 500, currency: "JOD" }],
    });
    expect(perTier.status).toBe(400);
  });

  it("returns the business's currency for display, so the screen never has to guess", async () => {
    const read = await call({ action: "read", templateId: fx.program.templateId });
    const live = read.body.live as { currency: string; currencyExponent: number };
    expect(live.currency).toBe("SYP");
    expect(live.currencyExponent).toBe(2);
  });
});

describe("who may change a rate table", () => {
  it("refuses a cashier, who may run the counter but not set the rates", async () => {
    const cashier = await createStaff(fx, MembershipRole.CASHIER, [fx.locationId]);
    session.userId = cashier.userId;

    const answer = await call({ action: "createDraft", templateId: fx.program.templateId });
    expect(answer.status).toBe(403);
  });

  it("refuses a signed-out caller", async () => {
    session.userId = null;
    const answer = await call({ action: "read", templateId: fx.program.templateId });
    expect(answer.status).toBe(401);
  });

  it("shows one business nothing of another's program", async () => {
    const other = await createMonetaryShop();
    session.userId = fx.userId;

    const answer = await call({ action: "read", templateId: other.program.templateId });
    expect(answer.status).toBe(404);
  });
});

describe("what the route refuses outright", () => {
  it("refuses a rate above 100% and a negative threshold at the boundary", async () => {
    await call({ action: "createDraft", templateId: fx.program.templateId });

    const tooHigh = await call({
      action: "updateRateTable",
      templateId: fx.program.templateId,
      tiers: [{ minCumulativeSpendMinor: 0, rateBasisPoints: 10_001 }],
    });
    expect(tooHigh.status).toBe(400);

    const negative = await call({
      action: "updateRateTable",
      templateId: fx.program.templateId,
      tiers: [{ minCumulativeSpendMinor: -1, rateBasisPoints: 100 }],
    });
    expect(negative.status).toBe(400);
  });

  it("refuses a stamp program of the SAME business — this is not the endpoint that edits one", async () => {
    /*
     * The template is written directly rather than through `createStampCafe`, which always registers
     * a new owner and business. The refusal being tested is about CARD TYPE, and a program in another
     * business would be refused as not-found first - the test would pass without the card-type check
     * existing at all.
     */
    const stamp = await migratorPrisma().programTemplate.create({
      data: { businessId: fx.businessId, name: "Stamps", cardType: "STAMP" },
      select: { id: true },
    });
    session.userId = fx.userId;

    const answer = await call({ action: "createDraft", templateId: stamp.id });
    expect(answer.status).toBe(400);
    expect(JSON.stringify(answer.body)).toMatch(/not a cashback or discount program/i);
  });
});
