/**
 * Phase 1a Prompt 2 — the owner's bootstrap flow.
 *
 * The product had a hole in the middle of it. Registration created a business, a Main location and
 * an OWNER; the stamp engine could award, redeem and reverse; and nothing in between let a
 * merchant create the card. So no enrolment link existed, no customer could join, and real-device
 * testing could not start. These tests cover the rung that was missing.
 *
 * Only the SESSION is mocked, as elsewhere: membership resolution, permissions and the database
 * are real, because the tenant check is the thing under test.
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

import { POST as programRoute } from "@/app/api/staff/program/route";
import { prisma } from "@/server/db";
import { getStampProgramOverview } from "@/server/program/stamp-program";
import { requireBusinessMembership } from "@/server/tenant/context";
import {
  createCafeCashier,
  createStampCafe,
  registerTestOwner,
  resetDatabase,
} from "../setup/fixtures";

interface Answer {
  status: number;
  body: Record<string, unknown>;
}

async function createProgram(body: unknown): Promise<Answer> {
  const res = await programRoute(
    new Request("http://localhost:3000/api/staff/program", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** A registered owner with a business and a Main location, and no program yet. */
async function freshOwner() {
  const reg = await registerTestOwner();
  session.userId = reg.userId;
  return reg;
}

const VALID = {
  name: "بطاقة القهوة",
  stampsRequiredPerReward: 6,
  rewardName: "قهوة مجانية",
};

describe("POST /api/staff/program — the owner bootstrap", () => {
  beforeAll(async () => {
    await resetDatabase();
  });

  beforeEach(() => {
    session.userId = null;
  });

  it("creates exactly one program, and publishes no public link for it", async () => {
    const owner = await freshOwner();

    const answer = await createProgram({ businessId: owner.businessId, ...VALID });

    expect(answer.status).toBe(201);
    expect(answer.body.created).toBe(true);
    expect(answer.body.programName).toBe(VALID.name);
    expect(answer.body.stampsRequiredPerReward).toBe(6);

    // Exactly one template, one ACTIVE version, one tier, one direct source.
    const templates = await prisma.programTemplate.findMany({
      where: { businessId: owner.businessId },
      select: { id: true, versions: { select: { id: true, status: true, rewardTiers: { select: { id: true } } } } },
    });
    expect(templates).toHaveLength(1);
    expect(templates[0].versions).toHaveLength(1);
    expect(templates[0].versions[0].status).toBe("ACTIVE");
    expect(templates[0].versions[0].rewardTiers).toHaveLength(1);

    const sources = await prisma.utmSourceLink.findMany({ where: { templateId: templates[0].id } });
    expect(sources).toHaveLength(1);

    // The source's token stays on the server. Owner decision B7 option 3 withdrew public
    // self-service enrolment, so the response publishes no link to point at it with.
    expect(answer.body.enrollmentUrl).toBeUndefined();
    expect(answer.body.enrollmentQrSvg).toBeUndefined();
    expect(JSON.stringify(answer.body)).not.toContain(sources[0].publicToken);
  });

  it("returns the same program on a repeated submission instead of creating a second", async () => {
    const owner = await freshOwner();

    const first = await createProgram({ businessId: owner.businessId, ...VALID });
    const second = await createProgram({ businessId: owner.businessId, ...VALID, name: "محاولة ثانية" });

    expect(first.status).toBe(201);
    expect(first.body.created).toBe(true);
    expect(second.status).toBe(200);
    expect(second.body.created).toBe(false);
    // The ORIGINAL program, not the name the second attempt tried to use.
    expect(second.body.programName).toBe(VALID.name);
    expect(second.body.stampsRequiredPerReward).toBe(first.body.stampsRequiredPerReward);

    expect(await prisma.programTemplate.count({ where: { businessId: owner.businessId } })).toBe(1);
  });

  it("creates one program when two submissions race", async () => {
    // The double tap, or a retry on a slow connection. `createStampProgram` takes a row lock on
    // the business, so one wins and the other is answered with the winner's link.
    const owner = await freshOwner();

    const [a, b] = await Promise.all([
      createProgram({ businessId: owner.businessId, ...VALID }),
      createProgram({ businessId: owner.businessId, ...VALID }),
    ]);

    expect(await prisma.programTemplate.count({ where: { businessId: owner.businessId } })).toBe(1);
    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect(a.body.programName).toBe(b.body.programName);
  });

  it("shows an existing owner the original link, through the same service the page uses", async () => {
    const cafe = await createStampCafe({ name: "مقهى قائم" });
    session.userId = cafe.userId;

    const overview = await getStampProgramOverview(cafe.ctx);
    expect(overview?.directSourceToken).toBe(cafe.program.directSourceToken);
    expect(overview?.templateName).toBe("مقهى قائم");

    // And the route agrees with the page.
    const answer = await createProgram({ businessId: cafe.businessId, ...VALID });
    expect(answer.status).toBe(200);
    expect(answer.body.created).toBe(false);
    expect(answer.body.programName).toBe("مقهى قائم");

    // No enrolment link or QR is published any more. Owner decision B7 option 3 withdrew public
    // self-service enrolment, so there is no public route for such a link to point at.
    expect(answer.body.enrollmentUrl).toBeUndefined();
    expect(answer.body.enrollmentQrSvg).toBeUndefined();
  });

  it("refuses a cashier, who may serve customers but not create the card", async () => {
    const cafe = await createStampCafe();
    const cashier = await createCafeCashier(cafe);
    session.userId = cashier.userId;

    const answer = await createProgram({ businessId: cafe.businessId, ...VALID });
    expect(answer.status).toBe(403);

    // And the read is refused too: the token is a capability, not a detail.
    const ctx = await requireBusinessMembership(prisma, cashier.userId, cafe.businessId);
    await expect(getStampProgramOverview(ctx)).rejects.toThrow(/EDIT_TEMPLATES|VIEW_TEMPLATES|permission/i);
  });

  it("refuses a signed-in user from another business, and tells them nothing about this one", async () => {
    const cafe = await createStampCafe({ name: "مقهى الجيران" });
    const stranger = await freshOwner();

    // A real account, signed in, naming someone else's business.
    const answer = await createProgram({ businessId: cafe.businessId, ...VALID });
    expect(answer.status).toBe(403);
    expect(JSON.stringify(answer.body)).not.toContain(cafe.program.directSourceToken);
    expect(JSON.stringify(answer.body)).not.toContain("مقهى الجيران");

    // The neighbour's program is untouched, and the stranger still has none.
    expect(await prisma.programTemplate.count({ where: { businessId: cafe.businessId } })).toBe(1);
    expect(await prisma.programTemplate.count({ where: { businessId: stranger.businessId } })).toBe(0);
  });

  it("refuses an unauthenticated caller", async () => {
    session.userId = null;
    const answer = await createProgram({ ...VALID });
    expect([401, 403]).toContain(answer.status);
  });

  it("accepts only the five pilot fields, and refuses anything else", async () => {
    const owner = await freshOwner();

    // Phase 1b settings offered to a Phase 1a screen are refused, not silently honoured.
    for (const extra of [
      { earnMode: "SPEND_BLOCK" },
      { spendAmountPerBlockMinor: 1000 },
      { dailyAwardLimit: 3 },
      { requirePurchaseAmount: true },
      { rewardValueMinor: 500 },
      { contractVersion: 2 },
    ]) {
      const answer = await createProgram({ businessId: owner.businessId, ...VALID, ...extra });
      expect(answer.status, `${JSON.stringify(extra)} must be refused`).toBe(400);
    }

    // A location may not be named at all, here or anywhere else in Phase 1a.
    const located = await createProgram({ businessId: owner.businessId, ...VALID, locationId: owner.locationId });
    expect(located.status).toBe(400);

    expect(await prisma.programTemplate.count({ where: { businessId: owner.businessId } })).toBe(0);
  });

  it("applies the welcome-bonus rule from the mechanics contract", async () => {
    const owner = await freshOwner();

    const tooMany = await createProgram({ businessId: owner.businessId, ...VALID, welcomeStamps: 6 });
    expect(tooMany.status).toBe(400);
    expect(await prisma.programTemplate.count({ where: { businessId: owner.businessId } })).toBe(0);

    const ok = await createProgram({ businessId: owner.businessId, ...VALID, welcomeStamps: 2 });
    expect(ok.status).toBe(201);
  });

  it("treats zero welcome stamps as no welcome bonus", async () => {
    const owner = await freshOwner();
    const answer = await createProgram({ businessId: owner.businessId, ...VALID, welcomeStamps: 0 });
    expect(answer.status).toBe(201);

    const ctx = await requireBusinessMembership(prisma, owner.userId, owner.businessId);
    const overview = await getStampProgramOverview(ctx);
    expect(overview?.mechanics.welcomeStamps).toBeUndefined();
  });

  it("never writes the enrolment source token to the audit log", async () => {
    // The token is a capability. An audit row is read by more people, and kept longer, than the
    // screen that legitimately shows it.
    const owner = await freshOwner();
    const answer = await createProgram({ businessId: owner.businessId, ...VALID });
    expect(answer.status).toBe(201);
    const { publicToken: token } = await prisma.utmSourceLink.findFirstOrThrow({
      where: { template: { businessId: owner.businessId } },
      select: { publicToken: true },
    });

    const entries = await prisma.auditLog.findMany({ where: { businessId: owner.businessId } });
    expect(entries.length).toBeGreaterThan(0);
    expect(JSON.stringify(entries)).not.toContain(token);
  });
});

