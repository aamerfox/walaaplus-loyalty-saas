/**
 * Staff-assisted enrolment and restore — owner decision B7, option 3.
 *
 * Public self-service enrolment is gone. A form that issues a live card to a number that has never
 * enrolled, and reveals nothing for a number that has, tells whoever submits it which case they
 * hit; only proof the submitter owns the number closes that, and Phase 1a has no channel to obtain
 * one. So enrolment moved behind a counter, where the person handing over a card can see who they
 * are handing it to.
 *
 * What has to hold here is everything the public route got right, plus the authorization it never
 * had. Only the SESSION is mocked; membership, permissions and the database are real.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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

import { POST as cardLinkRoute } from "@/app/api/scanner/card-link/route";
import { POST as enrollRoute } from "@/app/api/scanner/enroll/route";
import { AuditAction } from "@/server/audit/audit";
import { getPublicCardView } from "@/server/customers/card-view";
import { ENROLLMENT_CONSENT_VERSION } from "@/server/customers/consent";
import { prisma } from "@/server/db";
import {
  createCafeCashier,
  createStampCafe,
  expectReconciled,
  registerTestOwner,
  resetDatabase,
  uniqueSyrianPhone,
  type StampCafeFixture,
} from "../setup/fixtures";

interface Answer {
  status: number;
  body: Record<string, unknown>;
}

async function call(handler: (req: Request) => Promise<Response>, path: string, body: unknown): Promise<Answer> {
  const res = await handler(
    new Request(`http://localhost:3000${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const enroll = (body: unknown) => call(enrollRoute, "/api/scanner/enroll", body);
const revealLink = (body: unknown) => call(cardLinkRoute, "/api/scanner/card-link", body);

describe("POST /api/scanner/enroll", () => {
  let cafe: StampCafeFixture;

  beforeAll(async () => {
    await resetDatabase();
    cafe = await createStampCafe({ mechanics: { welcomeStamps: 2 } });
  });

  beforeEach(() => {
    session.userId = null;
  });

  it("creates one customer, one profile, one card and one welcome bonus", async () => {
    session.userId = cafe.userId;
    const phone = uniqueSyrianPhone();

    const answer = await enroll({ businessId: cafe.businessId, phone, firstName: "ليلى", marketingConsent: true });

    expect(answer.status).toBe(201);
    expect(answer.body.created).toBe(true);
    expect(answer.body.stampBalance).toBe(2);

    expect(await prisma.customer.count({ where: { normalizedPhone: phone } })).toBe(1);
    const cards = await prisma.customerCard.findMany({
      where: { businessId: cafe.businessId, profile: { customer: { normalizedPhone: phone } } },
      select: { id: true },
    });
    expect(cards).toHaveLength(1);
    expect(
      await prisma.loyaltyOperation.count({ where: { customerCardId: cards[0].id, kind: "WELCOME_BONUS" } }),
    ).toBe(1);
    await expectReconciled(cafe.businessId);
  });

  it("hands the staff member a working card link and its QR", async () => {
    // The counter equivalent of what the customer used to get on screen: something to show them
    // before they walk away.
    session.userId = cafe.userId;
    const answer = await enroll({ businessId: cafe.businessId, phone: uniqueSyrianPhone() });

    const url = String(answer.body.cardUrl);
    expect(url).toContain("/card/");
    await expect(getPublicCardView(url.split("/card/")[1])).resolves.toMatchObject({
      businessName: expect.any(String),
    });
    // Rendered on the server, fetching nothing: the only URL in the markup is the SVG namespace.
    const urls = String(answer.body.cardQrSvg).match(/https?:\/\/[^"' ]+/g) ?? [];
    expect(urls).toEqual(["http://www.w3.org/2000/svg"]);
  });

  it("records consent with its version and timestamp", async () => {
    session.userId = cafe.userId;
    const phone = uniqueSyrianPhone();
    await enroll({ businessId: cafe.businessId, phone, marketingConsent: true });

    const profile = await prisma.customerBusinessProfile.findFirstOrThrow({
      where: { businessId: cafe.businessId, customer: { normalizedPhone: phone } },
      select: { marketingConsent: true, consentTextVersion: true, privacyConsentAt: true },
    });
    expect(profile.marketingConsent).toBe(true);
    expect(profile.consentTextVersion).toBe(ENROLLMENT_CONSENT_VERSION);
    expect(profile.privacyConsentAt).toBeInstanceOf(Date);
  });

  it("does not create a second card or a second welcome bonus on a repeat", async () => {
    // A cashier who does not remember a regular can simply enrol them and find out.
    session.userId = cafe.userId;
    const phone = uniqueSyrianPhone();

    const first = await enroll({ businessId: cafe.businessId, phone, firstName: "ليلى" });
    const second = await enroll({ businessId: cafe.businessId, phone, firstName: "Someone else" });

    expect(first.status).toBe(201);
    expect(first.body.created).toBe(true);
    expect(second.status).toBe(200);
    expect(second.body.created).toBe(false);
    // Authorized staff may see the existing card — that is the restore path, not a leak.
    expect(second.body.cardUrl).toBe(first.body.cardUrl);

    const cards = await prisma.customerCard.findMany({
      where: { businessId: cafe.businessId, profile: { customer: { normalizedPhone: phone } } },
      select: { id: true, stampBalance: true },
    });
    expect(cards).toHaveLength(1);
    expect(cards[0].stampBalance).toBe(2);
    expect(
      await prisma.loyaltyOperation.count({ where: { customerCardId: cards[0].id, kind: "WELCOME_BONUS" } }),
    ).toBe(1);

    // And the repeat did not rename the customer.
    const profile = await prisma.customerBusinessProfile.findFirstOrThrow({
      where: { businessId: cafe.businessId, customer: { normalizedPhone: phone } },
      select: { firstName: true },
    });
    expect(profile.firstName).toBe("ليلى");
  });

  it("creates one card when two tills enrol the same number at once", async () => {
    session.userId = cafe.userId;
    const phone = uniqueSyrianPhone();

    const [a, b] = await Promise.all([
      enroll({ businessId: cafe.businessId, phone }),
      enroll({ businessId: cafe.businessId, phone }),
    ]);

    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect(a.body.cardUrl).toBe(b.body.cardUrl);
    expect(
      await prisma.customerCard.count({
        where: { businessId: cafe.businessId, profile: { customer: { normalizedPhone: phone } } },
      }),
    ).toBe(1);
  });

  it("lets a cashier enrol, because the cashier is who works the till", async () => {
    const cashier = await createCafeCashier(cafe);
    session.userId = cashier.userId;

    const answer = await enroll({ businessId: cafe.businessId, phone: uniqueSyrianPhone(), firstName: "زبون" });
    expect(answer.status).toBe(201);
  });

  it("refuses an anonymous caller", async () => {
    session.userId = null;
    const answer = await enroll({ phone: uniqueSyrianPhone() });
    expect([401, 403]).toContain(answer.status);
  });

  it("refuses a signed-in user from another business, and creates nothing", async () => {
    const stranger = await registerTestOwner();
    session.userId = stranger.userId;
    const phone = uniqueSyrianPhone();

    const answer = await enroll({ businessId: cafe.businessId, phone });

    expect(answer.status).toBe(403);
    expect(
      await prisma.customerCard.count({
        where: { businessId: cafe.businessId, profile: { customer: { normalizedPhone: phone } } },
      }),
    ).toBe(0);
    expect(JSON.stringify(answer.body)).not.toContain(cafe.program.directSourceToken);
  });

  it("accepts four fields and refuses anything else", async () => {
    session.userId = cafe.userId;
    for (const extra of [
      { sourceToken: cafe.program.directSourceToken },
      { locationId: cafe.locationId },
      { stampBalance: 99 },
      { welcomeStamps: 50 },
      { templateId: cafe.program.templateId },
    ]) {
      const answer = await enroll({ businessId: cafe.businessId, phone: uniqueSyrianPhone(), ...extra });
      expect(answer.status, `${JSON.stringify(extra)} must be refused`).toBe(400);
    }
  });

  it("writes an audit row carrying no phone, no name and no token", async () => {
    session.userId = cafe.userId;
    const phone = uniqueSyrianPhone();
    const answer = await enroll({ businessId: cafe.businessId, phone, firstName: "سارة" });
    const token = String(answer.body.cardUrl).split("/card/")[1];

    const entries = await prisma.auditLog.findMany({
      where: { businessId: cafe.businessId, action: AuditAction.CARD_ISSUED_AT_COUNTER },
    });
    expect(entries.length).toBeGreaterThan(0);
    const serialized = JSON.stringify(entries);
    expect(serialized).not.toContain(phone);
    expect(serialized).not.toContain("سارة");
    expect(serialized).not.toContain(token);
  });

  it("refuses when the business has no loyalty card yet", async () => {
    const fresh = await registerTestOwner();
    session.userId = fresh.userId;
    const answer = await enroll({ businessId: fresh.businessId, phone: uniqueSyrianPhone() });
    expect(answer.status).toBe(404);
  });
});

describe("POST /api/scanner/card-link — staff-assisted restore", () => {
  let cafe: StampCafeFixture;
  let customerCardId: string;
  let shareToken: string;

  beforeAll(async () => {
    await resetDatabase();
    cafe = await createStampCafe();
    session.userId = cafe.userId;
    const created = await enroll({ businessId: cafe.businessId, phone: uniqueSyrianPhone(), firstName: "ليلى" });
    customerCardId = String(created.body.customerCardId);
    shareToken = String(created.body.cardUrl).split("/card/")[1];
  });

  beforeEach(() => {
    session.userId = null;
  });

  it("gives staff the customer's own link and QR", async () => {
    session.userId = cafe.userId;
    const answer = await revealLink({ businessId: cafe.businessId, customerCardId });

    expect(answer.status).toBe(200);
    expect(String(answer.body.cardUrl)).toContain(shareToken);
    expect(String(answer.body.cardQrSvg)).toContain("<svg");
  });

  it("is available to a cashier, who is the one standing at the counter", async () => {
    const cashier = await createCafeCashier(cafe);
    session.userId = cashier.userId;
    expect((await revealLink({ businessId: cafe.businessId, customerCardId })).status).toBe(200);
  });

  it("is never available publicly", async () => {
    session.userId = null;
    const answer = await revealLink({ businessId: cafe.businessId, customerCardId });
    expect([401, 403]).toContain(answer.status);
    expect(JSON.stringify(answer.body)).not.toContain(shareToken);
  });

  it("refuses another business's card as not found, and leaks nothing", async () => {
    const stranger = await registerTestOwner();
    session.userId = stranger.userId;

    const answer = await revealLink({ businessId: stranger.businessId, customerCardId });
    expect([403, 404]).toContain(answer.status);
    expect(JSON.stringify(answer.body)).not.toContain(shareToken);
  });

  it("audits the reveal without storing the token or the URL", async () => {
    /*
     * The whole point of auditing this. `shareToken` OPENS the card, so writing it into an audit
     * row would put a live capability somewhere read by more people and kept far longer than the
     * screen that legitimately shows it.
     */
    session.userId = cafe.userId;
    await revealLink({ businessId: cafe.businessId, customerCardId });

    const entries = await prisma.auditLog.findMany({
      where: { businessId: cafe.businessId, action: AuditAction.CARD_LINK_REVEALED },
      select: { entityId: true, actorUserId: true, metadata: true },
    });
    expect(entries.length).toBeGreaterThan(0);

    // Who, and which card — enough to answer any question an audit needs to answer.
    expect(entries[0].entityId).toBe(customerCardId);
    expect(entries[0].actorUserId).toBe(cafe.userId);

    const serialized = JSON.stringify(entries);
    expect(serialized).not.toContain(shareToken);
    expect(serialized).not.toContain("/card/");
    expect(serialized).not.toContain("http");
  });
});
