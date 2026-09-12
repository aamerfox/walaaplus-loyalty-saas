import { expect, test, type Page, type Request } from "@playwright/test";
import { prisma } from "@/server/db";
import { registerTestOwner, TEST_PASSWORD, uniqueEmail } from "../setup/fixtures";

/**
 * Registration, in a real browser, against the real API.
 *
 * A staging owner filled in `/en/auth/register`, was taken to the dashboard, and had no account:
 * the page was prototype markup whose "Create Account" control was a **link to `/business`**. It
 * never called `POST /api/auth/register`, so the sign-in that followed correctly returned 401.
 * The registration service and its route had tests and worked the whole time — the page was
 * simply not connected to them, and looked finished either way.
 *
 * That is a defect no server-side test can catch, so these run the page. The central assertion is
 * not "the form looks right": it is that a **request actually left the browser** and a row
 * actually appeared in the database.
 */

const PASSWORD = "correct-horse-battery-staple";

/** Every request the page makes to the registration endpoint, in order. */
function recordRegisterCalls(page: Page): Request[] {
  const calls: Request[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/auth/register") && request.method() === "POST") calls.push(request);
  });
  return calls;
}

async function fillForm(
  page: Page,
  values: { firstName?: string; lastName?: string; businessName?: string; email?: string; password?: string },
) {
  if (values.firstName !== undefined) await page.locator("#firstName").fill(values.firstName);
  if (values.lastName !== undefined) await page.locator("#lastName").fill(values.lastName);
  if (values.businessName !== undefined) await page.locator("#businessName").fill(values.businessName);
  if (values.email !== undefined) await page.locator("#email").fill(values.email);
  if (values.password !== undefined) await page.locator("#password").fill(values.password);
}

