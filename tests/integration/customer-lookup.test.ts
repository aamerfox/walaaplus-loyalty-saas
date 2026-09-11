/**
 * Phase 1a — finding a customer at the counter, and reading their history.
 *
 * The property under test throughout is tenant isolation: a business must not resolve or list
 * another business's customer, card or operation even when it holds a valid phone number, QR
 * token or serial. A merchant who can tell "not found" from "forbidden" can use a competitor's
 * QR code to confirm that a person is their customer.
 */
import { randomUUID } from "node:crypto";
import { MembershipRole, OperationKind, OperationSource, UnitType } from "@prisma/client";
import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { ForbiddenError, NotFoundError } from "@/server/errors";
import { findCardByQrToken, findCardBySerial, findCardsByPhone, listCardOperations, listCustomers } from "@/server/customers/lookup";
import { awardManualStamps } from "@/server/stamp/engine";
import {
  createStaff,
  createStampCafe,
  enrolCustomer,
  ownerCtx,
  resetDatabase,
  uniqueSyrianPhone,
  type StampCafeFixture,
} from "../setup/fixtures";

const key = () => `k-${randomUUID()}`;

describe("customer lookup", () => {
  let cafe: StampCafeFixture;
  let rival: StampCafeFixture;
  /** One person who is a customer of BOTH businesses. */
  let sharedPhone: string;
  let hereCard: { customerCardId: string; qrToken: string; shareToken: string; serialNumber: string };
  let thereCard: { customerCardId: string; qrToken: string; serialNumber: string };

  beforeAll(async () => {
    await resetDatabase();
    cafe = await createStampCafe({ mechanics: { stampsRequiredPerReward: 10 } });
    rival = await createStampCafe({ mechanics: { stampsRequiredPerReward: 5 } });

    sharedPhone = uniqueSyrianPhone();
    hereCard = await enrolCustomer(cafe, { phone: sharedPhone, firstName: "ليلى", lastName: "حسن" });
    thereCard = await enrolCustomer(rival, { phone: sharedPhone, firstName: "ليلى", lastName: "حسن" });

    await awardManualStamps(cafe.ctx, {
      customerCardId: hereCard.customerCardId,
      quantity: 4,
      idempotencyKey: key(),
      source: OperationSource.SCANNER,
    });
  });

  describe("by QR token", () => {
    it("finds the card and what the counter needs to know", async () => {
      const found = await findCardByQrToken(cafe.ctx, hereCard.qrToken);
      expect(found.customerCardId).toBe(hereCard.customerCardId);
      expect(found.firstName).toBe("ليلى");
      expect(found.stampBalance).toBe(4);
      expect(found.stampsRequiredPerReward).toBe(10);
      expect(found.stampsToNextReward).toBe(6);
      expect(found.phone).toBe(`+963 ${sharedPhone.slice(4, 7)} ${sharedPhone.slice(7, 10)} ${sharedPhone.slice(10)}`);
    });

    it("refuses another business's QR token as simply not found", async () => {
      // The rival holds a real, valid token — for a card in a different business.
      await expect(findCardByQrToken(cafe.ctx, thereCard.qrToken)).rejects.toBeInstanceOf(NotFoundError);
      await expect(findCardByQrToken(rival.ctx, hereCard.qrToken)).rejects.toBeInstanceOf(NotFoundError);
    });

    it("refuses a card-page token used as a scan token", async () => {
      // The two secrets are separate on purpose: seeing a card page is not permission to scan it.
      await expect(findCardByQrToken(cafe.ctx, hereCard.shareToken)).rejects.toBeInstanceOf(NotFoundError);
    });

    it("refuses nonsense without leaking whether anything matched", async () => {
      for (const token of ["", "short", "definitely-not-a-token-but-long-enough"]) {
        await expect(findCardByQrToken(cafe.ctx, token)).rejects.toBeInstanceOf(NotFoundError);
      }
    });
  });

  describe("by phone", () => {
    it("finds the customer from any spelling of their number", async () => {
      const local = `0${sharedPhone.slice(4)}`;
      for (const spelling of [sharedPhone, local, `+963 ${sharedPhone.slice(4, 7)} ${sharedPhone.slice(7)}`]) {
        const found = await findCardsByPhone(cafe.ctx, spelling);
        expect(found, spelling).toHaveLength(1);
        expect(found[0].customerCardId).toBe(hereCard.customerCardId);
      }
    });

    it("returns only this business's card for a person enrolled in two", async () => {
      const here = await findCardsByPhone(cafe.ctx, sharedPhone);
      const there = await findCardsByPhone(rival.ctx, sharedPhone);

      expect(here).toHaveLength(1);
      expect(there).toHaveLength(1);
      expect(here[0].customerCardId).toBe(hereCard.customerCardId);
      expect(there[0].customerCardId).toBe(thereCard.customerCardId);
      // Balances are independent: the rival sees none of this café's stamps.
      expect(here[0].stampBalance).toBe(4);
      expect(there[0].stampBalance).toBe(0);
    });

    it("returns nothing for a stranger, and for an unparseable query", async () => {
      expect(await findCardsByPhone(cafe.ctx, uniqueSyrianPhone())).toEqual([]);
      expect(await findCardsByPhone(cafe.ctx, "not a phone")).toEqual([]);
      expect(await findCardsByPhone(cafe.ctx, "0944")).toEqual([]);
    });
  });

  describe("by serial", () => {
    it("finds the card, case-insensitively", async () => {
      const found = await findCardBySerial(cafe.ctx, hereCard.serialNumber.toLowerCase());
      expect(found.customerCardId).toBe(hereCard.customerCardId);
    });

    it("refuses another business's serial", async () => {
      await expect(findCardBySerial(cafe.ctx, thereCard.serialNumber)).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe("the customer directory", () => {
    it("lists this business's customers only", async () => {
      const page = await listCustomers(cafe.ctx);
      expect(page.items.length).toBeGreaterThanOrEqual(1);
      expect(page.items.some((i) => i.customerCardId === hereCard.customerCardId)).toBe(true);
      const ids = page.items.map((i) => i.customerBusinessProfileId);
      // Nothing from the rival business appears, though the same person is in both.
      const rivalProfiles = await prisma.customerBusinessProfile.findMany({
        where: { businessId: rival.businessId },
        select: { id: true },
      });
      for (const rivalProfile of rivalProfiles) expect(ids).not.toContain(rivalProfile.id);
    });

    it("searches by name and by phone", async () => {
      const byName = await listCustomers(cafe.ctx, { search: "ليلى" });
      expect(byName.items.some((i) => i.customerCardId === hereCard.customerCardId)).toBe(true);

      const byPhone = await listCustomers(cafe.ctx, { search: sharedPhone });
      expect(byPhone.items.some((i) => i.customerCardId === hereCard.customerCardId)).toBe(true);

      const noMatch = await listCustomers(cafe.ctx, { search: "nobody-by-this-name" });
      expect(noMatch.items).toEqual([]);
    });

    it("pages without repeating or skipping anyone", async () => {
      const many = await createStampCafe();
      for (let i = 0; i < 5; i++) await enrolCustomer(many, { firstName: `Customer ${i}` });

      const seen: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await listCustomers(many.ctx, { limit: 2, cursor });
        seen.push(...page.items.map((i) => i.customerBusinessProfileId));
        cursor = page.nextCursor ?? undefined;
      } while (cursor);

      expect(seen).toHaveLength(5);
      expect(new Set(seen).size).toBe(5);
    });

    it("is closed to a cashier, who may serve the person in front of them but not browse", async () => {
      const cashier = await createStaff(cafe, MembershipRole.CASHIER, [cafe.locationId]);
      await expect(listCustomers(cashier.ctx)).rejects.toBeInstanceOf(ForbiddenError);

      // The same cashier can still do their job.
      const scanned = await findCardByQrToken(cashier.ctx, hereCard.qrToken);
      expect(scanned.customerCardId).toBe(hereCard.customerCardId);
    });

    it("is open to a manager", async () => {
      const manager = await createStaff(cafe, MembershipRole.MANAGER, [cafe.locationId]);
      const page = await listCustomers(manager.ctx);
      expect(page.items.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("card history", () => {
    it("returns this card's operations, newest first", async () => {
      const page = await listCardOperations(cafe.ctx, hereCard.customerCardId);
      expect(page.items.length).toBeGreaterThanOrEqual(1);
      expect(page.items[0].kind).toBe("MANUAL_AWARD");
      expect(page.items[0].quantity).toBe(4);
      expect(page.items[0].balanceAfter).toBe(4);
      const times = page.items.map((i) => i.createdAt.getTime());
      expect([...times].sort((a, b) => b - a)).toEqual(times);
    });

    it("refuses another business's card as not found, rather than returning an empty list", async () => {
      // An empty list would confirm the id exists somewhere.
      await expect(listCardOperations(rival.ctx, hereCard.customerCardId)).rejects.toBeInstanceOf(NotFoundError);
      await expect(listCardOperations(cafe.ctx, thereCard.customerCardId)).rejects.toBeInstanceOf(NotFoundError);
    });

    it("narrows a cashier to their assigned locations", async () => {
      const otherLocation = await prisma.location.create({
        data: { businessId: cafe.businessId, name: "Second counter" },
      });

      /**
       * An operation at a counter this cashier is not assigned to.
       *
       * It is seeded directly rather than written through the engine, because Phase 1a's engine
       * refuses to write anywhere but Main — that restriction is asserted in stamp-engine.test.ts.
       * The narrowing logic still has to be correct for rows that DO exist at other locations:
       * imported history today, and multi-location programs from Phase 1b. The card projection is
       * moved by the same amount so reconciliation stays clean.
       */
      const card = await prisma.customerCard.findUniqueOrThrow({
        where: { id: hereCard.customerCardId },
        select: {
          businessId: true,
          templateId: true,
          programVersionId: true,
          customerBusinessProfileId: true,
          stampBalance: true,
          profile: { select: { customerId: true } },
        },
      });
      await prisma.loyaltyOperation.create({
        data: {
          transactionGroupId: randomUUID(),
          businessId: card.businessId,
          locationId: otherLocation.id,
          customerId: card.profile.customerId,
          customerBusinessProfileId: card.customerBusinessProfileId,
          customerCardId: hereCard.customerCardId,
          templateId: card.templateId,
          programVersionId: card.programVersionId,
          performedByUserId: cafe.userId,
          kind: OperationKind.MANUAL_AWARD,
          unitType: UnitType.STAMP,
          quantity: 1,
          balanceAfter: card.stampBalance + 1,
          countsAsVisit: true,
          source: OperationSource.DASHBOARD,
        },
      });
      await prisma.customerCard.update({
        where: { id: hereCard.customerCardId },
        data: { stampBalance: { increment: 1 } },
      });

      const owner = await listCardOperations(cafe.ctx, hereCard.customerCardId);
      const cashier = await createStaff(cafe, MembershipRole.CASHIER, [cafe.locationId]);
      const theirs = await listCardOperations(cashier.ctx, hereCard.customerCardId);

      // The owner sees every counter; the cashier sees only their own.
      expect(owner.items.some((o) => o.locationId === otherLocation.id)).toBe(true);
      expect(theirs.items.some((o) => o.locationId === otherLocation.id)).toBe(false);
      expect(theirs.items.every((o) => o.locationId === cafe.locationId)).toBe(true);
      expect(theirs.items.length).toBeLessThan(owner.items.length);
    });

    it("shows a cashier with no assignment nothing at all", async () => {
      const unassigned = await createStaff(cafe, MembershipRole.CASHIER, []);
      const page = await listCardOperations(unassigned.ctx, hereCard.customerCardId);
      // `locationIds: []` is a denial, never "unrestricted".
      expect(page.items).toEqual([]);
    });
  });

  describe("a foreign owner with real identifiers", () => {
    it("cannot reach this business's data by any path", async () => {
      const stranger = await ownerCtx(await createStampCafe());
      await expect(findCardByQrToken(stranger, hereCard.qrToken)).rejects.toBeInstanceOf(NotFoundError);
      await expect(findCardBySerial(stranger, hereCard.serialNumber)).rejects.toBeInstanceOf(NotFoundError);
      await expect(listCardOperations(stranger, hereCard.customerCardId)).rejects.toBeInstanceOf(NotFoundError);
      expect(await findCardsByPhone(stranger, sharedPhone)).toEqual([]);
      const page = await listCustomers(stranger);
      expect(page.items).toEqual([]);
    });
  });
});
