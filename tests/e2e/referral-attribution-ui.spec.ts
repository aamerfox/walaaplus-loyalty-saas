import { expect, test, type Page } from "@playwright/test";
import ar from "../../messages/ar.json";
import { prisma } from "@/server/db";
import { mintShareLink } from "@/server/share/share-links";
import { createStampCafe, enrolCustomer, TEST_PASSWORD, uniqueSyrianPhone } from "../setup/fixtures";

/**
 * Recording an invitation at the till, and reading it back on the customer's record.
 *
 * What these hold beyond "the screens work":
 *
 *  - **the capability never reaches a URL.** Every request the browser makes while enrolling is
 *    recorded and the token is asserted absent from all of them — it travels in a POST body and
 *    nowhere else;
 *  - **staff are never shown the referrer.** Not on the till, not on the customer record, not in any
 *    rendered HTML;
 *  - **nothing is promised.** No screen in either language says anybody earned anything;
 *  - **a cashier may record and may not withdraw**, and the difference is visible in the UI;
 *  - **the public page is untouched** and still enrols nobody.
 *
 * The default viewport is a Pixel 7 (playwright.config.ts); the desktop passes set 1440×900.
 */

const DESKTOP = { width: 1440, height: 900 };
const SHOTS = "playwright-results/visual";

/** Wording that would promise something the product has not built. */
const REWARD_WORDS = /\breward|\bearn\b|\bbonus\b|\bfree\b|\bdiscount\b|مكافأ|مكافآ|اربح|خصم|مجان/i;

async function emailOf(userId: string) {
  return (await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true } })).email;
}

async function signIn(page: Page, email: string, locale: "en" | "ar" = "en") {
  await page.goto(`/${locale}/auth/login`);
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(TEST_PASSWORD);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL(new RegExp(`/${locale}/business`), { timeout: 30_000 });
}

/** A café with one existing customer holding a live invitation. */
async function cafeWithReferrer(name: string) {
  const cafe = await createStampCafe({ name });
  const referrer = await enrolCustomer(cafe, { phone: uniqueSyrianPhone(), firstName: "ليلى" });
  const minted = await mintShareLink(cafe.ctx, referrer.customerCardId, "WALLET_PASS");
  const card = await prisma.customerCard.findUniqueOrThrow({
    where: { id: referrer.customerCardId },
    select: { qrToken: true, shareToken: true, serialNumber: true },
  });
  return { cafe, referrer, card, token: minted.rawToken };
}

/** Drive the till: search a number that does not exist, then enrol with an invitation. */
async function enrolAtCounter(page: Page, phone: string, invitation?: string) {
  // The phone lookup lives behind its own tab; the scanner opens on the QR one.
  await page.getByTestId("scanner-tab-phone").click();
  await page.getByTestId("scanner-phone-input").fill(phone);
  await page.getByTestId("scanner-phone-lookup").click();
  await expect(page.getByTestId("scanner-enroll")).toBeVisible({ timeout: 30_000 });

  await page.getByTestId("scanner-enroll-first-name").fill("Omar");
  if (invitation !== undefined) await page.getByTestId("scanner-referral-input").fill(invitation);
  await page.getByTestId("scanner-enroll-submit").click();
}

