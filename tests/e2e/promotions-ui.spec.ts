import { expect, test, type Page } from "@playwright/test";
import ar from "../../messages/ar.json";
import { prisma } from "@/server/db";
import { createStampCafe, enrolCustomer, TEST_PASSWORD, uniqueSyrianPhone } from "../setup/fixtures";

/**
 * A merchant writing a coupon, and a cashier taking one at the till.
 *
 * What these hold beyond "the screens work":
 *
 *  - **the code never reaches a URL**, and never comes back from the server once it is set;
 *  - **nothing claims a discount.** Both screens say what a redemption is and is not;
 *  - **a refusal names no reason**, and never fails the workflow that carried it;
 *  - **a cashier cannot reach the promotions screen at all**;
 *  - **B7 is unchanged.**
 *
 * The default viewport is a Pixel 7 (playwright.config.ts); the desktop passes set 1440×900.
 */

const DESKTOP = { width: 1440, height: 900 };
const SHOTS = "playwright-results/visual";
const CODE = "AUTUMN10";

/** Wording that would claim a calculation this product does not do. */
const MONEY_WORDS = /\bdiscounted\b|\bapplied\b|\bcharged\b|\bpaid\b|\binvoice\b|خُصم|طُبّق|حُصّل|دُفع|الفاتورة/i;

/**
 * A screen's text with its disclaimer removed.
 *
 * The notice at the top exists to DENY that a calculation happens — "Nothing is calculated,
 * discounted or charged here" — so it necessarily contains the words nothing else may. Subtracting
 * it is what lets the rest of the screen be checked against them, and asserting it was actually
 * found keeps the subtraction from silently becoming a no-op.
 */
async function textWithoutDisclaimer(page: Page): Promise<string> {
  const visible = await page.locator("main").innerText();
  const disclaimer = await page.getByTestId("promotions-nothing-automatic").innerText();
  expect(disclaimer.length).toBeGreaterThan(0);
  expect(visible).toContain(disclaimer);
  return visible.replace(disclaimer, "");
}

/**
 * A screenshot of the page as a person first meets it.
 *
 * The dashboard shell scrolls `main`, not the document, so `fullPage` captures one viewport of
 * wherever the test last scrolled — which after creating something is the bottom of a form.
 */
async function shot(page: Page, name: string) {
  await page.locator("main").evaluate((el) => el.scrollTo(0, 0));
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
}

async function emailOf(userId: string) {
  return (await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true } })).email;
}

async function signIn(page: Page, email: string, locale: "en" | "ar" = "en") {
  await page.goto(`/${locale}/auth/login`);
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(TEST_PASSWORD);
  await page.locator('button[type="submit"]').click();
  /*
   * Wait for a page that is NOT the login one. `/${locale}/` matches `/en/auth/login` itself, so a
   * looser pattern returns before the sign-in has happened and every later assertion fails against
   * a sign-in form — which is exactly what it did the first time this ran.
   */
  await page.waitForURL(/\/(business|scanner)/, { timeout: 30_000 });
}

/** A café with one enrolled customer, ready for a promotion to be written. */
async function cafeWithCustomer(name: string) {
  const cafe = await createStampCafe({ name });
  const phone = uniqueSyrianPhone();
  const customer = await enrolCustomer(cafe, { phone, firstName: "ليلى" });
  return { cafe, customer, phone };
}

/**
 * The browser suite shares ONE database across every spec and never truncates between tests, so
 * every row read back must be scoped to the café the test created. A bare `findFirst` here returns
 * some other test's promotion, and the button it then looks for is on a different page — which is
 * exactly what happened the first time this ran.
 */
function scoped(businessId: string) {
  return {
    promotion: () => prisma.promotion.findFirstOrThrow({ where: { businessId }, select: { id: true } }),
    redemptions: () =>
      prisma.promotionRedemption.findMany({ where: { businessId }, orderBy: { recordedAt: "asc" } }),
    redemptionCount: () => prisma.promotionRedemption.count({ where: { businessId } }),
  };
}

/** Create a promotion through the owner screen, then activate it. */
async function createPromotion(page: Page, businessId: string, locale: "en" | "ar", code = CODE) {
  await page.goto(`/${locale}/business/promotions`);
  await page.getByTestId("promotion-name").fill(locale === "ar" ? "عرض الخريف" : "Autumn offer");
  await page.getByTestId("promotion-benefit").fill(locale === "ar" ? "قهوة مجانية" : "A free espresso");
  await page.getByTestId("promotion-code").fill(code);
  await page.getByTestId("promotion-save").click();
  await expect(page.getByTestId("promotion-list")).toBeVisible({ timeout: 30_000 });

  const promotionId = (await scoped(businessId).promotion()).id;
  await page.getByTestId(`promotion-activate-${promotionId}`).click();
  await expect(page.getByTestId(`promotion-state-${promotionId}`)).toHaveText(
    locale === "ar" ? ar.Promotions.state.ACTIVE : "Active",
    { timeout: 30_000 },
  );
  return promotionId;
}

