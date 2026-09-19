import { ProgramVersionStatus } from "@prisma/client";
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import {
  createMoneyDraft,
  discardMoneyDraft,
  getMoneyProgramConfig,
  publishMoneyDraft,
  updateMoneyDraftRateTable,
} from "@/server/monetary/draft";
import { createMonetaryShop, migratorPrisma, resetDatabase, type MonetaryShopFixture } from "../setup/fixtures";

/**
 * The owner's draft lifecycle for a money program: open, edit the rate table, discard, publish.
 *
 * Every test goes through the SERVICE, because these are the service's rules — who may call it, what
 * a second draft does, which version a publish retires. `money-draft-config.test.ts` is the other
 * half: it writes the same rows directly as the restricted runtime role, and proves the database
 * refuses what the service would never send. Neither suite makes the other redundant; a service test
 * alone would prove only that this code is careful.
 */

let fx: MonetaryShopFixture;

beforeEach(async () => {
  await resetDatabase();
  fx = await createMonetaryShop({ tiers: [{ minCumulativeSpendMinor: 0, rateBasisPoints: 500 }] });
});

const templateId = () => fx.program.templateId;

describe("opening a draft", () => {
  it("copies the live rate table exactly, so 'what changed' means what the owner changed", async () => {
    const draft = await createMoneyDraft(fx.ctx, templateId());

    expect(draft.versionNumber).toBe(2);
    expect(draft.tiers).toEqual([{ tierIndex: 0, minCumulativeSpendMinor: 0n, rateBasisPoints: 500 }]);
    // The live version is untouched and still live.
    const live = await prisma.programVersion.findFirstOrThrow({
      where: { templateId: templateId(), status: ProgramVersionStatus.ACTIVE },
      select: { versionNumber: true },
    });
    expect(live.versionNumber).toBe(1);
  });

  it("carries the business's currency and exponent, which the caller never supplied", async () => {
    const draft = await createMoneyDraft(fx.ctx, templateId());
    const business = await prisma.business.findUniqueOrThrow({
      where: { id: fx.businessId },
      select: { currency: true },
    });
    expect(draft.currency).toBe(business.currency);
    expect(draft.currencyExponent).toBe(2);
  });

  it("takes the business's own currency even when that is not SYP", async () => {
    // The rule is "match the business", not "always SYP". Without this, a hard-coded SYP would pass.
    const jod = await createMonetaryShop({ currency: "JOD", existing: undefined });
    const draft = await createMoneyDraft(jod.ctx, jod.program.templateId);
    expect(draft.currency).toBe("JOD");
    expect(draft.currencyExponent).toBe(3);
  });

  it("returns the open draft instead of opening a second one", async () => {
    const first = await createMoneyDraft(fx.ctx, templateId());
    const again = await createMoneyDraft(fx.ctx, templateId());

    expect(again.versionId).toBe(first.versionId);
    expect(again.versionNumber).toBe(first.versionNumber);
    const drafts = await prisma.programVersion.count({
      where: { templateId: templateId(), status: ProgramVersionStatus.DRAFT },
    });
    expect(drafts).toBe(1);
  });
});

