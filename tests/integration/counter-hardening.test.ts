import { MembershipRole } from "@prisma/client";
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

import { GET as enrollGet, POST as enrollPost } from "@/app/api/enroll/route";
import { POST as awardRoute } from "@/app/api/scanner/award/route";
import { POST as cardLinkRoute } from "@/app/api/scanner/card-link/route";
import { POST as counterEnrollRoute } from "@/app/api/scanner/enroll/route";
import { POST as sourcesRoute } from "@/app/api/staff/sources/route";
import { AuditAction } from "@/server/audit/audit";
import { revealCardLink } from "@/server/customers/counter-enrollment";
import { prisma } from "@/server/db";
import { listSourceLinks } from "@/server/program/source-links";
import { createDraftVersion, publishDraftVersion, updateDraftVersion } from "@/server/program/versions";
import {
  consumeStaffActionLimit,
  hashKey,
  RateLimitScope,
  STAFF_ENROLL_MAX,
  STAFF_WRITE_MAX,
} from "@/server/security/rate-limit";
import { requireBusinessMembership } from "@/server/tenant/context";
import { createLocation as createLocationService } from "@/server/tenant/locations";
import {
  createStaff,
  createStampCafe,
  enrolCustomer,
  resetDatabase,
  uniqueSyrianPhone,
  type StampCafeFixture,
} from "../setup/fixtures";

/**
 * The four deferred findings this prompt closes, each with the behaviour that proves it.
 *
 * | Finding | What is asserted here |
 * |---|---|
 * | M-10 | the counter attribution row shares a commit with the issuance it describes |
 * | M-11 | one member of staff has a bounded number of enrolments and writes per hour |
 * | L-15 | nothing rate-limits public enrolment, because public enrolment does not exist |
 * | L-17 | a cashier cannot reveal the card link of a customer served only at another counter |
 *
 * B7 is re-asserted alongside them, because every one of these touches the enrolment path and the
 * whole point of B7 is that it does not come back by accident.
 */

const key = () => `k-${Math.random().toString(36).slice(2)}-${Date.now()}`;

