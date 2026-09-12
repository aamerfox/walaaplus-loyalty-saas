import { CardType, MembershipRole, OperationSource, ProgramVersionStatus, TemplateStatus } from "@prisma/client";
import { beforeAll, describe, expect, it } from "vitest";
import { AuditAction } from "@/server/audit/audit";
import { prisma } from "@/server/db";
import { enrollAtCounter } from "@/server/customers/counter-enrollment";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/server/errors";
import { awardManualPoints } from "@/server/points/engine";
import { createPointsProgram, listBusinessPrograms } from "@/server/program/programs";
import { createSourceLink, listSourceLinks, setSourceLinkActive } from "@/server/program/source-links";
import { createStampProgram } from "@/server/program/stamp-program";
import {
  CAFE_MECHANICS,
  createPointsShop,
  createStaff,
  createStampCafe,
  enrolPointsCustomer,
  resetDatabase,
  SHOP_POINTS_MECHANICS,
  SHOP_TIERS,
  uniqueSyrianPhone,
} from "../setup/fixtures";

/**
 * Several programs per business, and the named sources that attribute cards to campaigns.
 *
 * The Phase 1a pilot rule — one live program per business — is lifted here, and the test that
 * matters most is the one proving it was NOT lifted for the caller that never asked: the Phase 1a
 * owner screen submits twice on a double-click, and it must still be handed the program that
 * already exists rather than a second one.
 */

const key = () => `k-${Math.random().toString(36).slice(2)}-${Date.now()}`;

