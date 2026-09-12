import { expect, test, type Page } from "@playwright/test";
import { prisma } from "@/server/db";
import {
  createLocation,
  createPointsShop,
  createStampCafe,
  enrolPointsCustomer,
  TEST_PASSWORD,
  uniqueSyrianPhone,
} from "../setup/fixtures";

/**
 * The merchant interface, driven the way a merchant drives it.
 *
 * The viewport is a Pixel 7 (playwright.config.ts), so every journey here is also a phone-width
 * regression: a merchant in a café checks their dashboard on the same device the till runs on.
 *
 * What these tests are for, beyond "the page loads":
 *
 *  - a program created through the UI is a REAL program, with real rows behind it;
 *  - the owner's screens publish no enrolment link, which is owner decision B7 and the one thing
 *    a rebrand-and-redesign prompt could quietly undo;
 *  - the Arabic interface is Arabic — right-to-left, in Arabic words, not a translated English
 *    layout;
 *  - a multi-location program makes the counter CHOOSE, because the server refuses to guess.
 */

async function signIn(page: Page, email: string, locale: "en" | "ar" = "en") {
  await page.goto(`/${locale}/auth/login`);
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(TEST_PASSWORD);
  await page.locator('button[type="submit"]').click();
}

test.describe("owner program management", () => {
  test("an owner creates a points program with tiers and sees it back", async ({ page }) => {
    const cafe = await createStampCafe({ name: "Zademi test café" });
    const owner = await prisma.user.findUniqueOrThrow({ where: { id: cafe.userId }, select: { email: true } });

    await signIn(page, owner.email);
    await page.waitForURL(/\/en\/business/, { timeout: 30_000 });

    // ── the list, and the deliberate second program ──────────────────────────
    await page.goto("/en/business/programs");
    await expect(page.getByTestId("program-list")).toBeVisible();
    await expect(page.getByTestId("programs-enrolment-note")).toBeVisible();

    // B7: no public enrolment anywhere on an owner screen.
    expect(await page.content()).not.toContain("/join/");
    await expect(page.getByTestId("enrollment-url")).toHaveCount(0);

    await page.getByTestId("new-program").click();
    await page.waitForURL(/\/business\/programs\/new/);

    await page.getByTestId("card-type-POINTS").check();
    await page.getByTestId("program-name").fill("Delivery points");
    await page.getByTestId("spend-per-block").fill("1000");
    await page.getByTestId("units-per-block").fill("2");
    await page.getByTestId("tier-name-0").fill("Free drink");
    await page.getByTestId("tier-points-0").fill("20");
    await page.getByTestId("tier-value-0").fill("5000");

    await page.getByTestId("add-tier").click();
    await page.getByTestId("tier-name-1").fill("Free meal");
    await page.getByTestId("tier-points-1").fill("100");

    await page.getByTestId("create-program").click();

    // ── the detail screen, from the row that was actually written ────────────
    await page.waitForURL(/\/business\/programs\/[0-9a-f-]{36}/, { timeout: 30_000 });
    await expect(page.getByTestId("program-rules")).toContainText("2");
    await expect(page.getByTestId("tier-list")).toContainText("Free drink");
    await expect(page.getByTestId("tier-list")).toContainText("Free meal");
    await expect(page.getByTestId("program-immutable")).toBeVisible();
    await expect(page.getByTestId("program-counter-note")).toBeVisible();

    const template = await prisma.programTemplate.findFirstOrThrow({
      where: { businessId: cafe.businessId, cardType: "POINTS" },
      select: { id: true, name: true, versions: { select: { id: true, rewardTiers: { select: { requiredPoints: true } } } } },
    });
    expect(template.name).toBe("Delivery points");
    expect(template.versions[0].rewardTiers.map((t) => t.requiredPoints).sort((a, b) => a - b)).toEqual([20, 100]);

    // The stamp program is untouched: two programs, two kinds, one business.
    expect(await prisma.programTemplate.count({ where: { businessId: cafe.businessId } })).toBe(2);
  });

  test("invalid input is refused in the form, and no request is sent", async ({ page }) => {
    const cafe = await createStampCafe({ name: "Validation café" });
    const owner = await prisma.user.findUniqueOrThrow({ where: { id: cafe.userId }, select: { email: true } });

    await signIn(page, owner.email);
    await page.waitForURL(/\/en\/business/, { timeout: 30_000 });
    await page.goto("/en/business/programs/new");

    // Watch the network: a form that validates only on the server still sends the bad request, and
    // this test is the difference between "it shows an error" and "it never asked".
    const requests: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/api/staff/programs")) requests.push(request.url());
    });

    await page.getByTestId("card-type-POINTS").check();
    await page.getByTestId("program-name").fill("");
    await page.getByTestId("tier-points-0").fill("1.5");
    await page.getByTestId("create-program").click();

    await expect(page.getByTestId("program-errors")).toBeVisible();
    expect(requests).toHaveLength(0);
    expect(await prisma.programTemplate.count({ where: { businessId: cafe.businessId, cardType: "POINTS" } })).toBe(0);
  });
});

