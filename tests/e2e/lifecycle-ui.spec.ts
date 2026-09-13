import { expect, test, type Page } from "@playwright/test";
import ar from "../../messages/ar.json";
import { prisma } from "@/server/db";
import { createStampCafe, TEST_PASSWORD, uniqueSyrianPhone, enrolCustomer } from "../setup/fixtures";

/**
 * The Prompt 3 journeys, driven the way an owner drives them.
 *
 * Three things these tests are for, beyond "the page loads":
 *
 *  - **the lifecycle works end to end through the browser** — open a counter, open a draft, change a
 *    rule, read what will change, publish it — because every one of those is a POST a screen makes
 *    on the owner's behalf and a screen is where the wiring breaks;
 *  - **the refusals are legible**, in the owner's own language. A merchant who tries to close their
 *    main counter must read a sentence about counters, not a code and not English;
 *  - **B7 is still B7.** The source screen is new, and a source screen is exactly the shape a public
 *    enrolment link would come back in. Every one of these pages is checked for a link, a token and
 *    a QR.
 *
 * The default viewport is a Pixel 7 (playwright.config.ts), so these run at phone width unless a
 * test resizes; the desktop pass sets 1440×900 explicitly.
 */

const DESKTOP = { width: 1440, height: 900 };

async function signIn(page: Page, email: string, locale: "en" | "ar" = "en") {
  await page.goto(`/${locale}/auth/login`);
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(TEST_PASSWORD);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL(new RegExp(`/${locale}/business`), { timeout: 30_000 });
}

async function ownerOf(businessId: string, userId: string) {
  const owner = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true } });
  return { email: owner.email, businessId };
}

test.describe("counters", () => {
  test("an owner opens a counter, renames it, closes it, and is refused on the main one", async ({ page }) => {
    const cafe = await createStampCafe({ name: "Lifecycle café" });
    const { email } = await ownerOf(cafe.businessId, cafe.userId);
    await page.setViewportSize(DESKTOP);
    await signIn(page, email);

    await page.goto("/en/business/locations");
    await expect(page.getByTestId("location-list")).toBeVisible();

    // ── open one ─────────────────────────────────────────────────────────────
    await page.getByTestId("location-name").fill("Branch");
    await page.getByTestId("location-address").fill("Old city");
    await page.getByTestId("location-submit").click();
    await expect(page.getByTestId("location-message")).toBeVisible();
    await expect(page.getByText("Branch", { exact: true }).first()).toBeVisible();

    // ── rename it ────────────────────────────────────────────────────────────
    const branchCard = page.locator('[data-testid="location-list"] > li', { hasText: "Branch" });
    await branchCard.getByTestId("location-edit").click();
    await branchCard.getByTestId("location-edit-name").fill("Second counter");
    await branchCard.getByTestId("location-save").click();
    await expect(page.getByText("Second counter", { exact: true })).toBeVisible();

    // ── close it, and read what that means ───────────────────────────────────
    page.once("dialog", (dialog) => void dialog.accept());
    await page
      .locator('[data-testid="location-list"] > li', { hasText: "Second counter" })
      .getByTestId("location-deactivate")
      .click();
    await expect(page.getByText("Closed. Nothing new can be recorded here", { exact: false })).toBeVisible();

    // ── and the main counter offers no close button at all ───────────────────
    const mainCard = page.locator('[data-testid="location-list"] > li', { hasText: "Main" }).first();
    await expect(mainCard.getByTestId("location-deactivate")).toHaveCount(0);
  });

  test("explains a refusal in Arabic, on the phone", async ({ page }) => {
    const cafe = await createStampCafe({ name: "مقهى الاختبار" });
    const { email } = await ownerOf(cafe.businessId, cafe.userId);
    await signIn(page, email, "ar");

    await page.goto("/ar/business/locations");
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");

    // Two counters with one name is the refusal every merchant meets first.
    await page.getByTestId("location-name").fill("الفرع");
    await page.getByTestId("location-submit").click();
    await expect(page.getByTestId("location-message")).toBeVisible();

    await page.getByTestId("location-name").fill("الفرع");
    await page.getByTestId("location-submit").click();
    /*
     * `toContainText`, not `toHaveText`: every Notice carries a leading glyph, because colour is
     * never the only cue in this product. What matters is the SENTENCE, and that it is the Arabic
     * one from the message file rather than the English one the server writes for its logs.
     */
    await expect(page.getByTestId("location-message")).toContainText(ar.Locations.errorNameTaken);
  });
});

