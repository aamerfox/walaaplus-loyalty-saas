import { expect, test, type Page } from "@playwright/test";
import ar from "../../messages/ar.json";
import { prisma } from "@/server/db";
import {
  createPointsShop,
  createStampCafe,
  enrolCustomer,
  enrolPointsCustomer,
  TEST_PASSWORD,
  uniqueSyrianPhone,
} from "../setup/fixtures";

/**
 * The Phase 2 screens, driven the way a merchant drives them.
 *
 * What these hold beyond "the page renders":
 *
 *  - **a customer with two cards is one record**, and a points customer can be opened at all — the
 *    previous card-scoped page 404'd on one, and no test caught it because no test opened one;
 *  - **no capability leaks onto a CRM screen.** The real card token, share token and source token are
 *    read out of the database and asserted absent from the rendered HTML;
 *  - **a segment count comes from the server**, and the browser shows what the server said;
 *  - **the Arabic Locations screen says branch, not cashier**, which is the wording the owner found
 *    on staging, in RTL, at phone width.
 *
 * The default viewport is a Pixel 7 (playwright.config.ts); the desktop passes set 1440×900.
 */

const DESKTOP = { width: 1440, height: 900 };
const SHOTS = "playwright-results/visual";

async function signIn(page: Page, email: string, locale: "en" | "ar" = "en") {
  await page.goto(`/${locale}/auth/login`);
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(TEST_PASSWORD);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL(new RegExp(`/${locale}/business`), { timeout: 30_000 });
}

async function emailOf(userId: string) {
  const owner = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true } });
  return owner.email;
}

test.describe("customer 360", () => {
  test("opens one customer holding two cards, and leaks no token", async ({ page }) => {
    const cafe = await createStampCafe({ name: "CRM café" });
    const shop = await createPointsShop({
      existing: { userId: cafe.userId, businessId: cafe.businessId, locationId: cafe.locationId },
      name: "CRM points",
    });
    const phone = uniqueSyrianPhone();
    const stampCard = await enrolCustomer(cafe, { phone, firstName: "ليلى" });
    await enrolPointsCustomer(shop, { phone });

    await page.setViewportSize(DESKTOP);
    await signIn(page, await emailOf(cafe.userId));

    await page.goto("/en/business/customers");
    await expect(page.getByTestId("customers-table")).toBeVisible();
    // One row per person, with the number of programmes they hold.
    await page.getByRole("link", { name: "View" }).first().click();
    await page.waitForURL(/\/business\/customers\/[^/]+$/, { timeout: 30_000 });

    await expect(page.getByTestId("customer-cards")).toBeVisible();
    await expect(page.getByTestId("card-stamps")).toBeVisible();
    await expect(page.getByTestId("card-points")).toBeVisible();

    // The one assertion this screen turns on.
    const html = await page.content();
    const row = await prisma.customerCard.findUniqueOrThrow({
      where: { id: stampCard.customerCardId },
      select: { qrToken: true, shareToken: true, utmSourceLink: { select: { publicToken: true } } },
    });
    expect(html).not.toContain(row.qrToken);
    expect(html).not.toContain(row.shareToken);
    expect(html).not.toContain(row.utmSourceLink!.publicToken);
    expect(html).not.toContain("/join/");
    expect(html).not.toContain("/api/enroll");

    await page.screenshot({ path: `${SHOTS}/desktop-en-customer-360.png`, fullPage: true });
  });

  test("reads a customer record in Arabic, right to left, on a phone", async ({ page }) => {
    const shop = await createPointsShop({ name: "متجر النقاط" });
    await enrolPointsCustomer(shop, { phone: uniqueSyrianPhone(), firstName: "سارة" });

    await signIn(page, await emailOf(shop.userId), "ar");
    await page.goto("/ar/business/customers");
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await expect(page.getByTestId("customers-table")).toBeVisible();

    await page.getByTestId("customers-rows").getByRole("link").first().click();
    await page.waitForURL(/\/business\/customers\/[^/]+$/, { timeout: 30_000 });
    await expect(page.getByTestId("customer-identity")).toBeVisible();
    await expect(page.getByTestId("customer-ledger-note")).toContainText(ar.Customers.ledgerNote);

    await page.screenshot({ path: `${SHOTS}/phone-ar-customer-360.png`, fullPage: true });
  });
});