test.describe("the Arabic interface", () => {
  test("is right-to-left and in Arabic, on the merchant screens", async ({ page }) => {
    const cafe = await createStampCafe({ name: "مقهى الاختبار" });
    const owner = await prisma.user.findUniqueOrThrow({ where: { id: cafe.userId }, select: { email: true } });

    await signIn(page, owner.email, "ar");
    await page.waitForURL(/\/ar\/business/, { timeout: 30_000 });

    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await expect(page.locator("html")).toHaveAttribute("lang", "ar");

    // Navigation is Arabic words, not English ones in an RTL box. The phone menu holds it at this
    // width, so it is opened rather than assumed.
    await page.getByTestId("open-menu").click();
    await expect(page.getByRole("link", { name: "برامج الولاء" })).toBeVisible();
    await page.getByTestId("close-menu").click();

    await page.goto("/ar/business/programs");
    await expect(page.getByTestId("programs-enrolment-note")).toContainText("الكاشير");

    // The locale switch is a control with a destination, and it works both ways.
    await page.getByTestId("toggle-locale").click();
    await page.waitForURL(/\/en\/business\/programs/, { timeout: 30_000 });
    await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
  });
});

test.describe("the counter", () => {
  test("serves a points card and requires a location when the program runs at several", async ({ page }) => {
    const cafe = await createStampCafe({ name: "Two counters café" });
    const branch = await createLocation(cafe, "Branch");
    const shop = await createPointsShop({
      existing: { userId: cafe.userId, businessId: cafe.businessId, locationId: cafe.locationId },
      name: "Two counters points",
      mechanics: { availableLocations: [cafe.locationId, branch] },
    });
    const owner = await prisma.user.findUniqueOrThrow({ where: { id: cafe.userId }, select: { email: true } });

    const phone = uniqueSyrianPhone();
    await enrolPointsCustomer(shop, { phone });

    await signIn(page, owner.email);
    await page.waitForURL(/\/en\/business/, { timeout: 30_000 });
    await page.goto("/en/scanner");

    await page.getByTestId("scanner-tab-phone").click();
    await page.getByTestId("scanner-phone-input").fill(`0${phone.slice(4)}`);
    await page.getByTestId("scanner-phone-lookup").click();

    await expect(page.getByTestId("scanner-card")).toBeVisible();
    await expect(page.getByTestId("scanner-program")).toContainText("Two counters points");
    await expect(page.getByTestId("scanner-points")).toBeVisible();

    // Two counters on offer: the write is blocked until one is chosen, because the server refuses
    // to guess which branch earned it.
    await expect(page.getByTestId("scanner-location-required")).toBeVisible();
    await expect(page.getByTestId("scanner-points-award")).toBeDisabled();

    await page.getByTestId("scanner-location-select").selectOption(branch);
    await expect(page.getByTestId("scanner-points-award")).toBeEnabled();

    await page.getByTestId("scanner-points-quantity").fill("25");
    await page.getByTestId("scanner-points-award").click();
    await expect(page.getByTestId("scanner-points")).toContainText("25");

    const card = await prisma.customerCard.findFirstOrThrow({
      where: { businessId: cafe.businessId, templateId: shop.program.templateId },
      select: { id: true, pointBalance: true },
    });
    expect(card.pointBalance).toBe(25);

    // And it was attributed to the branch the cashier chose, not to Main.
    const rows = await prisma.loyaltyOperation.findMany({
      where: { customerCardId: card.id, kind: "MANUAL_AWARD" },
      select: { locationId: true },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].locationId).toBe(branch);

    // A reward the balance cannot pay for stays disabled; the affordable one redeems.
    const tiers = await prisma.rewardTier.findMany({
      where: { programVersionId: shop.program.programVersionId },
      select: { id: true, requiredPoints: true },
      orderBy: { requiredPoints: "asc" },
    });
    await expect(page.getByTestId(`scanner-redeem-tier-${tiers[1].id}`)).toBeDisabled();
    await page.getByTestId(`scanner-redeem-tier-${tiers[0].id}`).click();
    await expect(page.getByTestId("scanner-points")).toContainText("15");
  });

  test("never shows a card link until staff ask for it", async ({ page }) => {
    const shop = await createPointsShop({ name: "Reveal points" });
    const owner = await prisma.user.findUniqueOrThrow({ where: { id: shop.userId }, select: { email: true } });
    const phone = uniqueSyrianPhone();
    const enrolled = await enrolPointsCustomer(shop, { phone });

    await signIn(page, owner.email);
    await page.waitForURL(/\/en\/business/, { timeout: 30_000 });
    await page.goto("/en/scanner");

    await page.getByTestId("scanner-tab-phone").click();
    await page.getByTestId("scanner-phone-input").fill(`0${phone.slice(4)}`);
    await page.getByTestId("scanner-phone-lookup").click();
    await expect(page.getByTestId("scanner-card")).toBeVisible();

    // The capability is not on the screen, and not in the DOM either.
    await expect(page.getByTestId("scanner-card-link")).toHaveCount(0);
    expect(await page.content()).not.toContain(enrolled.shareToken);

    await page.getByTestId("scanner-reveal-link").click();
    await expect(page.getByTestId("scanner-card-link")).toBeVisible();
    expect(await page.getByTestId("scanner-card-link-url").inputValue()).toContain("/card/");

    // The reveal is audited, and the audit row carries no token and no URL.
    const reveals = await prisma.auditLog.findMany({
      where: { businessId: shop.businessId, action: "card.link_revealed" },
      select: { metadata: true },
    });
    expect(reveals).toHaveLength(1);
    const serialized = JSON.stringify(reveals);
    expect(serialized).not.toContain(enrolled.shareToken);
    expect(serialized).not.toContain("http");
  });
});

