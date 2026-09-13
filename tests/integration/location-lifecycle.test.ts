import { MembershipRole, Permission } from "@prisma/client";
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

import { POST as locationsRoute } from "@/app/api/staff/locations/route";
import { POST as awardRoute } from "@/app/api/scanner/award/route";
import { AuditAction } from "@/server/audit/audit";
import { prisma } from "@/server/db";
import { publishDraftVersion, createDraftVersion, updateDraftVersion } from "@/server/program/versions";
import { requireBusinessMembership } from "@/server/tenant/context";
import { listBusinessLocations, setLocationActive } from "@/server/tenant/locations";
import {
  createStaff,
  createStampCafe,
  enrolCustomer,
  resetDatabase,
  uniqueSyrianPhone,
  type StampCafeFixture,
} from "../setup/fixtures";

/**
 * The counter lifecycle, at the HTTP boundary and in the ledger underneath it.
 *
 * The rule these tests exist to hold is that **closing a counter is not deleting one**. Everything
 * written at a counter stays written there, readable, attributed, forever; what stops is new value.
 * Every refusal below protects a merchant from turning "tidy up the list" into "the till stops
 * working", and each one is asserted by its CODE, because the screen translates codes rather than
 * server sentences.
 */

const key = () => `k-${Math.random().toString(36).slice(2)}-${Date.now()}`;