describe("the program screen publishes no public enrolment link", () => {
  beforeAll(async () => {
    await resetDatabase();
  });

  it("returns no link and no QR, and never the source token", async () => {
    /*
     * This describe block used to walk the owner's published link through a public enrolment and
     * assert a customer got a card. That journey no longer exists: owner decision B7 option 3
     * withdrew public self-service enrolment because a form that issues a card to a new number and
     * nothing to an existing one tells whoever submits it which case they hit.
     *
     * What must hold now is the opposite — that the token stays inside the server.
     */
    const owner = await freshOwner();
    const created = await createProgram({ businessId: owner.businessId, ...VALID, welcomeStamps: 2 });
    expect(created.status).toBe(201);

    expect(created.body.enrollmentUrl).toBeUndefined();
    expect(created.body.enrollmentQrSvg).toBeUndefined();

    // The source exists and carries a token; the response does not mention it.
    const source = await prisma.utmSourceLink.findFirstOrThrow({
      where: { template: { businessId: owner.businessId } },
      select: { publicToken: true },
    });
    const serialized = JSON.stringify(created.body);
    expect(serialized).not.toContain(source.publicToken);
    expect(serialized.toLowerCase()).not.toContain("/join/");
  });

  it("still records the program, the tier and the source, so the counter can enrol", async () => {
    // Withdrawing the public route must not change what creating a program builds.
    const owner = await freshOwner();
    await createProgram({ businessId: owner.businessId, ...VALID, welcomeStamps: 2 });

    const template = await prisma.programTemplate.findFirstOrThrow({
      where: { businessId: owner.businessId },
      select: { id: true, versions: { select: { rewardTiers: { select: { id: true } } } } },
    });
    expect(template.versions[0].rewardTiers).toHaveLength(1);
    expect(
      await prisma.utmSourceLink.count({ where: { templateId: template.id, utmSource: "direct", active: true } }),
    ).toBe(1);
  });
});