test.describe("the Zademi brand", () => {
  test("names the product and shows no old branding", async ({ page }) => {
    const cafe = await createStampCafe({ name: "Brand café" });
    const owner = await prisma.user.findUniqueOrThrow({ where: { id: cafe.userId }, select: { email: true } });
    // The fixture names the PROGRAM; the business gets its own name at registration, and the header
    // shows that one - resolved from the membership on this request, not from the session token.
    const business = await prisma.business.findUniqueOrThrow({ where: { id: cafe.businessId }, select: { name: true } });

    await signIn(page, owner.email);
    await page.waitForURL(/\/en\/business/, { timeout: 30_000 });

    await expect(page).toHaveTitle(/Zademi/);
    await expect(page.getByTestId("current-business")).toContainText(business.name);

    const html = await page.content();
    expect(html).not.toContain("WalaaPlus");

    // Sign-out is a control that works, which the sidebar's used not to be.
    //
    // `:visible` because the navigation exists twice in the DOM at every width - once in the desktop
    // rail, once in the phone drawer - and only one of them is on screen. Clicking "the one a person
    // can see" is also the only click a person can make.
    await page.getByTestId("open-menu").click();
    await page.locator('[data-testid="sign-out"]:visible').click();
    await page.waitForURL(/\/auth\/login/, { timeout: 30_000 });
  });
});