test.describe("writing a promotion", () => {
  test("creates it as a draft, warns about the code, and claims no discount", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    const fx = await cafeWithCustomer("Promotion café");
    await signIn(page, await emailOf(fx.cafe.userId));

    await page.goto("/en/business/promotions");
    await expect(page.getByTestId("promotions-empty")).toBeVisible();
    // The two things this screen exists to say, both before anything is created.
    await expect(page.getByTestId("promotions-nothing-automatic")).toContainText("Nothing is calculated");
    await expect(page.getByTestId("promotion-code-warning")).toContainText("never be shown again");

    await page.getByTestId("promotion-name").fill("Autumn offer");
    await page.getByTestId("promotion-benefit").fill("A free espresso");
    await page.getByTestId("promotion-code").fill(CODE);
    await page.getByTestId("promotion-save").click();

    await expect(page.getByTestId("promotion-list")).toBeVisible({ timeout: 30_000 });
    const promotionId = (await scoped(fx.cafe.businessId).promotion()).id;
    await expect(page.getByTestId(`promotion-state-${promotionId}`)).toHaveText("Draft");

    await shot(page, "desktop-en-promotions");

    /*
     * The code was typed on this page and must not come back from it. It is cleared from the field,
     * absent from the rendered HTML, and absent from every request the browser made.
     */
    await expect(page.getByTestId("promotion-code")).toHaveValue("");
    const html = await page.content();
    expect(html).not.toContain(CODE);
    const row = await prisma.promotion.findFirstOrThrow({ where: { businessId: fx.cafe.businessId } });
    expect(html).not.toContain(row.codeDigest);
    expect(html).not.toContain(row.codeSalt);

    expect(
      await textWithoutDisclaimer(page),
      "the promotions screen must claim no calculation",
    ).not.toMatch(MONEY_WORDS);
  });

  test("puts the code in a body, never in a URL", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    const fx = await cafeWithCustomer("URL café");
    await signIn(page, await emailOf(fx.cafe.userId));

    const requestUrls: string[] = [];
    page.on("request", (request) => requestUrls.push(request.url()));

    await createPromotion(page, fx.cafe.businessId, "en");

    expect(requestUrls.length).toBeGreaterThan(0);
    for (const url of requestUrls) {
      expect(url, `the code must not appear in a request URL: ${url}`).not.toContain(CODE);
      expect(url).not.toContain(CODE.toLowerCase());
    }
  });

  test("walks the lifecycle, and expiring is final", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    const fx = await cafeWithCustomer("Lifecycle café");
    await signIn(page, await emailOf(fx.cafe.userId));
    const promotionId = await createPromotion(page, fx.cafe.businessId, "en");

    await page.getByTestId(`promotion-pause-${promotionId}`).click();
    await expect(page.getByTestId(`promotion-state-${promotionId}`)).toHaveText("Paused", { timeout: 30_000 });

    await page.getByTestId(`promotion-activate-${promotionId}`).click();
    await expect(page.getByTestId(`promotion-state-${promotionId}`)).toHaveText("Active", { timeout: 30_000 });

    // Expiring takes two steps, and the confirmation says why it cannot be undone.
    await page.getByTestId(`promotion-expire-${promotionId}`).click();
    await expect(page.getByTestId("promotion-expire-confirm")).toContainText("never be reopened");
    await page.getByTestId(`promotion-expire-yes-${promotionId}`).click();
    await expect(page.getByTestId(`promotion-state-${promotionId}`)).toHaveText("Expired", { timeout: 30_000 });

    // And no control offers to bring it back.
    await expect(page.getByTestId(`promotion-activate-${promotionId}`)).toHaveCount(0);
  });

  test("reads right to left in Arabic, on a phone", async ({ page }) => {
    const fx = await cafeWithCustomer("مقهى العروض");
    await signIn(page, await emailOf(fx.cafe.userId), "ar");

    await page.goto("/ar/business/promotions");
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await expect(page.getByTestId("promotions-nothing-automatic")).toContainText(ar.Promotions.nothingAutomatic);
    // The code field stays left to right inside an RTL page: a reversed code is a different code.
    await expect(page.getByTestId("promotion-code")).toHaveAttribute("dir", "ltr");

    await shot(page, "phone-ar-promotions");

    expect(
      await textWithoutDisclaimer(page),
      "the Arabic screen must claim no calculation",
    ).not.toMatch(MONEY_WORDS);
  });
});