test.describe("recording an invitation at the till", () => {
  test("records it, says so, and never puts the capability in a URL", async ({ page }) => {
    const fx = await cafeWithReferrer("Till café");
    await signIn(page, await emailOf(fx.cafe.userId));

    /*
     * Every request the browser makes while enrolling. The capability must be in none of their
     * URLs: it goes in a POST body, which is the only shape that keeps it out of an access log, a
     * proxy log and a `Referer` header.
     */
    const requestUrls: string[] = [];
    page.on("request", (request) => requestUrls.push(request.url()));

    await page.goto("/en/scanner");
    // Staff paste the FULL invitation URL; the fragment is taken from it on this device.
    await enrolAtCounter(page, uniqueSyrianPhone(), `https://zademi.example/share#${fx.token}`);

    await expect(page.getByTestId("scanner-feedback")).toContainText("Invitation recorded");

    expect(requestUrls.length).toBeGreaterThan(0);
    for (const url of requestUrls) {
      expect(url, `the capability must not appear in a request URL: ${url}`).not.toContain(fx.token);
    }

    // Nothing about the referring customer reached the till.
    const html = await page.content();
    for (const secret of [fx.token, fx.card.qrToken, fx.card.shareToken, fx.card.serialNumber, "ليلى"]) {
      expect(html, `the till must not carry ${secret}`).not.toContain(secret);
    }

    await page.screenshot({ path: `${SHOTS}/phone-en-referral-till.png`, fullPage: true });

    const row = await prisma.referralAttribution.findFirstOrThrow({ where: { businessId: fx.cafe.businessId } });
    expect(row.entry).toBe("ATTRIBUTED");
    expect(row.referringCustomerCardId).toBe(fx.referrer.customerCardId);
  });

  test("says the invitation could not be used, and enrols the customer anyway", async ({ page }) => {
    const fx = await cafeWithReferrer("Refusal café");
    await signIn(page, await emailOf(fx.cafe.userId));

    await page.goto("/en/scanner");
    await enrolAtCounter(page, uniqueSyrianPhone(), "https://zademi.example/share#not-a-real-invitation-at-all-xxxx");

    // The enrolment is what succeeded, so it leads. The refusal names no reason.
    const feedback = await page.getByTestId("scanner-feedback").innerText();
    expect(feedback).toContain("could not be used");
    expect(feedback).not.toMatch(/revoked|expired|another business|unknown|not found/i);

    await expect(page.getByTestId("scanner-card-link")).toBeVisible();
    expect(await prisma.referralAttribution.count({ where: { businessId: fx.cafe.businessId } })).toBe(0);
  });

  test("enrols normally when no invitation is offered", async ({ page }) => {
    const fx = await cafeWithReferrer("Plain café");
    await signIn(page, await emailOf(fx.cafe.userId));

    await page.goto("/en/scanner");
    await enrolAtCounter(page, uniqueSyrianPhone());

    const feedback = await page.getByTestId("scanner-feedback").innerText();
    expect(feedback).not.toContain("Invitation");
    expect(await prisma.referralAttribution.count({ where: { businessId: fx.cafe.businessId } })).toBe(0);
  });

  test("offers the field in Arabic, right to left, and promises nothing", async ({ page }) => {
    const fx = await cafeWithReferrer("مقهى الدعوة");
    await signIn(page, await emailOf(fx.cafe.userId), "ar");

    await page.goto("/ar/scanner");
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");

    // The field, read while it is on screen: the enrol section closes once enrolment succeeds.
    await page.getByTestId("scanner-tab-phone").click();
    await page.getByTestId("scanner-phone-input").fill(uniqueSyrianPhone());
    await page.getByTestId("scanner-phone-lookup").click();
    await expect(page.getByTestId("scanner-enroll")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("scanner-referral-input")).toHaveAttribute("placeholder", ar.Scanner.referralPlaceholder);

    const enrolSection = await page.getByTestId("scanner-enroll").innerText();
    expect(enrolSection, "the till must promise no reward").not.toMatch(REWARD_WORDS);

    await page.screenshot({ path: `${SHOTS}/phone-ar-referral-till.png`, fullPage: true });

    await page.getByTestId("scanner-referral-input").fill(fx.token);
    await page.getByTestId("scanner-enroll-submit").click();
    await expect(page.getByTestId("scanner-feedback")).toContainText(ar.Scanner.referralRecorded);
  });
});

