/**
 * Phase 1a — creating the one stamp program a pilot café runs.
 *
 * The program is four rows that must all exist or none: the template, its first immutable
 * version, the reward that version pays out, and the `direct` source customers arrive through.
 */
import { MembershipRole, ProgramVersionStatus, TemplateStatus } from "@prisma/client";
import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { ConflictError, ForbiddenError, ValidationError } from "@/server/errors";
import { STAMP_MECHANICS_CONTRACT_VERSION, StampEarnMode } from "@/server/program/mechanics";
import { createStampProgram, getActiveStampProgram, DIRECT_UTM_SOURCE } from "@/server/program/stamp-program";
import { AuditAction } from "@/server/audit/audit";
import { CAFE_MECHANICS, createStaff, createStampCafe, ownerCtx, registerTestOwner, resetDatabase, type StampCafeFixture } from "../setup/fixtures";

describe("stamp program creation", () => {
  let cafe: StampCafeFixture;

  beforeAll(async () => {
    await resetDatabase();
    cafe = await createStampCafe({
      mechanics: { stampsRequiredPerReward: 8, rewardName: "Free coffee", rewardValueMinor: 15_000, dailyAwardLimit: 3 },
    });
  });

  it("creates the template, an ACTIVE version, its reward tier and the direct source together", async () => {
    const template = await prisma.programTemplate.findUniqueOrThrow({
      where: { id: cafe.program.templateId },
      include: { versions: { include: { rewardTiers: true } }, utmLinks: true },
    });

    expect(template.businessId).toBe(cafe.businessId);
    expect(template.cardType).toBe("STAMP");
    expect(template.status).toBe(TemplateStatus.ACTIVE);

    expect(template.versions).toHaveLength(1);
    const version = template.versions[0];
    expect(version.versionNumber).toBe(1);
    expect(version.status).toBe(ProgramVersionStatus.ACTIVE);
    expect(version.activatedAt).toBeInstanceOf(Date);

    // The tier mirrors the mechanics, so a redemption can name what was given away.
    expect(version.rewardTiers).toHaveLength(1);
    expect(version.rewardTiers[0].name).toBe("Free coffee");
    expect(version.rewardTiers[0].requiredPoints).toBe(8);
    expect(version.rewardTiers[0].rewardValueMinor).toBe(15_000);

    expect(template.utmLinks).toHaveLength(1);
    expect(template.utmLinks[0].utmSource).toBe(DIRECT_UTM_SOURCE);
    expect(template.utmLinks[0].active).toBe(true);
  });

  it("stores mechanics that read back through the contract, not as loose JSON", async () => {
    const program = await getActiveStampProgram(cafe.ctx);
    expect(program).not.toBeNull();
    expect(program!.mechanics.stampsRequiredPerReward).toBe(8);
    expect(program!.mechanics.contractVersion).toBe(STAMP_MECHANICS_CONTRACT_VERSION);
    expect(program!.mechanics.dailyAwardLimit).toBe(3);
    expect(program!.mechanics.earnMode).toBe(StampEarnMode.MANUAL);
    expect(program!.programVersionId).toBe(cafe.program.programVersionId);
    expect(program!.rewardTierId).toBe(cafe.program.rewardTierId);
  });

  it("gives the direct source an opaque token that reveals nothing", async () => {
    const token = cafe.program.directSourceToken;
    expect(token).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    for (const secret of [cafe.businessId, cafe.program.templateId, cafe.program.programVersionId, cafe.userId]) {
      expect(token).not.toContain(secret);
      expect(token).not.toContain(secret.replace(/-/g, ""));
    }
  });

  describe("the version is frozen once active", () => {
    it("refuses a mechanics edit", async () => {
      await expect(
        prisma.programVersion.update({
          where: { id: cafe.program.programVersionId },
          data: { mechanics: { stampsRequiredPerReward: 1 } },
        }),
      ).rejects.toThrow(/immutable after activation/i);
    });

    it("refuses a change to its reward tier, and refuses adding another", async () => {
      await expect(
        prisma.rewardTier.update({ where: { id: cafe.program.rewardTierId }, data: { requiredPoints: 1 } }),
      ).rejects.toThrow(/immutable after activation/i);
      await expect(
        prisma.rewardTier.create({
          data: { programVersionId: cafe.program.programVersionId, name: "Second reward", requiredPoints: 2 },
        }),
      ).rejects.toThrow(/immutable after activation/i);
    });

    it("refuses changing the card type once a version is live", async () => {
      await expect(
        prisma.programTemplate.update({ where: { id: cafe.program.templateId }, data: { cardType: "POINTS" } }),
      ).rejects.toThrow(/cardType/i);
    });
  });

  describe("the Phase 1a one-program rule", () => {
    it("refuses a second live program for the same business", async () => {
      await expect(createStampProgram(cafe.ctx, { name: "Second card", mechanics: CAFE_MECHANICS })).rejects.toBeInstanceOf(
        ConflictError,
      );
      expect(await prisma.programTemplate.count({ where: { businessId: cafe.businessId } })).toBe(1);
    });

    it("does not stop a DIFFERENT business creating its own", async () => {
      const other = await createStampCafe();
      expect(other.program.templateId).not.toBe(cafe.program.templateId);
      expect(other.program.directSourceToken).not.toBe(cafe.program.directSourceToken);
    });
  });

  describe("authorisation", () => {
    it("refuses a cashier, who holds no EDIT_TEMPLATES", async () => {
      const cashier = await createStaff(cafe, MembershipRole.CASHIER, [cafe.locationId]);
      await expect(createStampProgram(cashier.ctx, { name: "Nope", mechanics: CAFE_MECHANICS })).rejects.toBeInstanceOf(
        ForbiddenError,
      );
    });

    it("allows a manager, who does", async () => {
      const fresh = await registerTestOwner();
      const manager = await createStaff({ businessId: fresh.businessId }, MembershipRole.MANAGER, [fresh.locationId]);
      const program = await createStampProgram(manager.ctx, { name: "Manager's card", mechanics: CAFE_MECHANICS });
      expect(program.templateId).toBeTruthy();
    });

    it("never reads another business's program", async () => {
      const other = await createStampCafe();
      const seenByOther = await getActiveStampProgram(other.ctx);
      expect(seenByOther!.templateId).toBe(other.program.templateId);
      expect(seenByOther!.templateId).not.toBe(cafe.program.templateId);
    });

    it("reports no program for a business that has none", async () => {
      const fresh = await registerTestOwner();
      expect(await getActiveStampProgram(await ownerCtx(fresh))).toBeNull();
    });
  });

  describe("input validation", () => {
    it("refuses invalid mechanics before writing anything", async () => {
      const fresh = await registerTestOwner();
      const ctx = await ownerCtx(fresh);
      await expect(
        createStampProgram(ctx, { name: "Bad", mechanics: { ...CAFE_MECHANICS, stampsRequiredPerReward: 0 } }),
      ).rejects.toBeInstanceOf(ValidationError);
      await expect(createStampProgram(ctx, { name: "  ", mechanics: CAFE_MECHANICS })).rejects.toBeInstanceOf(ValidationError);
      expect(await prisma.programTemplate.count({ where: { businessId: fresh.businessId } })).toBe(0);
    });

    it("refuses a deferred mechanic rather than storing it", async () => {
      const fresh = await registerTestOwner();
      await expect(
        createStampProgram(await ownerCtx(fresh), {
          name: "Points in disguise",
          mechanics: { ...CAFE_MECHANICS, pointsPerVisit: 5 } as never,
        }),
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });

  it("audits creation without writing the enrollment token", async () => {
    const audits = await prisma.auditLog.findMany({
      where: { businessId: cafe.businessId, action: { in: [AuditAction.PROGRAM_CREATED, AuditAction.ENROLLMENT_SOURCE_CREATED] } },
    });
    expect(audits).toHaveLength(2);
    expect(audits.every((a) => a.actorUserId === cafe.userId)).toBe(true);
    // The token is a capability: holding it opens the enrollment page.
    expect(JSON.stringify(audits)).not.toContain(cafe.program.directSourceToken);
  });
});
