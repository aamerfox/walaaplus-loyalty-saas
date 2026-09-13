import { expect, test, type Page } from "@playwright/test";
import ar from "../../messages/ar.json";
import { prisma } from "@/server/db";
import { createStampCafe, enrolCustomer, TEST_PASSWORD, uniqueSyrianPhone } from "../setup/fixtures";

/**
 * The Prompt 2 screens, driven the way a merchant drives them.
 *
 * What these hold beyond "the page renders":
 *
 *  - **the draft-only banner is on every campaign screen**, and there is no send or schedule
 *    control anywhere — including a disabled one, which would be a promise;
 *  - **the preview is drawn from sample values**, so a real customer's name never appears in one;
 *  - **a consent change is recorded and shown**, without the enrolment answer moving;
 *  - **no capability reaches either screen.** The real tokens are read out of the database and
 *    asserted absent from the rendered HTML.
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
  return (await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true } })).email;
}

/**
 * A screenshot of the page as a person first meets it.
 *
 * The dashboard shell scrolls `main`, not the document, so Playwright's fullPage captures one
 * viewport of whatever the test last scrolled to — which after a save is the confirmation, with the
 * page's own heading and its draft-only banner out of frame. Rewinding first means the evidence
 * shows the promise the screen makes, not just the field the test happened to touch.
 */
async function shot(page: Page, name: string) {
  await page.locator("main").evaluate((el) => el.scrollTo(0, 0));
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
}

/** The same, framed on one section rather than on the top of the page. */
async function shotOf(page: Page, testId: string, name: string) {
  await page.getByTestId(testId).scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
}

/**
 * Every word a delivery CONTROL could plausibly be labelled with, in both locales.
 *
 * Matched against the names of the page's buttons and links, not against its prose. The copy
 * deliberately says that sending does not exist yet — "Sending, scheduling, unsubscribe links and
 * delivery reports are a later step" — and a test that banned the words outright would forbid the
 * product from explaining its own boundary. What must not exist is something a merchant can press.
 */
const SENDING_WORDS = /send|schedul|queue|dispatch|إرسال|جدول/i;

/** Every button and link inside the page body, by the name a person would read. */
async function controlNames(page: Page): Promise<string[]> {
  const main = page.locator("main");
  const names = await main.getByRole("button").or(main.getByRole("link")).allInnerTexts();
  return names.map((name) => name.trim()).filter(Boolean);
}

test.describe("campaign drafts", () => {
  test("writes a draft, previews it from samples, and offers nothing that sends", async ({ page }) => {
    const cafe = await createStampCafe({ name: "Draft café" });
    const customer = await enrolCustomer(cafe, { phone: uniqueSyrianPhone(), firstName: "ليلى" });

    await page.setViewportSize(DESKTOP);
    await signIn(page, await emailOf(cafe.userId));

    await page.goto("/en/business/campaigns");
    await expect(page.getByTestId("campaigns-draft-only")).toBeVisible();
    await expect(page.getByTestId("campaigns-empty")).toBeVisible();

    await page.getByTestId("campaign-name").fill("Autumn offer");
    await page.getByTestId("campaign-body").fill("Hello {{firstName}}, from {{businessName}}.");

    // The preview substitutes SAMPLE values. The real customer's name is not in it, and no query
    // ran to draw it.
    await expect(page.getByTestId("preview-body")).toContainText("Layla");
    await expect(page.getByTestId("preview-body")).not.toContainText("ليلى");

    await page.getByTestId("campaign-save").click();
    await page.waitForURL(/\/business\/campaigns$/, { timeout: 30_000 });
    await expect(page.getByTestId("campaign-list")).toBeVisible();

    await shot(page, "desktop-en-campaigns");

    /*
     * No control that sends, schedules or queues — and none disabled either, since a greyed-out
     * Send button promises the same thing a working one does.
     */
    const names = await controlNames(page);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) expect(name, `"${name}" must not offer delivery`).not.toMatch(SENDING_WORDS);
    await expect(page.locator("main button:disabled")).toHaveCount(0);

    // And no capability on the screen.
    const html = await page.content();
    const row = await prisma.customerCard.findUniqueOrThrow({
      where: { id: customer.customerCardId },
      select: { qrToken: true, shareToken: true, utmSourceLink: { select: { publicToken: true } } },
    });
    for (const secret of [row.qrToken, row.shareToken, row.utmSourceLink!.publicToken]) {
      expect(html).not.toContain(secret);
    }
  });

  test("refuses an unavailable placeholder, and says why", async ({ page }) => {
    const cafe = await createStampCafe({ name: "Placeholder café" });
    await page.setViewportSize(DESKTOP);
    await signIn(page, await emailOf(cafe.userId));

    await page.goto("/en/business/campaigns");
    await page.getByTestId("campaign-name").fill("Bad placeholder");
    await page.getByTestId("campaign-body").fill("You have stamps on {{programName}}");
    // The check runs on blur, before the merchant even tries to save.
    await page.getByTestId("campaign-name").click();

    await expect(page.getByTestId("campaign-problems")).toBeVisible();
    await expect(page.getByTestId("campaign-problems")).toContainText("several cards");

    await page.getByTestId("campaign-save").click();
    await expect(page.getByTestId("campaign-message")).toBeVisible();
    expect(await prisma.campaign.count({ where: { businessId: cafe.businessId } })).toBe(0);
  });

  test("shows the audience as counts, never as people", async ({ page }) => {
    const cafe = await createStampCafe({ name: "Audience café" });
    await enrolCustomer(cafe, { phone: uniqueSyrianPhone(), firstName: "ليلى" });
    await enrolCustomer(cafe, { phone: uniqueSyrianPhone(), firstName: "Omar" });

    await page.setViewportSize(DESKTOP);
    await signIn(page, await emailOf(cafe.userId));

    // A segment first, then a draft that points at it.
    await page.goto("/en/business/segments");
    await page.getByTestId("segment-name").fill("Everyone");
    await page.getByTestId("segment-field-0").selectOption("stampBalance");
    await page.getByTestId("segment-value-0").fill("0");
    await page.getByTestId("segment-save").click();
    await expect(page.getByTestId("segment-list")).toBeVisible();

    await page.goto("/en/business/campaigns");
    await page.getByTestId("campaign-name").fill("To everyone");
    await page.getByTestId("campaign-segment").selectOption({ label: "Everyone" });
    await page.getByTestId("campaign-body").fill("Hello {{firstName}}");
    await page.getByTestId("campaign-save").click();
    await page.waitForURL(/\/business\/campaigns$/, { timeout: 30_000 });

    await page.getByTestId("campaign-list").getByRole("link").first().click();
    await page.waitForURL(/\/business\/campaigns\/[^/]+$/, { timeout: 30_000 });
    await expect(page.getByTestId("campaign-draft-only-detail")).toBeVisible();

    await page.getByTestId("campaign-preview-audience").click();
    await expect(page.getByTestId("audience-preview")).toBeVisible();
    // Two matched, and neither agreed at enrolment, so neither may be contacted.
    await expect(page.getByTestId("audience-preview")).toContainText("2");

    const preview = await page.getByTestId("audience-preview").innerText();
    expect(preview).not.toContain("ليلى");
    expect(preview).not.toContain("Omar");

    await shot(page, "desktop-en-campaign-detail");
  });

  test("renders the editor in Arabic, right to left", async ({ page }) => {
    const cafe = await createStampCafe({ name: "مقهى الحملات" });
    await signIn(page, await emailOf(cafe.userId), "ar");

    await page.goto("/ar/business/campaigns");
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await expect(page.getByTestId("campaigns-draft-only")).toContainText(ar.Campaigns.draftOnlyBanner);
    await expect(page.getByTestId("campaign-editor")).toBeVisible();

    // The preview follows the DRAFT's language, not the screen's.
    await page.getByTestId("campaign-body").fill("مرحباً {{firstName}}");
    await expect(page.getByTestId("preview-body")).toContainText("ليلى");
    /*
     * The preview carries the DRAFT's direction on its own wrapper, so an Arabic message composed on
     * an English screen still reads the way its recipients will read it.
     */
    await expect(page.getByTestId("campaign-preview").locator("[dir]")).toHaveAttribute("dir", "rtl");

    for (const name of await controlNames(page)) {
      expect(name, `"${name}" must not offer delivery`).not.toMatch(SENDING_WORDS);
    }

    await shot(page, "phone-ar-campaigns");
  });
});

