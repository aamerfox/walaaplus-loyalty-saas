import { MembershipRole, ProgramVersionStatus, TemplateStatus } from "@prisma/client";
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

import { POST as versionRoute } from "@/app/api/staff/program-version/route";
import { POST as awardRoute } from "@/app/api/scanner/award/route";
import { POST as pointsRoute } from "@/app/api/scanner/points/route";
import { AuditAction } from "@/server/audit/audit";
import { prisma } from "@/server/db";
import { getProgramDraft, listProgramVersions } from "@/server/program/versions";
import {
  createPointsShop,
  createStaff,
  createStampCafe,
  enrolCustomer,
  enrolPointsCustomer,
  resetDatabase,
  uniqueSyrianPhone,
  type PointsShopFixture,
  type StampCafeFixture,
} from "../setup/fixtures";

/**
 * Publishing a new version of a live program.
 *
 * The guarantee under test is the one the whole product rests on: **a card keeps the rules it was
 * sold under.** Every test here publishes a genuinely different version and then checks that the
 * card issued before it is untouched — balance, threshold, rewards and all — while a card issued
 * after it gets the new rules.
 *
 * The second guarantee is that publishing is a single atomic swap. A draft is validated again
 * inside the transaction that publishes it, the live version is retired in the same transaction,
 * and a publish made stale by someone else's is refused rather than applied to a draft nobody read.
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
  return { status: res.status, body: (await res.json()) as Record<string, unknown> & { error?: { code?: string } } };
}

const version = (body: unknown) => call(versionRoute, "/api/staff/program-version", body);
const award = (body: unknown) => call(awardRoute, "/api/scanner/award", body);
const points = (body: unknown) => call(pointsRoute, "/api/scanner/points", body);

const STAMP_V2 = {
  kind: "STAMP" as const,
  contractVersion: 1 as const,
  stampsRequiredPerReward: 5,
  rewardName: "شاي مجاني",
  earnMode: "MANUAL" as const,
  countRewardRedemptionAsVisit: false,
};

describe("draft, edit, discard", () => {
  let cafe: StampCafeFixture;

  beforeEach(async () => {
    await resetDatabase();
    cafe = await createStampCafe();
    session.userId = cafe.userId;
  });

  it("opens a draft that is an exact copy, so an unedited publish changes nothing", async () => {
    const created = await version({ action: "createDraft", businessId: cafe.businessId, templateId: cafe.program.templateId });
    expect(created.status).toBe(201);
    expect(created.body.versionNumber).toBe(2);

    const draft = await getProgramDraft(cafe.ctx, cafe.program.templateId);
    expect(draft).not.toBeNull();
    expect(draft!.changes).toEqual([]);
  });

  it("returns the open draft instead of creating a second", async () => {
    await version({ action: "createDraft", businessId: cafe.businessId, templateId: cafe.program.templateId });
    const again = await version({ action: "createDraft", businessId: cafe.businessId, templateId: cafe.program.templateId });
    expect(again.status).toBe(200);
    expect(again.body.existed).toBe(true);

    const drafts = await prisma.programVersion.count({
      where: { templateId: cafe.program.templateId, status: ProgramVersionStatus.DRAFT },
    });
    expect(drafts).toBe(1);
  });

  it("edits a draft and reports exactly what differs from the live version", async () => {
    await version({ action: "createDraft", businessId: cafe.businessId, templateId: cafe.program.templateId });
    const edited = await version({
      action: "updateDraft",
      businessId: cafe.businessId,
      templateId: cafe.program.templateId,
      mechanics: STAMP_V2,
    });
    expect(edited.status).toBe(200);

    const draft = await getProgramDraft(cafe.ctx, cafe.program.templateId);
    const fields = draft!.changes.map((c) => c.field).sort();
    expect(fields).toContain("stampsRequiredPerReward");
    expect(fields).toContain("rewardName");
    const threshold = draft!.changes.find((c) => c.field === "stampsRequiredPerReward")!;
    expect(threshold.before).toBe(10);
    expect(threshold.after).toBe(5);
  });

  it("refuses a points shape on a stamp program, and the other way round", async () => {
    await version({ action: "createDraft", businessId: cafe.businessId, templateId: cafe.program.templateId });
    const wrong = await version({
      action: "updateDraft",
      businessId: cafe.businessId,
      templateId: cafe.program.templateId,
      mechanics: { kind: "POINTS", contractVersion: 1, earnMode: "MANUAL" },
      tiers: [{ name: "Gift", requiredPoints: 10 }],
    });
    // Refused at the route's own boundary, before any service: a stamp template's draft may not
    // carry points mechanics, and the engines stay two engines.
    expect(wrong.status).toBe(400);
  });

  it("discards a draft without touching the live version", async () => {
    await version({ action: "createDraft", businessId: cafe.businessId, templateId: cafe.program.templateId });
    await version({ action: "updateDraft", businessId: cafe.businessId, templateId: cafe.program.templateId, mechanics: STAMP_V2 });

    const discarded = await version({ action: "discardDraft", businessId: cafe.businessId, templateId: cafe.program.templateId });
    expect(discarded.status).toBe(200);

    const history = await listProgramVersions(cafe.ctx, cafe.program.templateId);
    expect(history.draftVersionNumber).toBeNull();
    expect(history.versions).toHaveLength(1);
    expect(history.versions[0].status).toBe(ProgramVersionStatus.ACTIVE);
    // The live rules are exactly what they were.
    expect((history.versions[0].mechanics as { stampsRequiredPerReward: number }).stampsRequiredPerReward).toBe(10);
  });
});

describe("publishing", () => {
  let cafe: StampCafeFixture;

  beforeEach(async () => {
    await resetDatabase();
    cafe = await createStampCafe();
    session.userId = cafe.userId;
  });

  it("leaves an existing card on its old version, with its old rules", async () => {
    const before = await enrolCustomer(cafe, { phone: uniqueSyrianPhone() });
    await award({
      businessId: cafe.businessId,
      customerCardId: before.customerCardId,
      mode: "manual",
      quantity: 3,
      idempotencyKey: key(),
    });

    await version({ action: "createDraft", businessId: cafe.businessId, templateId: cafe.program.templateId });
    await version({ action: "updateDraft", businessId: cafe.businessId, templateId: cafe.program.templateId, mechanics: STAMP_V2 });
    const published = await version({
      action: "publish",
      businessId: cafe.businessId,
      templateId: cafe.program.templateId,
      expectedVersionNumber: 2,
    });
    expect(published.status).toBe(200);
    expect(published.body.publishedVersionNumber).toBe(2);
    expect(published.body.retiredVersionNumber).toBe(1);
    expect(published.body.cardsOnRetiredVersion).toBe(1);

    const card = await prisma.customerCard.findUniqueOrThrow({
      where: { id: before.customerCardId },
      select: { programVersionId: true, stampBalance: true, rewardBalance: true, programVersion: { select: { versionNumber: true, mechanics: true } } },
    });
    // Pinned, untouched, and still on ten stamps per reward.
    expect(card.programVersion.versionNumber).toBe(1);
    expect((card.programVersion.mechanics as { stampsRequiredPerReward: number }).stampsRequiredPerReward).toBe(10);
    expect(card.stampBalance).toBe(3);
    expect(card.rewardBalance).toBe(0);

    // And the old card still converts on ITS threshold, not the new one: seven more, not two.
    await award({
      businessId: cafe.businessId,
      customerCardId: before.customerCardId,
      mode: "manual",
      quantity: 6,
      idempotencyKey: key(),
    });
    const atNine = await prisma.customerCard.findUniqueOrThrow({ where: { id: before.customerCardId } });
    expect(atNine.stampBalance).toBe(9);
    expect(atNine.rewardBalance).toBe(0);
  });

  it("issues new cards on the new version", async () => {
    await version({ action: "createDraft", businessId: cafe.businessId, templateId: cafe.program.templateId });
    await version({ action: "updateDraft", businessId: cafe.businessId, templateId: cafe.program.templateId, mechanics: STAMP_V2 });
    await version({ action: "publish", businessId: cafe.businessId, templateId: cafe.program.templateId, expectedVersionNumber: 2 });

    const after = await enrolCustomer(cafe, { phone: uniqueSyrianPhone() });
    const card = await prisma.customerCard.findUniqueOrThrow({
      where: { id: after.customerCardId },
      select: { programVersion: { select: { versionNumber: true, mechanics: true } } },
    });
    expect(card.programVersion.versionNumber).toBe(2);
    expect((card.programVersion.mechanics as { stampsRequiredPerReward: number }).stampsRequiredPerReward).toBe(5);

    // Five stamps completes THIS card, because five is what it was sold under.
    await award({
      businessId: cafe.businessId,
      customerCardId: after.customerCardId,
      mode: "manual",
      quantity: 5,
      idempotencyKey: key(),
    });
    const completed = await prisma.customerCard.findUniqueOrThrow({ where: { id: after.customerCardId } });
    expect(completed.rewardBalance).toBe(1);
  });

  it("retires the old version in the same transaction, and records when", async () => {
    await version({ action: "createDraft", businessId: cafe.businessId, templateId: cafe.program.templateId });
    await version({ action: "updateDraft", businessId: cafe.businessId, templateId: cafe.program.templateId, mechanics: STAMP_V2 });
    await version({ action: "publish", businessId: cafe.businessId, templateId: cafe.program.templateId, expectedVersionNumber: 2 });

    const history = await listProgramVersions(cafe.ctx, cafe.program.templateId);
    const [v2, v1] = history.versions;
    expect(v2.versionNumber).toBe(2);
    expect(v2.status).toBe(ProgramVersionStatus.ACTIVE);
    expect(v1.status).toBe(ProgramVersionStatus.RETIRED);
    expect(v1.retiredAt).not.toBeNull();
    // Retired and activated at the same instant: it is one swap, not two events.
    expect(v1.retiredAt!.getTime()).toBe(v2.activatedAt!.getTime());

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { businessId: cafe.businessId, action: AuditAction.PROGRAM_VERSION_PUBLISHED },
    });
    expect((audit.metadata as { retiredVersionNumber: number }).retiredVersionNumber).toBe(1);
  });

  it("refuses a publish whose draft number is not the draft the server holds", async () => {
    await version({ action: "createDraft", businessId: cafe.businessId, templateId: cafe.program.templateId });
    const stale = await version({
      action: "publish",
      businessId: cafe.businessId,
      templateId: cafe.program.templateId,
      expectedVersionNumber: 7,
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error?.code).toBe("DRAFT_STALE");
  });

  it("lets only one of two concurrent publishes through", async () => {
    await version({ action: "createDraft", businessId: cafe.businessId, templateId: cafe.program.templateId });
    await version({ action: "updateDraft", businessId: cafe.businessId, templateId: cafe.program.templateId, mechanics: STAMP_V2 });

    const body = {
      action: "publish",
      businessId: cafe.businessId,
      templateId: cafe.program.templateId,
      expectedVersionNumber: 2,
    };
    const [a, b] = await Promise.all([version(body), version(body)]);
    const statuses = [a.status, b.status].sort();
    // One publishes; the other finds no draft to publish, because there is only ever one.
    expect(statuses[0]).toBe(200);
    expect(statuses[1]).toBeGreaterThanOrEqual(400);

    const active = await prisma.programVersion.count({
      where: { templateId: cafe.program.templateId, status: ProgramVersionStatus.ACTIVE },
    });
    expect(active).toBe(1);
  });

  it("refuses a caller who does not own the program, as if it did not exist", async () => {
    const theirs = await createStampCafe({ name: "Theirs" });
    session.userId = cafe.userId;
    const refused = await version({
      action: "createDraft",
      businessId: cafe.businessId,
      templateId: theirs.program.templateId,
    });
    expect(refused.status).toBe(404);
    const drafts = await prisma.programVersion.count({
      where: { templateId: theirs.program.templateId, status: ProgramVersionStatus.DRAFT },
    });
    expect(drafts).toBe(0);
  });

  it("refuses a cashier, who may work a counter but not change the rules", async () => {
    const cashier = await createStaff(cafe, MembershipRole.CASHIER, [cafe.locationId]);
    session.userId = cashier.userId;
    const refused = await version({ action: "createDraft", businessId: cafe.businessId, templateId: cafe.program.templateId });
    expect(refused.status).toBe(403);
  });
});

describe("pausing", () => {
  let cafe: StampCafeFixture;

  beforeEach(async () => {
    await resetDatabase();
    cafe = await createStampCafe();
    session.userId = cafe.userId;
  });

  it("stops new sign-ups and nothing else", async () => {
    const existing = await enrolCustomer(cafe, { phone: uniqueSyrianPhone() });

    const paused = await version({
      action: "setStatus",
      businessId: cafe.businessId,
      templateId: cafe.program.templateId,
      status: TemplateStatus.PAUSED,
    });
    expect(paused.status).toBe(200);

    // The existing card keeps working, completely.
    const stamp = await award({
      businessId: cafe.businessId,
      customerCardId: existing.customerCardId,
      mode: "manual",
      quantity: 1,
      idempotencyKey: key(),
    });
    expect(stamp.status).toBe(200);

    // New enrolment into a paused program is refused.
    await expect(enrolCustomer(cafe, { phone: uniqueSyrianPhone() })).rejects.toThrow();

    const resumed = await version({
      action: "setStatus",
      businessId: cafe.businessId,
      templateId: cafe.program.templateId,
      status: TemplateStatus.ACTIVE,
    });
    expect(resumed.status).toBe(200);
    const again = await enrolCustomer(cafe, { phone: uniqueSyrianPhone() });
    expect(again.created).toBe(true);
  });

  it("offers no destructive verb at all", async () => {
    for (const status of ["ARCHIVED", "DRAFT", "DELETED"]) {
      const refused = await version({
        action: "setStatus",
        businessId: cafe.businessId,
        templateId: cafe.program.templateId,
        status,
      });
      expect(refused.status, `${status} must be refused`).toBe(400);
    }
  });
});

describe("points and stamps stay isolated across a version change", () => {
  let shop: PointsShopFixture;

  beforeEach(async () => {
    await resetDatabase();
    shop = await createPointsShop();
    session.userId = shop.userId;
  });

  it("keeps a points card on its own tiers after the program publishes new ones", async () => {
    const card = await enrolPointsCustomer(shop, { phone: uniqueSyrianPhone() });
    await points({
      businessId: shop.businessId,
      customerCardId: card.customerCardId,
      mode: "manual",
      quantity: 20,
      idempotencyKey: key(),
    });

    await version({ action: "createDraft", businessId: shop.businessId, templateId: shop.program.templateId });
    await version({
      action: "updateDraft",
      businessId: shop.businessId,
      templateId: shop.program.templateId,
      mechanics: { kind: "POINTS", contractVersion: 1, earnMode: "MANUAL", countRewardRedemptionAsVisit: false },
      tiers: [{ name: "مكافأة جديدة", requiredPoints: 200 }],
    });
    await version({ action: "publish", businessId: shop.businessId, templateId: shop.program.templateId, expectedVersionNumber: 2 });

    const pinned = await prisma.customerCard.findUniqueOrThrow({
      where: { id: card.customerCardId },
      select: {
        pointBalance: true,
        programVersion: { select: { versionNumber: true, rewardTiers: { select: { name: true, requiredPoints: true } } } },
      },
    });
    expect(pinned.programVersion.versionNumber).toBe(1);
    expect(pinned.pointBalance).toBe(20);
    // Still the tiers this customer was sold, priced as they were sold.
    expect(pinned.programVersion.rewardTiers.map((t) => t.requiredPoints).sort((a, b) => a - b)).toEqual([10, 50]);
    expect(pinned.programVersion.rewardTiers.some((t) => t.name === "مكافأة جديدة")).toBe(false);

    // The stamp engine still refuses this card outright: a version change moves no card between
    // engines, because a card's card type is pinned by its template.
    const wrongEngine = await award({
      businessId: shop.businessId,
      customerCardId: card.customerCardId,
      mode: "manual",
      quantity: 1,
      idempotencyKey: key(),
    });
    expect(wrongEngine.status).toBeGreaterThanOrEqual(400);
  });
});
