import { OperationKind, OperationSource, ProgramVersionStatus, UnitType } from "@prisma/client";
import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { appendOperationGroup } from "@/server/ledger/ledger";
import { createBusinessWithCard, ownerActor, resetDatabase, type CardFixture } from "../setup/fixtures";

const APPEND_ONLY = /append-only/i;

describe("PostgreSQL-level protection", () => {
  let fx: CardFixture;
  let opId: string;

  beforeAll(async () => {
    await resetDatabase();
    fx = await createBusinessWithCard();
    const r = await appendOperationGroup({
      actor: await ownerActor(fx, OperationSource.DASHBOARD),
      customerCardId: fx.cardId,
      locationId: fx.locationId,
      operations: [{ kind: OperationKind.MANUAL_AWARD, unitType: UnitType.STAMP, quantity: 1 }],
    });
    opId = r.operations[0].id;
  });

  describe("LoyaltyOperation is append-only", () => {
    it("rejects UPDATE through Prisma", async () => {
      await expect(prisma.loyaltyOperation.update({ where: { id: opId }, data: { quantity: 99 } })).rejects.toThrow(APPEND_ONLY);
      await expect(prisma.loyaltyOperation.updateMany({ data: { comment: "x" } })).rejects.toThrow(APPEND_ONLY);
    });

    it("rejects DELETE through Prisma", async () => {
      await expect(prisma.loyaltyOperation.delete({ where: { id: opId } })).rejects.toThrow(APPEND_ONLY);
      await expect(prisma.loyaltyOperation.deleteMany({})).rejects.toThrow(APPEND_ONLY);
    });

    it("rejects raw SQL UPDATE, DELETE and TRUNCATE", async () => {
      await expect(prisma.$executeRawUnsafe(`UPDATE "LoyaltyOperation" SET quantity = 5`)).rejects.toThrow(APPEND_ONLY);
      await expect(prisma.$executeRawUnsafe(`DELETE FROM "LoyaltyOperation"`)).rejects.toThrow(APPEND_ONLY);
      await expect(prisma.$executeRawUnsafe(`TRUNCATE "LoyaltyOperation"`)).rejects.toThrow(APPEND_ONLY);
    });

    it("the row is still intact afterwards", async () => {
      const row = await prisma.loyaltyOperation.findUniqueOrThrow({ where: { id: opId } });
      expect(row.quantity).toBe(1);
      expect(await prisma.loyaltyOperation.count()).toBe(1);
    });
  });

  describe("ProgramVersion immutability", () => {
    it("rejects mechanics changes on an ACTIVE version", async () => {
      await expect(
        prisma.programVersion.update({ where: { id: fx.programVersionId }, data: { mechanics: { changed: true } } }),
      ).rejects.toThrow(/immutable after activation/i);
    });

    it("rejects moving ACTIVE back to DRAFT and deleting a non-DRAFT version", async () => {
      await expect(
        prisma.programVersion.update({ where: { id: fx.programVersionId }, data: { status: ProgramVersionStatus.DRAFT } }),
      ).rejects.toThrow(/cannot move/i);
      await expect(prisma.programVersion.delete({ where: { id: fx.programVersionId } })).rejects.toThrow(/only DRAFT/i);
    });

    it("allows editing and deleting a DRAFT version", async () => {
      const draft = await prisma.programVersion.create({
        data: { templateId: fx.templateId, versionNumber: 2, mechanics: { a: 1 } },
      });
      await prisma.programVersion.update({ where: { id: draft.id }, data: { mechanics: { a: 2 } } });
      await prisma.programVersion.delete({ where: { id: draft.id } });
    });

    it("permits only one ACTIVE version per template (partial unique index)", async () => {
      const draft = await prisma.programVersion.create({
        data: { templateId: fx.templateId, versionNumber: 3, mechanics: {} },
      });
      await expect(
        prisma.programVersion.update({ where: { id: draft.id }, data: { status: ProgramVersionStatus.ACTIVE } }),
      ).rejects.toThrow(/unique|ProgramVersion_one_active_per_template/i);
    });
  });

  it("permits only one default location per business (partial unique index)", async () => {
    await expect(
      prisma.location.create({ data: { businessId: fx.businessId, name: "Second default", isDefault: true } }),
    ).rejects.toThrow(/unique|Location_one_default_per_business/i);
  });
});
