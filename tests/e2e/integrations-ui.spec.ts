import { expect, test, type Page } from "@playwright/test";
import ar from "../../messages/ar.json";
import { prisma } from "@/server/db";
import { createStampCafe, enrolCustomer, TEST_PASSWORD, uniqueSyrianPhone } from "../setup/fixtures";

/**
 * The integrations screen, which exists partly to say what it is not.
 *
 * What these hold beyond "the page renders":
 *
 *  - **no provider is claimed.** No logo, no "Connect", no key field, and a notice saying so;
 *  - **no sensitive value is on the page** — no phone, name, code, serial or wallet token;
 *  - **a cashier cannot reach it at all**, and the nav does not offer it to them;
 *  - **an event appears only when a workflow completes**, and a refused coupon leaves none;
 *  - **Arabic reads right to left on a phone.**
 *
 * The default viewport is a Pixel 7 (playwright.config.ts); the desktop passes set 1440×900.
 */

const DESKTOP = { width: 1440, height: 900 };
const SHOTS = "playwright-results/visual";
const CODE = "AUTUMN10";

/** Wording that would claim a provider is attached to this product. */
const CONNECTED_WORDS = /\bconnected to\b|\bconnect your\b|\bauthorize\b|\bapi key\b|\bwebhook url\b/i;

/**
 * The browser suite shares ONE database across every spec and never truncates between tests, so
 * every row read back must be scoped to the café the test created.
 */
function scoped(businessId: string) {
  return {
    events: () =>
      prisma.integrationEvent.findMany({ where: { businessId }, orderBy: { occurredAt: "asc" } }),
    count: () => prisma.integrationEvent.count({ where: { businessId } }),
  };
}

/** A screenshot of the page as a person first meets it — the shell scrolls `main`, not the document. */
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
  await page.waitForURL(/\/(business|scanner)/, { timeout: 30_000 });
}

/** A café with an ACTIVE promotion and one enrolled customer, built through the owner's own screens. */
async function cafeWithOffer(name: string, locale: "en" | "ar" = "en") {
  const cafe = await createStampCafe({ name });
  const phone = uniqueSyrianPhone();
  const customer = await enrolCustomer(cafe, { phone, firstName: "ليلى" });
  return { cafe, customer, phone, locale };
}

async function createAndActivate(page: Page, businessId: string, locale: "en" | "ar") {
  await page.goto(`/${locale}/business/promotions`);
  await page.getByTestId("promotion-name").fill(locale === "ar" ? "عرض الخريف" : "Autumn offer");
  await page.getByTestId("promotion-benefit").fill(locale === "ar" ? "قهوة مجانية" : "A free espresso");
  await page.getByTestId("promotion-code").fill(CODE);
  await page.getByTestId("promotion-save").click();
  await expect(page.getByTestId("promotion-list")).toBeVisible({ timeout: 30_000 });

  const promotion = await prisma.promotion.findFirstOrThrow({ where: { businessId }, select: { id: true } });
  await page.getByTestId(`promotion-activate-${promotion.id}`).click();
  await expect(page.getByTestId(`promotion-state-${promotion.id}`)).toHaveText(/Active|فعّال|نشط/, {
    timeout: 30_000,
  });
}

/** Redeem a coupon at the till, which is the one thing that produces an event today. */
async function redeemAtTill(page: Page, phone: string, locale: "en" | "ar", code = CODE) {
  await page.goto(`/${locale}/scanner`);
  await page.getByTestId("scanner-tab-phone").click();
  await page.getByTestId("scanner-phone-input").fill(phone);
  await page.getByTestId("scanner-phone-lookup").click();
  await expect(page.getByTestId("scanner-card")).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("scanner-coupon-input").fill(code);
  await page.getByTestId("scanner-coupon-submit").click();
  await expect(page.getByTestId("scanner-feedback")).toBeVisible({ timeout: 30_000 });
}

