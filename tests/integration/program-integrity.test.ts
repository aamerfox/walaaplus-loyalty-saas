import { CardType, OperationKind, ProgramVersionStatus, TemplateStatus, UnitType } from "@prisma/client";
import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { LedgerInvariantError } from "@/server/errors";
import { appendOperationGroup } from "@/server/ledger/ledger";
import { createBusinessWithCard, ownerActor, resetDatabase, systemActor } from "../setup/fixtures";

const IMMUTABLE = /immutable after activation|not permitted/i;

describe("program integrity (remediation item 4)", () => {
  beforeAll(resetDatabase);

  describe("database: RewardTier frozen with its ProgramVersion", () => {
    it("allows insert/update/delete while the version is DRAFT", async () => {
      const fx = await createBusinessWithCard();
      const draft = await prisma.programVersion.create({ data: { templateId: fx.templateId, versionNumber: 2, mechanics: {} } });
      const tier = await prisma.rewardTier.create({ data: { programVersionId: draft.id, name: "Coffee", requiredPoints: 100 } });
      await prisma.rewardTier.update({ where: { id: tier.id }, data: { requiredPoints: 120 } });
      await prisma.rewardTier.delete({ where: { id: tier.id } });
    });

    it("rejects insert, update, move and delete once the version is ACTIVE", async () => {
      const fx = await createBusinessWithCard({ rewardTiers: [{ name: "Latte", requiredPoints: 50 }] });
      const [tierId] = fx.rewardTierIds;

      await expect(prisma.rewardTier.create({ data: { programVersionId: fx.programVersionId, name: "New", requiredPoints: 10 } })).rejects.toThrow(IMMUTABLE);
      await expect(prisma.rewardTier.update({ where: { id: tierId }, data: { requiredPoints: 5 } })).rejects.toThrow(IMMUTABLE);
      await expect(prisma.rewardTier.update({ where: { id: tierId }, data: { name: "Renamed" } })).rejects.toThrow(IMMUTABLE);
      await expect(prisma.rewardTier.delete({ where: { id: tierId } })).rejects.toThrow(IMMUTABLE);

      // moving a tier out of an active version is refused too (the version check fires on OLD row)
      const draft = await prisma.programVersion.create({ data: { templateId: fx.templateId, versionNumber: 2, mechanics: {} } });
      await expect(prisma.rewardTier.update({ where: { id: tierId }, data: { programVersionId: draft.id } })).rejects.toThrow(IMMUTABLE);

      const still = await prisma.rewardTier.findUniqueOrThrow({ where: { id: tierId } });
      expect(still).toMatchObject({ name: "Latte", requiredPoints: 50, programVersionId: fx.programVersionId });
    });

    it("stays frozen after the version is RETIRED", async () => {
      const fx = await createBusinessWithCard({ rewardTiers: [{ name: "T", requiredPoints: 1 }] });
      await prisma.programVersion.update({ where: { id: fx.programVersionId }, data: { status: ProgramVersionStatus.RETIRED } });
      await expect(prisma.rewardTier.delete({ where: { id: fx.rewardTierIds[0] } })).rejects.toThrow(IMMUTABLE);
    });
  });

  describe("database: ProgramTemplate.cardType lock", () => {
    it("can change while nothing is activated or issued", async () => {
      const fx = await createBusinessWithCard();
      const t = await prisma.programTemplate.create({
        data: { businessId: fx.businessId, name: "Fresh", cardType: CardType.STAMP, versions: { create: { versionNumber: 1, mechanics: {} } } },
      });
      await prisma.programTemplate.update({ where: { id: t.id }, data: { cardType: CardType.POINTS } });
    });

    it("locks once a version is ACTIVE", async () => {
      const fx = await createBusinessWithCard(); // version ACTIVE, card issued
      await expect(prisma.programTemplate.update({ where: { id: fx.templateId }, data: { cardType: CardType.POINTS } })).rejects.toThrow(/locked/i);
      // other live presentation fields remain editable
      await prisma.programTemplate.update({ where: { id: fx.templateId }, data: { name: "Renamed live", status: TemplateStatus.PAUSED } });
    });

    it("locks once any card is issued, even if every version is still DRAFT", async () => {
      const fx = await createBusinessWithCard();
      const t = await prisma.programTemplate.create({
        data: { businessId: fx.businessId, name: "Draft w/ card", cardType: CardType.STAMP, versions: { create: { versionNumber: 1, mechanics: {} } } },
        include: { versions: true },
      });
      const customer = await prisma.customer.create({ data: { normalizedPhone: `+9639${Date.now().toString().slice(-8)}` } });
      const profile = await prisma.customerBusinessProfile.create({ data: { businessId: fx.businessId, customerId: customer.id } });
      await prisma.customerCard.create({
        data: {
          businessId: fx.businessId,
          templateId: t.id,
          programVersionId: t.versions[0].id,
          customerBusinessProfileId: profile.id,
          serialNumber: `SN-${Date.now()}`,
          qrToken: `q-${Date.now()}`,
          shareToken: `s-${Date.now()}`,
        },
      });
      await expect(prisma.programTemplate.update({ where: { id: t.id }, data: { cardType: CardType.POINTS } })).rejects.toThrow(/locked/i);
    });
  });

  describe("service: rewardTierId must belong to the card's pinned version", () => {
    it("accepts a tier of the pinned version and records it", async () => {
      const fx = await createBusinessWithCard({ rewardTiers: [{ name: "Latte", requiredPoints: 50, rewardValueMinor: 15_000 }] });
      await appendOperationGroup({ actor: systemActor(fx), customerCardId: fx.cardId, locationId: fx.locationId, operations: [{ kind: OperationKind.REWARD_EARNED, unitType: UnitType.REWARD, quantity: 1 }] });
      const r = await appendOperationGroup({
        actor: await ownerActor(fx),
        customerCardId: fx.cardId,
        locationId: fx.locationId,
        operations: [{ kind: OperationKind.REWARD_REDEEMED, unitType: UnitType.REWARD, quantity: -1, rewardTierId: fx.rewardTierIds[0], redemptionValueMinor: 15_000 }],
      });
      const row = await prisma.loyaltyOperation.findUniqueOrThrow({ where: { id: r.operations[0].id } });
      expect(row.rewardTierId).toBe(fx.rewardTierIds[0]);
    });

    it("rejects a tier from another version of the same business, another business, or an unknown id — with one generic message", async () => {
      const fx = await createBusinessWithCard();
      await appendOperationGroup({ actor: systemActor(fx), customerCardId: fx.cardId, locationId: fx.locationId, operations: [{ kind: OperationKind.REWARD_EARNED, unitType: UnitType.REWARD, quantity: 3 }] });

      // another version in the SAME business (draft, so a tier can be added)
      const draft = await prisma.programVersion.create({ data: { templateId: fx.templateId, versionNumber: 2, mechanics: {} } });
      const sameBizOtherVersion = await prisma.rewardTier.create({ data: { programVersionId: draft.id, name: "Other version", requiredPoints: 1 } });
      // another business entirely
      const foreign = await createBusinessWithCard({ rewardTiers: [{ name: "Foreign", requiredPoints: 1 }] });

      const messages = new Set<string>();
      for (const tierId of [sameBizOtherVersion.id, foreign.rewardTierIds[0], "00000000-0000-0000-0000-000000000000"]) {
        let err: unknown;
        try {
          await appendOperationGroup({
            actor: await ownerActor(fx),
            customerCardId: fx.cardId,
            locationId: fx.locationId,
            operations: [{ kind: OperationKind.REWARD_REDEEMED, unitType: UnitType.REWARD, quantity: -1, rewardTierId: tierId }],
          });
        } catch (e) {
          err = e;
        }
        expect(err).toBeInstanceOf(LedgerInvariantError);
        messages.add((err as Error).message);
        expect((err as Error).message).not.toContain(foreign.businessId);
        expect((err as Error).message).not.toContain(tierId);
      }
      expect(messages.size).toBe(1); // identical wording: nothing distinguishes "foreign" from "unknown"

      const card = await prisma.customerCard.findUniqueOrThrow({ where: { id: fx.cardId } });
      expect(card.rewardBalance).toBe(3);
      expect(await prisma.loyaltyOperation.count({ where: { customerCardId: fx.cardId, kind: OperationKind.REWARD_REDEEMED } })).toBe(0);
    });
  });
});