describe("several programs per business", () => {
  beforeAll(async () => {
    await resetDatabase();
  });

  it("still refuses a second program to a caller that did not opt in", async () => {
    const cafe = await createStampCafe();

    // Exactly the Phase 1a contract: the double-click conflicts, and the route above turns that
    // 409 into "here is the program you already have".
    await expect(createStampProgram(cafe.ctx, { name: "Second try", mechanics: CAFE_MECHANICS })).rejects.toBeInstanceOf(
      ConflictError,
    );
    await expect(
      createPointsProgram(cafe.ctx, { name: "Points too", mechanics: SHOP_POINTS_MECHANICS, tiers: SHOP_TIERS }),
    ).rejects.toBeInstanceOf(ConflictError);

    expect(await prisma.programTemplate.count({ where: { businessId: cafe.businessId } })).toBe(1);
  });

  it("creates a second program when the caller asks for one", async () => {
    const cafe = await createStampCafe();
    const points = await createPointsProgram(cafe.ctx, {
      name: "Points card",
      mechanics: SHOP_POINTS_MECHANICS,
      tiers: SHOP_TIERS,
      allowAdditionalProgram: true,
    });

    const programs = await listBusinessPrograms(cafe.ctx);
    expect(programs).toHaveLength(2);
    expect(programs.map((p) => p.cardType).sort()).toEqual([CardType.POINTS, CardType.STAMP]);

    const listed = programs.find((p) => p.templateId === points.templateId);
    expect(listed?.tiers.map((t) => t.requiredPoints)).toEqual([10, 50]);
    expect(listed?.availableLocations).toBeNull();

    // A list is shown on a screen; a source token is a capability. It is not in there.
    const token = await prisma.utmSourceLink.findFirstOrThrow({
      where: { id: points.directSourceId },
      select: { publicToken: true },
    });
    expect(JSON.stringify(programs)).not.toContain(token.publicToken);
  });

  it("refuses two live programs with the same name", async () => {
    const cafe = await createStampCafe({ name: "Coffee club" });
    await expect(
      createPointsProgram(cafe.ctx, {
        name: "  coffee club  ",
        mechanics: SHOP_POINTS_MECHANICS,
        tiers: SHOP_TIERS,
        allowAdditionalProgram: true,
      }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("pins the card type and the mechanics of the version a card was issued under", async () => {
    const shop = await createPointsShop();
    const card = await enrolPointsCustomer(shop);

    const row = await prisma.customerCard.findUniqueOrThrow({
      where: { id: card.customerCardId },
      select: { programVersionId: true, template: { select: { cardType: true } } },
    });
    expect(row.programVersionId).toBe(shop.program.programVersionId);
    expect(row.template.cardType).toBe(CardType.POINTS);

    // The version is frozen: the database trigger refuses a change to a non-DRAFT version's
    // mechanics, so a merchant editing the program tomorrow cannot rewrite this card's rules.
    await expect(
      prisma.programVersion.update({
        where: { id: shop.program.programVersionId },
        data: { mechanics: { kind: "POINTS", contractVersion: 1, earnMode: "MANUAL" } },
      }),
    ).rejects.toThrow();
  });

  it("gives one customer one card per program, and never two on one", async () => {
    const cafe = await createStampCafe({ name: "Stamps" });
    const shop = await createPointsShop({
      existing: { userId: cafe.userId, businessId: cafe.businessId, locationId: cafe.locationId },
      name: "Points",
    });
    const phone = uniqueSyrianPhone();

    const a = await enrollAtCounter(cafe.ctx, { phone, templateId: cafe.program.templateId });
    const b = await enrollAtCounter(cafe.ctx, { phone, templateId: shop.program.templateId });
    const repeat = await enrollAtCounter(cafe.ctx, { phone, templateId: shop.program.templateId });

    expect(a.created).toBe(true);
    expect(b.created).toBe(true);
    expect(repeat.created).toBe(false);
    expect(repeat.customerCardId).toBe(b.customerCardId);
    expect(a.cardType).toBe(CardType.STAMP);
    expect(b.cardType).toBe(CardType.POINTS);

    const cards = await prisma.customerCard.count({ where: { businessId: cafe.businessId } });
    expect(cards).toBe(2);
  });

  it("makes the counter name a program when the business runs several, and refuses another tenant's", async () => {
    const cafe = await createStampCafe({ name: "Stamps" });
    const rival = await createStampCafe({ name: "Rival" });
    await createPointsShop({
      existing: { userId: cafe.userId, businessId: cafe.businessId, locationId: cafe.locationId },
      name: "Points",
    });

    // Ambiguous: two live programs and no choice made.
    await expect(enrollAtCounter(cafe.ctx, { phone: uniqueSyrianPhone() })).rejects.toBeInstanceOf(ValidationError);

    // Another business's template is "not available", the same answer as one that does not exist.
    await expect(
      enrollAtCounter(cafe.ctx, { phone: uniqueSyrianPhone(), templateId: rival.program.templateId }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("does not enrol into a paused program", async () => {
    const shop = await createPointsShop();
    await prisma.programTemplate.update({ where: { id: shop.program.templateId }, data: { status: TemplateStatus.PAUSED } });

    // PAUSED means "no new enrolment, existing cards keep working" (PRODUCT-SPEC §4).
    await expect(enrollAtCounter(shop.ctx, { phone: uniqueSyrianPhone() })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("refuses a points program a cashier tries to create, and one with a reward-sized welcome bonus", async () => {
    const cafe = await createStampCafe();
    const cashier = await createStaff(cafe, MembershipRole.CASHIER, [cafe.locationId]);

    await expect(
      createPointsProgram(cashier.ctx, { name: "Mine", mechanics: SHOP_POINTS_MECHANICS, tiers: SHOP_TIERS }),
    ).rejects.toBeInstanceOf(ForbiddenError);

    await expect(
      createPointsProgram(cafe.ctx, {
        name: "Too generous",
        mechanics: { ...SHOP_POINTS_MECHANICS, welcomePoints: 10 },
        tiers: [{ name: "Reward", requiredPoints: 10 }],
        allowAdditionalProgram: true,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("refuses two tiers with the same name, in the service and in the database", async () => {
    const cafe = await createStampCafe();

    await expect(
      createPointsProgram(cafe.ctx, {
        name: "Duplicated rewards",
        mechanics: SHOP_POINTS_MECHANICS,
        tiers: [
          { name: "Free coffee", requiredPoints: 10 },
          { name: "free coffee", requiredPoints: 20 },
        ],
        allowAdditionalProgram: true,
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    // And beneath the service, the unique index added by this phase's migration.
    const shop = await createPointsShop({
      existing: { userId: cafe.userId, businessId: cafe.businessId, locationId: cafe.locationId },
      name: "Real rewards",
    });
    const existing = await prisma.rewardTier.findFirstOrThrow({ where: { programVersionId: shop.program.programVersionId } });
    await expect(
      prisma.rewardTier.create({
        data: { programVersionId: shop.program.programVersionId, name: existing.name, requiredPoints: 999 },
      }),
    ).rejects.toThrow();
  });
});

describe("named source links", () => {
  beforeAll(async () => {
    await resetDatabase();
  });

  it("creates one, attributes cards to it, and never returns its token", async () => {
    const shop = await createPointsShop();

    const link = await createSourceLink(shop.ctx, {
      templateId: shop.program.templateId,
      name: "Instagram October",
      utmSource: "instagram",
      utmMedium: "social",
      utmCampaign: "october",
      welcomeUnitQuantity: 3,
    });
    expect(link.active).toBe(true);
    expect(link.cardCount).toBe(0);

    // B7 is binding: the token exists in the row and never leaves the server through this module.
    const stored = await prisma.utmSourceLink.findUniqueOrThrow({
      where: { id: link.id },
      select: { publicToken: true },
    });
    const listed = await listSourceLinks(shop.ctx, shop.program.templateId);
    expect(JSON.stringify([link, listed])).not.toContain(stored.publicToken);
    expect(Object.keys(link)).not.toContain("publicToken");

    // Attribution is a property of the data: point a card at the link and the count follows.
    const card = await enrolPointsCustomer(shop);
    await prisma.customerCard.update({ where: { id: card.customerCardId }, data: { utmSourceLinkId: link.id } });
    const after = await listSourceLinks(shop.ctx, shop.program.templateId);
    expect(after.find((l) => l.id === link.id)?.cardCount).toBe(1);

    const entry = await prisma.auditLog.findFirstOrThrow({
      where: { businessId: shop.businessId, action: AuditAction.SOURCE_LINK_CREATED },
      select: { metadata: true },
    });
    expect(JSON.stringify(entry.metadata)).not.toContain(stored.publicToken);
  });

  it("keeps names unique per program and refuses the reserved direct source", async () => {
    const shop = await createPointsShop();
    await createSourceLink(shop.ctx, { templateId: shop.program.templateId, name: "Flyers", utmSource: "print" });

    await expect(
      createSourceLink(shop.ctx, { templateId: shop.program.templateId, name: "Flyers", utmSource: "print" }),
    ).rejects.toBeInstanceOf(ConflictError);
    await expect(
      createSourceLink(shop.ctx, { templateId: shop.program.templateId, name: "Anything", utmSource: "direct" }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      createSourceLink(shop.ctx, { templateId: shop.program.templateId, name: "Direct", utmSource: "print" }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("is tenant-scoped in both directions", async () => {
    const mine = await createPointsShop({ name: "Mine" });
    const theirs = await createPointsShop({ name: "Theirs" });
    await createSourceLink(theirs.ctx, { templateId: theirs.program.templateId, name: "Theirs only", utmSource: "instagram" });

    // Cannot create a source on another business's program...
    await expect(
      createSourceLink(mine.ctx, { templateId: theirs.program.templateId, name: "Sneaky", utmSource: "instagram" }),
    ).rejects.toBeInstanceOf(NotFoundError);

    // ...cannot list theirs...
    const listed = await listSourceLinks(mine.ctx);
    expect(listed.every((l) => l.templateId === mine.program.templateId)).toBe(true);
    expect(listed.map((l) => l.name)).not.toContain("Theirs only");

    // ...and cannot switch theirs off.
    const theirLink = await prisma.utmSourceLink.findFirstOrThrow({
      where: { template: { businessId: theirs.businessId }, name: "Theirs only" },
      select: { id: true },
    });
    await expect(setSourceLinkActive(mine.ctx, theirLink.id, false)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("deactivates a campaign without touching the cards it brought, and never the direct source", async () => {
    const shop = await createPointsShop();
    const link = await createSourceLink(shop.ctx, {
      templateId: shop.program.templateId,
      name: "Ended campaign",
      utmSource: "instagram",
    });
    const card = await enrolPointsCustomer(shop);
    await prisma.customerCard.update({ where: { id: card.customerCardId }, data: { utmSourceLinkId: link.id } });

    await setSourceLinkActive(shop.ctx, link.id, false);
    const after = await listSourceLinks(shop.ctx, shop.program.templateId);
    const ended = after.find((l) => l.id === link.id);
    expect(ended?.active).toBe(false);
    // Attribution is history. It does not change because a campaign finished.
    expect(ended?.cardCount).toBe(1);

    // The direct source is how staff enrol; switching it off would be a program-wide outage.
    await expect(setSourceLinkActive(shop.ctx, shop.program.directSourceId, false)).rejects.toBeInstanceOf(ConflictError);

    // And counter enrolment still works, which is the point of that refusal.
    const enrolled = await enrollAtCounter(shop.ctx, { phone: uniqueSyrianPhone() });
    expect(enrolled.created).toBe(true);
    await awardManualPoints(shop.ctx, {
      customerCardId: enrolled.customerCardId,
      quantity: 1,
      idempotencyKey: key(),
      source: OperationSource.SCANNER,
    });
  });

  it("refuses a cashier creating or listing sources", async () => {
    const shop = await createPointsShop();
    const cashier = await createStaff(shop, MembershipRole.CASHIER, [shop.locationId]);

    await expect(
      createSourceLink(cashier.ctx, { templateId: shop.program.templateId, name: "Mine", utmSource: "instagram" }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(listSourceLinks(cashier.ctx)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("keeps every program's active version singular after all of this", async () => {
    const shop = await createPointsShop();
    const versions = await prisma.programVersion.count({
      where: { templateId: shop.program.templateId, status: ProgramVersionStatus.ACTIVE },
    });
    expect(versions).toBe(1);
  });
});