describe("editing the rate table", () => {
  it("replaces the whole table, renumbering the tiers", async () => {
    await createMoneyDraft(fx.ctx, templateId());
    const edited = await updateMoneyDraftRateTable(fx.ctx, templateId(), [
      { minCumulativeSpendMinor: 0, rateBasisPoints: 300 },
      { minCumulativeSpendMinor: 500_000, rateBasisPoints: 700 },
      { minCumulativeSpendMinor: 2_000_000, rateBasisPoints: 1000 },
    ]);

    expect(edited.tiers).toEqual([
      { tierIndex: 0, minCumulativeSpendMinor: 0n, rateBasisPoints: 300 },
      { tierIndex: 1, minCumulativeSpendMinor: 500_000n, rateBasisPoints: 700 },
      { tierIndex: 2, minCumulativeSpendMinor: 2_000_000n, rateBasisPoints: 1000 },
    ]);
  });

  it("leaves the LIVE table untouched while the draft changes", async () => {
    await createMoneyDraft(fx.ctx, templateId());
    await updateMoneyDraftRateTable(fx.ctx, templateId(), [{ minCumulativeSpendMinor: 0, rateBasisPoints: 9999 }]);

    const config = await getMoneyProgramConfig(fx.ctx, templateId());
    expect(config.live?.tiers[0].rateBasisPoints).toBe(500);
    expect(config.draft?.tiers[0].rateBasisPoints).toBe(9999);
  });

  it("allows an incomplete empty draft, but refuses one past the tier ceiling", async () => {
    await createMoneyDraft(fx.ctx, templateId());
    const empty = await updateMoneyDraftRateTable(fx.ctx, templateId(), []);
    expect(empty.tiers).toHaveLength(0);

    const tooMany = Array.from({ length: 11 }, (_, i) => ({
      minCumulativeSpendMinor: i * 1000,
      rateBasisPoints: 100 + i,
    }));
    await expect(updateMoneyDraftRateTable(fx.ctx, templateId(), tooMany)).rejects.toThrow(/more than 10 tiers/);
  });

  it("refuses a rate above 100%", async () => {
    await createMoneyDraft(fx.ctx, templateId());
    await expect(
      updateMoneyDraftRateTable(fx.ctx, templateId(), [{ minCumulativeSpendMinor: 0, rateBasisPoints: 10_001 }]),
    ).rejects.toThrow();
  });

  it("refuses when there is no open draft at all", async () => {
    await expect(
      updateMoneyDraftRateTable(fx.ctx, templateId(), [{ minCumulativeSpendMinor: 0, rateBasisPoints: 100 }]),
    ).rejects.toThrow(/no open draft/);
  });
});

describe("discarding a draft", () => {
  it("RETIRES it — the row survives, and nothing is deleted", async () => {
    const draft = await createMoneyDraft(fx.ctx, templateId());
    await discardMoneyDraft(fx.ctx, templateId());

    const row = await prisma.programVersion.findUniqueOrThrow({
      where: { id: draft.versionId },
      select: { status: true, retiredAt: true },
    });
    expect(row.status).toBe(ProgramVersionStatus.RETIRED);
    expect(row.retiredAt).not.toBeNull();

    // Its rate table survives with it: a retired version is evidence, not a tombstone.
    const rule = await prisma.monetaryRule.findFirst({ where: { programVersionId: draft.versionId } });
    expect(rule).not.toBeNull();
  });

  it("leaves the live version live, and lets a fresh draft be opened afterwards", async () => {
    await createMoneyDraft(fx.ctx, templateId());
    await discardMoneyDraft(fx.ctx, templateId());

    const config = await getMoneyProgramConfig(fx.ctx, templateId());
    expect(config.live?.versionNumber).toBe(1);
    expect(config.draft).toBeNull();

    const next = await createMoneyDraft(fx.ctx, templateId());
    expect(next.versionNumber).toBe(3); // 2 was retired and its number is not reused
  });

  it("a discarded draft can never be activated", async () => {
    const draft = await createMoneyDraft(fx.ctx, templateId());
    await discardMoneyDraft(fx.ctx, templateId());

    // Straight at the database, as the owner role, bypassing the service entirely.
    await expect(
      migratorPrisma().$executeRawUnsafe(
        `UPDATE "ProgramVersion" SET status='ACTIVE',"activatedAt"=now() WHERE id=$1`,
        draft.versionId,
      ),
    ).rejects.toThrow();
  });
});