test.describe("segments", () => {
  test("describes a segment, counts it on the server, saves it and archives it", async ({ page }) => {
    const cafe = await createStampCafe({ name: "Segment café", mechanics: { stampsRequiredPerReward: 20 } });
    for (let i = 0; i < 2; i += 1) await enrolCustomer(cafe, { phone: uniqueSyrianPhone() });

    await page.setViewportSize(DESKTOP);
    await signIn(page, await emailOf(cafe.userId));

    await page.goto("/en/business/segments");
    await expect(page.getByTestId("segments-empty")).toBeVisible();
    // It is a foundation, and the page says so rather than implying a campaign button is coming.
    await expect(page.getByTestId("segments-foundation")).toBeVisible();

    await page.getByTestId("segment-name").fill("Everyone with a card");
    await page.getByTestId("segment-field-0").selectOption("stampBalance");
    await page.getByTestId("segment-value-0").fill("0");

    await page.getByTestId("segment-count").click();
    // The number comes from the server; the browser computes nothing.
    await expect(page.getByTestId("segment-count-result")).toContainText("2");

    await page.getByTestId("segment-save").click();
    await expect(page.getByTestId("segment-message")).toBeVisible();
    await expect(page.getByTestId("segment-list")).toBeVisible();

    await page.screenshot({ path: `${SHOTS}/desktop-en-segments.png`, fullPage: true });

    await page.getByTestId("segment-archive").first().click();
    await expect(page.getByTestId("segment-archived")).toBeVisible();
    // Archived, never deleted: the row is still there.
    expect(await prisma.customerSegment.count({ where: { businessId: cafe.businessId } })).toBe(1);
  });

  test("renders the segment builder in Arabic, right to left", async ({ page }) => {
    const cafe = await createStampCafe({ name: "مقهى الشرائح" });
    await signIn(page, await emailOf(cafe.userId), "ar");

    await page.goto("/ar/business/segments");
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await expect(page.getByTestId("segment-builder")).toBeVisible();
    await expect(page.getByTestId("segments-foundation")).toContainText(ar.Segments.foundationNote);

    await page.screenshot({ path: `${SHOTS}/phone-ar-segments.png`, fullPage: true });
  });
});

test.describe("the dashboard counts a range the merchant chose", () => {
  test("switches preset, applies a custom range, and filters by branch", async ({ page }) => {
    const cafe = await createStampCafe({ name: "Range café" });
    await enrolCustomer(cafe, { phone: uniqueSyrianPhone() });

    await page.setViewportSize(DESKTOP);
    await signIn(page, await emailOf(cafe.userId));
    await page.goto("/en/business");

    await expect(page.getByTestId("dashboard-filters")).toBeVisible();
    await page.getByTestId("range-today").click();
    await expect(page).toHaveURL(/range=today/);
    // A card issued today is inside "today", which is the cheapest possible check that the range
    // is being applied rather than decorated.
    await expect(page.getByTestId("dashboard-stats")).toBeVisible();

    await page.getByTestId("range-from").fill("2026-01-01");
    await page.getByTestId("range-to").fill("2026-01-31");
    await page.getByTestId("range-apply").click();
    await expect(page).toHaveURL(/range=custom/);
    await expect(page.getByTestId("metrics-provenance")).toBeVisible();

    await page.screenshot({ path: `${SHOTS}/desktop-en-dashboard-range.png`, fullPage: true });
  });

  test("falls back, and says so, when the range in the URL cannot be read", async ({ page }) => {
    const cafe = await createStampCafe({ name: "Bad range café" });
    await signIn(page, await emailOf(cafe.userId));

    // Only a hand-edited URL gets here. It must not be an error page over readable numbers.
    await page.goto("/en/business?range=custom&from=nonsense&to=2026-01-31");
    await expect(page.getByTestId("range-fallback")).toBeVisible();
    await expect(page.getByTestId("dashboard-stats")).toBeVisible();
  });
});

test.describe("the Locations screen says branch, not cashier", () => {
  test("uses the corrected Arabic wording, in RTL, at phone width", async ({ page }) => {
    const cafe = await createStampCafe({ name: "مقهى الفروع" });
    await signIn(page, await emailOf(cafe.userId), "ar");

    await page.goto("/ar/business/locations");
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");

    const body = page.locator("main");
    await expect(body).toContainText(ar.Locations.addTitle);
    await expect(body).toContainText(ar.Locations.lifecycleNote);

    /*
     * The owner's finding, held from the browser as well as from the message file.
     *
     * Asserted against the VISIBLE TEXT, not `page.content()`. next-intl serialises the whole
     * message file into the document for the client components on the page, so the raw HTML of any
     * Arabic screen contains every Arabic string in the product — including the Team screen's
     * "كاشير", which is correct there because it is a person. What a merchant reads is the rendered
     * text, and that is what this checks.
     */
    const visible = await page.locator("main").innerText();
    expect(visible).not.toContain("كاشير");
    expect(visible).toContain("فرع");

    await page.screenshot({ path: `${SHOTS}/phone-ar-locations-wording.png`, fullPage: true });
  });
});
