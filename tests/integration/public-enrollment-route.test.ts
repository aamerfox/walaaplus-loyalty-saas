/**
 * Phase 1a Prompt 2 — the public enrollment endpoint.
 *
 * The only public write in the product, so the tests are about what it refuses and what it
 * declines to reveal as much as about what it creates.
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { POST } from "@/app/api/enroll/route";
import { HONEYPOT_FIELD } from "@/app/api/enroll/route";
import { prisma } from "@/server/db";
import { env } from "@/server/env";
import { createStampCafe, expectReconciled, resetDatabase, uniqueSyrianPhone, type StampCafeFixture } from "../setup/fixtures";

interface Answer {
  status: number;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

async function post(body: unknown, headers: Record<string, string> = {}): Promise<Answer> {
  const res = await POST(
    new Request("http://localhost:3000/api/enroll", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
  );
  return {
    status: res.status,
    body: (await res.json()) as Record<string, unknown>,
    headers: Object.fromEntries(res.headers.entries()),
  };
}

describe("POST /api/enroll", () => {
  let cafe: StampCafeFixture;
  let welcoming: StampCafeFixture;

  beforeAll(async () => {
    await resetDatabase();
    cafe = await createStampCafe({ mechanics: { stampsRequiredPerReward: 10 } });
    welcoming = await createStampCafe({ mechanics: { stampsRequiredPerReward: 10, welcomeStamps: 2 } });
  });

  beforeEach(async () => {
    // Each test gets the full enrollment allowance; the limiter has its own tests below.
    await prisma.authRateLimit.deleteMany({});
  });

  describe("a valid link", () => {
    it("creates exactly one card and returns only its page token", async () => {
      const phone = uniqueSyrianPhone();
      const answer = await post({ sourceToken: cafe.program.directSourceToken, phone, firstName: "سامر" });

      expect(answer.status).toBe(200);
      expect(Object.keys(answer.body)).toEqual(["cardToken"]);
      const cardToken = String(answer.body.cardToken);

      const card = await prisma.customerCard.findFirstOrThrow({
        where: { shareToken: cardToken },
        include: { profile: { include: { customer: true } } },
      });
      expect(card.businessId).toBe(cafe.businessId);
      expect(card.programVersionId).toBe(cafe.program.programVersionId);
      expect(card.profile.customer.normalizedPhone).toBe(phone);
      expect(await prisma.customerCard.count({ where: { profile: { customer: { normalizedPhone: phone } } } })).toBe(1);

      // The response is the page token, never the scanner token and never an internal id.
      expect(cardToken).not.toBe(card.qrToken);
      const dump = JSON.stringify(answer.body);
      for (const secret of [card.id, card.businessId, card.customerBusinessProfileId, card.qrToken, phone]) {
        expect(dump).not.toContain(secret);
      }
    });

    it("grants a configured welcome bonus once", async () => {
      const phone = uniqueSyrianPhone();
      const first = await post({ sourceToken: welcoming.program.directSourceToken, phone });
      const again = await post({ sourceToken: welcoming.program.directSourceToken, phone });

      expect(first.status).toBe(200);
      expect(again.body.cardToken).toBe(first.body.cardToken);

      const card = await prisma.customerCard.findFirstOrThrow({ where: { shareToken: String(first.body.cardToken) } });
      expect(card.stampBalance).toBe(2);
      expect(await prisma.loyaltyOperation.count({ where: { customerCardId: card.id, kind: "WELCOME_BONUS" } })).toBe(1);
      await expectReconciled(welcoming.businessId);
    });

    it("answers a repeat enrollment exactly like a first one", async () => {
      const phone = uniqueSyrianPhone();
      const first = await post({ sourceToken: cafe.program.directSourceToken, phone, firstName: "First" });
      const repeat = await post({ sourceToken: cafe.program.directSourceToken, phone, firstName: "Second" });

      // Same status, same keys, same token: nothing here says "you were already a customer".
      expect(repeat.status).toBe(first.status);
      expect(Object.keys(repeat.body)).toEqual(Object.keys(first.body));
      expect(repeat.body.cardToken).toBe(first.body.cardToken);
      expect(await prisma.customerCard.count({ where: { profile: { customer: { normalizedPhone: phone } } } })).toBe(1);
    });

    it("normalises the phone, so two spellings reach one card", async () => {
      const local = "0955887766";
      const a = await post({ sourceToken: cafe.program.directSourceToken, phone: local });
      const b = await post({ sourceToken: cafe.program.directSourceToken, phone: "+963 955 887 766" });
      expect(b.body.cardToken).toBe(a.body.cardToken);
      expect(await prisma.customer.count({ where: { normalizedPhone: "+963955887766" } })).toBe(1);
    });
  });

  describe("tokens it refuses", () => {
    it("refuses unknown, empty, altered and inactive links the same way", async () => {
      const before = await prisma.customerCard.count();
      const good = cafe.program.directSourceToken;

      const attempts = [
        "",
        "short",
        "definitely-not-a-token-at-all-but-long",
        `${good}x`, // altered by one character
        good.slice(0, -1),
        good.toUpperCase(),
      ];
      for (const sourceToken of attempts) {
        const answer = await post({ sourceToken, phone: uniqueSyrianPhone() });
        expect(answer.status, sourceToken).toBe(404);
        expect(JSON.stringify(answer.body)).not.toContain(cafe.businessId);
      }
      expect(await prisma.customerCard.count()).toBe(before);
    });

    it("refuses a deactivated link and an archived program", async () => {
      const paused = await createStampCafe();
      await prisma.utmSourceLink.update({ where: { id: paused.program.directSourceId }, data: { active: false } });
      expect((await post({ sourceToken: paused.program.directSourceToken, phone: uniqueSyrianPhone() })).status).toBe(404);

      const archived = await createStampCafe();
      await prisma.programTemplate.update({ where: { id: archived.program.templateId }, data: { status: "ARCHIVED" } });
      expect((await post({ sourceToken: archived.program.directSourceToken, phone: uniqueSyrianPhone() })).status).toBe(404);
    });

    it("cannot be pointed at another business by naming one", async () => {
      // The body carries a rival's ids; the token still decides, and the ids are ignored.
      const rival = await createStampCafe();
      const phone = uniqueSyrianPhone();
      const answer = await post({
        sourceToken: cafe.program.directSourceToken,
        phone,
        businessId: rival.businessId,
        templateId: rival.program.templateId,
        programVersionId: rival.program.programVersionId,
      });

      expect(answer.status).toBe(200);
      const card = await prisma.customerCard.findFirstOrThrow({ where: { shareToken: String(answer.body.cardToken) } });
      expect(card.businessId).toBe(cafe.businessId);
      expect(await prisma.customerCard.count({ where: { businessId: rival.businessId } })).toBe(0);
    });

    it("refuses a body that names a location, writing nothing", async () => {
      const before = await prisma.customerCard.count();
      for (const body of [
        { sourceToken: cafe.program.directSourceToken, phone: uniqueSyrianPhone(), locationId: cafe.locationId },
        { sourceToken: cafe.program.directSourceToken, phone: uniqueSyrianPhone(), location: "Main" },
        { sourceToken: cafe.program.directSourceToken, phone: uniqueSyrianPhone(), nested: { locationId: cafe.locationId } },
      ]) {
        const answer = await post(body);
        expect(answer.status).toBe(400);
      }
      expect(await prisma.customerCard.count()).toBe(before);
    });
  });

  describe("bad input", () => {
    it("refuses an unusable phone number without creating anything", async () => {
      const before = await prisma.customer.count();
      for (const phone of ["", "abc", "0112345678", "+971501234567"]) {
        expect((await post({ sourceToken: cafe.program.directSourceToken, phone })).status).toBe(400);
      }
      expect(await prisma.customer.count()).toBe(before);
    });

    it("refuses a non-JSON body", async () => {
      const res = await POST(
        new Request("http://localhost:3000/api/enroll", { method: "POST", headers: { "content-type": "application/json" }, body: "{" }),
      );
      expect(res.status).toBe(400);
    });
  });

  describe("the honeypot", () => {
    it("refuses a filled honeypot and creates nothing", async () => {
      const phone = uniqueSyrianPhone();
      const answer = await post({ sourceToken: cafe.program.directSourceToken, phone, [HONEYPOT_FIELD]: "https://spam.example" });

      expect(answer.status).toBe(400);
      expect(await prisma.customer.count({ where: { normalizedPhone: phone } })).toBe(0);
    });

    it("says nothing about why it failed, or about the customer", async () => {
      const existing = uniqueSyrianPhone();
      await post({ sourceToken: cafe.program.directSourceToken, phone: existing });

      // A bot filling the honeypot for a KNOWN customer and for a stranger gets identical answers.
      const known = await post({ sourceToken: cafe.program.directSourceToken, phone: existing, [HONEYPOT_FIELD]: "x" });
      const stranger = await post({ sourceToken: cafe.program.directSourceToken, phone: uniqueSyrianPhone(), [HONEYPOT_FIELD]: "x" });

      expect(known.status).toBe(stranger.status);
      expect(known.body).toEqual(stranger.body);
      expect(JSON.stringify(known.body)).not.toMatch(/honeypot|bot|spam|companyWebsite/i);
    });

    it("is not required to be present for a genuine submission", async () => {
      const answer = await post({ sourceToken: cafe.program.directSourceToken, phone: uniqueSyrianPhone() });
      expect(answer.status).toBe(200);
    });
  });

  describe("the rate limit", () => {
    it("refuses once the per-link window is exhausted, generically", async () => {
      const link = await createStampCafe();
      const max = env().ENROLL_RATE_LIMIT_LINK_MAX;
      // Drive the LINK window to its limit directly; the route's own consumption is asserted below.
      const { consumeEnrollmentLimit } = await import("@/server/security/rate-limit");
      for (let i = 0; i < max; i++) await consumeEnrollmentLimit(null, link.program.directSourceToken);

      const answer = await post({ sourceToken: link.program.directSourceToken, phone: uniqueSyrianPhone() });
      expect(answer.status).toBe(429);
      expect(answer.headers["retry-after"]).toMatch(/^\d+$/);
      const dump = JSON.stringify(answer.body);
      expect(dump).toContain("Too many attempts");
      // Nothing about which window tripped, or about any customer.
      expect(dump).not.toContain(link.program.directSourceToken);
      expect(dump).not.toContain(link.businessId);
    });

    it("counts real enrollments against the window", async () => {
      const link = await createStampCafe();
      await post({ sourceToken: link.program.directSourceToken, phone: uniqueSyrianPhone() });
      const rows = await prisma.authRateLimit.findMany({ where: { scope: "enroll.link" } });
      expect(rows).toHaveLength(1);
      expect(rows[0].attempts).toBe(1);
    });

    it("counts a honeypot attempt too, so a bot pays for being caught", async () => {
      const link = await createStampCafe();
      await post({ sourceToken: link.program.directSourceToken, phone: uniqueSyrianPhone(), [HONEYPOT_FIELD]: "x" });
      const rows = await prisma.authRateLimit.findMany({ where: { scope: "enroll.link" } });
      expect(rows).toHaveLength(1);
      expect(rows[0].attempts).toBe(1);
    });
  });

  it("leaves the ledger and the projections in agreement", async () => {
    await expectReconciled(cafe.businessId);
    await expectReconciled(welcoming.businessId);
  });
});