test.describe("owner registration", () => {
  test("a real registration creates the account and lands on first-card setup", async ({ page }) => {
    const calls = recordRegisterCalls(page);
    const email = uniqueEmail("owner-reg");

    await page.goto("/en/auth/register");
    await expect(page.getByTestId("register-form")).toBeVisible();

    await fillForm(page, {
      firstName: "Rami",
      lastName: "Haddad",
      businessName: "Damascus Roasters",
      email,
      password: PASSWORD,
    });
    // Start waiting BEFORE the click. Waiting afterwards races the request, which on a warm
    // server has already been sent and matched nothing — the first run of this test failed
    // exactly there.
    const requestPromise = page.waitForRequest(
      (r) => r.url().includes("/api/auth/register") && r.method() === "POST",
      { timeout: 15_000 },
    );
    await page.getByTestId("register-submit").click();

    // ── the request actually happened, with the Syria-first defaults ──────────
    const request = await requestPromise;
    const body = JSON.parse(request.postData() ?? "{}") as Record<string, unknown>;
    expect(body.email).toBe(email);
    expect(body.businessName).toBe("Damascus Roasters");
    expect(body.firstName).toBe("Rami");
    expect(body.lastName).toBe("Haddad");
    expect(body.locale).toBe("en");
    expect(body.currency).toBe("SYP");
    expect(body.timezone).toBe("Asia/Damascus");
    // Nothing the product does not support travels with it.
    expect(body.account_type).toBeUndefined();

    // ── the owner is signed in and lands on the first loyalty card ───────────
    await page.waitForURL(/\/en\/business\/program/, { timeout: 30_000 });
    await expect(page.getByTestId("program-form")).toBeVisible();

    // ── and the database agrees ──────────────────────────────────────────────
    const user = await prisma.user.findUniqueOrThrow({
      where: { email },
      select: { id: true, firstName: true, memberships: { select: { role: true, businessId: true } } },
    });
    expect(user.firstName).toBe("Rami");
    expect(user.memberships).toHaveLength(1);
    expect(user.memberships[0].role).toBe("OWNER");

    const business = await prisma.business.findUniqueOrThrow({
      where: { id: user.memberships[0].businessId },
      select: { name: true, currency: true, timezone: true, locations: { select: { name: true, isDefault: true } } },
    });
    expect(business.name).toBe("Damascus Roasters");
    expect(business.currency).toBe("SYP");
    expect(business.timezone).toBe("Asia/Damascus");
    expect(business.locations.filter((l) => l.isDefault)).toHaveLength(1);

    expect(calls).toHaveLength(1);
  });

  test("the page offers no shortcut into the dashboard", async ({ page }) => {
    // The exact prototype defect: a link that navigated to /business without registering.
    await page.goto("/en/auth/register");

    const submit = page.getByTestId("register-submit");
    await expect(submit).toHaveAttribute("type", "submit");
    // It is a button, not an anchor dressed as one.
    expect(await submit.evaluate((el) => el.tagName)).toBe("BUTTON");

    const hrefs = await page.locator("a[href]").evaluateAll((links) =>
      links.map((l) => l.getAttribute("href") ?? ""),
    );
    for (const href of hrefs) {
      expect(href, `no link on this page may lead to the dashboard: ${href}`).not.toMatch(/\/business(\/|$)/);
    }
  });

  test("invalid input does not submit", async ({ page }) => {
    const calls = recordRegisterCalls(page);
    await page.goto("/en/auth/register");

    // Nothing filled in at all.
    await page.getByTestId("register-submit").click();
    await expect(page.getByTestId("register-error")).toBeVisible();
    await expect(page.getByTestId("firstName-error")).toBeVisible();
    await expect(page.getByTestId("email-error")).toBeVisible();
    expect(page.url()).toContain("/auth/register");

    // Everything but a long enough password.
    await fillForm(page, {
      firstName: "Rami",
      businessName: "Damascus Roasters",
      email: uniqueEmail("never-sent"),
      password: "short",
    });
    await page.getByTestId("register-submit").click();
    await expect(page.getByTestId("password-error")).toBeVisible();

    // The page never navigated, and not one request left the browser.
    expect(page.url()).toContain("/auth/register");
    expect(calls).toHaveLength(0);
  });

  test("an email that already has an account is answered exactly like a new one", async ({ page }) => {
    // An existing owner, created through the service.
    const existing = await registerTestOwner();
    const taken = await prisma.user.findUniqueOrThrow({ where: { id: existing.userId }, select: { email: true } });
    const businessesBefore = await prisma.business.count();

    const responses: number[] = [];
    page.on("response", (r) => {
      if (r.url().includes("/api/auth/register")) responses.push(r.status());
    });

    await page.goto("/en/auth/register");
    await fillForm(page, {
      firstName: "Someone",
      businessName: "Probing Ltd",
      email: taken.email,
      // Deliberately NOT the existing account's password: the sign-in that follows must fail.
      password: "a-different-password-entirely",
    });
    await page.getByTestId("register-submit").click();

    // The same accepted status a new registration gets.
    await expect(page.getByTestId("register-notice")).toBeVisible();
    expect(responses).toEqual([202]);

    // The message says to sign in. It does not say the account exists, or that it does not.
    const notice = (await page.getByTestId("register-notice").textContent()) ?? "";
    for (const leak of ["exist", "already", "taken", "registered", "in use", "duplicate"]) {
      expect(notice.toLowerCase(), `the notice must not say "${leak}"`).not.toContain(leak);
    }
    // And it did not sign the prober in.
    expect(page.url()).toContain("/auth/register");

    // Nothing was created for them.
    expect(await prisma.business.count()).toBe(businessesBefore);
    expect(await prisma.business.count({ where: { name: "Probing Ltd" } })).toBe(0);

    // The real owner's password still works, so nothing about their account was disturbed.
    await page.goto("/en/auth/login");
    await page.locator('input[type="email"]').fill(taken.email);
    await page.locator('input[type="password"]').fill(TEST_PASSWORD);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL(/\/en\/business/, { timeout: 30_000 });
  });

  test("renders correctly in Arabic and in English", async ({ page }) => {
    await page.goto("/ar/auth/register");
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await expect(page.getByTestId("register-form")).toBeVisible();
    await expect(page.getByRole("heading", { name: "أنشئ حسابك" })).toBeVisible();
    // Phase 1a onboards local businesses, and the page says so in Arabic too.
    await expect(page.getByTestId("register-scope")).toBeVisible();
    await expect(page.getByTestId("register-scope")).toContainText("الوكالات");

    await page.goto("/en/auth/register");
    await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
    await expect(page.getByRole("heading", { name: "Create your account" })).toBeVisible();
    await expect(page.getByTestId("register-scope")).toContainText("Agency accounts are not available yet");
  });
});
