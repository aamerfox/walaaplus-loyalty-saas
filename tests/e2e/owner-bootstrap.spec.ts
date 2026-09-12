import { expect, test } from "@playwright/test";
import { prisma } from "@/server/db";
import { registerTestOwner, TEST_PASSWORD, uniqueSyrianPhone } from "../setup/fixtures";

/**
 * The journey that did not exist: a merchant with an empty account ends up with a customer
 * holding a card, without anyone touching the database.
 *
 * Staging was healthy and a real owner still could not run the café loop, because nothing
 * invoked `createStampProgram`. Every service was in place and unreachable from a browser. This
 * spec walks the whole rung that was missing — sign in, create the card, read the link off the
 * screen, open that link as a customer, join — so the gap cannot reopen quietly.
 *
 * The owner is seeded through the registration service rather than the sign-up form: what is
 * under test here is the bootstrap step after registration, and registration has its own tests.
 * Everything from the sign-in onward is a real browser against the real application.
 */
test.describe("owner bootstrap", () => {
  test("an owner with no card creates one and a customer joins from the link on screen", async ({ page }) => {
    // ── an account exactly as registration leaves it: business, Main location, OWNER, no card ──
    const reg = await registerTestOwner();
    const owner = await prisma.user.findUniqueOrThrow({ where: { id: reg.userId }, select: { email: true } });
    expect(await prisma.programTemplate.count({ where: { businessId: reg.businessId } })).toBe(0);

    // ── 1. the owner signs in ─────────────────────────────────────────────────
    await page.goto("/ar/business/program");
    await page.waitForURL(/\/auth\/login/);
    await page.locator('input[type="email"]').fill(owner.email);
    await page.locator('input[type="password"]').fill(TEST_PASSWORD);
    await page.locator('button[type="submit"]').click();

    // ── 2. and is carried back to where they were headed, on an empty card screen ──
    // Waiting for the redirect rather than navigating again: a second `goto` races the session
    // cookie and lands back on the login form, which is exactly what happened the first time
    // this test ran.
    await page.waitForURL(/\/ar\/business\/program/, { timeout: 30_000 });
    await expect(page.getByTestId("program-form")).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");

    // ── 3. five fields, and nothing this phase does not support ───────────────
    await page.locator("#program-name").fill("بطاقة القهوة");
    await page.locator("#stamps").fill("5");
    await page.locator("#reward-name").fill("قهوة مجانية");
    await page.locator("#welcome-stamps").fill("1");

    // No earn mode, no spend block, no daily limit, no location: not on this screen at all.
    for (const absent of ["#earn-mode", "#location", "#daily-limit", "#spend-amount"]) {
      await expect(page.locator(absent)).toHaveCount(0);
    }

    await page.getByTestId("program-submit").click();

    // ── 4. the link and the QR appear ─────────────────────────────────────────
    await expect(page.getByTestId("program-created")).toBeVisible();
    await expect(page.getByTestId("enrollment-qr").locator("svg")).toHaveCount(1);
    await expect(page.getByTestId("program-summary")).toContainText("قهوة مجانية");
    await expect(page.getByTestId("next-cashier")).toBeVisible();
    await expect(page.getByTestId("next-scanner")).toBeVisible();

    const enrollmentUrl = await page.getByTestId("enrollment-url").inputValue();
    expect(enrollmentUrl).toContain("/join/");

    // Exactly one program, created through the UI.
    expect(await prisma.programTemplate.count({ where: { businessId: reg.businessId } })).toBe(1);

    // ── 5. reloading shows the SAME link, not an offer to create another ──────
    await page.reload();
    await expect(page.getByTestId("program-form")).toHaveCount(0);
    await expect(page.getByTestId("enrollment-url")).toHaveValue(enrollmentUrl);

    // ── 6. a customer opens that exact link and joins ─────────────────────────
    const customer = await page.context().browser()!.newContext();
    const customerPage = await customer.newPage();
    const phone = uniqueSyrianPhone();

    // The URL as printed, absolute and without a locale prefix: the redirect to a negotiated
    // locale is part of what is being proved.
    await customerPage.goto(enrollmentUrl);
    await customerPage.waitForURL(/\/(ar|en)\/join\//);
    await expect(customerPage.getByTestId("join-form")).toBeVisible();

    await customerPage.locator("#phone").fill(`0${phone.slice(4)}`);
    await customerPage.locator("#firstName").fill("ليلى");
    await customerPage.getByTestId("join-submit").click();

    // ── 7. they hold a card, with the welcome stamp the owner chose ───────────
    await customerPage.waitForURL(/\/card\/[A-Za-z0-9_-]{20,}/);
    await expect(customerPage.getByTestId("card-qr")).toBeVisible();
    await expect(customerPage.getByTestId("card-progress")).toContainText("1");

    const cardToken = customerPage.url().split("/card/")[1];
    const card = await prisma.customerCard.findFirstOrThrow({
      where: { shareToken: cardToken },
      select: { businessId: true, stampBalance: true },
    });
    expect(card.businessId).toBe(reg.businessId);
    expect(card.stampBalance).toBe(1);

    await customer.close();
  });
});
