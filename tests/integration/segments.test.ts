import { MembershipRole, OperationSource, Permission } from "@prisma/client";
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

import { POST as segmentsRoute } from "@/app/api/staff/segments/route";
import { AuditAction } from "@/server/audit/audit";
import { prisma } from "@/server/db";
import { awardManualStamps } from "@/server/stamp/engine";
import { listSegments } from "@/server/segments/segments";
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
  type PointsShopFixture,
  type StampCafeFixture,
} from "../setup/fixtures";

/**
 * Saved segments, at the HTTP boundary.
 *
 * Three things these tests hold, and each one is a way this feature could go wrong:
 *
 *  1. **a definition is an allowlist.** An unknown field, an unknown operator or another business's
 *     id is refused on save, not silently dropped — a dropped condition matches MORE people than
 *     the merchant described;
 *  2. **a count is derived, on the server, from live data.** Never stored, never trusted from a
 *     browser, and never widened by who is asking;
 *  3. **an archive keeps the row.** A campaign in a later phase will reference a segment by id.
 */

const key = () => `k-${Math.random().toString(36).slice(2)}-${Date.now()}`;

async function call(body: unknown) {
  const res = await segmentsRoute(
    new Request("http://localhost:3000/api/staff/segments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, body: (await res.json()) as Record<string, never> & { error?: { code?: string } } };
}

const STAMPS_AT_LEAST = (min: number) => ({
  version: 1,
  match: "all",
  conditions: [{ field: "stampBalance", range: { min } }],
});

describe("segments are validated, tenant-scoped definitions", () => {
  let cafe: StampCafeFixture;

  beforeEach(async () => {
    await resetDatabase();
    cafe = await createStampCafe({ name: "Segment café" });
    session.userId = cafe.userId;
  });

  it("saves a definition and reports what it matches, from live data", async () => {
    const quiet = await enrolCustomer(cafe, { phone: uniqueSyrianPhone() });
    const busy = await enrolCustomer(cafe, { phone: uniqueSyrianPhone() });
    await awardManualStamps(cafe.ctx, {
      customerCardId: busy.customerCardId,
      quantity: 6,
      idempotencyKey: key(),
      source: OperationSource.SCANNER,
    });

    const counted = await call({ action: "count", businessId: cafe.businessId, definition: STAMPS_AT_LEAST(5) });
    expect(counted.status).toBe(200);
    expect((counted.body as unknown as { customers: number }).customers).toBe(1);
    // The preview names people so a merchant can sanity-check, and carries no phone and no card.
    const preview = JSON.stringify(counted.body);
    expect(preview).not.toContain(busy.customerCardId);
    expect(preview).not.toContain(busy.shareToken);
    expect(preview).not.toContain(quiet.customerCardId);

    const created = await call({
      action: "create",
      businessId: cafe.businessId,
      name: "Nearly there",
      definition: STAMPS_AT_LEAST(5),
    });
    expect(created.status).toBe(201);

    // Derived on every read: one more stamp and the same saved segment means one more person.
    await awardManualStamps(cafe.ctx, {
      customerCardId: quiet.customerCardId,
      quantity: 5,
      idempotencyKey: key(),
      source: OperationSource.SCANNER,
    });
    const again = await call({ action: "count", businessId: cafe.businessId, definition: STAMPS_AT_LEAST(5) });
    expect((again.body as unknown as { customers: number }).customers).toBe(2);

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { businessId: cafe.businessId, action: AuditAction.SEGMENT_CREATED },
    });
    // The rule, never the people it matched.
    expect(JSON.stringify(audit.metadata)).toContain("stampBalance");
    expect(JSON.stringify(audit.metadata)).not.toContain(busy.customerCardId);
  });

  it("refuses an unknown field, an unknown key and a version it cannot read", async () => {
    for (const definition of [
      { version: 1, match: "all", conditions: [{ field: "email", value: "a@b.c" }] },
      { version: 1, match: "all", conditions: [{ field: "program", templateId: "t", sql: "1=1" }] },
      { version: 1, match: "sometimes", conditions: [{ field: "cardType", cardType: "STAMP" }] },
      { version: 9, match: "all", conditions: [{ field: "cardType", cardType: "STAMP" }] },
      { version: 1, match: "all", conditions: [] },
    ]) {
      const refused = await call({ action: "count", businessId: cafe.businessId, definition });
      expect(refused.status, `${JSON.stringify(definition)} must be refused`).toBe(400);
    }
  });

  it("refuses a definition that names another business's program, branch or source", async () => {
    const theirs = await createStampCafe({ name: "Theirs" });
    const theirBranch = await createLocation(theirs, "Their branch");
    session.userId = cafe.userId;

    for (const definition of [
      { version: 1, match: "all", conditions: [{ field: "program", templateId: theirs.program.templateId }] },
      { version: 1, match: "all", conditions: [{ field: "servedAtLocation", locationId: theirBranch }] },
    ]) {
      const refused = await call({ action: "create", businessId: cafe.businessId, name: "Nope", definition });
      expect(refused.status).toBe(400);
    }
    expect(await prisma.customerSegment.count({ where: { businessId: cafe.businessId } })).toBe(0);
  });

  it("keeps names unique per business, case- and space-insensitively", async () => {
    const first = await call({ action: "create", businessId: cafe.businessId, name: "VIP", definition: STAMPS_AT_LEAST(5) });
    expect(first.status).toBe(201);

    const twin = await call({ action: "create", businessId: cafe.businessId, name: "  vip ", definition: STAMPS_AT_LEAST(1) });
    expect(twin.status).toBe(409);
    expect(twin.body.error?.code).toBe("NAME_TAKEN");

    // Another business may have a VIP of their own: uniqueness is tenant-scoped.
    const theirs = await createStampCafe({ name: "Theirs" });
    session.userId = theirs.userId;
    const mine = await call({ action: "create", businessId: theirs.businessId, name: "VIP", definition: STAMPS_AT_LEAST(5) });
    expect(mine.status).toBe(201);
  });

  it("archives without destroying, and restores", async () => {
    const created = await call({ action: "create", businessId: cafe.businessId, name: "Autumn", definition: STAMPS_AT_LEAST(3) });
    const segmentId = String((created.body as unknown as { id: string }).id);

    const archived = await call({ action: "archive", businessId: cafe.businessId, segmentId });
    expect(archived.status).toBe(200);

    // Gone from the working list, still in the database, still referable by id.
    expect((await listSegments(cafe.ctx)).some((s) => s.id === segmentId)).toBe(false);
    expect((await listSegments(cafe.ctx, { includeArchived: true })).some((s) => s.id === segmentId)).toBe(true);
    expect(await prisma.customerSegment.count({ where: { id: segmentId } })).toBe(1);

    // An archived segment is not edited in place.
    const edited = await call({ action: "update", businessId: cafe.businessId, segmentId, name: "Winter" });
    expect(edited.status).toBe(409);

    const restored = await call({ action: "restore", businessId: cafe.businessId, segmentId });
    expect(restored.status).toBe(200);
    expect((await listSegments(cafe.ctx)).some((s) => s.id === segmentId)).toBe(true);

    const actions = await prisma.auditLog.findMany({
      where: { entityId: segmentId },
      select: { action: true },
      orderBy: { createdAt: "asc" },
    });
    expect(actions.map((a) => a.action)).toEqual([
      AuditAction.SEGMENT_CREATED,
      AuditAction.SEGMENT_ARCHIVED,
      AuditAction.SEGMENT_RESTORED,
    ]);
  });

  it("never reaches another tenant's segment by id", async () => {
    const theirs = await createStampCafe({ name: "Theirs" });
    session.userId = theirs.userId;
    const created = await call({ action: "create", businessId: theirs.businessId, name: "Theirs", definition: STAMPS_AT_LEAST(2) });
    const segmentId = String((created.body as unknown as { id: string }).id);

    session.userId = cafe.userId;
    for (const action of ["archive", "restore"]) {
      const refused = await call({ action, businessId: cafe.businessId, segmentId });
      expect(refused.status).toBe(404);
    }
    const stolen = await call({ action: "update", businessId: cafe.businessId, segmentId, name: "Mine now" });
    expect(stolen.status).toBe(404);

    const row = await prisma.customerSegment.findUniqueOrThrow({ where: { id: segmentId } });
    expect(row.name).toBe("Theirs");
    expect(row.archivedAt).toBeNull();
  });
});