test.describe("consent on the customer record", () => {
  test("shows an incomplete sign-up as not-a-permission, and records a change", async ({ page }) => {
    const cafe = await createStampCafe({ name: "Consent café" });
    const customer = await enrolCustomer(cafe, { phone: uniqueSyrianPhone(), firstName: "ليلى" });
    // The real historical shape: a tick with no date and no wording recorded.
    await prisma.customerBusinessProfile.update({
      where: { id: customer.customerBusinessProfileId },
      data: { marketingConsent: true, privacyConsentAt: null, consentTextVersion: null },
    });

    await page.setViewportSize(DESKTOP);
    await signIn(page, await emailOf(cafe.userId));
    await page.goto(`/en/business/customers/${customer.customerBusinessProfileId}`);

    await expect(page.getByTestId("consent-state")).toHaveText("Not known");
    await expect(page.getByTestId("consent-ambiguity")).toBeVisible();
    await expect(page.getByTestId("customer-consent")).toBeVisible();

    await shot(page, "desktop-en-consent");

    await page.getByTestId("consent-reason").fill("asked again at the counter");
    await page.getByTestId("consent-grant").click();
    await expect(page.getByTestId("consent-message")).toBeVisible();
    await expect(page.getByTestId("consent-state")).toHaveText("Agreed");

    // The enrolment answer is history and did not move.
    const profile = await prisma.customerBusinessProfile.findUniqueOrThrow({
      where: { id: customer.customerBusinessProfileId },
      select: { marketingConsent: true, privacyConsentAt: true, consentTextVersion: true },
    });
    expect(profile).toEqual({ marketingConsent: true, privacyConsentAt: null, consentTextVersion: null });
    // And the change is a row, with both entries readable.
    await expect(page.getByTestId("consent-history").locator("tbody tr")).toHaveCount(2);

    await shotOf(page, "customer-consent", "desktop-en-consent-history");
  });

  test("reads the consent history in Arabic, right to left, on a phone", async ({ page }) => {
    const cafe = await createStampCafe({ name: "مقهى الموافقات" });
    const customer = await enrolCustomer(cafe, { phone: uniqueSyrianPhone(), firstName: "سارة" });

    await signIn(page, await emailOf(cafe.userId), "ar");
    await page.goto(`/ar/business/customers/${customer.customerBusinessProfileId}`);

    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await expect(page.getByTestId("customer-consent")).toBeVisible();
    await expect(page.getByTestId("consent-append-only")).toContainText(ar.Consent.appendOnlyNote);

    await shot(page, "phone-ar-consent");
    await shotOf(page, "customer-consent", "phone-ar-consent-history");
  });
});