test.describe("the customer's own record", () => {
  test("says they arrived with an invitation, and never who sent it", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    const fx = await cafeWithReferrer("Record café");
    await signIn(page, await emailOf(fx.cafe.userId));

    await page.goto("/en/scanner");
    await enrolAtCounter(page, uniqueSyrianPhone(), fx.token);
    await expect(page.getByTestId("scanner-feedback")).toContainText("Invitation recorded");

    const attribution = await prisma.referralAttribution.findFirstOrThrow({ where: { businessId: fx.cafe.businessId } });
    const enrolledProfileId = attribution.enrolledProfileId;

    await page.goto(`/en/business/customers/${enrolledProfileId}`);
    await expect(page.getByTestId("referral-panel")).toBeVisible();
    await expect(page.getByTestId("referral-state")).toHaveText("Recorded as arriving with an invitation");
    await expect(page.getByTestId("referral-no-referrer")).toBeVisible();
    await expect(page.getByTestId("referral-no-reward")).toBeVisible();

    await page.getByTestId("referral-panel").scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${SHOTS}/desktop-en-referral-record.png`, fullPage: true });

    // The referring customer is nowhere on this page — not their name, card, tokens or ids.
    const html = await page.content();
    for (const secret of [
      fx.token,
      fx.card.qrToken,
      fx.card.shareToken,
      fx.card.serialNumber,
      fx.referrer.customerCardId,
      fx.referrer.customerBusinessProfileId,
      "ليلى",
    ]) {
      expect(html, `the customer record must not carry ${secret}`).not.toContain(secret);
    }

    // The aggregate is a count, with no list behind it.
    await expect(page.getByTestId("referral-counts")).toContainText("1 customer has been recorded");
    await expect(page.getByTestId("referral-counts")).toContainText("keeps no list of who invited whom");

    /*
     * Scoped to the referral panel, not the whole page. A customer record legitimately shows a
     * loyalty card's rewards balance and reward name — that is the product — and a blanket scan
     * would have to be weakened until it proved nothing. What must promise nothing is this panel.
     */
    const panel = await page.getByTestId("referral-panel").innerText();
    expect(panel, "the referral record must promise no reward").not.toMatch(REWARD_WORDS);
    const counts = await page.getByTestId("referral-counts").innerText();
    expect(counts, "the aggregate must promise no reward").not.toMatch(REWARD_WORDS);
  });

  test("says nothing was recorded for a customer who arrived without one", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    const fx = await cafeWithReferrer("Plain record café");
    await signIn(page, await emailOf(fx.cafe.userId));

    await page.goto(`/en/business/customers/${fx.referrer.customerBusinessProfileId}`);
    await expect(page.getByTestId("referral-none")).toBeVisible();
    await expect(page.getByTestId("referral-panel")).toHaveCount(0);
  });

  test("lets an owner withdraw a record, in two steps, keeping both rows", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    const fx = await cafeWithReferrer("Withdraw café");
    await signIn(page, await emailOf(fx.cafe.userId));

    await page.goto("/en/scanner");
    await enrolAtCounter(page, uniqueSyrianPhone(), fx.token);
    await expect(page.getByTestId("scanner-feedback")).toContainText("Invitation recorded");
    const attribution = await prisma.referralAttribution.findFirstOrThrow({ where: { businessId: fx.cafe.businessId } });

    await page.goto(`/en/business/customers/${attribution.enrolledProfileId}`);
    await page.getByTestId("referral-void").click();
    await expect(page.getByTestId("referral-void-confirm")).toContainText("cannot be attributed again");
    await page.getByTestId("referral-void-reason").fill("scanned the wrong phone");
    await page.getByTestId("referral-void-yes").click();

    await expect(page.getByTestId("referral-state")).toHaveText("This record was withdrawn", { timeout: 30_000 });

    const rows = await prisma.referralAttribution.findMany({
      where: { businessId: fx.cafe.businessId },
      orderBy: { recordedAt: "asc" },
    });
    expect(rows.map((r) => r.entry)).toEqual(["ATTRIBUTED", "VOIDED"]);
    expect(rows[1].voidsAttributionId).toBe(rows[0].id);
  });
});

test.describe("the boundary holds", () => {
  test("the public invitation page still enrols nobody", async ({ page }) => {
    const fx = await cafeWithReferrer("Boundary café");
    const before = {
      cards: await prisma.customerCard.count(),
      attributions: await prisma.referralAttribution.count(),
    };

    await page.goto(`/en/share#${fx.token}`);
    await expect(page.getByTestId("share-invite")).toBeVisible();
    // No form, no field, and nothing that claims an invitation.
    await expect(page.locator("main form")).toHaveCount(0);
    await expect(page.locator("main input")).toHaveCount(0);

    expect({
      cards: await prisma.customerCard.count(),
      attributions: await prisma.referralAttribution.count(),
    }).toEqual(before);
  });

  test("B7 is unchanged by any of this", async ({ page }) => {
    for (const method of ["GET", "POST"] as const) {
      const response = await page.request.fetch("/api/enroll", { method });
      expect(response.status(), `${method} /api/enroll`).toBe(410);
    }
    const join = await page.request.get("/join/anything-at-all");
    expect(join.status()).toBeLessThan(400);
    expect(await join.text()).not.toContain("<form");
  });

  test("offers no public route that claims or lists a referral", async ({ page }) => {
    const fx = await cafeWithReferrer("No-claim café");
    for (const path of ["/api/referrals", "/api/staff/referrals", "/api/referral/claim", "/en/referral"]) {
      const response = await page.request.get(path);
      const body = await response.text();
      expect(body, `${path} must reveal nothing`).not.toContain(fx.token);
      expect(body, `${path} must reveal nothing`).not.toContain(fx.card.qrToken);
      expect(body).not.toContain('"entry":"ATTRIBUTED"');
    }
  });
});
