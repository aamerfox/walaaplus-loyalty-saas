import { MembershipRole, OperationSource, Permission } from "@prisma/client";
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

import { POST as awardRoute } from "@/app/api/scanner/award/route";
import { GET as lookupRoute } from "@/app/api/scanner/lookup/route";
import { POST as pointsRoute } from "@/app/api/scanner/points/route";
import { POST as reverseRoute } from "@/app/api/scanner/reverse/route";
import { POST as membershipRoute } from "@/app/api/staff/membership/route";
import { POST as programsRoute } from "@/app/api/staff/programs/route";
import { prisma } from "@/server/db";
import { awardManualPoints } from "@/server/points/engine";
import { requireBusinessMembership } from "@/server/tenant/context";
import { setMembershipPermissions } from "@/server/tenant/memberships";
import {
  createLocation,
  createPointsShop,
  createStaff,
  createStampCafe,
  enrolCustomer,
  enrolPointsCustomer,
  resetDatabase,
  uniqueSyrianPhone,
} from "../setup/fixtures";

/**
 * The authenticated routes the merchant screens call.
 *
 * Every one of them is tested at the HTTP boundary rather than through its service, because the
 * boundary is where this prompt added something new: a strict schema, a location that is now
 * allowed to exist, and a body that arrives from a browser. The services beneath already have their
 * own suites; what these tests hold is that nothing widened on the way in.
 */

const key = () => `k-${Math.random().toString(36).slice(2)}-${Date.now()}`;