async function call(route: (req: Request) => Promise<Response>, url: string, body: unknown) {
  const res = await route(
    new Request(`http://localhost:3000${url}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return {
    status: res.status,
    retryAfter: res.headers.get("retry-after"),
    body: (await res.json()) as Record<string, unknown> & { error?: { code?: string } },
  };
}

describe("M-10 — counter attribution commits with the issuance", () => {
  let cafe: StampCafeFixture;

  beforeEach(async () => {
    await resetDatabase();
    cafe = await createStampCafe();
    session.userId = cafe.userId;
  });

  it("writes the attribution row in the same transaction, naming the actor and no customer", async () => {
    const phone = uniqueSyrianPhone();
    const answer = await call(counterEnrollRoute, "/api/scanner/enroll", { businessId: cafe.businessId, phone, firstName: "سارة" });
    expect(answer.status).toBe(201);

    const [issued, attributed] = await Promise.all([
      prisma.auditLog.findFirstOrThrow({ where: { businessId: cafe.businessId, action: AuditAction.CARD_ISSUED } }),
      prisma.auditLog.findFirstOrThrow({ where: { businessId: cafe.businessId, action: AuditAction.CARD_ISSUED_AT_COUNTER } }),
    ]);

    // One commit: the two rows describe the same card, and the attribution names the member.
    expect(attributed.entityId).toBe(issued.entityId);
    expect(attributed.actorUserId).toBe(cafe.userId);
    const membership = await prisma.businessMembership.findFirstOrThrow({
      where: { userId: cafe.userId, businessId: cafe.businessId },
      select: { id: true },
    });
    expect((attributed.metadata as { membershipId: string }).membershipId).toBe(membership.id);

    const serialized = JSON.stringify([issued, attributed]);
    expect(serialized).not.toContain(phone);
    expect(serialized).not.toContain("سارة");
  });

  it("records a repeat as a reveal, not as a second issuance", async () => {
    const phone = uniqueSyrianPhone();
    await call(counterEnrollRoute, "/api/scanner/enroll", { businessId: cafe.businessId, phone });
    const again = await call(counterEnrollRoute, "/api/scanner/enroll", { businessId: cafe.businessId, phone });
    expect(again.status).toBe(200);
    expect(again.body.created).toBe(false);

    // Exactly one issuance, ever. The second call handed the staff member the card link, which is
    // what a reveal is, and it is recorded as one.
    const issuances = await prisma.auditLog.count({
      where: { businessId: cafe.businessId, action: AuditAction.CARD_ISSUED_AT_COUNTER },
    });
    expect(issuances).toBe(1);
    const reveals = await prisma.auditLog.count({
      where: { businessId: cafe.businessId, action: AuditAction.CARD_LINK_REVEALED },
    });
    expect(reveals).toBe(1);
  });
});

describe("M-11 — one member of staff, one window", () => {
  let cafe: StampCafeFixture;

  beforeEach(async () => {
    await resetDatabase();
    cafe = await createStampCafe();
    session.userId = cafe.userId;
  });

  it("allows the whole allowance and refuses the one after it", async () => {
    const membership = await prisma.businessMembership.findFirstOrThrow({
      where: { userId: cafe.userId, businessId: cafe.businessId },
      select: { id: true },
    });
    const ctx = { membershipId: membership.id, businessId: cafe.businessId, userId: cafe.userId };

    for (let i = 0; i < STAFF_ENROLL_MAX; i += 1) {
      const decision = await consumeStaffActionLimit(ctx, "enroll");
      expect(decision.allowed, `attempt ${i + 1} of ${STAFF_ENROLL_MAX} must be allowed`).toBe(true);
    }
    const refused = await consumeStaffActionLimit(ctx, "enroll");
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterSeconds).toBeGreaterThan(0);

    // Writes are a different window: exhausting enrolment does not stop the till serving.
    const write = await consumeStaffActionLimit(ctx, "write");
    expect(write.allowed).toBe(true);

    // Audited once, with no customer anywhere in it.
    const limited = await prisma.auditLog.findMany({
      where: { businessId: cafe.businessId, action: AuditAction.STAFF_RATE_LIMITED },
    });
    expect(limited).toHaveLength(1);
    expect(limited[0].actorUserId).toBe(cafe.userId);
  });

  it("answers an exhausted window with 429 and a retry-after", async () => {
    const card = await enrolCustomer(cafe, { phone: uniqueSyrianPhone() });
    const membership = await prisma.businessMembership.findFirstOrThrow({
      where: { userId: cafe.userId, businessId: cafe.businessId },
      select: { id: true },
    });

    // Spend the window directly rather than by making three hundred requests: the limiter has its
    // own test above, and what this one is about is the ROUTE's answer.
    await prisma.authRateLimit.create({
      data: {
        scope: RateLimitScope.STAFF_WRITE,
        keyHash: hashKey(RateLimitScope.STAFF_WRITE, membership.id),
        attempts: STAFF_WRITE_MAX,
        windowStart: new Date(),
        expiresAt: new Date(Date.now() + 3_600_000),
        lastAttemptAt: new Date(),
      },
    });

    const refused = await call(awardRoute, "/api/scanner/award", {
      businessId: cafe.businessId,
      customerCardId: card.customerCardId,
      mode: "manual",
      quantity: 1,
      idempotencyKey: key(),
    });
    expect(refused.status).toBe(429);
    expect(refused.body.error?.code).toBe("RATE_LIMITED");
    expect(Number(refused.retryAfter)).toBeGreaterThan(0);

    // Nothing was written: the limit runs before the service.
    const after = await prisma.customerCard.findUniqueOrThrow({ where: { id: card.customerCardId } });
    expect(after.stampBalance).toBe(0);
  });

  it("keeps one member's window to themselves", async () => {
    const cashier = await createStaff(cafe, MembershipRole.CASHIER, [cafe.locationId]);
    const theirMembership = await prisma.businessMembership.findFirstOrThrow({
      where: { userId: cashier.userId, businessId: cafe.businessId },
      select: { id: true },
    });
    const ownerMembership = await prisma.businessMembership.findFirstOrThrow({
      where: { userId: cafe.userId, businessId: cafe.businessId },
      select: { id: true },
    });

    await prisma.authRateLimit.create({
      data: {
        scope: RateLimitScope.STAFF_WRITE,
        keyHash: hashKey(RateLimitScope.STAFF_WRITE, ownerMembership.id),
        attempts: STAFF_WRITE_MAX,
        windowStart: new Date(),
        expiresAt: new Date(Date.now() + 3_600_000),
        lastAttemptAt: new Date(),
      },
    });

    const theirs = await consumeStaffActionLimit(
      { membershipId: theirMembership.id, businessId: cafe.businessId, userId: cashier.userId },
      "write",
    );
    expect(theirs.allowed).toBe(true);
  });
});

describe("L-15 and B7 — public enrolment is gone, and so is its limiter", () => {
  it("answers the withdrawn endpoint identically to everyone, opening no window", async () => {
    await resetDatabase();
    const before = await prisma.authRateLimit.count();

    for (const run of [
      await enrollPost(),
      await enrollGet(),
      await enrollPost(),
    ]) {
      expect(run.status).toBe(410);
      const body = (await run.json()) as { error: { code: string } };
      expect(body.error.code).toBe("ENROLLMENT_MOVED");
    }

    // No row, for any scope: the handler reads nothing and counts nothing.
    expect(await prisma.authRateLimit.count()).toBe(before);
  });

  it("has no enrolment scope left to consume", () => {
    expect(Object.values(RateLimitScope)).not.toContain("enroll.ip");
    expect(Object.values(RateLimitScope)).not.toContain("enroll.link");
  });
});

describe("named sources are internal, and the built-in one is protected", () => {
  let cafe: StampCafeFixture;

  beforeEach(async () => {
    await resetDatabase();
    cafe = await createStampCafe();
    session.userId = cafe.userId;
  });

  it("creates, renames and deactivates a source without ever returning a token", async () => {
    const created = await call(sourcesRoute, "/api/staff/sources", {
      action: "create",
      businessId: cafe.businessId,
      templateId: cafe.program.templateId,
      name: "Instagram",
      utmSource: "instagram",
    });
    expect(created.status).toBe(201);
    const sourceLinkId = String(created.body.id);

    // The one assertion this whole feature turns on.
    const seen = JSON.stringify(created.body);
    expect(seen).not.toContain("publicToken");
    expect(seen).not.toContain("token");
    expect(seen).not.toMatch(/https?:\/\//);

    const renamed = await call(sourcesRoute, "/api/staff/sources", {
      action: "update",
      businessId: cafe.businessId,
      sourceLinkId,
      name: "Instagram autumn",
    });
    expect(renamed.status).toBe(200);
    expect(JSON.stringify(renamed.body)).not.toContain("token");

    const off = await call(sourcesRoute, "/api/staff/sources", {
      action: "deactivate",
      businessId: cafe.businessId,
      sourceLinkId,
    });
    expect(off.status).toBe(200);

    const list = await listSourceLinks(cafe.ctx, cafe.program.templateId);
    const instagram = list.find((s) => s.id === sourceLinkId)!;
    expect(instagram.name).toBe("Instagram autumn");
    expect(instagram.active).toBe(false);
    expect(JSON.stringify(list)).not.toContain("publicToken");

    // The audit rows carry attribution, never the capability.
    const audits = await prisma.auditLog.findMany({ where: { entityId: sourceLinkId } });
    const row = await prisma.utmSourceLink.findUniqueOrThrow({ where: { id: sourceLinkId }, select: { publicToken: true } });
    expect(JSON.stringify(audits)).not.toContain(row.publicToken);
  });

  it("will not let the built-in counter source be renamed or switched off", async () => {
    const direct = (await listSourceLinks(cafe.ctx, cafe.program.templateId)).find((s) => s.isDirect)!;
    expect(direct).toBeDefined();

    const renamed = await call(sourcesRoute, "/api/staff/sources", {
      action: "update",
      businessId: cafe.businessId,
      sourceLinkId: direct.id,
      name: "Something else",
    });
    expect(renamed.status).toBe(409);
    expect(renamed.body.error?.code).toBe("SOURCE_PROTECTED");

    const off = await call(sourcesRoute, "/api/staff/sources", {
      action: "deactivate",
      businessId: cafe.businessId,
      sourceLinkId: direct.id,
    });
    expect(off.status).toBe(409);
    expect(off.body.error?.code).toBe("SOURCE_PROTECTED");

    // Still there, still working: staff can still enrol.
    const enrolled = await call(counterEnrollRoute, "/api/scanner/enroll", {
      businessId: cafe.businessId,
      phone: uniqueSyrianPhone(),
    });
    expect(enrolled.status).toBe(201);
  });

  it("refuses a cashier, and another business's program", async () => {
    const cashier = await createStaff(cafe, MembershipRole.CASHIER, [cafe.locationId]);
    session.userId = cashier.userId;
    const byCashier = await call(sourcesRoute, "/api/staff/sources", {
      action: "create",
      businessId: cafe.businessId,
      templateId: cafe.program.templateId,
      name: "Nope",
      utmSource: "nope",
    });
    expect(byCashier.status).toBe(403);

    const theirs = await createStampCafe({ name: "Theirs" });
    session.userId = cafe.userId;
    const crossTenant = await call(sourcesRoute, "/api/staff/sources", {
      action: "create",
      businessId: cafe.businessId,
      templateId: theirs.program.templateId,
      name: "Nope",
      utmSource: "nope",
    });
    expect(crossTenant.status).toBe(404);
  });
});

describe("L-17 — a card link is revealed only where the member serves", () => {
  it("refuses a cashier at another counter, and allows the manager", async () => {
    await resetDatabase();
    const cafe = await createStampCafe();
    session.userId = cafe.userId;

    const branchId = (await createLocationService(cafe.ctx, { name: "Branch" })).id;

    // A version that runs at the BRANCH only, so a card issued under it belongs to the branch.
    await createDraftVersion(cafe.ctx, cafe.program.templateId);
    await updateDraftVersion(cafe.ctx, cafe.program.templateId, {
      mechanics: {
        kind: "STAMP",
        contractVersion: 1,
        stampsRequiredPerReward: 10,
        rewardName: "قهوة مجانية",
        earnMode: "MANUAL",
        countRewardRedemptionAsVisit: false,
        availableLocations: [branchId],
      },
    });
    await publishDraftVersion(cafe.ctx, cafe.program.templateId, 2);

    const branchCard = await enrolCustomer(cafe, { phone: uniqueSyrianPhone() });

    // A cashier assigned only to Main.
    const mainCashier = await createStaff(cafe, MembershipRole.CASHIER, [cafe.locationId]);
    const mainCtx = await requireBusinessMembership(prisma, mainCashier.userId, cafe.businessId);
    await expect(revealCardLink(mainCtx, branchCard.customerCardId)).rejects.toThrow(/not found/i);

    // The same cashier, once assigned to the branch.
    const branchCashier = await createStaff(cafe, MembershipRole.CASHIER, [branchId]);
    const branchCtx = await requireBusinessMembership(prisma, branchCashier.userId, cafe.businessId);
    const revealed = await revealCardLink(branchCtx, branchCard.customerCardId);
    expect(revealed.cardUrl).toContain("/card/");

    // The owner is unrestricted: they answer the support call about a branch they are not in.
    const byOwner = await revealCardLink(cafe.ctx, branchCard.customerCardId);
    expect(byOwner.serialNumber).toBe(revealed.serialNumber);

    // And the refusal is a 404 through the route, not a 403: a member learns only that they cannot.
    session.userId = mainCashier.userId;
    const overHttp = await call(cardLinkRoute, "/api/scanner/card-link", {
      businessId: cafe.businessId,
      customerCardId: branchCard.customerCardId,
    });
    expect(overHttp.status).toBe(404);
  });

  it("refuses a cashier with no counter assigned at all", async () => {
    await resetDatabase();
    const cafe = await createStampCafe();
    session.userId = cafe.userId;
    const card = await enrolCustomer(cafe, { phone: uniqueSyrianPhone() });

    const unassigned = await createStaff(cafe, MembershipRole.CASHIER, []);
    const ctx = await requireBusinessMembership(prisma, unassigned.userId, cafe.businessId);
    // An empty assignment list is never "unrestricted", anywhere in this system.
    await expect(revealCardLink(ctx, card.customerCardId)).rejects.toThrow(/not found/i);
  });
});