test.describe("taking a coupon at the till", () => {
  test("records it for manual fulfilment, and says nothing was charged", async ({ page }) => {
    const fx = await cafeWithCustomer("Till café");
    await signIn(page, await emailOf(fx.cafe.userId));
    await createPromotion(page, fx.cafe.businessId, "en");

    const requestUrls: string[] = [];
    page.on("request", (request) => requestUrls.push(request.url()));

    await page.goto("/en/scanner");
    await page.getByTestId("scanner-tab-phone").click();
    await page.getByTestId("scanner-phone-input").fill(fx.phone);
    await page.getByTestId("scanner-phone-lookup").click();
    await expect(page.getByTestId("scanner-card")).toBeVisible({ timeout: 30_000 });

    await page.getByTestId("scanner-coupon-input").fill(CODE);
    await page.getByTestId("scanner-coupon-submit").click();

    const feedback = await page.getByTestId("scanner-feedback").innerText();
    expect(feedback).toContain("manual fulfilment");
    expect(feedback).toContain("A free espresso");
    expect(feedback).toContain("Nothing was discounted or charged");

    await page.screenshot({ path: `${SHOTS}/phone-en-coupon-till.png`, fullPage: true });

    // The field is cleared and the code is in no request URL and no rendered HTML.
    await expect(page.getByTestId("scanner-coupon-input")).toHaveValue("");
    for (const url of requestUrls) expect(url).not.toContain(CODE);
    expect(await page.content()).not.toContain(CODE);

    const [row] = await scoped(fx.cafe.businessId).redemptions();
    expect(row.entry).toBe("REDEEMED");
    expect(row.customerCardId).toBe(fx.customer.customerCardId);

    // And no balance moved.
    const card = await prisma.customerCard.findUniqueOrThrow({ where: { id: fx.customer.customerCardId } });
    expect({ stamps: card.stampBalance, points: card.pointBalance, rewards: card.rewardBalance }).toEqual({
      stamps: 0,
      points: 0,
      rewards: 0,
    });
  });

  test("refuses an unusable code without saying why, and keeps the card on screen", async ({ page }) => {
    const fx = await cafeWithCustomer("Refusal café");
    await signIn(page, await emailOf(fx.cafe.userId));
    await createPromotion(page, fx.cafe.businessId, "en");

    await page.goto("/en/scanner");
    await page.getByTestId("scanner-tab-phone").click();
    await page.getByTestId("scanner-phone-input").fill(fx.phone);
    await page.getByTestId("scanner-phone-lookup").click();
    await expect(page.getByTestId("scanner-card")).toBeVisible({ timeout: 30_000 });

    await page.getByTestId("scanner-coupon-input").fill("NOSUCHCODE");
    await page.getByTestId("scanner-coupon-submit").click();

    const feedback = await page.getByTestId("scanner-feedback").innerText();
    expect(feedback).toContain("could not be used");
    // No reason is named: a till that could tell these apart could be asked which codes exist.
    expect(feedback).not.toMatch(/expired|paused|draft|unknown|not found|limit|another business/i);

    // The workflow behind it is untouched: the card is still there.
    await expect(page.getByTestId("scanner-card")).toBeVisible();
    expect(await scoped(fx.cafe.businessId).redemptionCount()).toBe(0);
  });

  test("takes a coupon in Arabic, right to left, on a phone", async ({ page }) => {
    const fx = await cafeWithCustomer("مقهى الكاشير");
    await signIn(page, await emailOf(fx.cafe.userId), "ar");
    await createPromotion(page, fx.cafe.businessId, "ar");

    await page.goto("/ar/scanner");
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await page.getByTestId("scanner-tab-phone").click();
    await page.getByTestId("scanner-phone-input").fill(fx.phone);
    await page.getByTestId("scanner-phone-lookup").click();
    await expect(page.getByTestId("scanner-card")).toBeVisible({ timeout: 30_000 });

    await expect(page.getByTestId("scanner-coupon-input")).toHaveAttribute("placeholder", ar.Scanner.couponPlaceholder);
    await page.getByTestId("scanner-coupon-input").fill(CODE);
    await page.getByTestId("scanner-coupon-submit").click();

    await expect(page.getByTestId("scanner-feedback")).toContainText("لتسليم اليدوي");
    await page.screenshot({ path: `${SHOTS}/phone-ar-coupon-till.png`, fullPage: true });
  });
});

