import { expect, test, type Page } from "@playwright/test";
import ar from "../../messages/ar.json";
import { prisma } from "@/server/db";
import { createStampCafe, enrolCustomer, TEST_PASSWORD, uniqueSyrianPhone } from "../setup/fixtures";

/**
 * Approval, withdrawal and the audience snapshot, driven the way a merchant drives them.
 *
 * What these hold beyond "the page renders":
 *
 *  - **approving takes two deliberate steps**, and the confirmation says what is about to become
 *    permanent;
 *  - **the screen never stops saying that nothing sends** — not on the banner, not in the approval
 *    panel, and not in the readiness list, whose last line is the reason that never clears;
 *  - **no control sends, schedules or queues**, including a disabled one;
 *  - **no recipient reaches the browser.** The real tokens, serial and phone are read out of the
 *    database and asserted absent from the rendered HTML — which, for an approved campaign, is the
 *    moment the product is holding a list of contactable people for the first time;
 *  - **editing approved words visibly un-approves the campaign**;
 *  - **B7 is untouched.**
 *
 * The default viewport is a Pixel 7 (playwright.config.ts); the desktop passes set 1440×900.
 */

const DESKTOP = { width: 1440, height: 900 };
const SHOTS = "playwright-results/visual";

/** Words a delivery CONTROL could be labelled with, in both locales. Matched against control names. */
const SENDING_WORDS = /send|schedul|queue|dispatch|إرسال|جدول/i;

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

/** Every button and link inside the page body, by the name a person would read. */
async function controlNames(page: Page): Promise<string[]> {
  const main = page.locator("main");
  const names = await main.getByRole("button").or(main.getByRole("link")).allInnerTexts();
  return names.map((name) => name.trim()).filter(Boolean);
}

/**
 * The browser suite shares ONE database across every spec and never truncates between tests, so
 * every row a test reads back must be scoped to the café that test created. A bare `count()` here
 * counts every other test's campaigns too — which is how an assertion quietly stops meaning
 * anything while still passing.
 */
function scoped(businessId: string) {
  return {
    approvals: () => prisma.campaignApproval.findMany({ where: { businessId }, orderBy: { decidedAt: "asc" } }),
    approvalCount: () => prisma.campaignApproval.count({ where: { businessId } }),
    snapshots: () => prisma.campaignAudienceSnapshot.findMany({ where: { businessId } }),
    revisions: () =>
      prisma.campaignRevision.findMany({
        where: { campaign: { businessId } },
        orderBy: { revisionNumber: "asc" },
      }),
  };
}

/** A screenshot of the page as a person first meets it; the shell scrolls `main`, not the document. */
async function shotOf(page: Page, testId: string, name: string) {
  await page.getByTestId(testId).scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
}

/**
 * A café, a consenting customer, a segment matching everybody, and a draft pointed at it — built
 * through the UI where the UI is the thing under test, and through the services where it is not.
 */
async function cafeWithDraft(page: Page, name: string, locale: "en" | "ar" = "en") {
  const cafe = await createStampCafe({ name });
  const customer = await enrolCustomer(cafe, { phone: uniqueSyrianPhone(), firstName: "ليلى" });
  // An explicit, dated, versioned agreement, recorded the way the counter records one.
  await prisma.consentRecord.create({
    data: {
      businessId: cafe.businessId,
      customerBusinessProfileId: customer.customerBusinessProfileId,
      scope: "MARKETING",
      state: "GRANTED",
      previousState: "WITHDRAWN",
      capturedVia: "STAFF_UPDATE",
      policyVersion: "2026-09-12.1",
      recordedAt: new Date(),
      actorUserId: cafe.userId,
    },
  });

  await signIn(page, await emailOf(cafe.userId), locale);

  await page.goto(`/${locale}/business/segments`);
  await page.getByTestId("segment-name").fill(locale === "ar" ? "الجميع" : "Everyone");
  await page.getByTestId("segment-field-0").selectOption("stampBalance");
  await page.getByTestId("segment-value-0").fill("0");
  await page.getByTestId("segment-save").click();
  await expect(page.getByTestId("segment-list")).toBeVisible();

  await page.goto(`/${locale}/business/campaigns`);
  await page.getByTestId("campaign-name").fill(locale === "ar" ? "عرض الخريف" : "Autumn offer");
  await page.getByTestId("campaign-segment").selectOption({ index: 1 });
  await page.getByTestId("campaign-body").fill(locale === "ar" ? "مرحباً {{firstName}}" : "Hello {{firstName}}");
  await page.getByTestId("campaign-save").click();
  await page.waitForURL(new RegExp(`/business/campaigns$`), { timeout: 30_000 });

  await page.getByTestId("campaign-list").getByRole("link").first().click();
  await page.waitForURL(/\/business\/campaigns\/[^/]+$/, { timeout: 30_000 });

  return { cafe, customer };
}