describe("combining conditions selects the customers it says", () => {
  let shop: PointsShopFixture;

  beforeEach(async () => {
    await resetDatabase();
    shop = await createPointsShop({ name: "Points shop" });
    session.userId = shop.userId;
  });

  it("requires ONE card to satisfy every card rule under `all`", async () => {
    // A customer with a points card and a stamp card, whose stamps are the ones with a balance.
    const cafe = await createStampCafe({ name: "Stamp side" });
    const both = uniqueSyrianPhone();
    await enrolPointsCustomer(shop, { phone: both });
    const stampCard = await enrolCustomer(cafe, { phone: both });
    await awardManualStamps(cafe.ctx, {
      customerCardId: stampCard.customerCardId,
      quantity: 8,
      idempotencyKey: key(),
      source: OperationSource.SCANNER,
    });

    session.userId = shop.userId;
    /*
     * "A points card WITH at least one stamp" is nobody: the customer's stamps are on a different
     * programme and a different business. The naive reading — two independent subqueries — would
     * have matched them, and a campaign built on it would promise a reward they cannot claim.
     */
    const counted = await call({
      action: "count",
      businessId: shop.businessId,
      definition: {
        version: 1,
        match: "all",
        conditions: [
          { field: "cardType", cardType: "POINTS" },
          { field: "stampBalance", range: { min: 1 } },
        ],
      },
    });
    expect((counted.body as unknown as { customers: number }).customers).toBe(0);
  });

  it("is a union under `any`", async () => {
    await enrolPointsCustomer(shop, { phone: uniqueSyrianPhone() });
    const counted = await call({
      action: "count",
      businessId: shop.businessId,
      definition: {
        version: 1,
        match: "any",
        conditions: [
          { field: "cardType", cardType: "POINTS" },
          { field: "stampBalance", range: { min: 1_000 } },
        ],
      },
    });
    expect((counted.body as unknown as { customers: number }).customers).toBe(1);
  });

  it("counts only this business's customers, even for the same person", async () => {
    const shared = uniqueSyrianPhone();
    await enrolPointsCustomer(shop, { phone: shared });
    const rival = await createPointsShop({ name: "Rival" });
    await enrolPointsCustomer(rival, { phone: shared });

    session.userId = shop.userId;
    const mine = await call({
      action: "count",
      businessId: shop.businessId,
      definition: { version: 1, match: "all", conditions: [{ field: "cardType", cardType: "POINTS" }] },
    });
    expect((mine.body as unknown as { customers: number }).customers).toBe(1);
  });
});