describe("publishing", () => {
  it("makes the draft live and retires the version it replaces", async () => {
    const draft = await createMoneyDraft(fx.ctx, templateId());
    await updateMoneyDraftRateTable(fx.ctx, templateId(), [{ minCumulativeSpendMinor: 0, rateBasisPoints: 750 }]);

    const result = await publishMoneyDraft(fx.ctx, templateId(), draft.versionNumber);
    expect(result).toEqual({ publishedVersionNumber: 2, retiredVersionNumber: 1 });

    const config = await getMoneyProgramConfig(fx.ctx, templateId());
    expect(config.live?.versionNumber).toBe(2);
    expect(config.live?.tiers[0].rateBasisPoints).toBe(750);
    expect(config.draft).toBeNull();
  });

  it("refuses to publish a version number the caller was not looking at", async () => {
    const draft = await createMoneyDraft(fx.ctx, templateId());
    await expect(publishMoneyDraft(fx.ctx, templateId(), draft.versionNumber + 1)).rejects.toThrow(
      /is version 2, not 3/,
    );
  });

  it("refuses when there is no draft", async () => {
    await expect(publishMoneyDraft(fx.ctx, templateId(), 2)).rejects.toThrow(/no open draft/);
  });

  it("refuses an incomplete rate table AT THE DATABASE, not merely in this code", async () => {
    const draft = await createMoneyDraft(fx.ctx, templateId());
    // Remove the tiers behind the service's back, so publish meets a draft it never could have made.
    const owner = migratorPrisma();
    const rule = await owner.monetaryRule.findFirstOrThrow({
      where: { programVersionId: draft.versionId },
      select: { id: true },
    });
    await owner.monetaryTier.deleteMany({ where: { monetaryRuleId: rule.id } });

    await expect(publishMoneyDraft(fx.ctx, templateId(), draft.versionNumber)).rejects.toThrow(/tier|rate table/i);

    // And the live version is still live: a refused publish retires nothing.
    const live = await prisma.programVersion.findFirstOrThrow({
      where: { templateId: templateId(), status: ProgramVersionStatus.ACTIVE },
      select: { versionNumber: true },
    });
    expect(live.versionNumber).toBe(1);
  });

  it("runs the same draft, refusal, publish, and post-publish freeze for DISCOUNT", async () => {
    const discount = await createMonetaryShop({ kind: "DISCOUNT", name: "Discount lifecycle" });
    const draft = await createMoneyDraft(discount.ctx, discount.program.templateId);
    await updateMoneyDraftRateTable(discount.ctx, discount.program.templateId, []);

    await expect(publishMoneyDraft(discount.ctx, discount.program.templateId, draft.versionNumber)).rejects.toThrow(/tier|rate table/i);
    await updateMoneyDraftRateTable(discount.ctx, discount.program.templateId, [{ minCumulativeSpendMinor: 0, rateBasisPoints: 1250 }]);
    await expect(publishMoneyDraft(discount.ctx, discount.program.templateId, draft.versionNumber)).resolves.toEqual({
      publishedVersionNumber: 2,
      retiredVersionNumber: 1,
    });

    await expect(
      updateMoneyDraftRateTable(discount.ctx, discount.program.templateId, [{ minCumulativeSpendMinor: 0, rateBasisPoints: 1500 }]),
    ).rejects.toThrow(/no open draft/);
    const live = await prisma.programVersion.findFirstOrThrow({
      where: { templateId: discount.program.templateId, status: ProgramVersionStatus.ACTIVE },
      select: { status: true },
    });
    expect(live.status).toBe(ProgramVersionStatus.ACTIVE);
  });
});

describe("what this flow refuses to touch", () => {
  it("refuses a stamp or points program, rather than half-editing one", async () => {
    const { createStampCafe } = await import("../setup/fixtures");
    const cafe = await createStampCafe({ name: "Not money" });
    /*
     * `cafe.program.templateId`, not `cafe.templateId`. The first draft of this test used the latter,
     * which is `undefined` - and Prisma treats an `undefined` filter as ABSENT, so `findFirst` matched
     * the business's first template rather than none. The test passed, for a reason that had nothing
     * to do with what it claims to check.
     */
    await expect(createMoneyDraft(cafe.ctx, cafe.program.templateId)).rejects.toThrow(
      /not a cashback or discount program/i,
    );
  });

  it("refuses another business's program as if it did not exist", async () => {
    const other = await createMonetaryShop();
    await expect(createMoneyDraft(fx.ctx, other.program.templateId)).rejects.toThrow(/Program not found/);
  });
});