async function post(route: (req: Request) => Promise<Response>, url: string, body: unknown) {
  const res = await route(
    new Request(`http://localhost:3000${url}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const POINTS_PROGRAM = {
  cardType: "POINTS" as const,
  name: "Route points card",
  earnMode: "SPEND_BLOCK" as const,
  spendAmountPerBlockMinor: 1_000,
  pointsPerBlock: 1,
  tiers: [{ name: "Small reward", requiredPoints: 10, rewardValueMinor: 5_000 }],
};

describe("POST /api/staff/programs", () => {
  beforeAll(async () => {
    await resetDatabase();
  });
  beforeEach(() => {
    session.userId = null;
  });

  it("creates an additional points program for the caller's own business", async () => {
    const cafe = await createStampCafe({ name: "Stamps first" });
    session.userId = cafe.userId;

    const answer = await post(programsRoute, "/api/staff/programs", POINTS_PROGRAM);
    expect(answer.status).toBe(201);
    expect(answer.body.tierCount).toBe(1);

    const template = await prisma.programTemplate.findFirstOrThrow({
      where: { id: String(answer.body.templateId) },
      select: { businessId: true, cardType: true, name: true },
    });
    expect(template.businessId).toBe(cafe.businessId);
    expect(template.cardType).toBe("POINTS");

    // The response carries no capability: the direct source token stays on the server (B7).
    const source = await prisma.utmSourceLink.findFirstOrThrow({
      where: { templateId: String(answer.body.templateId) },
      select: { publicToken: true },
    });
    expect(JSON.stringify(answer.body)).not.toContain(source.publicToken);
  });

  it("refuses unknown, privileged and caller-supplied tenant fields", async () => {
    const cafe = await createStampCafe();
    session.userId = cafe.userId;

    for (const extra of [
      { businessId: cafe.businessId },
      { templateId: "t_1" },
      { sourceToken: "abcdefghijklmnop" },
      { cashbackPercent: 5 },
      { pointBalance: 500 },
      { contractVersion: 2 },
      { kind: "POINTS" },
      { locationId: cafe.locationId },
    ]) {
      const answer = await post(programsRoute, "/api/staff/programs", { ...POINTS_PROGRAM, ...extra });
      expect(answer.status, `${JSON.stringify(extra)} must be refused`).toBe(400);
    }

    expect(await prisma.programTemplate.count({ where: { businessId: cafe.businessId } })).toBe(1);
  });

  it("refuses fractional and zero values", async () => {
    const cafe = await createStampCafe();
    session.userId = cafe.userId;

    for (const broken of [
      { pointsPerBlock: 1.5 },
      { pointsPerBlock: 0 },
      { spendAmountPerBlockMinor: -1 },
      { tiers: [{ name: "Half", requiredPoints: 0.5 }] },
      { tiers: [] },
    ]) {
      const answer = await post(programsRoute, "/api/staff/programs", { ...POINTS_PROGRAM, ...broken });
      expect(answer.status, `${JSON.stringify(broken)} must be refused`).toBe(400);
    }
  });

  it("refuses a cashier and an anonymous caller", async () => {
    const cafe = await createStampCafe();
    const cashier = await createStaff(cafe, MembershipRole.CASHIER, [cafe.locationId]);

    session.userId = cashier.userId;
    expect((await post(programsRoute, "/api/staff/programs", POINTS_PROGRAM)).status).toBe(403);

    session.userId = null;
    expect([401, 403]).toContain((await post(programsRoute, "/api/staff/programs", POINTS_PROGRAM)).status);

    expect(await prisma.programTemplate.count({ where: { businessId: cafe.businessId } })).toBe(1);
  });

  it("conflicts on a repeated name, which is what protects the double click", async () => {
    const cafe = await createStampCafe();
    session.userId = cafe.userId;

    expect((await post(programsRoute, "/api/staff/programs", POINTS_PROGRAM)).status).toBe(201);
    const second = await post(programsRoute, "/api/staff/programs", POINTS_PROGRAM);
    expect(second.status).toBe(409);
    expect(await prisma.programTemplate.count({ where: { businessId: cafe.businessId, cardType: "POINTS" } })).toBe(1);
  });
});

describe("POST /api/staff/membership", () => {
  beforeAll(async () => {
    await resetDatabase();
  });
  beforeEach(() => {
    session.userId = null;
  });

  it("changes a role, permissions and locations for an authorized owner", async () => {
    const cafe = await createStampCafe();
    const branch = await createLocation(cafe, "Branch");
    const cashier = await createStaff(cafe, MembershipRole.CASHIER, [cafe.locationId]);
    session.userId = cafe.userId;

    expect((await post(membershipRoute, "/api/staff/membership", { action: "role", membershipId: cashier.membershipId, role: "MANAGER" })).status).toBe(200);
    expect((await post(membershipRoute, "/api/staff/membership", { action: "permissions", membershipId: cashier.membershipId, permissions: ["VIEW_DASHBOARD"] })).status).toBe(200);
    expect((await post(membershipRoute, "/api/staff/membership", { action: "locations", membershipId: cashier.membershipId, locationIds: [branch] })).status).toBe(200);

    const updated = await requireBusinessMembership(prisma, cashier.userId, cafe.businessId);
    expect(updated.role).toBe(MembershipRole.MANAGER);
    expect(updated.permissions.has(Permission.VIEW_DASHBOARD)).toBe(true);

    expect((await post(membershipRoute, "/api/staff/membership", { action: "deactivate", membershipId: cashier.membershipId })).status).toBe(200);
    await expect(requireBusinessMembership(prisma, cashier.userId, cafe.businessId)).rejects.toThrow();
    expect((await post(membershipRoute, "/api/staff/membership", { action: "reactivate", membershipId: cashier.membershipId })).status).toBe(200);
  });

  it("refuses editing your own membership, at the boundary", async () => {
    const cafe = await createStampCafe();
    const ownerMembership = await prisma.businessMembership.findFirstOrThrow({
      where: { businessId: cafe.businessId, userId: cafe.userId },
      select: { id: true },
    });
    session.userId = cafe.userId;

    const answer = await post(membershipRoute, "/api/staff/membership", { action: "deactivate", membershipId: ownerMembership.id });
    expect(answer.status).toBe(403);
  });

  it("refuses granting a permission the caller does not hold", async () => {
    const cafe = await createStampCafe();
    const manager = await createStaff(cafe, MembershipRole.MANAGER, []);
    await setMembershipPermissions(cafe.ctx, manager.membershipId, [Permission.EDIT_STAFF]);
    const cashier = await createStaff(cafe, MembershipRole.CASHIER, [cafe.locationId]);
    session.userId = manager.userId;

    const answer = await post(membershipRoute, "/api/staff/membership", {
      action: "permissions",
      membershipId: cashier.membershipId,
      permissions: ["EDIT_BILLING"],
    });
    expect(answer.status).toBe(403);

    const unchanged = await requireBusinessMembership(prisma, cashier.userId, cafe.businessId);
    expect(unchanged.permissions.has(Permission.EDIT_BILLING)).toBe(false);
  });

  it("refuses a cashier, an unknown action and another business's membership", async () => {
    const cafe = await createStampCafe();
    const rival = await createStampCafe({ name: "Rival" });
    const cashier = await createStaff(cafe, MembershipRole.CASHIER, [cafe.locationId]);
    const theirs = await createStaff(rival, MembershipRole.CASHIER, [rival.locationId]);

    session.userId = cashier.userId;
    expect((await post(membershipRoute, "/api/staff/membership", { action: "deactivate", membershipId: theirs.membershipId })).status).toBe(403);

    session.userId = cafe.userId;
    // Tenant-scoped: another business's membership is "not found", never "forbidden".
    expect((await post(membershipRoute, "/api/staff/membership", { action: "deactivate", membershipId: theirs.membershipId })).status).toBe(404);
    // OWNER is not an option this endpoint offers at all.
    expect((await post(membershipRoute, "/api/staff/membership", { action: "role", membershipId: theirs.membershipId, role: "OWNER" })).status).toBe(400);
    expect((await post(membershipRoute, "/api/staff/membership", { action: "delete", membershipId: theirs.membershipId })).status).toBe(400);
  });
});

describe("POST /api/scanner/points", () => {
  beforeAll(async () => {
    await resetDatabase();
  });
  beforeEach(() => {
    session.userId = null;
  });

  it("awards and redeems through the engine, and replays a retry", async () => {
    const shop = await createPointsShop();
    const card = await enrolPointsCustomer(shop);
    session.userId = shop.userId;

    const idempotencyKey = key();
    const award = await post(pointsRoute, "/api/scanner/points", {
      mode: "purchase",
      customerCardId: card.customerCardId,
      purchaseAmountMinor: 30_000,
      idempotencyKey,
    });
    expect(award.status).toBe(200);
    expect(award.body.pointBalance).toBe(30);

    const retry = await post(pointsRoute, "/api/scanner/points", {
      mode: "purchase",
      customerCardId: card.customerCardId,
      purchaseAmountMinor: 30_000,
      idempotencyKey,
    });
    expect(retry.body.transactionGroupId).toBe(award.body.transactionGroupId);
    expect(retry.body.pointBalance).toBe(30);

    const redeem = await post(pointsRoute, "/api/scanner/points", {
      mode: "redeem",
      customerCardId: card.customerCardId,
      rewardTierId: shop.cheapTierId,
      idempotencyKey: key(),
    });
    expect(redeem.status).toBe(200);
    expect(redeem.body.pointBalance).toBe(20);
    expect(redeem.body.rewardTierId).toBe(shop.cheapTierId);
  });

  it("refuses unknown fields, a caller-supplied balance and a foreign card", async () => {
    const shop = await createPointsShop();
    const card = await enrolPointsCustomer(shop);
    const rival = await createPointsShop({ name: "Rival" });
    const rivalCard = await enrolPointsCustomer(rival);
    session.userId = shop.userId;

    for (const extra of [{ pointBalance: 999 }, { quantity: 5 }, { sourceToken: "abcdefghijk" }, { rewardTierId: shop.cheapTierId }]) {
      const answer = await post(pointsRoute, "/api/scanner/points", {
        mode: "purchase",
        customerCardId: card.customerCardId,
        purchaseAmountMinor: 1_000,
        idempotencyKey: key(),
        ...extra,
      });
      expect(answer.status, `${JSON.stringify(extra)} must be refused`).toBe(400);
    }

    const foreign = await post(pointsRoute, "/api/scanner/points", {
      mode: "manual",
      customerCardId: rivalCard.customerCardId,
      quantity: 5,
      idempotencyKey: key(),
    });
    expect(foreign.status).toBe(404);
  });

  it("refuses a location the program does not offer, and requires one when it offers several", async () => {
    const cafe = await createStampCafe({ name: "Multi base" });
    const branch = await createLocation(cafe, "Branch");
    const kiosk = await createLocation(cafe, "Kiosk");
    const shop = await createPointsShop({
      existing: { userId: cafe.userId, businessId: cafe.businessId, locationId: cafe.locationId },
      name: "Two counters",
      mechanics: { availableLocations: [cafe.locationId, branch] },
    });
    const card = await enrolPointsCustomer(shop);
    session.userId = cafe.userId;

    const common = { mode: "manual", customerCardId: card.customerCardId, quantity: 5 };

    // Not offered by this program.
    expect((await post(pointsRoute, "/api/scanner/points", { ...common, locationId: kiosk, idempotencyKey: key() })).status).toBe(404);
    // Several on offer and none named: the server refuses to guess.
    expect((await post(pointsRoute, "/api/scanner/points", { ...common, idempotencyKey: key() })).status).toBe(400);
    // One of its own, named.
    const ok = await post(pointsRoute, "/api/scanner/points", { ...common, locationId: branch, idempotencyKey: key() });
    expect(ok.status).toBe(200);
    expect(ok.body.locationId).toBe(branch);
  });

  it("refuses a cashier who may not work the location they named", async () => {
    const cafe = await createStampCafe({ name: "Assigned" });
    const branch = await createLocation(cafe, "Branch");
    const shop = await createPointsShop({
      existing: { userId: cafe.userId, businessId: cafe.businessId, locationId: cafe.locationId },
      name: "Assigned points",
      mechanics: { availableLocations: [cafe.locationId, branch] },
    });
    const card = await enrolPointsCustomer(shop);
    const mainOnly = await createStaff(cafe, MembershipRole.CASHIER, [cafe.locationId]);
    session.userId = mainOnly.userId;

    const answer = await post(pointsRoute, "/api/scanner/points", {
      mode: "manual",
      customerCardId: card.customerCardId,
      quantity: 1,
      locationId: branch,
      idempotencyKey: key(),
    });
    expect(answer.status).toBe(403);
  });
});

describe("the stamp routes keep their Phase 1a contract", () => {
  beforeAll(async () => {
    await resetDatabase();
  });
  beforeEach(() => {
    session.userId = null;
  });

  it("still refuses a location on a Main-only program", async () => {
    const cafe = await createStampCafe();
    const branch = await createLocation(cafe, "Branch");
    const card = await enrolCustomer(cafe);
    session.userId = cafe.userId;

    const named = await post(awardRoute, "/api/scanner/award", {
      mode: "manual",
      customerCardId: card.customerCardId,
      quantity: 1,
      locationId: branch,
      idempotencyKey: key(),
    });
    expect(named.status).toBe(400);

    const plain = await post(awardRoute, "/api/scanner/award", {
      mode: "manual",
      customerCardId: card.customerCardId,
      quantity: 1,
      idempotencyKey: key(),
    });
    expect(plain.status).toBe(200);
    expect(plain.body.stampBalance).toBe(1);
  });

  it("refuses a nested location however it is wrapped", async () => {
    const cafe = await createStampCafe();
    const card = await enrolCustomer(cafe);
    session.userId = cafe.userId;

    const answer = await post(awardRoute, "/api/scanner/award", {
      mode: "manual",
      customerCardId: card.customerCardId,
      quantity: 1,
      idempotencyKey: key(),
      extra: { locationId: cafe.locationId },
    });
    expect(answer.status).toBe(400);
  });

  it("reverses either kind of card, resolving the engine on the server", async () => {
    const shop = await createPointsShop();
    const card = await enrolPointsCustomer(shop);
    session.userId = shop.userId;

    const award = await awardManualPoints(shop.ctx, {
      customerCardId: card.customerCardId,
      quantity: 12,
      idempotencyKey: key(),
      source: OperationSource.SCANNER,
    });

    const reversal = await post(reverseRoute, "/api/scanner/reverse", {
      transactionGroupId: award.transactionGroupId,
      reason: "rang up the wrong customer",
      idempotencyKey: key(),
    });
    expect(reversal.status).toBe(200);
    expect(reversal.body.cardType).toBe("POINTS");
    expect(reversal.body.pointBalance).toBe(0);

    // A reversal never takes a location: it corrects the place the mistake was made.
    const withLocation = await post(reverseRoute, "/api/scanner/reverse", {
      transactionGroupId: award.transactionGroupId,
      reason: "again",
      idempotencyKey: key(),
      locationId: shop.locationId,
    });
    expect(withLocation.status).toBe(400);
  });
});

describe("GET /api/scanner/lookup", () => {
  beforeAll(async () => {
    await resetDatabase();
  });

  it("returns a points card instead of failing on it", async () => {
    /*
     * The regression this exists for: the lookup read every card through the STAMP mechanics
     * contract, so one points card in a business made the phone lookup throw - and it took the
     * customer's stamp cards down with it, because the lookup maps over every card the number
     * matched. The engines were isolated; this read was not.
     */
    const cafe = await createStampCafe({ name: "Both kinds" });
    const shop = await createPointsShop({
      existing: { userId: cafe.userId, businessId: cafe.businessId, locationId: cafe.locationId },
      name: "Both kinds points",
    });
    const phone = uniqueSyrianPhone();
    await enrolCustomer(cafe, { phone });
    await enrolPointsCustomer(shop, { phone });
    session.userId = cafe.userId;

    const local = `0${phone.slice(4)}`;
    const res = await lookupRoute(new Request(`http://localhost:3000/api/scanner/lookup?phone=${encodeURIComponent(local)}`));
    expect(res.status).toBe(200);
    const { cards } = (await res.json()) as { cards: { cardType: string; programName: string; earnMode: string }[] };

    expect(cards).toHaveLength(2);
    expect(cards.map((c) => c.cardType).sort()).toEqual(["POINTS", "STAMP"]);
    // Each card says which program it belongs to and how that program earns, so the counter can
    // show the buttons that exist rather than the ones the engine would refuse.
    expect(cards.every((c) => typeof c.programName === "string" && c.programName.length > 0)).toBe(true);
    expect(cards.every((c) => ["MANUAL", "PER_VISIT", "SPEND_BLOCK"].includes(c.earnMode))).toBe(true);

    // No capability travels with a lookup: the card's page token is not in this response.
    const tokens = await prisma.customerCard.findMany({ where: { businessId: cafe.businessId }, select: { shareToken: true } });
    for (const { shareToken } of tokens) expect(JSON.stringify(cards)).not.toContain(shareToken);
  });
});