test.describe("approving a campaign", () => {
  test("takes two deliberate steps, records the decision, and still sends nothing", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    const { cafe, customer } = await cafeWithDraft(page, "Approval café");

    // Before any decision: nothing is frozen and nothing is deliverable.
    await expect(page.getByTestId("snapshot-none")).toBeVisible();
    await expect(page.getByTestId("decisions-empty")).toBeVisible();
    await expect(page.getByTestId("readiness-blockers")).toContainText("Nobody has approved");

    // One click opens a confirmation rather than writing history.
    await page.getByTestId("campaign-approve").click();
    await expect(page.getByTestId("approval-confirm")).toBeVisible();
    await expect(page.getByTestId("approval-confirm")).toContainText("cannot be edited or deleted");
    const mine = scoped(cafe.businessId);
    expect(await mine.approvalCount()).toBe(0);

    // Backing out writes nothing either.
    await page.getByTestId("approval-confirm-no").click();
    await expect(page.getByTestId("approval-confirm")).toHaveCount(0);
    expect(await mine.approvalCount()).toBe(0);

    await page.getByTestId("campaign-approve").click();
    await page.getByTestId("approval-note").fill("read it twice");
    await page.getByTestId("approval-confirm-yes").click();

    await expect(page.getByTestId("campaign-state")).toHaveText("Approved");
    await expect(page.getByTestId("snapshot-counts")).toBeVisible();
    // One customer matched and one may be contacted, because one person actually agreed.
    await expect(page.getByTestId("snapshot-counts")).toContainText("1 customer matched");
    await expect(page.getByTestId("decision-table")).toContainText("Approved");
    await expect(page.getByTestId("decision-table")).toContainText("read it twice");

    await shotOf(page, "campaign-approval", "desktop-en-campaign-approved");

    /*
     * The moment that matters for privacy: the product is now holding a list of contactable people
     * for the first time, and none of it may reach the browser.
     */
    const html = await page.content();
    const card = await prisma.customerCard.findUniqueOrThrow({
      where: { id: customer.customerCardId },
      select: { qrToken: true, shareToken: true, serialNumber: true, utmSourceLink: { select: { publicToken: true } } },
    });
    const phone = (await prisma.customer.findFirstOrThrow({ select: { normalizedPhone: true } })).normalizedPhone;
    for (const secret of [card.qrToken, card.shareToken, card.serialNumber, card.utmSourceLink!.publicToken, phone]) {
      expect(html, `an approved campaign page must not carry ${secret}`).not.toContain(secret);
    }
    expect(html).not.toContain(customer.customerBusinessProfileId);

    // And the standing fact, in both places it is claimed.
    await expect(page.getByTestId("approval-sends-nothing")).toBeVisible();
    await expect(page.getByTestId("readiness-blockers")).toContainText("no provider, no schedule, no queue");

    const names = await controlNames(page);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) expect(name, `"${name}" must not offer delivery`).not.toMatch(SENDING_WORDS);
    await expect(page.locator("main button:disabled")).toHaveCount(0);

    // The database agrees with the screen.
    const approvals = await mine.approvals();
    expect(approvals).toHaveLength(1);
    expect(approvals[0].decision).toBe("APPROVED");
    expect(approvals[0].revisionNumber).toBe(1);

    const snapshots = await mine.snapshots();
    expect(snapshots).toHaveLength(1);
    expect(await prisma.campaignAudienceMember.count({ where: { snapshotId: snapshots[0].id } })).toBe(1);
  });

  test("un-approves itself when the words change, and says so", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    const { cafe } = await cafeWithDraft(page, "Editing café");
    const mine = scoped(cafe.businessId);

    await page.getByTestId("campaign-approve").click();
    await page.getByTestId("approval-confirm-yes").click();
    await expect(page.getByTestId("campaign-state")).toHaveText("Approved");

    // A typo spotted after approval. Fixing it must not carry the approval along.
    await page.getByTestId("campaign-body").fill("Hello {{firstName}}, one more thing");
    await page.getByTestId("campaign-save").click();
    await expect(page.getByTestId("campaign-state")).toHaveText("Draft", { timeout: 30_000 });

    // The decision stays in the history, still true about the revision it named.
    await expect(page.getByTestId("decision-table")).toContainText("Approved");
    await expect(page.getByTestId("snapshot-none")).toBeVisible();
    await expect(page.getByTestId("readiness-blockers")).toContainText("Nobody has approved");

    const revisions = await mine.revisions();
    expect(revisions).toHaveLength(2);
    // The approved words are untouched. An edit writes a new row; it never rewrites an old one.
    expect(revisions[0].body).toBe("Hello {{firstName}}");
    expect(await mine.approvalCount()).toBe(1);
  });

  test("withdraws an approval by adding to the history, never by erasing it", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    const { cafe } = await cafeWithDraft(page, "Withdrawal café");
    const mine = scoped(cafe.businessId);

    await page.getByTestId("campaign-approve").click();
    await page.getByTestId("approval-confirm-yes").click();
    await expect(page.getByTestId("campaign-state")).toHaveText("Approved");

    await page.getByTestId("campaign-withdraw").click();
    await expect(page.getByTestId("approval-confirm")).toContainText("stays in the history");
    await page.getByTestId("approval-note").fill("wrong month");
    await page.getByTestId("approval-confirm-yes").click();

    await expect(page.getByTestId("campaign-state")).toHaveText("Withdrawn");
    await expect(page.getByTestId("decision-table").locator("tbody tr")).toHaveCount(2);
    await expect(page.getByTestId("readiness-blockers")).toContainText("taken back");

    await shotOf(page, "campaign-decisions", "desktop-en-campaign-withdrawn");

    const rows = await mine.approvals();
    expect(rows.map((r) => r.decision)).toEqual(["APPROVED", "WITHDRAWN"]);
    // The withdrawal points at what it took back rather than removing it.
    expect(rows[1].withdrawsApprovalId).toBe(rows[0].id);
  });

  test("reads the approval screen in Arabic, right to left, on a phone", async ({ page }) => {
    await cafeWithDraft(page, "مقهى الاعتماد", "ar");

    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await expect(page.getByTestId("approval-sends-nothing")).toContainText(ar.Campaigns.approvalSendsNothing);
    await expect(page.getByTestId("consent-recheck-note")).toContainText(ar.Campaigns.consentRecheckNote);

    await page.getByTestId("campaign-approve").click();
    await page.getByTestId("approval-confirm-yes").click();
    await expect(page.getByTestId("campaign-state")).toHaveText(ar.Campaigns.state.APPROVED);

    await shotOf(page, "campaign-approval", "phone-ar-campaign-approved");

    // The Arabic screen offers no delivery control either.
    for (const name of await controlNames(page)) {
      expect(name, `"${name}" must not offer delivery`).not.toMatch(SENDING_WORDS);
    }
  });
});