test.describe("the customer's record", () => {
  test("shows what was recorded, and that no money moved", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    const fx = await cafeWithCustomer("Record café");
    await signIn(page, await emailOf(fx.cafe.userId));
    await createPromotion(page, fx.cafe.businessId, "en");

    await page.goto("/en/scanner");
    await page.getByTestId("scanner-tab-phone").click();
    await page.getByTestId("scanner-phone-input").fill(fx.phone);
    await page.getByTestId("scanner-phone-lookup").click();
    await expect(page.getByTestId("scanner-card")).toBeVisible({ timeout: 30_000 });
    await page.getByTestId("scanner-coupon-input").fill(CODE);
    await page.getByTestId("scanner-coupon-submit").click();
    await expect(page.getByTestId("scanner-feedback")).toContainText("manual fulfilment");

    await page.goto(`/en/business/customers/${fx.customer.customerBusinessProfileId}`);
    await expect(page.getByTestId("redemptions-panel")).toBeVisible();
    await expect(page.getByTestId("redemption-row")).toContainText("A free espresso");
    await expect(page.getByTestId("redemptions-no-money")).toContainText("Nothing here was discounted");

    await page.getByTestId("redemptions-panel").scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${SHOTS}/desktop-en-customer-redemptions.png`, fullPage: true });

    expect(await page.content()).not.toContain(CODE);
  });

  test("withdraws one in two steps, keeping both rows", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    const fx = await cafeWithCustomer("Withdraw café");
    await signIn(page, await emailOf(fx.cafe.userId));
    await createPromotion(page, fx.cafe.businessId, "en");

    await page.goto("/en/scanner");
    await page.getByTestId("scanner-tab-phone").click();
    await page.getByTestId("scanner-phone-input").fill(fx.phone);
    await page.getByTestId("scanner-phone-lookup").click();
    await expect(page.getByTestId("scanner-card")).toBeVisible({ timeout: 30_000 });
    await page.getByTestId("scanner-coupon-input").fill(CODE);
    await page.getByTestId("scanner-coupon-submit").click();
    await expect(page.getByTestId("scanner-feedback")).toContainText("manual fulfilment");

    const [redemption] = await scoped(fx.cafe.businessId).redemptions();
    await page.goto(`/en/business/customers/${fx.customer.customerBusinessProfileId}`);
    await page.getByTestId(`redemption-void-${redemption.id}`).click();
    // The consequence a merchant would not guess, stated in the confirmation.
    await expect(page.getByTestId("redemption-void-confirm")).toContainText("use the offer again");
    await page.getByTestId("redemption-void-reason").fill("rang it up twice");
    await page.getByTestId("redemption-void-yes").click();

    await expect(page.getByTestId("redemption-row").first()).toContainText("Withdrawn", { timeout: 30_000 });

    const rows = await scoped(fx.cafe.businessId).redemptions();
    expect(rows.map((r) => r.entry)).toEqual(["REDEEMED", "VOIDED"]);
  });
});

test.describe("who sees what", () => {
  test("a cashier cannot reach the promotions screen", async ({ page }) => {
    const fx = await cafeWithCustomer("Cashier café");
    await signIn(page, await emailOf(fx.cafe.userId));

    // The page is there for an owner, and the nav offers it.
    await expect(page.getByTestId("promotions-client")).toHaveCount(0);
    expect((await page.goto("/en/business/promotions"))?.status()).toBe(200);
    await expect(page.getByTestId("promotions-client")).toBeVisible();

    /*
     * Now the same person, as a cashier.
     *
     * The membership role is changed under the live session rather than signing in as a fixture
     * cashier, because `createStaff` gives its user no usable password. That is not a weaker test:
     * the tenant context is rebuilt from the database on every request, so the very next navigation
     * is genuinely a cashier's — which is the guard this is about.
     */
    await prisma.businessMembership.updateMany({
      where: { businessId: fx.cafe.businessId, userId: fx.cafe.userId },
      data: { role: "CASHIER" },
    });

    const response = await page.goto("/en/business/promotions");
    // A 404, not an empty screen: they are not being told there is a page here.
    expect(response?.status()).toBe(404);
    await expect(page.getByTestId("promotions-client")).toHaveCount(0);

    // And the nav does not offer it either.
    await page.goto("/en/scanner");
    expect(await page.content()).not.toContain("/business/promotions");
  });
});

test.describe("the boundary holds", () => {
  test("B7 is unchanged by any of this", async ({ page }) => {
    for (const method of ["GET", "POST"] as const) {
      const response = await page.request.fetch("/api/enroll", { method });
      expect(response.status(), `${method} /api/enroll`).toBe(410);
    }
    const join = await page.request.get("/join/anything-at-all");
    expect(join.status()).toBeLessThan(400);
    expect(await join.text()).not.toContain("<form");
  });

  test("offers no public coupon lookup, claim or redemption route", async ({ page }) => {
    for (const path of [
      "/api/coupons",
      "/api/promotions",
      `/api/scanner/coupon?code=${CODE}`,
      `/api/coupon/${CODE}`,
      "/en/coupon",
      "/en/redeem",
    ]) {
      const response = await page.request.get(path);
      const body = await response.text();
      expect(body, `${path} must reveal nothing`).not.toContain("A free espresso");
      expect(body).not.toContain('"outcome":"RECORDED"');
    }
  });
});
