/**
 * Phase 1a Prompt 2 — the authenticated scanner endpoints.
 *
 * Only the SESSION is mocked: `getCurrentUserId` / `requireUserId` answer with whichever user the
 * test is acting as. Everything below that is real — membership resolution, permissions, the
 * ledger, the database. Mocking the tenant check instead would make these tests prove nothing,
 * because the tenant check is the thing under test.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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

import { MembershipRole } from "@prisma/client";
import { POST as awardRoute } from "@/app/api/scanner/award/route";
import { GET as lookupRoute } from "@/app/api/scanner/lookup/route";
import { POST as redeemRoute } from "@/app/api/scanner/redeem/route";
import { POST as reverseRoute } from "@/app/api/scanner/reverse/route";
import { POST as cashierRoute } from "@/app/api/staff/cashiers/route";
import { prisma } from "@/server/db";
import {
  createCafeCashier,
  createStampCafe,
  enrolCustomer,
  expectReconciled,
  resetDatabase,
  uniqueEmail,
  uniqueSyrianPhone,
  type StampCafeFixture,
} from "../setup/fixtures";

interface Answer {
  status: number;
  body: Record<string, unknown>;
}

async function callPost(
  handler: (req: Request) => Promise<Response>,
  path: string,
  body: unknown,
): Promise<Answer> {
  const res = await handler(
    new Request(`http://localhost:3000${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

async function callLookup(query: Record<string, string>): Promise<Answer> {
  const url = new URL("http://localhost:3000/api/scanner/lookup");
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const res = await lookupRoute(new Request(url));
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

const key = () => `e2e-${crypto.randomUUID()}`;

describe("scanner routes", () => {
  let cafe: StampCafeFixture;
  let rival: StampCafeFixture;
  let cardId: string;
  let qrToken: string;
  let phone: string;
  let rivalCardId: string;

  beforeAll(async () => {
    await resetDatabase();
    cafe = await createStampCafe({ mechanics: { stampsRequiredPerReward: 5 } });
    rival = await createStampCafe({ mechanics: { stampsRequiredPerReward: 5 } });

    phone = uniqueSyrianPhone();
    const enrolled = await enrolCustomer(cafe, { phone, firstName: "زبون" });
    cardId = enrolled.customerCardId;
    qrToken = enrolled.qrToken;
    rivalCardId = (await enrolCustomer(rival)).customerCardId;
  });

  beforeEach(() => {
    session.userId = cafe.userId; // the owner, unless a test says otherwise
  });

  describe("authentication", () => {
    it("refuses every endpoint when nobody is signed in", async () => {
      session.userId = null;
      expect((await callLookup({ qr: qrToken })).status).toBe(401);
      expect((await callPost(awardRoute, "/api/scanner/award", { mode: "manual", quantity: 1, customerCardId: cardId, idempotencyKey: key() })).status).toBe(401);
      expect((await callPost(redeemRoute, "/api/scanner/redeem", { customerCardId: cardId, idempotencyKey: key() })).status).toBe(401);
      expect((await callPost(reverseRoute, "/api/scanner/reverse", { transactionGroupId: crypto.randomUUID(), reason: "x", idempotencyKey: key() })).status).toBe(401);
      expect((await callPost(cashierRoute, "/api/staff/cashiers", { email: uniqueEmail(), password: "0123456789", firstName: "X" })).status).toBe(401);
    });

    it("refuses a signed-in user with no membership in the business", async () => {
      session.userId = rival.userId;
      const answer = await callLookup({ qr: qrToken, businessId: cafe.businessId });
      expect(answer.status).toBe(403);
    });
  });

  describe("lookup", () => {
    it("finds the card by QR token", async () => {
      const answer = await callLookup({ qr: qrToken });
      expect(answer.status).toBe(200);
      const cards = answer.body.cards as { customerCardId: string }[];
      expect(cards).toHaveLength(1);
      expect(cards[0].customerCardId).toBe(cardId);
    });

    it("finds the card by phone, in any spelling", async () => {
      for (const spelling of [phone, `0${phone.slice(4)}`]) {
        const answer = await callLookup({ phone: spelling });
        expect(answer.status, spelling).toBe(200);
        expect((answer.body.cards as unknown[]).length).toBe(1);
      }
    });

    it("returns an empty list rather than an error for an unknown phone", async () => {
      const answer = await callLookup({ phone: uniqueSyrianPhone() });
      expect(answer.status).toBe(200);
      expect(answer.body.cards).toEqual([]);
    });

    it("refuses a lookup that names no identifier", async () => {
      expect((await callLookup({})).status).toBe(400);
    });

    it("cannot reach another business's card by QR, phone or serial", async () => {
      const rivalCard = await prisma.customerCard.findUniqueOrThrow({ where: { id: rivalCardId } });
      expect((await callLookup({ qr: rivalCard.qrToken })).status).toBe(404);
      expect((await callLookup({ serial: rivalCard.serialNumber })).status).toBe(404);

      const rivalPhone = (
        await prisma.customerBusinessProfile.findFirstOrThrow({
          where: { id: rivalCard.customerBusinessProfileId },
          select: { customer: { select: { normalizedPhone: true } } },
        })
      ).customer.normalizedPhone;
      const byPhone = await callLookup({ phone: rivalPhone });
      expect(byPhone.status).toBe(200);
      expect(byPhone.body.cards).toEqual([]);
    });

    it("refuses a query string that names a location", async () => {
      expect((await callLookup({ qr: qrToken, locationId: cafe.locationId })).status).toBe(400);
    });
  });

  describe("award, redeem and reverse", () => {
    it("awards through the engine and reports the new balances", async () => {
      const fresh = (await enrolCustomer(cafe)).customerCardId;
      const answer = await callPost(awardRoute, "/api/scanner/award", {
        mode: "manual",
        quantity: 2,
        customerCardId: fresh,
        idempotencyKey: key(),
      });

      expect(answer.status).toBe(200);
      expect(answer.body.stampBalance).toBe(2);
      const rows = await prisma.loyaltyOperation.findMany({ where: { customerCardId: fresh } });
      expect(rows).toHaveLength(1);
      expect(rows[0].kind).toBe("MANUAL_AWARD");
      expect(rows[0].locationId).toBe(cafe.locationId); // Main, resolved by the server
      await expectReconciled(cafe.businessId);
    });

    it("crosses the threshold and then redeems", async () => {
      const fresh = (await enrolCustomer(cafe)).customerCardId;
      const award = await callPost(awardRoute, "/api/scanner/award", {
        mode: "manual",
        quantity: 5,
        customerCardId: fresh,
        idempotencyKey: key(),
      });
      expect(award.body.rewardsEarned).toBe(1);
      expect(award.body.rewardBalance).toBe(1);

      const redeem = await callPost(redeemRoute, "/api/scanner/redeem", { customerCardId: fresh, idempotencyKey: key() });
      expect(redeem.status).toBe(200);
      expect(redeem.body.rewardBalance).toBe(0);
      expect(redeem.body.stampBalance).toBe(0);
      await expectReconciled(cafe.businessId);
    });

    it("reports a redemption with no reward as its own conflict code", async () => {
      const fresh = (await enrolCustomer(cafe)).customerCardId;
      const answer = await callPost(redeemRoute, "/api/scanner/redeem", { customerCardId: fresh, idempotencyKey: key() });
      expect(answer.status).toBe(409);
      expect((answer.body.error as { code: string }).code).toBe("NO_REWARD_AVAILABLE");
    });

    it("reverses a group and refuses to reverse it twice", async () => {
      const fresh = (await enrolCustomer(cafe)).customerCardId;
      const award = await callPost(awardRoute, "/api/scanner/award", {
        mode: "manual",
        quantity: 3,
        customerCardId: fresh,
        idempotencyKey: key(),
      });
      const groupId = String(award.body.transactionGroupId);

      const reversal = await callPost(reverseRoute, "/api/scanner/reverse", {
        transactionGroupId: groupId,
        reason: "wrong customer",
        idempotencyKey: key(),
      });
      expect(reversal.status).toBe(200);
      expect(reversal.body.stampBalance).toBe(0);

      const again = await callPost(reverseRoute, "/api/scanner/reverse", {
        transactionGroupId: groupId,
        reason: "again",
        idempotencyKey: key(),
      });
      expect(again.status).toBe(409);
      expect((again.body.error as { code: string }).code).toBe("ALREADY_REVERSED");
      await expectReconciled(cafe.businessId);
    });

    it("requires a reason for a reversal", async () => {
      const answer = await callPost(reverseRoute, "/api/scanner/reverse", {
        transactionGroupId: crypto.randomUUID(),
        reason: "   ",
        idempotencyKey: key(),
      });
      expect(answer.status).toBe(400);
    });

    it("refuses an award on another business's card", async () => {
      const answer = await callPost(awardRoute, "/api/scanner/award", {
        mode: "manual",
        quantity: 1,
        customerCardId: rivalCardId,
        idempotencyKey: key(),
      });
      expect(answer.status).toBe(404);
      expect(await prisma.loyaltyOperation.count({ where: { customerCardId: rivalCardId } })).toBe(0);
    });

    it("validates the award mode and its arguments", async () => {
      const fresh = (await enrolCustomer(cafe)).customerCardId;
      for (const body of [
        { mode: "nonsense", customerCardId: fresh, idempotencyKey: key() },
        { mode: "manual", customerCardId: fresh, idempotencyKey: key() },
        { mode: "purchase", customerCardId: fresh, idempotencyKey: key() },
        { mode: "manual", quantity: 1, customerCardId: fresh, idempotencyKey: "short" },
      ]) {
        expect((await callPost(awardRoute, "/api/scanner/award", body)).status).toBe(400);
      }
      expect(await prisma.loyaltyOperation.count({ where: { customerCardId: fresh } })).toBe(0);
    });
  });

  describe("idempotency", () => {
    it("replays a repeated request instead of awarding twice", async () => {
      const fresh = (await enrolCustomer(cafe)).customerCardId;
      const body = { mode: "manual", quantity: 2, customerCardId: fresh, idempotencyKey: key() };

      const first = await callPost(awardRoute, "/api/scanner/award", body);
      const retry = await callPost(awardRoute, "/api/scanner/award", body);

      expect(retry.body.transactionGroupId).toBe(first.body.transactionGroupId);
      expect(retry.body.stampBalance).toBe(2);
      expect(await prisma.loyaltyOperation.count({ where: { customerCardId: fresh } })).toBe(1);
    });

    it("executes a concurrent duplicate exactly once", async () => {
      const fresh = (await enrolCustomer(cafe)).customerCardId;
      const body = { mode: "manual", quantity: 1, customerCardId: fresh, idempotencyKey: key() };

      const answers = await Promise.all(Array.from({ length: 4 }, () => callPost(awardRoute, "/api/scanner/award", body)));
      expect(new Set(answers.map((a) => a.body.transactionGroupId)).size).toBe(1);
      expect(await prisma.loyaltyOperation.count({ where: { customerCardId: fresh } })).toBe(1);
      await expectReconciled(cafe.businessId);
    });

    it("refuses the same key reused for a different intent", async () => {
      const fresh = (await enrolCustomer(cafe)).customerCardId;
      const sameKey = key();
      await callPost(awardRoute, "/api/scanner/award", { mode: "manual", quantity: 1, customerCardId: fresh, idempotencyKey: sameKey });
      const conflict = await callPost(awardRoute, "/api/scanner/award", {
        mode: "manual",
        quantity: 5,
        customerCardId: fresh,
        idempotencyKey: sameKey,
      });
      expect(conflict.status).toBe(409);
      expect((conflict.body.error as { code: string }).code).toBe("IDEMPOTENCY_CONFLICT");
    });
  });

  describe("no request may name a location", () => {
    it("refuses it on every mutating endpoint, with no ledger write", async () => {
      const fresh = (await enrolCustomer(cafe)).customerCardId;
      const attempts: [typeof awardRoute, string, Record<string, unknown>][] = [
        [awardRoute, "/api/scanner/award", { mode: "manual", quantity: 1, customerCardId: fresh, idempotencyKey: key(), locationId: cafe.locationId }],
        [redeemRoute, "/api/scanner/redeem", { customerCardId: fresh, idempotencyKey: key(), locationId: cafe.locationId }],
        [reverseRoute, "/api/scanner/reverse", { transactionGroupId: crypto.randomUUID(), reason: "x", idempotencyKey: key(), locationId: cafe.locationId }],
      ];
      for (const [handler, path, body] of attempts) {
        const answer = await callPost(handler, path, body);
        expect(answer.status, path).toBe(400);
        expect(JSON.stringify(answer.body)).toMatch(/Main location/);
      }
      expect(await prisma.loyaltyOperation.count({ where: { customerCardId: fresh } })).toBe(0);
    });

    it("refuses a location hidden one level down, or spelled differently", async () => {
      const fresh = (await enrolCustomer(cafe)).customerCardId;
      for (const extra of [{ location: "Main" }, { meta: { locationId: cafe.locationId } }, { LocationID: cafe.locationId }]) {
        const answer = await callPost(awardRoute, "/api/scanner/award", {
          mode: "manual",
          quantity: 1,
          customerCardId: fresh,
          idempotencyKey: key(),
          ...extra,
        });
        expect(answer.status, JSON.stringify(extra)).toBe(400);
      }
      expect(await prisma.loyaltyOperation.count({ where: { customerCardId: fresh } })).toBe(0);
    });
  });

  describe("a cashier", () => {
    it("may look up and award, but not create staff", async () => {
      const cashier = await createCafeCashier(cafe);
      session.userId = cashier.userId;

      const found = await callLookup({ qr: qrToken });
      expect(found.status).toBe(200);

      const award = await callPost(awardRoute, "/api/scanner/award", {
        mode: "manual",
        quantity: 1,
        customerCardId: cardId,
        idempotencyKey: key(),
      });
      expect(award.status).toBe(200);

      const staff = await callPost(cashierRoute, "/api/staff/cashiers", {
        email: uniqueEmail(),
        password: "0123456789",
        firstName: "No",
      });
      expect(staff.status).toBe(403);
    });

    it("cannot act for another business even by naming it", async () => {
      const cashier = await createCafeCashier(cafe);
      session.userId = cashier.userId;
      const answer = await callPost(awardRoute, "/api/scanner/award", {
        mode: "manual",
        quantity: 1,
        customerCardId: rivalCardId,
        idempotencyKey: key(),
        businessId: rival.businessId,
      });
      expect(answer.status).toBe(403);
    });
  });

  describe("the owner-only cashier endpoint", () => {
    it("creates a cashier limited to Main with role defaults", async () => {
      session.userId = cafe.userId;
      const email = uniqueEmail("till");
      const answer = await callPost(cashierRoute, "/api/staff/cashiers", { email, password: "0123456789", firstName: "Till" });

      expect(answer.status).toBe(201);
      expect(answer.body).not.toHaveProperty("password");
      expect(JSON.stringify(answer.body)).not.toContain("0123456789");

      const membership = await prisma.businessMembership.findUniqueOrThrow({
        where: { id: String(answer.body.membershipId) },
        include: { locations: true },
      });
      expect(membership.role).toBe(MembershipRole.CASHIER);
      expect(membership.permissions).toEqual([]);
      expect(membership.locations.map((l) => l.locationId)).toEqual([cafe.locationId]);
    });

    it("refuses a duplicate email", async () => {
      session.userId = cafe.userId;
      const email = uniqueEmail("dup");
      expect((await callPost(cashierRoute, "/api/staff/cashiers", { email, password: "0123456789", firstName: "A" })).status).toBe(201);
      expect((await callPost(cashierRoute, "/api/staff/cashiers", { email, password: "0123456789", firstName: "B" })).status).toBe(409);
    });
  });
});