test.describe("the boundary holds at the edges", () => {
  test("B7 is unchanged by any of this", async ({ page }) => {
    // Approval added routes to the staff API. It added nothing public, and the withdrawn public
    // enrolment surface answers exactly as it did before.
    for (const method of ["GET", "POST"] as const) {
      const response = await page.request.fetch("/api/enroll", { method });
      expect(response.status(), `${method} /api/enroll`).toBe(410);
    }
    const join = await page.request.get("/join/anything-at-all");
    expect(join.status()).toBeLessThan(400);
    expect(await join.text()).not.toContain("<form");
  });

  test("offers no public campaign, approval, delivery or unsubscribe API", async ({ page }) => {
    /*
     * Scoped to /api on purpose. A page path falls through next-intl's locale rewrite and renders
     * the app's own not-found chrome, which is a 200 with no content of interest; an API path that
     * does not exist is a 404 from the router. It is the API surface that would leak something.
     */
    for (const path of [
      "/api/campaigns",
      "/api/campaign",
      "/api/staff/campaigns/send",
      "/api/staff/campaigns/approve",
      "/api/deliver",
      "/api/unsubscribe",
      "/api/track",
    ]) {
      const response = await page.request.get(path);
      expect(response.status(), `${path} must not exist`).toBeGreaterThanOrEqual(400);
    }
  });

  test("has no page a customer could use to change a preference or unsubscribe", async ({ page }) => {
    /*
     * Both would be public endpoints that identify a customer and change something about them,
     * which is the unsolved problem of B7 wearing a different hat.
     *
     * The proof is where an unauthenticated visitor ENDS UP. None of these paths exists, so the
     * proxy sends the visitor to the staff sign-in — which is the whole point: a customer who
     * follows a guessed preference URL is asked for a staff password, not handed a control over
     * their own record. Asserting on the status code would prove less, because the shell answers an
     * unknown page under `[locale]` with a 200.
     */
    for (const path of ["/en/unsubscribe", "/en/preferences", "/en/campaigns", "/ar/unsubscribe"]) {
      await page.goto(path);
      await expect(page, `${path} must lead to staff sign-in, not to a customer control`).toHaveURL(/\/auth\/login/);
      // `body`, not `main`: the sign-in page has its own layout and no main landmark.
      const visible = await page.locator("body").innerText();
      expect(visible.toLowerCase(), `${path} must not offer to unsubscribe`).not.toContain("unsubscribe");
    }
  });
});