test.describe("the integrations screen", () => {
  test("says nothing is connected, and offers no way to connect one", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    const fx = await cafeWithOffer("Integrations café");
    await signIn(page, await emailOf(fx.cafe.userId));

    await page.goto("/en/business/integrations");
    await expect(page.getByTestId("integrations")).toBeVisible();
    await expect(page.getByTestId("integrations-nothing-connected")).toBeVisible();

    const visible = await page.locator("main").innerText();
    const denial = await page.getByTestId("integrations-nothing-connected").innerText();
    expect(denial.length).toBeGreaterThan(40);
    /*
     * The denial necessarily contains the word "connected", so it is subtracted before the rest of
     * the screen is checked — the same trick, and the same reason, as the promotions disclaimer.
     */
    expect(visible).toContain(denial);
    expect(visible.replace(denial, ""), "the screen claimed a provider").not.toMatch(CONNECTED_WORDS);

    // No control offers to attach anything, because there is nothing to attach.
    const controls = await page.locator("main button, main a, main input, main select").allInnerTexts();
    expect(controls.join(" ")).not.toMatch(CONNECTED_WORDS);
    await expect(page.locator('main input[type="password"]')).toHaveCount(0);
  });

  test("shows nothing before a workflow has completed", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    const fx = await cafeWithOffer("Empty café");
    await signIn(page, await emailOf(fx.cafe.userId));

    await page.goto("/en/business/integrations");
    await expect(page.getByTestId("integration-events-empty")).toBeVisible();
    expect(await scoped(fx.cafe.businessId).count()).toBe(0);
    await shot(page, "desktop-en-integrations-empty");
  });

  test("records one entry when a coupon is taken at the till", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    const fx = await cafeWithOffer("Recording café");
    await signIn(page, await emailOf(fx.cafe.userId));
    await createAndActivate(page, fx.cafe.businessId, "en");
    await redeemAtTill(page, fx.phone, "en");

    await page.goto("/en/business/integrations");
    await expect(page.getByTestId("integration-event-row")).toHaveCount(1);
    await expect(page.getByTestId("integration-events")).toContainText("Offer recorded");

    const events = await scoped(fx.cafe.businessId).events();
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe("PROMOTION_REDEMPTION_RECORDED");
    await shot(page, "desktop-en-integrations");
  });

  test("records nothing when the coupon was refused", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    const fx = await cafeWithOffer("Refused café");
    await signIn(page, await emailOf(fx.cafe.userId));
    await createAndActivate(page, fx.cafe.businessId, "en");
    await redeemAtTill(page, fx.phone, "en", "NOTACODE");

    await page.goto("/en/business/integrations");
    await expect(page.getByTestId("integration-events-empty")).toBeVisible();
    expect(await scoped(fx.cafe.businessId).count()).toBe(0);
  });

  test("shows a second entry when the offer is withdrawn", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    const fx = await cafeWithOffer("Withdrawn café");
    await signIn(page, await emailOf(fx.cafe.userId));
    await createAndActivate(page, fx.cafe.businessId, "en");
    await redeemAtTill(page, fx.phone, "en");

    await page.goto(`/en/business/customers/${fx.customer.customerBusinessProfileId}`);
    const redemption = (await scoped(fx.cafe.businessId).events())[0];
    await page.getByTestId(`redemption-void-${redemption.entityId}`).click();
    await page.getByTestId("redemption-void-yes").click();
    // The void landed when the second redemption row exists; the wording on that panel is that
    // screen's own test to make.
    await expect
      .poll(
        async () =>
          prisma.promotionRedemption.count({ where: { businessId: fx.cafe.businessId, entry: "VOIDED" } }),
        { timeout: 30_000 },
      )
      .toBe(1);

    await page.goto("/en/business/integrations");
    await expect(page.getByTestId("integration-event-row")).toHaveCount(2);
    const events = await scoped(fx.cafe.businessId).events();
    expect(events.map((e) => e.eventType)).toEqual([
      "PROMOTION_REDEMPTION_RECORDED",
      "PROMOTION_REDEMPTION_VOIDED",
    ]);
  });

  test("puts no phone, name, code, serial or wallet token on the page", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    const fx = await cafeWithOffer("Leak café");
    await signIn(page, await emailOf(fx.cafe.userId));
    await createAndActivate(page, fx.cafe.businessId, "en");
    await redeemAtTill(page, fx.phone, "en");

    await page.goto("/en/business/integrations");
    await expect(page.getByTestId("integration-event-row")).toHaveCount(1);

    const card = await prisma.customerCard.findUniqueOrThrow({ where: { id: fx.customer.customerCardId } });
    const promotion = await prisma.promotion.findFirstOrThrow({ where: { businessId: fx.cafe.businessId } });

    /*
     * The WHOLE document, not just `main`: a value that reached a data attribute, a script payload
     * or a hidden field would be just as leaked as one that was rendered.
     */
    const html = await page.content();
    for (const secret of [
      fx.phone,
      fx.phone.replace(/\D/g, ""),
      "ليلى",
      CODE,
      card.serialNumber,
      card.qrToken,
      card.shareToken,
      promotion.codeDigest,
      promotion.codeSalt,
    ]) {
      expect(html, `the page leaked ${secret.slice(0, 10)}`).not.toContain(secret);
    }
  });
});

