/**
 * `POST /api/scanner/money` — the counter for a cashback or discount programme.
 *
 * Only the SESSION is mocked. The engine, the permissions, the tenant check and the database are
 * real, because what a counter route must get right is exactly the part a mock would hide: who may
 * do it, to whose card, and what the customer is told to pay.
 */
import { randomUUID } from "node:crypto";
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

import { POST as moneyRoute } from "@/app/api/scanner/money/route";
import {
  createMonetaryShop,
  enrolMonetaryCustomer,
  resetDatabase,
  type MonetaryShopFixture,
} from "../setup/fixtures";

interface Answer {
  status: number;
  body: Record<string, unknown>;
}

async function call(body: unknown): Promise<Answer> {
  const res = await moneyRoute(
    new Request("http://localhost/api/scanner/money", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

let fx: MonetaryShopFixture;
let cardId: string;

beforeEach(async () => {
  await resetDatabase();
  // 5% cashback, so a 10,000 bill earns 500 and the arithmetic is checkable by eye.
  fx = await createMonetaryShop({ tiers: [{ minCumulativeSpendMinor: 0, rateBasisPoints: 500 }] });
  const enrolled = await enrolMonetaryCustomer(fx);
  cardId = enrolled.customerCardId;
  session.userId = fx.userId;
});

describe("earning", () => {
  it("earns the rate on the bill and says what to collect", async () => {
    const answer = await call({
      action: "earn",
      customerCardId: cardId,
      grossAmountMinor: "10000",
      idempotencyKey: randomUUID(),
    });

    expect(answer.status).toBe(201);
    expect(answer.body).toMatchObject({
      kind: "CASHBACK_EARNED",
      grossAmountMinor: "10000",
      cashEffectMinor: "500",
      cashBalanceAfterMinor: "500",
      // Earning does not change what the customer pays today.
      netCounterAmountMinor: "10000",
      rateBasisPoints: 500,
      currency: "SYP",
    });
  });

  it("rounds half-up, at the smallest unit of the business's currency", async () => {
    // 5% of 5,010 is 250.5 minor units, which is 251 rounded half up — never 250, and never 250.5.
    const answer = await call({
      action: "earn",
      customerCardId: cardId,
      grossAmountMinor: "5010",
      idempotencyKey: randomUUID(),
    });
    expect(answer.body.cashEffectMinor).toBe("251");
  });

  it("returns the same row for a repeated idempotency key, not a second earning", async () => {
    const key = randomUUID();
    const first = await call({ action: "earn", customerCardId: cardId, grossAmountMinor: "10000", idempotencyKey: key });
    const again = await call({ action: "earn", customerCardId: cardId, grossAmountMinor: "10000", idempotencyKey: key });

    expect(again.body.operationId).toBe(first.body.operationId);
    expect(again.body.cashBalanceAfterMinor).toBe("500");
  });
});

describe("redeeming", () => {
  async function earn(amount: string) {
    return call({ action: "earn", customerCardId: cardId, grossAmountMinor: amount, idempotencyKey: randomUUID() });
  }

  it("takes the requested amount off the bill and off the balance", async () => {
    await earn("100000"); // balance 5,000

    const answer = await call({
      action: "redeem",
      customerCardId: cardId,
      grossAmountMinor: "20000",
      requestedRedemptionMinor: "3000",
      idempotencyKey: randomUUID(),
    });

    expect(answer.status).toBe(201);
    expect(answer.body).toMatchObject({
      kind: "CASHBACK_REDEEMED",
      requestedRedemptionMinor: "3000",
      cashEffectMinor: "-3000",
      cashBalanceAfterMinor: "2000",
      netCounterAmountMinor: "17000", // 20,000 bill less 3,000 redeemed
    });
  });

  it("caps at the balance, and reports what was asked alongside what was applied", async () => {
    await earn("10000"); // balance 500

    const answer = await call({
      action: "redeem",
      customerCardId: cardId,
      grossAmountMinor: "20000",
      requestedRedemptionMinor: "9999",
      idempotencyKey: randomUUID(),
    });

    expect(answer.body).toMatchObject({
      requestedRedemptionMinor: "9999",
      cashEffectMinor: "-500",
      cashBalanceAfterMinor: "0",
      netCounterAmountMinor: "19500",
    });
  });

  it("caps at the INVOICE, so a redemption is never a cash withdrawal", async () => {
    await earn("1000000"); // balance 50,000

    const answer = await call({
      action: "redeem",
      customerCardId: cardId,
      grossAmountMinor: "2000",
      requestedRedemptionMinor: "50000",
      idempotencyKey: randomUUID(),
    });

    // At most the bill comes off, so the customer never walks away with the difference in cash.
    expect(answer.body).toMatchObject({ cashEffectMinor: "-2000", netCounterAmountMinor: "0" });
  });
});

describe("what the wire will not accept", () => {
  it("refuses an amount sent as a JSON number", async () => {
    /*
     * A JSON number is a double. Accepting one would mean deciding what a caller meant by 8.2 minor
     * units, and every reading of that is a bug in the caller rather than an amount.
     */
    const answer = await call({
      action: "earn",
      customerCardId: cardId,
      grossAmountMinor: 10000,
      idempotencyKey: randomUUID(),
    });
    expect(answer.status).toBe(400);
  });

  it("refuses a decimal, a negative and a currency field", async () => {
    for (const body of [
      { action: "earn", customerCardId: cardId, grossAmountMinor: "100.50", idempotencyKey: randomUUID() },
      { action: "earn", customerCardId: cardId, grossAmountMinor: "-100", idempotencyKey: randomUUID() },
      { action: "earn", customerCardId: cardId, grossAmountMinor: "100", currency: "USD", idempotencyKey: randomUUID() },
    ]) {
      const answer = await call(body);
      expect(answer.status, JSON.stringify(body)).toBe(400);
    }
  });

  it("refuses a reversal with no reason", async () => {
    const earned = await call({
      action: "earn",
      customerCardId: cardId,
      grossAmountMinor: "10000",
      idempotencyKey: randomUUID(),
    });
    const answer = await call({
      action: "reverse",
      monetaryOperationId: earned.body.operationId,
      reason: "  ",
      idempotencyKey: randomUUID(),
    });
    expect(answer.status).toBe(400);
  });
});

describe("reversing", () => {
  it("takes back what was earned, as a linked row rather than an edit", async () => {
    const earned = await call({
      action: "earn",
      customerCardId: cardId,
      grossAmountMinor: "10000",
      idempotencyKey: randomUUID(),
    });

    const reversed = await call({
      action: "reverse",
      monetaryOperationId: earned.body.operationId,
      reason: "Bill was rung up twice",
      idempotencyKey: randomUUID(),
    });

    expect(reversed.status).toBe(201);
    expect(reversed.body).toMatchObject({
      reversalOfId: earned.body.operationId,
      cashEffectMinor: "-500",
      cashBalanceAfterMinor: "0",
    });
  });

  it("refuses to reverse the same operation twice", async () => {
    const earned = await call({
      action: "earn",
      customerCardId: cardId,
      grossAmountMinor: "10000",
      idempotencyKey: randomUUID(),
    });
    const reason = "Rung up twice";
    await call({ action: "reverse", monetaryOperationId: earned.body.operationId, reason, idempotencyKey: randomUUID() });

    const second = await call({
      action: "reverse",
      monetaryOperationId: earned.body.operationId,
      reason,
      idempotencyKey: randomUUID(),
    });
    expect(second.status).toBeGreaterThanOrEqual(400);
  });
});

describe("who may run the counter", () => {
  it("refuses a signed-out caller", async () => {
    session.userId = null;
    const answer = await call({
      action: "earn",
      customerCardId: cardId,
      grossAmountMinor: "10000",
      idempotencyKey: randomUUID(),
    });
    expect(answer.status).toBe(401);
  });

  it("will not touch another business's card, and does not confirm it exists", async () => {
    const other = await createMonetaryShop();
    const theirs = await enrolMonetaryCustomer(other);
    session.userId = fx.userId;

    const answer = await call({
      action: "earn",
      customerCardId: theirs.customerCardId,
      grossAmountMinor: "10000",
      idempotencyKey: randomUUID(),
    });
    expect(answer.status).toBe(404);
  });
});
