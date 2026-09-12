import { expect, test } from "@playwright/test";
import { AuditAction } from "@/server/audit/audit";
import { prisma } from "@/server/db";
import { registerTestOwner, TEST_PASSWORD, uniqueSyrianPhone } from "../setup/fixtures";

/**
 * A merchant with an empty account ends up with a customer holding a card, without anyone
 * touching the database.
 *
 * Staging was healthy and a real owner still could not run the café loop, because nothing
 * invoked `createStampProgram`. Every service was in place and unreachable from a browser.
 *
 * Sign in, create the loyalty card, then enrol a customer AT THE COUNTER and watch them open the
 * link they were handed. Enrolment moved here from a public join page by owner decision B7
 * option 3: a public form that issued a card to a new number and nothing to an existing one told
 * whoever submitted it which case they hit.
 *
 * The owner is seeded through the registration service rather than the sign-up form: what is
 * under test here is the bootstrap step after registration, and registration has its own tests.
 * Everything from the sign-in onward is a real browser against the real application.
 */
test.describe("owner bootstrap", () => {
  test("an owner with no card creates one, then enrols a customer at the counter", async ({ page }) => {
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

    // ── 4. the card is created, and the screen says where to enrol people ────
    await expect(page.getByTestId("program-created")).toBeVisible();
    await expect(page.getByTestId("program-summary")).toContainText("قهوة مجانية");
    await expect(page.getByTestId("enrollment-guidance")).toBeVisible();
    await expect(page.getByTestId("next-scanner")).toBeVisible();

    /*
     * No public enrolment link or QR anywhere on this screen. Owner decision B7 option 3 withdrew
     * public self-service enrolment, and a screen that still published the link would be handing
     * out an address that now answers "ask at the counter".
     */
    await expect(page.getByTestId("enrollment-url")).toHaveCount(0);
    await expect(page.getByTestId("enrollment-qr")).toHaveCount(0);
    const html = await page.content();
    expect(html).not.toContain("/join/");

    // Exactly one program, created through the UI.
    expect(await prisma.programTemplate.count({ where: { businessId: reg.businessId } })).toBe(1);

    // ── 5. the owner enrols a customer at the counter ────────────────────────
    await page.getByTestId("next-scanner").click();
    await page.waitForURL(/\/ar\/scanner(\?|$)/, { timeout: 30_000 });

    const phone = uniqueSyrianPhone();
    const localPhone = `0${phone.slice(4)}`;

    await page.getByTestId("scanner-tab-phone").click();
    await page.getByTestId("scanner-phone-input").fill(localPhone);
    await page.getByTestId("scanner-phone-lookup").click();

    // Nobody found, so the counter offers to sign them up rather than stopping.
    await expect(page.getByTestId("scanner-enroll")).toBeVisible();
    await expect(page.getByTestId("scanner-enroll-phone")).toContainText(localPhone);

    await page.getByTestId("scanner-enroll-first-name").fill("ليلى");
    await page.getByTestId("scanner-enroll-consent").check();
    await page.getByTestId("scanner-enroll-submit").click();

    // ── 6. the customer's own link and QR appear, for staff to hand over ─────
    await expect(page.getByTestId("scanner-card-link")).toBeVisible();
    await expect(page.getByTestId("scanner-card-qr").locator("svg")).toHaveCount(1);
    const cardUrl = await page.getByTestId("scanner-card-link-url").inputValue();
    expect(cardUrl).toContain("/card/");

    // And the card is loaded, so a stamp can be awarded without searching again.
    await expect(page.getByTestId("scanner-card")).toBeVisible();
    await expect(page.getByTestId("scanner-stamps")).toContainText("1");

    // ── 7. the customer loses the link, and staff restore it at the counter ──
    // The reason the public "type your number and get your card back" page could be withdrawn:
    // there is still a way back to a card, it just runs through a member of staff.
    await page.getByTestId("scanner-phone-input").fill(localPhone);
    await page.getByTestId("scanner-phone-lookup").click();
    await expect(page.getByTestId("scanner-card")).toBeVisible();
    await expect(page.getByTestId("scanner-card-link")).toHaveCount(0);

    await page.getByTestId("scanner-reveal-link").click();
    await expect(page.getByTestId("scanner-card-link")).toBeVisible();
    expect(await page.getByTestId("scanner-card-link-url").inputValue()).toBe(cardUrl);

    // Revealing a link is audited, and the audit row must not carry the link itself.
    const reveals = await prisma.auditLog.findMany({
      where: { businessId: reg.businessId, action: AuditAction.CARD_LINK_REVEALED },
      select: { metadata: true },
    });
    expect(reveals).toHaveLength(1);
    expect(JSON.stringify(reveals)).not.toContain(cardUrl.split("/card/")[1]);

    // ── 8. the customer opens the link they were given ───────────────────────
    const customer = await page.context().browser()!.newContext();
    const customerPage = await customer.newPage();
    await customerPage.goto(cardUrl);
    await customerPage.waitForURL(/\/(ar|en)\/card\//);
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