test.describe("who may see it", () => {
  test("a cashier cannot reach the screen, and the nav does not offer it", async ({ page }) => {
    const fx = await cafeWithOffer("Cashier café");
    await signIn(page, await emailOf(fx.cafe.userId));

    // The page is there for an owner.
    expect((await page.goto("/en/business/integrations"))?.status()).toBe(200);
    await expect(page.getByTestId("integrations")).toBeVisible();

    /*
     * Now the same person, as a cashier. The role is changed under the live session rather than
     * signing in as a fixture cashier, because `createStaff` gives its user no usable password —
     * and this is not a weaker test: the tenant context is rebuilt from the database on every
     * request, so the very next navigation is genuinely a cashier's.
     */
    await prisma.businessMembership.updateMany({
      where: { businessId: fx.cafe.businessId, userId: fx.cafe.userId },
      data: { role: "CASHIER" },
    });

    const response = await page.goto("/en/business/integrations");
    // A 404, not an empty screen: they are not being told there is a page here.
    expect(response?.status()).toBe(404);
    await expect(page.getByTestId("integrations")).toHaveCount(0);

    await page.goto("/en/scanner");
    expect(await page.content()).not.toContain("/business/integrations");
  });
});

test.describe("Arabic", () => {
  test("reads right to left on a phone, and denies a connection in Arabic", async ({ page }) => {
    const fx = await cafeWithOffer("مقهى التكامل", "ar");
    await signIn(page, await emailOf(fx.cafe.userId), "ar");
    await createAndActivate(page, fx.cafe.businessId, "ar");
    await redeemAtTill(page, fx.phone, "ar");

    await page.goto("/ar/business/integrations");
    await expect(page.getByTestId("integrations")).toBeVisible();

    // The strings come from the message file, so the test cannot pass against English fallbacks.
    await expect(page.getByTestId("integrations-nothing-connected")).toContainText(
      ar.Integrations.nothingConnected,
    );
    await expect(page.getByTestId("integration-events")).toContainText(ar.Integrations.historyTitle);
    await expect(page.getByTestId("integration-event-row").first()).toContainText(
      ar.Integrations.typeRedemptionRecorded,
    );

    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await shot(page, "phone-ar-integrations");
  });

  test("renders the same screen on a phone in English", async ({ page }) => {
    const fx = await cafeWithOffer("Phone café");
    await signIn(page, await emailOf(fx.cafe.userId));
    await createAndActivate(page, fx.cafe.businessId, "en");
    await redeemAtTill(page, fx.phone, "en");

    await page.goto("/en/business/integrations");
    await expect(page.getByTestId("integration-event-row")).toHaveCount(1);
    await shot(page, "phone-en-integrations");
  });

  test("shows the desktop screen in Arabic", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    const fx = await cafeWithOffer("مقهى سطح المكتب", "ar");
    await signIn(page, await emailOf(fx.cafe.userId), "ar");
    await createAndActivate(page, fx.cafe.businessId, "ar");
    await redeemAtTill(page, fx.phone, "ar");

    await page.goto("/ar/business/integrations");
    await expect(page.getByTestId("integration-event-row")).toHaveCount(1);
    await shot(page, "desktop-ar-integrations");
  });
});

test.describe("the boundary holds", () => {
  test("B7 is unchanged, and no public integration route exists", async ({ page }) => {
    for (const path of ["/api/enroll"]) {
      const res = await page.request.get(path);
      expect(res.status()).toBe(410);
    }
    // No API surface at all: these are outside the proxy's matcher, so a 404 is the server's own.
    for (const path of ["/api/integrations", "/api/webhooks", "/api/events"]) {
      const res = await page.request.get(path);
      expect(res.status(), `${path} answered ${res.status()}`).toBe(404);
    }

    /*
     * An un-prefixed `/integrations` is NOT public, so a signed-out request lands on the login page
     * with a 200 rather than a 404 — the proxy declines to say whether the path exists at all,
     * which is the behaviour B7 asks for everywhere else. The assertion is therefore about where it
     * lands, not what it returns.
     */
    const bare = await page.goto("/integrations");
    expect(page.url()).toMatch(/\/auth\/login/);
    expect(bare?.status()).toBeLessThan(400);
    expect(await page.content()).not.toContain("integration-events");
  });

  test("signed out, the screen is not reachable", async ({ page }) => {
    const response = await page.goto("/en/business/integrations");
    // Redirected to the login page rather than rendered.
    expect(page.url()).toMatch(/\/auth\/login/);
    expect(response?.status()).toBeLessThan(400);
  });
});
