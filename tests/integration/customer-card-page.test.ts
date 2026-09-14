/**
 * Phase 1a Prompt 2 — the public customer card, its per-card manifest and its QR.
 *
 * The card URL is a capability: whoever holds it sees the card. So the tests here are mostly
 * about what a holder CANNOT reach from it — another card, an internal id, or the scanner.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { GET as manifestRoute } from "@/app/[locale]/card/[shareToken]/manifest.webmanifest/route";
import { getCardManifestView, getPublicCardView } from "@/server/customers/card-view";
import { prisma } from "@/server/db";
import { NotFoundError } from "@/server/errors";
import { qrModuleCount, qrSvg } from "@/server/qr";
import { awardManualStamps } from "@/server/stamp/engine";
import { createStampCafe, enrolCustomer, resetDatabase, uniqueSyrianPhone, type StampCafeFixture } from "../setup/fixtures";

async function manifest(shareToken: string, locale = "ar") {
  const res = await manifestRoute(new Request(`http://localhost:3000/${locale}/card/${shareToken}/manifest.webmanifest`), {
    params: Promise.resolve({ locale, shareToken }),
  });
  return { status: res.status, headers: Object.fromEntries(res.headers.entries()), body: res.status === 200 ? await res.json() : null };
}

describe("the public customer card", () => {
  let cafe: StampCafeFixture;
  let rival: StampCafeFixture;
  let card: { customerCardId: string; shareToken: string; qrToken: string; serialNumber: string };
  let rivalCard: { shareToken: string };

  beforeAll(async () => {
    await resetDatabase();
    cafe = await createStampCafe({ mechanics: { stampsRequiredPerReward: 5, rewardName: "قهوة مجانية" } });
    rival = await createStampCafe({ mechanics: { stampsRequiredPerReward: 8 } });
    card = await enrolCustomer(cafe, { phone: uniqueSyrianPhone(), firstName: "نور" });
    rivalCard = await enrolCustomer(rival);
  });

  describe("what it shows", () => {
    it("shows this card's program, progress and scanner token", async () => {
      await awardManualStamps(cafe.ctx, {
        customerCardId: card.customerCardId,
        quantity: 3,
        idempotencyKey: `c-${crypto.randomUUID()}`,
        source: "SCANNER",
      });

      const view = await getPublicCardView(card.shareToken);
      expect(view.businessName).toBeTruthy();
      expect(view.rewardName).toBe("قهوة مجانية");
      expect(view.stampBalance).toBe(3);
      expect(view.stampsRequiredPerReward).toBe(5);
      expect(view.stampsToNextReward).toBe(2);
      expect(view.rewardBalance).toBe(0);
      expect(view.customerFirstName).toBe("نور");
      expect(view.active).toBe(true);
      expect(view.expired).toBe(false);
      // The QR the holder shows at the counter is their own scanner token.
      expect(view.qrToken).toBe(card.qrToken);
    });

    it("carries no internal identifier of anything", async () => {
      const view = await getPublicCardView(card.shareToken);
      const dump = JSON.stringify(view);
      const row = await prisma.customerCard.findUniqueOrThrow({ where: { id: card.customerCardId } });
      for (const secret of [row.id, row.businessId, row.templateId, row.programVersionId, row.customerBusinessProfileId]) {
        expect(dump, secret).not.toContain(secret);
      }
      // Nor the page token itself, which is already in the URL and need not be echoed.
      expect(dump).not.toContain(card.shareToken);
    });

    it("reports a paused and an expired card as inactive", async () => {
      const paused = await enrolCustomer(cafe);
      await prisma.customerCard.update({ where: { id: paused.customerCardId }, data: { status: "PAUSED" } });
      const pausedView = await getPublicCardView(paused.shareToken);
      expect(pausedView.active).toBe(false);
      expect(pausedView.expired).toBe(false);

      const expired = await enrolCustomer(cafe);
      await prisma.customerCard.update({ where: { id: expired.customerCardId }, data: { expiresAt: new Date(Date.now() - 1000) } });
      const expiredView = await getPublicCardView(expired.shareToken);
      expect(expiredView.active).toBe(false);
      expect(expiredView.expired).toBe(true);
    });
  });

  describe("what it refuses", () => {
    it("cannot be opened with the SCANNER token", async () => {
      // The two secrets are drawn separately: scanning a card at the counter must not hand the
      // cashier the URL that opens it.
      await expect(getPublicCardView(card.qrToken)).rejects.toBeInstanceOf(NotFoundError);
    });

    it("refuses unknown, altered, truncated and empty tokens identically", async () => {
      for (const token of [
        "",
        "short",
        "not-a-real-token-but-long-enough-to-try",
        `${card.shareToken}x`,
        card.shareToken.slice(0, -1),
        card.shareToken.toUpperCase(),
      ]) {
        await expect(getPublicCardView(token), token).rejects.toBeInstanceOf(NotFoundError);
      }
    });

    it("refuses a deleted card", async () => {
      const doomed = await enrolCustomer(cafe);
      await prisma.customerCard.update({ where: { id: doomed.customerCardId }, data: { status: "DELETED" } });
      await expect(getPublicCardView(doomed.shareToken)).rejects.toBeInstanceOf(NotFoundError);
    });

    it("shows one card only: a rival's token resolves to the rival's own card, never this one", async () => {
      const mine = await getPublicCardView(card.shareToken);
      const theirs = await getPublicCardView(rivalCard.shareToken);
      expect(theirs.businessName).not.toBe(mine.businessName);
      expect(theirs.stampsRequiredPerReward).toBe(8);
      expect(theirs.qrToken).not.toBe(mine.qrToken);
    });
  });

  describe("the QR code", () => {
    it("encodes the scanner token as inline SVG, with no third party involved", async () => {
      const view = await getPublicCardView(card.shareToken);
      const svg = qrSvg(view.qrToken);
      expect(svg).toMatch(/^<svg/);
      // Nothing is fetched to render it: no <image>, no href, and the only URL in the document is
      // the SVG namespace itself, which is an identifier rather than an address.
      expect(svg).not.toMatch(/<image\b/i);
      expect(svg).not.toMatch(/href=/i);
      const urls = svg.match(/https?:\/\/[^"'\s>]+/g) ?? [];
      expect(urls).toEqual(["http://www.w3.org/2000/svg"]);
      expect(qrModuleCount(view.qrToken)).toBeGreaterThan(20);
      // Two different tokens produce two different symbols.
      expect(qrSvg(view.qrToken)).not.toBe(qrSvg(`${view.qrToken}x`));
    });
  });

  describe("the per-card manifest", () => {
    it("is scoped to this card, so three cards install as three apps", async () => {
      const mine = await manifest(card.shareToken);
      const theirs = await manifest(rivalCard.shareToken);

      expect(mine.status).toBe(200);
      expect(mine.headers["content-type"]).toMatch(/application\/manifest\+json/);
      expect(mine.body.id).toBe(`/ar/card/${card.shareToken}`);
      expect(mine.body.start_url).toBe(`/ar/card/${card.shareToken}`);
      expect(mine.body.scope).toBe(`/ar/card/${card.shareToken}`);
      expect(mine.body.display).toBe("standalone");
      expect(mine.body.dir).toBe("rtl");
      expect(mine.body.lang).toBe("ar");

      // Different card, different identity: not one shared app.
      expect(theirs.body.id).not.toBe(mine.body.id);
      expect(theirs.body.scope).not.toBe(mine.body.scope);
    });

    it("declares icons a browser will accept for installation", async () => {
      const { body } = await manifest(card.shareToken);
      const icons = body.icons as { src: string; sizes: string; type: string; purpose: string }[];
      expect(icons.map((i) => i.sizes)).toEqual(expect.arrayContaining(["192x192", "512x512"]));
      expect(icons.every((i) => i.type === "image/png")).toBe(true);
      expect(icons.some((i) => i.purpose === "maskable")).toBe(true);
    });

    it("follows the locale of the URL", async () => {
      const en = await manifest(card.shareToken, "en");
      expect(en.body.dir).toBe("ltr");
      expect(en.body.lang).toBe("en");
      expect(en.body.start_url).toBe(`/en/card/${card.shareToken}`);
    });

    it("carries nothing that changes or identifies the customer", async () => {
      const { body } = await manifest(card.shareToken);
      const dump = JSON.stringify(body);
      const view = await getPublicCardView(card.shareToken);
      expect(dump).not.toContain(view.qrToken);
      expect(dump).not.toContain(view.serialNumber);
      expect(dump).not.toContain(String(view.stampBalance === 0 ? "__never__" : view.customerFirstName));
      expect(Object.keys(await getCardManifestView(card.shareToken)).sort()).toEqual(["businessName", "programName"]);
    });

    it("404s for an unknown token", async () => {
      expect((await manifest("no-such-card-token-at-all")).status).toBe(404);
    });
  });
});
