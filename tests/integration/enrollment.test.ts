/**
 * Phase 1a — enrollment by Syrian phone number through a public direct link.
 *
 * The properties that matter here are the ones that cannot be repaired later: one person is one
 * customer, one card, and one welcome bonus, no matter how many times the form is submitted or
 * how many submissions land at the same instant.
 */
import { CardStatus, OperationKind, OperationSource, UnitType } from "@prisma/client";
import { beforeAll, describe, expect, it } from "vitest";
import { AuditAction } from "@/server/audit/audit";
import { prisma } from "@/server/db";
import { NotFoundError, ValidationError } from "@/server/errors";
import { enrollCustomer, getEnrollmentSourceView } from "@/server/customers/enrollment";
import { normalizeSyrianPhone } from "@/server/customers/phone";
import {
  createStampCafe,
  enrolCustomer,
  expectReconciled,
  resetDatabase,
  uniqueSyrianPhone,
  type StampCafeFixture,
} from "../setup/fixtures";

describe("customer enrollment", () => {
  let cafe: StampCafeFixture;
  /** A café whose direct link grants a welcome bonus. */
  let welcoming: StampCafeFixture;

  beforeAll(async () => {
    await resetDatabase();
    cafe = await createStampCafe({ mechanics: { stampsRequiredPerReward: 10 } });
    welcoming = await createStampCafe({ mechanics: { stampsRequiredPerReward: 10, welcomeStamps: 2 } });
  });

  describe("a first enrollment", () => {
    it("creates the customer, the profile and a card pinned to the active version", async () => {
      const phone = uniqueSyrianPhone();
      const result = await enrolCustomer(cafe, { phone, firstName: "سارة", lastName: "أحمد" });

      expect(result.created).toBe(true);
      expect(result.businessId).toBe(cafe.businessId);
      expect(result.programVersionId).toBe(cafe.program.programVersionId);

      const card = await prisma.customerCard.findUniqueOrThrow({
        where: { id: result.customerCardId },
        include: { profile: { include: { customer: true } } },
      });
      expect(card.status).toBe(CardStatus.ISSUED);
      expect(card.programVersionId).toBe(cafe.program.programVersionId);
      expect(card.utmSourceLinkId).toBe(cafe.program.directSourceId);
      expect(card.stampBalance).toBe(0);
      expect(card.profile.firstName).toBe("سارة");
      expect(card.profile.lastName).toBe("أحمد");
      // Names live on the per-business profile; the global identity is only the phone.
      expect(card.profile.customer.normalizedPhone).toBe(phone);
      expect(card.profile.utmSource).toBe("direct");
    });

    it("normalises the phone, so any spelling reaches the same customer", async () => {
      const local = "0955111222";
      const first = await enrolCustomer(cafe, { phone: local });
      const again = await enrolCustomer(cafe, { phone: "+963 955 111 222" });

      expect(again.created).toBe(false);
      expect(again.customerId).toBe(first.customerId);
      expect(again.customerCardId).toBe(first.customerCardId);
      expect(await prisma.customer.count({ where: { normalizedPhone: normalizeSyrianPhone(local) } })).toBe(1);
    });

    it("gives the card three independent opaque tokens", async () => {
      const result = await enrolCustomer(cafe);
      const { qrToken, shareToken, serialNumber, customerCardId, customerId } = result;

      expect(new Set([qrToken, shareToken, serialNumber]).size).toBe(3);
      for (const token of [qrToken, shareToken]) {
        expect(token).toMatch(/^[A-Za-z0-9_-]{32,}$/);
        // Nothing about the card, the customer, the business or the phone is recoverable from it.
        for (const secret of [customerCardId, customerId, cafe.businessId, result.templateId]) {
          expect(token).not.toContain(secret);
          expect(token).not.toContain(secret.replace(/-/g, ""));
        }
      }
      expect(serialNumber).toMatch(/^WP-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    });

    it("records issuance in the audit log, not in the ledger", async () => {
      const result = await enrolCustomer(cafe);

      // The ledger refuses zero-quantity rows, so issuance cannot be an operation. It is audited.
      expect(await prisma.loyaltyOperation.count({ where: { customerCardId: result.customerCardId } })).toBe(0);
      expect(await prisma.loyaltyOperation.count({ where: { kind: OperationKind.CARD_ISSUED } })).toBe(0);

      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { action: AuditAction.CARD_ISSUED, entityId: result.customerCardId },
      });
      expect(audit.businessId).toBe(cafe.businessId);
      expect(audit.actorUserId).toBeNull(); // the customer acted, not a staff member
      const metadata = JSON.stringify(audit.metadata);
      // Never the phone number, never any of the card's tokens.
      expect(metadata).not.toContain(result.qrToken);
      expect(metadata).not.toContain(result.shareToken);
      expect(metadata).not.toContain(result.serialNumber);
      const phone = (
        await prisma.customer.findUniqueOrThrow({ where: { id: result.customerId }, select: { normalizedPhone: true } })
      ).normalizedPhone;
      expect(metadata).not.toContain(phone);
    });
  });

  describe("repeat enrollment", () => {
    it("returns the existing card and writes nothing new", async () => {
      const phone = uniqueSyrianPhone();
      const first = await enrolCustomer(cafe, { phone, firstName: "First" });
      const operationsBefore = await prisma.loyaltyOperation.count({ where: { customerCardId: first.customerCardId } });

      const second = await enrolCustomer(cafe, { phone, firstName: "Second" });
      expect(second.created).toBe(false);
      expect(second.customerCardId).toBe(first.customerCardId);
      expect(second.qrToken).toBe(first.qrToken);
      expect(second.welcomeStampsGranted).toBe(0);
      expect(await prisma.loyaltyOperation.count({ where: { customerCardId: first.customerCardId } })).toBe(operationsBefore);
      expect(await prisma.customerCard.count({ where: { customerBusinessProfileId: first.customerBusinessProfileId } })).toBe(1);
    });

    it("does not let a second submission overwrite the stored name or consent", async () => {
      // Anyone can open a public enrollment form and type someone else's number.
      const phone = uniqueSyrianPhone();
      await enrolCustomer(cafe, { phone, firstName: "رنا", lastName: "خالد", marketingConsent: true, consentTextVersion: "v1" });
      await enrolCustomer(cafe, { phone, firstName: "Impostor", lastName: "Overwrite", marketingConsent: false });

      const profile = await prisma.customerBusinessProfile.findFirstOrThrow({
        where: { businessId: cafe.businessId, customer: { normalizedPhone: phone } },
      });
      expect(profile.firstName).toBe("رنا");
      expect(profile.lastName).toBe("خالد");
      expect(profile.marketingConsent).toBe(true);
      expect(profile.consentTextVersion).toBe("v1");
    });
  });

  describe("concurrent enrollment", () => {
    it("produces exactly one customer, one profile and one card", async () => {
      const phone = uniqueSyrianPhone();
      const attempts = 6;
      const results = await Promise.all(
        Array.from({ length: attempts }, (_, i) => enrolCustomer(cafe, { phone, firstName: `Racer ${i}` })),
      );

      // Exactly one caller issued the card; the rest found it.
      expect(results.filter((r) => r.created)).toHaveLength(1);
      expect(new Set(results.map((r) => r.customerCardId)).size).toBe(1);
      expect(new Set(results.map((r) => r.customerId)).size).toBe(1);

      expect(await prisma.customer.count({ where: { normalizedPhone: phone } })).toBe(1);
      expect(
        await prisma.customerBusinessProfile.count({ where: { businessId: cafe.businessId, customer: { normalizedPhone: phone } } }),
      ).toBe(1);
      expect(await prisma.customerCard.count({ where: { profile: { customer: { normalizedPhone: phone } } } })).toBe(1);
    });

    it("grants the welcome bonus exactly once under a concurrent burst", async () => {
      const phone = uniqueSyrianPhone();
      const results = await Promise.all(Array.from({ length: 6 }, () => enrolCustomer(welcoming, { phone })));

      const cardId = results[0].customerCardId;
      expect(new Set(results.map((r) => r.customerCardId)).size).toBe(1);
      expect(results.filter((r) => r.welcomeStampsGranted > 0)).toHaveLength(1);

      const welcomeRows = await prisma.loyaltyOperation.findMany({
        where: { customerCardId: cardId, kind: OperationKind.WELCOME_BONUS },
      });
      expect(welcomeRows).toHaveLength(1);
      expect(welcomeRows[0].quantity).toBe(2);

      const card = await prisma.customerCard.findUniqueOrThrow({ where: { id: cardId } });
      expect(card.stampBalance).toBe(2);
      await expectReconciled(welcoming.businessId);
    });
  });

  describe("the welcome bonus", () => {
    it("is written through the ledger as an enrollment bonus that is not a visit", async () => {
      const result = await enrolCustomer(welcoming);
      expect(result.welcomeStampsGranted).toBe(2);
      expect(result.stampBalance).toBe(2);

      const rows = await prisma.loyaltyOperation.findMany({ where: { customerCardId: result.customerCardId } });
      expect(rows).toHaveLength(1);
      const row = rows[0];
      expect(row.kind).toBe(OperationKind.WELCOME_BONUS);
      expect(row.unitType).toBe(UnitType.STAMP);
      expect(row.quantity).toBe(2);
      expect(row.balanceAfter).toBe(2);
      expect(row.source).toBe(OperationSource.ENROLLMENT);
      // A welcome bonus is never a visit: nobody came in (PRODUCT-SPEC §5.4).
      expect(row.countsAsVisit).toBe(false);
      // No staff member was involved.
      expect(row.performedByUserId).toBeNull();

      // The system write is traceable through the audit log the ledger requires of it.
      const audit = await prisma.auditLog.findFirst({
        where: { action: AuditAction.LEDGER_SYSTEM_GROUP_APPENDED, entityId: row.transactionGroupId },
      });
      expect(audit).not.toBeNull();
      await expectReconciled(welcoming.businessId);
    });

    it("is absent when the program does not configure one", async () => {
      const result = await enrolCustomer(cafe);
      expect(result.welcomeStampsGranted).toBe(0);
      expect(result.stampBalance).toBe(0);
      expect(await prisma.loyaltyOperation.count({ where: { customerCardId: result.customerCardId } })).toBe(0);
    });
  });

  describe("one person, two businesses", () => {
    it("keeps two separate profiles and cards, with no cross-tenant visibility", async () => {
      const phone = uniqueSyrianPhone();
      const here = await enrolCustomer(cafe, { phone, firstName: "Same Person" });
      const there = await enrolCustomer(welcoming, { phone, firstName: "Same Person" });

      // One global identity.
      expect(here.customerId).toBe(there.customerId);
      expect(await prisma.customer.count({ where: { normalizedPhone: phone } })).toBe(1);

      // Two independent memberships of that identity.
      expect(here.customerBusinessProfileId).not.toBe(there.customerBusinessProfileId);
      expect(here.customerCardId).not.toBe(there.customerCardId);
      expect(here.businessId).not.toBe(there.businessId);

      // Neither business can see the other's card, even knowing the phone number.
      const cafeCards = await prisma.customerCard.findMany({
        where: { businessId: cafe.businessId, profile: { customer: { normalizedPhone: phone } } },
      });
      expect(cafeCards).toHaveLength(1);
      expect(cafeCards[0].id).toBe(here.customerCardId);

      // And the balances are independent: the welcome bonus belongs to one of them only.
      expect(here.stampBalance).toBe(0);
      expect(there.stampBalance).toBe(2);
    });
  });

  describe("refusals", () => {
    it("refuses an unparseable or foreign phone number before touching the database", async () => {
      const before = await prisma.customer.count();
      for (const phone of ["", "abc", "0112345678", "+971501234567", "12345"]) {
        await expect(enrolCustomer(cafe, { phone })).rejects.toBeInstanceOf(ValidationError);
      }
      expect(await prisma.customer.count()).toBe(before);
    });

    it("refuses an unknown, inactive or foreign enrollment token, all the same way", async () => {
      await expect(enrollCustomer({ sourceToken: "not-a-real-token", phone: uniqueSyrianPhone() })).rejects.toBeInstanceOf(
        NotFoundError,
      );
      await expect(enrollCustomer({ sourceToken: "", phone: uniqueSyrianPhone() })).rejects.toBeInstanceOf(NotFoundError);

      const paused = await createStampCafe();
      await prisma.utmSourceLink.update({ where: { id: paused.program.directSourceId }, data: { active: false } });
      await expect(enrolCustomer(paused)).rejects.toBeInstanceOf(NotFoundError);
    });

    it("refuses enrollment into an archived program", async () => {
      const archived = await createStampCafe();
      await prisma.programTemplate.update({ where: { id: archived.program.templateId }, data: { status: "ARCHIVED" } });
      await expect(enrolCustomer(archived)).rejects.toBeInstanceOf(NotFoundError);
    });

    it("refuses an over-long name", async () => {
      await expect(enrolCustomer(cafe, { firstName: "x".repeat(81) })).rejects.toBeInstanceOf(ValidationError);
    });
  });

  describe("the public enrollment page's view", () => {
    it("shows the offer and nothing else", async () => {
      const view = await getEnrollmentSourceView(welcoming.program.directSourceToken);
      expect(view.stampsRequiredPerReward).toBe(10);
      expect(view.welcomeStamps).toBe(2);
      expect(view.rewardName).toBeTruthy();
      expect(view.businessName).toBeTruthy();
      // No ids, no tokens, no customer data.
      expect(JSON.stringify(view)).not.toContain(welcoming.businessId);
      expect(JSON.stringify(view)).not.toContain(welcoming.program.directSourceToken);
    });

    it("refuses an unknown token", async () => {
      await expect(getEnrollmentSourceView("nope-nope-nope")).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  it("leaves the ledger and the projections in agreement", async () => {
    await expectReconciled(cafe.businessId);
    await expectReconciled(welcoming.businessId);
  });
});
