/**
 * Phase 1a — the one staff account a pilot café needs.
 *
 * A cashier can do exactly two things that matter: give stamps and hand over rewards, at the
 * counter they were put behind. Everything else — templates, locations, staff, other businesses —
 * is closed to them, and that is what this file checks.
 */
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { MembershipRole, OperationSource, Permission } from "@prisma/client";
import { beforeAll, describe, expect, it } from "vitest";
import { AuditAction } from "@/server/audit/audit";
import { prisma } from "@/server/db";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/server/errors";
import { createStampProgram } from "@/server/program/stamp-program";
import { createCashier } from "@/server/staff/cashiers";
import { addMembership } from "@/server/tenant/memberships";
import { requireBusinessMembership } from "@/server/tenant/context";
import { awardManualStamps, redeemReward } from "@/server/stamp/engine";
import {
  CAFE_MECHANICS,
  createStaff,
  createStampCafe,
  enrolCustomer,
  expectReconciled,
  resetDatabase,
  uniqueEmail,
  type StampCafeFixture,
} from "../setup/fixtures";

const key = () => `k-${randomUUID()}`;
const PASSWORD = "till-password-not-a-secret";

describe("cashier accounts", () => {
  let cafe: StampCafeFixture;

  beforeAll(async () => {
    await resetDatabase();
    cafe = await createStampCafe({ mechanics: { stampsRequiredPerReward: 5 } });
  });

  describe("creation", () => {
    it("gives the new cashier role defaults and the Main location, and nothing more", async () => {
      const email = uniqueEmail("cashier");
      const created = await createCashier(cafe.ctx, { email, password: PASSWORD, firstName: "بائع" });

      expect(created.email).toBe(email);
      expect(created.locationId).toBe(cafe.locationId);

      const membership = await prisma.businessMembership.findUniqueOrThrow({
        where: { id: created.membershipId },
        include: { locations: true },
      });
      expect(membership.role).toBe(MembershipRole.CASHIER);
      expect(membership.businessId).toBe(cafe.businessId);
      expect(membership.active).toBe(true);
      // No explicit grants: the role defaults are the whole permission set.
      expect(membership.permissions).toEqual([]);
      expect(membership.locations.map((l) => l.locationId)).toEqual([cafe.locationId]);

      const ctx = await requireBusinessMembership(prisma, created.userId, cafe.businessId);
      expect(ctx.role).toBe(MembershipRole.CASHIER);
      expect([...ctx.permissions].sort()).toEqual(
        [Permission.MAKE_ACCRUALS, Permission.MAKE_REDEMPTIONS, Permission.VIEW_CUSTOMERS, Permission.VIEW_OPERATIONS].sort(),
      );
      // Scoped to exactly one counter: never null, which would mean unrestricted.
      expect(ctx.locationIds).toEqual([cafe.locationId]);
    });

    it("stores a password that actually authenticates, and never the password itself", async () => {
      const email = uniqueEmail("cashier");
      const created = await createCashier(cafe.ctx, { email, password: PASSWORD, firstName: "Till" });

      const user = await prisma.user.findUniqueOrThrow({ where: { id: created.userId } });
      expect(user.passwordHash).not.toBe(PASSWORD);
      expect(user.passwordHash).toMatch(/^\$2[aby]\$/); // bcrypt
      expect(await bcrypt.compare(PASSWORD, user.passwordHash)).toBe(true);

      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { action: AuditAction.CASHIER_CREATED, entityId: created.membershipId },
      });
      expect(audit.actorUserId).toBe(cafe.userId);
      expect(JSON.stringify(audit.metadata)).not.toContain(PASSWORD);
      expect(JSON.stringify(audit.metadata)).not.toContain(user.passwordHash);
    });

    it("normalises the email and refuses a weak or malformed one", async () => {
      const email = uniqueEmail("MixedCase");
      const created = await createCashier(cafe.ctx, { email: `  ${email.toUpperCase()}  `, password: PASSWORD, firstName: "X" });
      expect(created.email).toBe(email.toLowerCase());

      await expect(createCashier(cafe.ctx, { email: "not-an-email", password: PASSWORD, firstName: "X" })).rejects.toBeInstanceOf(
        ValidationError,
      );
      await expect(createCashier(cafe.ctx, { email: uniqueEmail(), password: "short", firstName: "X" })).rejects.toBeInstanceOf(
        ValidationError,
      );
      await expect(createCashier(cafe.ctx, { email: uniqueEmail(), password: PASSWORD, firstName: "  " })).rejects.toBeInstanceOf(
        ValidationError,
      );
    });

    it("refuses an email that already belongs to someone, rather than resetting their password", async () => {
      const email = uniqueEmail("taken");
      await createCashier(cafe.ctx, { email, password: PASSWORD, firstName: "First" });
      await expect(createCashier(cafe.ctx, { email, password: "another-password", firstName: "Second" })).rejects.toBeInstanceOf(
        ConflictError,
      );
      expect(await prisma.user.count({ where: { email } })).toBe(1);
    });
  });

  describe("who may create one", () => {
    it("refuses a manager, even though they administer much else", async () => {
      const manager = await createStaff(cafe, MembershipRole.MANAGER, [cafe.locationId]);
      await expect(
        createCashier(manager.ctx, { email: uniqueEmail(), password: PASSWORD, firstName: "No" }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });

    it("refuses a cashier", async () => {
      const cashier = await createStaff(cafe, MembershipRole.CASHIER, [cafe.locationId]);
      await expect(
        createCashier(cashier.ctx, { email: uniqueEmail(), password: PASSWORD, firstName: "No" }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });

    it("refuses a manager who has been granted EDIT_STAFF explicitly", async () => {
      // The check is on the ROLE, so it cannot be widened by handing out a permission bit.
      const manager = await createStaff(cafe, MembershipRole.MANAGER, [cafe.locationId]);
      await prisma.businessMembership.update({
        where: { id: manager.membershipId },
        data: { permissions: [Permission.EDIT_STAFF] },
      });
      const elevated = await requireBusinessMembership(prisma, manager.userId, cafe.businessId);
      expect(elevated.permissions.has(Permission.EDIT_STAFF)).toBe(true);
      await expect(
        createCashier(elevated, { email: uniqueEmail(), password: PASSWORD, firstName: "Still no" }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });
  });

  describe("what a cashier can and cannot do", () => {
    let cashierCtx: Awaited<ReturnType<typeof requireBusinessMembership>>;
    let cardId: string;

    beforeAll(async () => {
      const created = await createCashier(cafe.ctx, { email: uniqueEmail("till"), password: PASSWORD, firstName: "Till" });
      cashierCtx = await requireBusinessMembership(prisma, created.userId, cafe.businessId);
      cardId = (await enrolCustomer(cafe)).customerCardId;
    });

    it("awards stamps and redeems rewards at its own counter", async () => {
      const award = await awardManualStamps(cashierCtx, {
        customerCardId: cardId,
        quantity: 5,
        idempotencyKey: key(),
        source: OperationSource.SCANNER,
      });
      expect(award.rewardBalance).toBe(1);
      expect(award.operations[0].kind).toBe("MANUAL_AWARD");

      const redemption = await redeemReward(cashierCtx, {
        customerCardId: cardId,
        idempotencyKey: key(),
        source: OperationSource.SCANNER,
      });
      expect(redemption.rewardBalance).toBe(0);

      const rows = await prisma.loyaltyOperation.findMany({ where: { customerCardId: cardId } });
      expect(rows.every((r) => r.locationId === cafe.locationId)).toBe(true);
      expect(rows.some((r) => r.performedByUserId === cashierCtx.userId)).toBe(true);
      await expectReconciled(cafe.businessId);
    });

    it("cannot reach a second counter, because nobody can name one", async () => {
      // Phase 1a is one café at one counter. A second Location row may exist in the database, but
      // no caller can direct an operation to it: the location is resolved by the server.
      const otherCounter = await prisma.location.create({ data: { businessId: cafe.businessId, name: "Drive-through" } });
      const before = await prisma.loyaltyOperation.count({ where: { customerCardId: cardId } });

      await expect(
        awardManualStamps(cashierCtx, {
          customerCardId: cardId,
          quantity: 1,
          idempotencyKey: key(),
          source: OperationSource.SCANNER,
          locationId: otherCounter.id,
        } as unknown as Parameters<typeof awardManualStamps>[1]),
      ).rejects.toBeInstanceOf(ValidationError);

      expect(await prisma.loyaltyOperation.count({ where: { customerCardId: cardId } })).toBe(before);
      expect(await prisma.loyaltyOperation.count({ where: { locationId: otherCounter.id } })).toBe(0);
    });

    it("cannot create or change the loyalty program", async () => {
      await expect(createStampProgram(cashierCtx, { name: "Mine now", mechanics: CAFE_MECHANICS })).rejects.toBeInstanceOf(
        ForbiddenError,
      );
    });

    it("cannot add staff", async () => {
      await expect(
        addMembership(cashierCtx, { userId: cafe.userId, role: MembershipRole.CASHIER }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });

    it("cannot touch another business, even with a real card id", async () => {
      const rival = await createStampCafe();
      const rivalCard = (await enrolCustomer(rival)).customerCardId;
      await expect(
        awardManualStamps(cashierCtx, {
          customerCardId: rivalCard,
          quantity: 1,
          idempotencyKey: key(),
          source: OperationSource.SCANNER,
        }),
      ).rejects.toBeInstanceOf(NotFoundError);
      // And has no membership there at all.
      await expect(requireBusinessMembership(prisma, cashierCtx.userId, rival.businessId)).rejects.toBeInstanceOf(ForbiddenError);
    });

    it("loses access the moment the owner deactivates the membership", async () => {
      const created = await createCashier(cafe.ctx, { email: uniqueEmail("temp"), password: PASSWORD, firstName: "Temp" });
      const ctx = await requireBusinessMembership(prisma, created.userId, cafe.businessId);
      expect(ctx.role).toBe(MembershipRole.CASHIER);

      await prisma.businessMembership.update({ where: { id: created.membershipId }, data: { active: false } });
      // Contexts are rebuilt from the database on every request, so this takes effect at once.
      await expect(requireBusinessMembership(prisma, created.userId, cafe.businessId)).rejects.toBeInstanceOf(ForbiddenError);
    });
  });

  describe("an unassigned cashier", () => {
    it("is refused everywhere rather than treated as unrestricted", async () => {
      const unassigned = await createStaff(cafe, MembershipRole.CASHIER, []);
      expect(unassigned.ctx.locationIds).toEqual([]);
      const cardId = (await enrolCustomer(cafe)).customerCardId;

      await expect(
        awardManualStamps(unassigned.ctx, {
          customerCardId: cardId,
          quantity: 1,
          idempotencyKey: key(),
          source: OperationSource.SCANNER,
        }),
      ).rejects.toBeInstanceOf(ForbiddenError);
      expect(await prisma.loyaltyOperation.count({ where: { customerCardId: cardId } })).toBe(0);
    });
  });
});