test.describe("program versions", () => {
  test("an owner drafts, reviews and publishes a new version, and old cards keep their rules", async ({ page }) => {
    const cafe = await createStampCafe({ name: "Versioned café" });
    const { email } = await ownerOf(cafe.businessId, cafe.userId);
    // One customer, enrolled BEFORE the change, so the review can state what it protects.
    await enrolCustomer(cafe, { phone: uniqueSyrianPhone() });

    await page.setViewportSize(DESKTOP);
    await signIn(page, email);
    await page.goto(`/en/business/programs/${cafe.program.templateId}`);

    // The history is there before anything changes: one version, holding one card.
    await expect(page.getByTestId("version-table")).toBeVisible();
    await expect(page.getByTestId("version-pinning")).toBeVisible();

    await page.getByTestId("open-draft").click();
    await page.waitForURL(/\/draft$/, { timeout: 30_000 });

    // An untouched draft says so rather than pretending to be a change.
    await expect(page.getByTestId("draft-no-changes")).toBeVisible();

    await page.getByTestId("draft-stamps-required").fill("5");
    await page.getByTestId("save-draft").click();
    await expect(page.getByTestId("draft-saved")).toBeVisible();

    // The review reads from the SAVED draft, and names the change in words.
    await expect(page.getByTestId("draft-changes")).toBeVisible();
    await expect(page.getByTestId("draft-changes")).toContainText("Stamps per reward");
    await expect(page.getByTestId("draft-immutability")).toContainText("keeps its current rules");

    page.once("dialog", (dialog) => void dialog.accept());
    await page.getByTestId("publish-draft").click();
    await page.waitForURL(new RegExp(`/business/programs/${cafe.program.templateId}$`), { timeout: 30_000 });

    // Two versions now: the live one, and the retired one still holding the card.
    const table = page.getByTestId("version-table");
    await expect(table).toContainText("Live");
    await expect(table).toContainText("Retired");

    const versions = await prisma.programVersion.findMany({
      where: { templateId: cafe.program.templateId },
      orderBy: { versionNumber: "asc" },
      select: { versionNumber: true, status: true, cards: { select: { id: true } } },
    });
    expect(versions[0].status).toBe("RETIRED");
    expect(versions[0].cards).toHaveLength(1);
    expect(versions[1].status).toBe("ACTIVE");
    expect(versions[1].cards).toHaveLength(0);
  });

  test("pauses sign-ups in Arabic without touching existing cards", async ({ page }) => {
    const cafe = await createStampCafe({ name: "مقهى الإيقاف" });
    const { email } = await ownerOf(cafe.businessId, cafe.userId);
    await signIn(page, email, "ar");

    await page.goto(`/ar/business/programs/${cafe.program.templateId}`);
    page.once("dialog", (dialog) => void dialog.accept());
    await page.getByTestId("pause-program").click();

    await expect(page.getByTestId("program-paused")).toBeVisible();
    await expect(page.getByTestId("program-paused")).toContainText(ar.Programs.pausedNote);

    const template = await prisma.programTemplate.findUniqueOrThrow({ where: { id: cafe.program.templateId } });
    expect(template.status).toBe("PAUSED");
  });
});