describe("segments are permission-gated, and a count is never narrowed per viewer", () => {
  it("refuses a cashier outright, and a branch-scoped member a count", async () => {
    await resetDatabase();
    const cafe = await createStampCafe();
    const cashier = await createStaff(cafe, MembershipRole.CASHIER, [cafe.locationId]);

    session.userId = cashier.userId;
    const refused = await call({
      action: "count",
      businessId: cafe.businessId,
      definition: STAMPS_AT_LEAST(1),
    });
    expect(refused.status).toBe(403);

    // Even granted VIEW_SEGMENTS explicitly, a branch-scoped member is refused a COUNT rather than
    // shown a smaller one: a number that changed with the reader would target a set nobody saw.
    session.userId = cafe.userId;
    await setMembershipPermissions(cafe.ctx, cashier.membershipId, [Permission.VIEW_SEGMENTS]);
    const scopedCtx = await requireBusinessMembership(prisma, cashier.userId, cafe.businessId);
    expect(scopedCtx.permissions.has(Permission.VIEW_SEGMENTS)).toBe(true);
    expect(scopedCtx.locationIds).not.toBeNull();

    session.userId = cashier.userId;
    const stillRefused = await call({ action: "count", businessId: cafe.businessId, definition: STAMPS_AT_LEAST(1) });
    expect(stillRefused.status).toBe(403);

    // And they cannot write one either: EDIT_SEGMENTS was not granted.
    const written = await call({
      action: "create",
      businessId: cafe.businessId,
      name: "Not mine to make",
      definition: STAMPS_AT_LEAST(1),
    });
    expect(written.status).toBe(403);
  });
});