async function post(body: unknown) {
  const res = await locationsRoute(
    new Request("http://localhost:3000/api/staff/locations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, body: (await res.json()) as Record<string, never> & { error?: { code?: string } } };
}

async function award(body: unknown) {
  const res = await awardRoute(
    new Request("http://localhost:3000/api/scanner/award", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, body: (await res.json()) as { error?: { code?: string } } };
}

describe("counters: create, rename, close, reopen", () => {
  let cafe: StampCafeFixture;

  beforeEach(async () => {
    await resetDatabase();
    cafe = await createStampCafe();
    session.userId = cafe.userId;
  });

  it("creates a counter that starts with no staff and no programs", async () => {
    const created = await post({ action: "create", businessId: cafe.businessId, name: "Branch", address: "Old city" });
    expect(created.status).toBe(201);

    const locations = await listBusinessLocations(cafe.ctx);
    const branch = locations.find((l) => l.name === "Branch");
    expect(branch).toBeDefined();
    expect(branch!.isDefault).toBe(false);
    expect(branch!.active).toBe(true);
    // The safe default in both directions: nobody can transact there, and no existing card moved.
    expect(branch!.assignedStaffCount).toBe(0);
    expect(branch!.programCount).toBe(0);

    const audit = await prisma.auditLog.findFirst({
      where: { businessId: cafe.businessId, action: AuditAction.LOCATION_CREATED, entityId: branch!.id },
    });
    expect(audit).not.toBeNull();
    // The label answers "which counter"; the street is closer to personal data than a label is.
    expect(JSON.stringify(audit!.metadata)).not.toContain("Old city");
  });

  it("refuses a second active counter with the same name, and frees the name when one closes", async () => {
    await post({ action: "create", businessId: cafe.businessId, name: "Branch" });
    const twin = await post({ action: "create", businessId: cafe.businessId, name: "  branch " });
    expect(twin.status).toBe(409);
    expect(twin.body.error?.code).toBe("NAME_TAKEN");

    const branchId = (await listBusinessLocations(cafe.ctx)).find((l) => l.name === "Branch")!.id;
    await post({ action: "deactivate", businessId: cafe.businessId, locationId: branchId });
    const reuse = await post({ action: "create", businessId: cafe.businessId, name: "Branch" });
    expect(reuse.status).toBe(201);
  });

  it("renames a counter without moving anything that happened at it", async () => {
    const phone = uniqueSyrianPhone();
    const card = await enrolCustomer(cafe, { phone });
    await award({
      businessId: cafe.businessId,
      customerCardId: card.customerCardId,
      mode: "manual",
      quantity: 1,
      idempotencyKey: key(),
    });

    const before = await prisma.loyaltyOperation.findMany({
      where: { businessId: cafe.businessId },
      select: { locationId: true },
    });
    const renamed = await post({ action: "update", businessId: cafe.businessId, locationId: cafe.locationId, name: "Front" });
    expect(renamed.status).toBe(200);

    const after = await prisma.loyaltyOperation.findMany({
      where: { businessId: cafe.businessId },
      select: { locationId: true },
    });
    // The rows hold an ID, so a rename is a label change and nothing else.
    expect(after).toEqual(before);
    expect(after.every((row) => row.locationId === cafe.locationId)).toBe(true);
  });

  it("never closes the main counter, and never the last active one", async () => {
    const main = await post({ action: "deactivate", businessId: cafe.businessId, locationId: cafe.locationId });
    expect(main.status).toBe(409);
    expect(main.body.error?.code).toBe("LOCATION_IS_MAIN");

    // And the general rule underneath it, reached by taking the default flag off first — which no
    // service does, and which is exactly why the second guard is worth having.
    await prisma.location.update({ where: { id: cafe.locationId }, data: { isDefault: false } });
    const last = await post({ action: "deactivate", businessId: cafe.businessId, locationId: cafe.locationId });
    expect(last.status).toBe(409);
    expect(last.body.error?.code).toBe("LOCATION_LAST_ACTIVE");
  });

  it("refuses to close the only counter a live program runs at", async () => {
    const created = await post({ action: "create", businessId: cafe.businessId, name: "Branch" });
    const branchId = String((created.body as unknown as { id: string }).id);

    // Publish a version that runs at the branch ONLY, then try to close the branch.
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

    const refused = await post({ action: "deactivate", businessId: cafe.businessId, locationId: branchId });
    expect(refused.status).toBe(409);
    expect(refused.body.error?.code).toBe("LOCATION_STRANDS_PROGRAM");

    // It is still open, and still serving.
    const locations = await listBusinessLocations(cafe.ctx);
    expect(locations.find((l) => l.id === branchId)!.active).toBe(true);
  });

  it("closes and reopens a counter, keeping its id and its history", async () => {
    const created = await post({ action: "create", businessId: cafe.businessId, name: "Branch" });
    const branchId = String((created.body as unknown as { id: string }).id);

    const closed = await post({ action: "deactivate", businessId: cafe.businessId, locationId: branchId });
    expect(closed.status).toBe(200);
    expect((await listBusinessLocations(cafe.ctx)).find((l) => l.id === branchId)!.active).toBe(false);

    const reopened = await post({ action: "activate", businessId: cafe.businessId, locationId: branchId });
    expect(reopened.status).toBe(200);
    const after = (await listBusinessLocations(cafe.ctx)).find((l) => l.id === branchId)!;
    expect(after.id).toBe(branchId); // the same row, so the same history
    expect(after.active).toBe(true);

    const actions = await prisma.auditLog.findMany({
      where: { businessId: cafe.businessId, entityId: branchId },
      select: { action: true },
      orderBy: { createdAt: "asc" },
    });
    expect(actions.map((a) => a.action)).toEqual([
      AuditAction.LOCATION_CREATED,
      AuditAction.LOCATION_DEACTIVATED,
      AuditAction.LOCATION_REACTIVATED,
    ]);
  });
});

describe("a closed counter takes no new value", () => {
  let cafe: StampCafeFixture;
  let branchId: string;

  beforeEach(async () => {
    await resetDatabase();
    cafe = await createStampCafe();
    session.userId = cafe.userId;

    const created = await post({ action: "create", businessId: cafe.businessId, name: "Branch" });
    branchId = String((created.body as unknown as { id: string }).id);

    // A version that runs at BOTH counters, so closing one strands nothing and the refusal under
    // test is the write's own, not the deactivation guard's.
    await createDraftVersion(cafe.ctx, cafe.program.templateId);
    await updateDraftVersion(cafe.ctx, cafe.program.templateId, {
      mechanics: {
        kind: "STAMP",
        contractVersion: 1,
        stampsRequiredPerReward: 10,
        rewardName: "قهوة مجانية",
        earnMode: "MANUAL",
        countRewardRedemptionAsVisit: false,
        availableLocations: [cafe.locationId, branchId],
      },
    });
    await publishDraftVersion(cafe.ctx, cafe.program.templateId, 2);
  });

  it("refuses a scanner award at a counter closed after the card was issued", async () => {
    const card = await enrolCustomer(cafe, { phone: uniqueSyrianPhone() });

    const before = await award({
      businessId: cafe.businessId,
      customerCardId: card.customerCardId,
      mode: "manual",
      quantity: 1,
      locationId: branchId,
      idempotencyKey: key(),
    });
    expect(before.status).toBe(200);

    await setLocationActive(cafe.ctx, branchId, false);

    const after = await award({
      businessId: cafe.businessId,
      customerCardId: card.customerCardId,
      mode: "manual",
      quantity: 1,
      locationId: branchId,
      idempotencyKey: key(),
    });
    // 404: a closed counter is indistinguishable from one that was never offered.
    expect(after.status).toBe(404);

    // And the stamp that WAS taken there is still attributed to it.
    const rows = await prisma.loyaltyOperation.findMany({
      where: { businessId: cafe.businessId, locationId: branchId },
      select: { id: true },
    });
    expect(rows.length).toBeGreaterThan(0);
  });

  it("refuses a new program version that names a closed counter", async () => {
    await setLocationActive(cafe.ctx, branchId, false);

    await createDraftVersion(cafe.ctx, cafe.program.templateId);
    await expect(
      updateDraftVersion(cafe.ctx, cafe.program.templateId, {
        mechanics: {
          kind: "STAMP",
          contractVersion: 1,
          stampsRequiredPerReward: 10,
          rewardName: "قهوة مجانية",
          earnMode: "MANUAL",
          countRewardRedemptionAsVisit: false,
          availableLocations: [cafe.locationId, branchId],
        },
      }),
    ).rejects.toThrow(/do not belong to this business, or are not active/);
  });

  it("keeps counter enrolment working: it writes at the main counter, which never closes", async () => {
    await setLocationActive(cafe.ctx, branchId, false);
    const card = await enrolCustomer(cafe, { phone: uniqueSyrianPhone() });
    expect(card.created).toBe(true);
  });
});

describe("counters are tenant-scoped and permission-gated", () => {
  it("refuses another business's location id as if it did not exist", async () => {
    await resetDatabase();
    const mine = await createStampCafe({ name: "Mine" });
    const theirs = await createStampCafe({ name: "Theirs" });

    session.userId = mine.userId;
    const rename = await post({
      action: "update",
      businessId: mine.businessId,
      locationId: theirs.locationId,
      name: "Taken over",
    });
    expect(rename.status).toBe(404);

    // Untouched, and named what its owner named it.
    const theirLocation = await prisma.location.findUniqueOrThrow({ where: { id: theirs.locationId } });
    expect(theirLocation.name).not.toBe("Taken over");
  });

  it("refuses a cashier, who may see counters but not change them", async () => {
    await resetDatabase();
    const cafe = await createStampCafe();
    const cashier = await createStaff(cafe, MembershipRole.CASHIER, [cafe.locationId]);

    session.userId = cashier.userId;
    const created = await post({ action: "create", businessId: cafe.businessId, name: "Branch" });
    expect(created.status).toBe(403);

    // A cashier does not even hold VIEW_LOCATIONS, so the list refuses them too.
    const ctx = await requireBusinessMembership(prisma, cashier.userId, cafe.businessId);
    expect(ctx.permissions.has(Permission.EDIT_LOCATIONS)).toBe(false);
    await expect(listBusinessLocations(ctx)).rejects.toThrow(/VIEW_LOCATIONS/);
  });
});