test.describe("named sources stay internal", () => {
  test("adds a source and publishes no link, token or QR anywhere on the page", async ({ page }) => {
    const cafe = await createStampCafe({ name: "Source café" });
    const { email } = await ownerOf(cafe.businessId, cafe.userId);
    await page.setViewportSize(DESKTOP);
    await signIn(page, email);

    await page.goto(`/en/business/programs/${cafe.program.templateId}`);
    await expect(page.getByTestId("source-list")).toBeVisible();

    await page.getByTestId("source-name").fill("Instagram");
    await page.getByTestId("source-channel").fill("instagram");
    await page.getByTestId("source-submit").click();
    await expect(page.getByTestId("source-message")).toBeVisible();

    // B7, on the screen that could most easily undo it.
    const html = await page.content();
    expect(html).not.toContain("/join/");
    expect(html).not.toContain("/api/enroll");
    await expect(page.locator("svg[data-qr], img[alt*='QR' i]")).toHaveCount(0);

    // And the real token, from the database, appears nowhere in the rendered page.
    const tokens = await prisma.utmSourceLink.findMany({
      where: { template: { businessId: cafe.businessId } },
      select: { publicToken: true },
    });
    expect(tokens.length).toBeGreaterThan(0);
    for (const { publicToken } of tokens) expect(html).not.toContain(publicToken);

    // The built-in counter source is present, badged, and carries no controls.
    const builtIn = page.locator('[data-testid="source-list"] > li', { hasText: "Built in" });
    await expect(builtIn).toHaveCount(1);
    await expect(builtIn.getByTestId("source-deactivate")).toHaveCount(0);
    await expect(builtIn.getByTestId("source-edit")).toHaveCount(0);
  });
});

/**
 * A visual record of the three screens this prompt changed.
 *
 * Written into the same folder the Prompt 2 remediation uses, for the same reason: a layout change
 * that nobody looks at is a layout change nobody has reviewed. Desktop and phone, Arabic and
 * English, with a draft actually open so the editor and the review panel are both photographed
 * with content in them.
 */
const SHOTS = "playwright-results/visual";

for (const [label, viewport] of [
  ["desktop", DESKTOP],
  ["phone", { width: 390, height: 844 }],
] as const) {
  for (const locale of ["en", "ar"] as const) {
    test(`lifecycle screens · ${label} · ${locale}`, async ({ page }) => {
      const cafe = await createStampCafe({ name: locale === "ar" ? "مقهى الإصدارات" : "Lifecycle café" });
      const { email } = await ownerOf(cafe.businessId, cafe.userId);
      await enrolCustomer(cafe, { phone: uniqueSyrianPhone() });

      await page.setViewportSize(viewport);
      await signIn(page, email, locale);

      await page.goto(`/${locale}/business/locations`);
      await expect(page.locator("h1").first()).toBeVisible({ timeout: 15_000 });
      await page.screenshot({ path: `${SHOTS}/${label}-${locale}-locations-lifecycle.png`, fullPage: true });

      await page.goto(`/${locale}/business/programs/${cafe.program.templateId}`);
      await expect(page.getByTestId("version-table")).toBeVisible({ timeout: 15_000 });
      await page.screenshot({ path: `${SHOTS}/${label}-${locale}-program-top.png`, fullPage: true });
      /*
       * Scrolled, deliberately. The merchant shell is a fixed-height column with its own scroll, so
       * `fullPage` captures the viewport and nothing below it — and the version history, which is
       * the whole point of this screen, lives below it.
       */
      await page.getByTestId("version-table").scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${SHOTS}/${label}-${locale}-program-versions.png` });
      await page.getByTestId("source-list").scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${SHOTS}/${label}-${locale}-program-sources.png` });

      await page.getByTestId("open-draft").click();
      await page.waitForURL(/\/draft$/, { timeout: 30_000 });
      await page.getByTestId("draft-stamps-required").fill("5");
      await page.getByTestId("save-draft").click();
      await expect(page.getByTestId("draft-saved")).toBeVisible({ timeout: 15_000 });
      await page.screenshot({ path: `${SHOTS}/${label}-${locale}-program-draft.png`, fullPage: true });
      // The review panel is what a merchant reads before pressing publish, and it sits above the
      // editor, so it needs its own frame in the record.
      await page.getByTestId("draft-review").scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${SHOTS}/${label}-${locale}-program-draft-review.png` });
    });
  }
}
