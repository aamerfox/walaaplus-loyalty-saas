import { expect, test } from "@playwright/test";
import { prisma } from "@/server/db";
import { createStampCafe, TEST_PASSWORD, uniqueSyrianPhone } from "../setup/fixtures";
import { reconcileCardBalances } from "@/server/ledger/reconciliation";

/**
 * The whole Phase 1a café loop, in a browser, on a phone-sized viewport.
 *
 * Customer joins from a QR link → gets a card → cashier signs in, finds them by phone → awards
 * stamps → the card shows the new balance → the reward is redeemed.
 *
 * **Nothing here claims a camera scan.** The scanner's QR path is driven by putting a decoded
 * token into the field, which is exactly what the prompt permits and what the component supports
 * for pasted codes. A physical scan is a manual check, recorded in the evidence checklist.
 *
 * Data is seeded through the REAL services rather than SQL, so the journey starts from a café
 * that was created the way a merchant creates one.
 */

const STAMPS_PER_REWARD = 5;

test.describe("café loyalty loop", () => {
  test("a customer joins, is served at the counter, and collects a reward", async ({ page }) => {
    // ── seed: a café with a live stamp program ────────────────────────────────
    const cafe = await createStampCafe({
      mechanics: { stampsRequiredPerReward: STAMPS_PER_REWARD, rewardName: "قهوة مجانية" },
      name: "مقهى الاختبار",
    });
    const owner = await prisma.user.findUniqueOrThrow({ where: { id: cafe.userId }, select: { email: true } });
    const phone = uniqueSyrianPhone();
    const localPhone = `0${phone.slice(4)}`;

    // ── 1. the customer opens the café's public link and joins ────────────────
    await page.goto(`/ar/join/${cafe.program.directSourceToken}`);
    await expect(page.getByTestId("join-form")).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");

    await page.locator("#phone").fill(localPhone);
    await page.locator("#firstName").fill("ليلى");
    await page.getByTestId("join-submit").click();

    // ── 2. they land on their own card ────────────────────────────────────────
    await page.waitForURL(/\/ar\/card\/[A-Za-z0-9_-]{20,}/);
    const cardUrl = page.url();
    const shareToken = cardUrl.split("/card/")[1];

    await expect(page.getByTestId("card-qr")).toBeVisible();
    await expect(page.getByTestId("card-qr").locator("svg")).toHaveCount(1);
    await expect(page.getByTestId("card-progress")).toContainText("0");
    await expect(page.getByTestId("card-install")).toBeVisible();

    // The card page offers no staff action.
    await expect(page.getByTestId("scanner-award")).toHaveCount(0);
    await expect(page.getByTestId("scanner-redeem")).toHaveCount(0);

    // ── 3. the PWA foundation is actually served ──────────────────────────────
    const manifestResponse = await page.request.get(`/ar/card/${shareToken}/manifest.webmanifest`);
    expect(manifestResponse.status()).toBe(200);
    const manifest = (await manifestResponse.json()) as { id: string; display: string; icons: { src: string }[] };
    expect(manifest.id).toBe(`/ar/card/${shareToken}`);
    expect(manifest.display).toBe("standalone");

    const sw = await page.request.get("/sw.js");
    expect(sw.status()).toBe(200);
    // The worker must not be caching anything in this phase.
    expect(await sw.text()).not.toMatch(/caches\.open|cache\.put|addEventListener\(["']fetch/);

    for (const icon of manifest.icons) {
      const iconResponse = await page.request.get(icon.src);
      expect(iconResponse.status(), icon.src).toBe(200);
    }

    // ── 4. the cashier signs in through the public scanner login ──────────────
    await page.goto("/ar/scanner/login");
    await page.waitForURL(/\/auth\/login/);
    await page.locator('input[type="email"]').fill(owner.email);
    await page.locator('input[type="password"]').fill(TEST_PASSWORD);
    await page.locator('button[type="submit"]').click();

    // callbackUrl carried the cashier to the scanner rather than the dashboard.
    await page.waitForURL(/\/ar\/scanner(\?|$)/, { timeout: 30_000 });
    await expect(page.getByTestId("scanner-tab-phone")).toBeVisible();

    // ── 5. manual phone lookup, then an award ─────────────────────────────────
    await page.getByTestId("scanner-tab-phone").click();
    await page.getByTestId("scanner-phone-input").fill(localPhone);
    await page.getByTestId("scanner-phone-lookup").click();

    await expect(page.getByTestId("scanner-card")).toBeVisible();
    await expect(page.getByTestId("scanner-stamps")).toContainText("0");

    await page.getByTestId("scanner-quantity").fill(String(STAMPS_PER_REWARD));
    await page.getByTestId("scanner-award").click();

    // Crossing the threshold converts immediately and the reward appears.
    await expect(page.getByTestId("scanner-feedback")).toBeVisible();
    await expect(page.getByTestId("scanner-rewards")).toContainText("1");
    await expect(page.getByTestId("scanner-stamps")).toContainText("0");

    // ── 6. the customer's card reflects it ────────────────────────────────────
    await page.goto(cardUrl);
    await expect(page.getByTestId("card-reward-ready")).toBeVisible();
    await expect(page.getByTestId("card-reward-ready")).toContainText("قهوة مجانية");

    // ── 7. the reward is handed over ──────────────────────────────────────────
    await page.goto("/ar/scanner");
    await page.getByTestId("scanner-tab-phone").click();
    await page.getByTestId("scanner-phone-input").fill(localPhone);
    await page.getByTestId("scanner-phone-lookup").click();
    await expect(page.getByTestId("scanner-card")).toBeVisible();

    await page.getByTestId("scanner-redeem").click();
    await expect(page.getByTestId("scanner-rewards")).toContainText("0");

    await page.goto(cardUrl);
    await expect(page.getByTestId("card-reward-ready")).toHaveCount(0);

    // ── 8. the ledger and the projections still agree ─────────────────────────
    const report = await reconcileCardBalances({ businessId: cafe.businessId });
    expect(report.mismatches).toEqual([]);
  });

  test("the QR path works from a decoded token, and a stranger's token does not", async ({ page }) => {
    const cafe = await createStampCafe({ mechanics: { stampsRequiredPerReward: STAMPS_PER_REWARD } });
    const rival = await createStampCafe({ mechanics: { stampsRequiredPerReward: STAMPS_PER_REWARD } });
    const owner = await prisma.user.findUniqueOrThrow({ where: { id: cafe.userId }, select: { email: true } });

    // Two customers: one of this café, one of a different business.
    await page.goto(`/ar/join/${cafe.program.directSourceToken}`);
    await page.locator("#phone").fill(`0${uniqueSyrianPhone().slice(4)}`);
    await page.getByTestId("join-submit").click();
    await page.waitForURL(/\/ar\/card\//);
    const mineToken = page.url().split("/card/")[1];

    await page.goto(`/ar/join/${rival.program.directSourceToken}`);
    await page.locator("#phone").fill(`0${uniqueSyrianPhone().slice(4)}`);
    await page.getByTestId("join-submit").click();
    await page.waitForURL(/\/ar\/card\//);
    const rivalToken = page.url().split("/card/")[1];

    const mine = await prisma.customerCard.findFirstOrThrow({ where: { shareToken: mineToken }, select: { qrToken: true } });
    const theirs = await prisma.customerCard.findFirstOrThrow({ where: { shareToken: rivalToken }, select: { qrToken: true } });

    await page.goto("/ar/scanner/login");
    await page.waitForURL(/\/auth\/login/);
    await page.locator('input[type="email"]').fill(owner.email);
    await page.locator('input[type="password"]').fill(TEST_PASSWORD);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL(/\/ar\/scanner(\?|$)/, { timeout: 30_000 });

    // A decoded token pasted into the field: the same value a camera would have produced.
    await page.getByTestId("scanner-qr-input").fill(mine.qrToken);
    await page.getByTestId("scanner-qr-lookup").click();
    await expect(page.getByTestId("scanner-card")).toBeVisible();

    // The rival's real, valid token finds nothing here.
    await page.getByTestId("scanner-qr-input").fill(theirs.qrToken);
    await page.getByTestId("scanner-qr-lookup").click();
    await expect(page.getByTestId("scanner-feedback")).toBeVisible();
    await expect(page.getByTestId("scanner-card")).toHaveCount(0);
  });

  test("a card page cannot be reached by guessing, and refuses the scanner token", async ({ page }) => {
    const cafe = await createStampCafe();
    await page.goto(`/ar/join/${cafe.program.directSourceToken}`);
    await page.locator("#phone").fill(`0${uniqueSyrianPhone().slice(4)}`);
    await page.getByTestId("join-submit").click();
    await page.waitForURL(/\/ar\/card\//);
    const token = page.url().split("/card/")[1];

    const card = await prisma.customerCard.findFirstOrThrow({ where: { shareToken: token }, select: { id: true, qrToken: true } });

    // The scanner token, the internal id, and an altered token all lead nowhere.
    for (const attempt of [card.qrToken, card.id, `${token}x`, token.slice(0, -1)]) {
      const response = await page.request.get(`/ar/card/${attempt}`);
      expect(response.status(), attempt).toBe(404);
    }
  });
});
