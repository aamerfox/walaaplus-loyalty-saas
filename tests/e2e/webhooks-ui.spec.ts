import { expect, test, type Page } from "@playwright/test";
import ar from "../../messages/ar.json";
import en from "../../messages/en.json";
import { prisma } from "@/server/db";
import { createStampCafe, TEST_PASSWORD } from "../setup/fixtures";

/**
 * The owner setting up a webhook destination, and everybody else being unable to.
 *
 * What these hold beyond "the screens work":
 *
 *  - **the at-least-once sentence is on the screen**, in both languages, before a destination
 *    exists — a receiver written on the assumption of exactly-once is a receiver that double-counts;
 *  - **a destination begins disabled**, and says so;
 *  - **the secret is shown once**, with a warning, and never comes back;
 *  - **the URL never appears** anywhere after it is typed;
 *  - **a manager and a cashier cannot see the section at all**;
 *  - **an unsafe address is refused at the form**, not at delivery time;
 *  - **a port other than 443 is refused at the form too**, with a sentence that says which rule was
 *    broken rather than the generic "check the address" — and in both languages.
 *
 * The default viewport is a Pixel 7 (playwright.config.ts); the desktop passes set 1440×900.
 */

const DESKTOP = { width: 1440, height: 900 };
const SHOTS = "playwright-results/visual";
const URL_A = "https://hooks.example.com/walaaplus";

/** The browser suite shares one database and never truncates, so every read is scoped. */
function scoped(businessId: string) {
  return {
    destinations: () => prisma.webhookDestination.findMany({ where: { businessId } }),
    count: () => prisma.webhookDestination.count({ where: { businessId } }),
    deliveries: () => prisma.webhookDelivery.findMany({ where: { businessId } }),
  };
}

/** The shell scrolls `main`, not the document. */
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

async function addDestination(page: Page, name: string, url = URL_A) {
  await page.getByTestId("webhook-name").fill(name);
  await page.getByTestId("webhook-url").fill(url);
  await page.getByTestId("webhook-save").click();
}

test.describe("the owner sets one up", () => {
  test("says at-least-once before anything exists, and offers no way to connect a provider", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    const cafe = await createStampCafe({ name: "Webhook café" });
    await signIn(page, await emailOf(cafe.userId));

    await page.goto("/en/business/integrations");
    await expect(page.getByTestId("webhooks")).toBeVisible();

    // The sentence a receiver's author has to read, always shown and never behind a disclosure.
    const atLeastOnce = await page.getByTestId("webhooks-at-least-once").innerText();
    expect(atLeastOnce).toMatch(/more than once/i);
    expect(atLeastOnce).toMatch(/event id/i);

    await expect(page.getByTestId("webhooks-empty")).toBeVisible();
    await expect(page.getByTestId("webhooks-delay-notice")).toContainText(/background/i);
    await shot(page, "desktop-en-webhooks-empty");
  });

  test("creates one disabled, shows the secret once, and never shows the URL", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    const cafe = await createStampCafe({ name: "Secret café" });
    await signIn(page, await emailOf(cafe.userId));
    await page.goto("/en/business/integrations");

    await addDestination(page, "Ops");
    await expect(page.getByTestId("webhook-secret")).toBeVisible({ timeout: 30_000 });

    const secret = await page.getByTestId("webhook-secret-value").innerText();
    expect(secret.length).toBeGreaterThan(20);
    await expect(page.getByTestId("webhook-secret-warning")).toContainText(/never be shown again/i);

    const [row] = await scoped(cafe.businessId).destinations();
    expect(row.state).toBe("DISABLED");
    await expect(page.getByTestId(`webhook-state-${row.id}`)).toHaveText("Disabled");
    await expect(page.getByTestId(`webhook-disabled-${row.id}`)).toContainText(/Nothing is sent/i);
    await shot(page, "desktop-en-webhooks");

    // Dismiss it, reload, and it is gone for good.
    await page.getByTestId("webhook-secret-done").click();
    await page.reload();
    await expect(page.getByTestId("webhook-secret")).toHaveCount(0);

    const html = await page.content();
    expect(html, "the secret survived a reload").not.toContain(secret);
    expect(html, "the URL is on the page").not.toContain("/walaaplus");
    expect(html).not.toContain(row.endpointCipher);
    expect(html).not.toContain(row.signingSecretCipher);
    // The hostname IS shown, because the owner needs to tell two destinations apart.
    await expect(page.getByTestId(`webhook-host-${row.id}`)).toHaveText("hooks.example.com");
  });

  test("refuses an unsafe address at the form", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    const cafe = await createStampCafe({ name: "SSRF café" });
    await signIn(page, await emailOf(cafe.userId));
    await page.goto("/en/business/integrations");

    for (const url of ["http://hooks.example.com/x", "https://127.0.0.1/x", "https://localhost/x"]) {
      await addDestination(page, `Bad ${url}`, url);
      await expect(page.getByTestId("webhooks-error")).toBeVisible({ timeout: 30_000 });
    }
    expect(await scoped(cafe.businessId).count()).toBe(0);
  });

  test("refuses a port other than 443, and says which rule was broken", async ({ page }) => {
    /*
     * The gateway has always refused anything but 443. It refused at DISPATCH, which meant this
     * form accepted `:8443`, the destination sat in the list looking configured, and every attempt
     * then failed with an error class the owner had to go and read. The refusal belongs here.
     *
     * The sentence matters as much as the refusal: "check the address" is no help to somebody whose
     * address is perfectly good apart from a port.
     */
    await page.setViewportSize(DESKTOP);
    const cafe = await createStampCafe({ name: "Port café" });
    await signIn(page, await emailOf(cafe.userId));
    await page.goto("/en/business/integrations");

    for (const url of [
      "https://hooks.example.com:8443/walaaplus",
      "https://hooks.example.com:80/walaaplus",
      "https://hooks.example.com:3000/walaaplus",
    ]) {
      await addDestination(page, `Port ${url}`, url);
      const error = page.getByTestId("webhooks-error");
      await expect(error).toBeVisible({ timeout: 30_000 });
      // From the message file, so this cannot pass against the generic line.
      await expect(error).toContainText(en.Integrations.errorPort);
    }

    // Nothing was created, and nothing was queued.
    expect(await scoped(cafe.businessId).count()).toBe(0);
    expect(await scoped(cafe.businessId).deliveries()).toHaveLength(0);

    /*
     * And the MESSAGE never repeats what was typed. Scoped to the error element on purpose: the URL
     * field still holds the owner's own text, which is right - they have to be able to correct it -
     * so the thing that must not echo is the sentence the product writes, not the form they filled.
     */
    const errorText = (await page.getByTestId("webhooks-error").innerText()).trim();
    for (const fragment of ["8443", "3000", "/walaaplus", "hooks.example.com"]) {
      expect(errorText, fragment).not.toContain(fragment);
    }

    await shot(page, "desktop-en-webhook-port-refused");

    // The same form accepts the same address on 443, so the rule is a port rule and nothing wider.
    await addDestination(page, "Ops", URL_A);
    await expect(page.getByTestId("webhook-secret")).toBeVisible({ timeout: 30_000 });
    expect(await scoped(cafe.businessId).count()).toBe(1);
  });

  test("enables, tests, and shows the queued test without sending from the page", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    const cafe = await createStampCafe({ name: "Enable café" });
    await signIn(page, await emailOf(cafe.userId));
    await page.goto("/en/business/integrations");

    await addDestination(page, "Ops");
    await expect(page.getByTestId("webhook-secret")).toBeVisible({ timeout: 30_000 });
    await page.getByTestId("webhook-secret-done").click();

    const [row] = await scoped(cafe.businessId).destinations();
    await page.getByTestId(`webhook-enable-${row.id}`).click();
    await expect(page.getByTestId(`webhook-state-${row.id}`)).toHaveText("Enabled", { timeout: 30_000 });

    await page.getByTestId(`webhook-test-${row.id}`).click();
    await expect(page.getByTestId("webhooks-message")).toContainText(/no customer data/i, { timeout: 30_000 });

    // A row, waiting. The worker sends it; the page did not.
    const deliveries = await scoped(cafe.businessId).deliveries();
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].isTest).toBe(true);
    expect(deliveries[0].status).toBe("PENDING");
    expect(deliveries[0].attemptCount).toBe(0);
    await shot(page, "desktop-en-webhooks-test");
  });

  test("asks twice before revoking, and revoking is final", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    const cafe = await createStampCafe({ name: "Revoke café" });
    await signIn(page, await emailOf(cafe.userId));
    await page.goto("/en/business/integrations");

    await addDestination(page, "Ops");
    await expect(page.getByTestId("webhook-secret")).toBeVisible({ timeout: 30_000 });
    await page.getByTestId("webhook-secret-done").click();
    const [row] = await scoped(cafe.businessId).destinations();

    await page.getByTestId(`webhook-revoke-${row.id}`).click();
    await expect(page.getByTestId("webhook-confirm")).toContainText(/permanent/i);
    await page.getByTestId("webhook-confirm-yes").click();

    await expect(page.getByTestId(`webhook-state-${row.id}`)).toHaveText("Revoked", { timeout: 30_000 });
    // No controls at all on a revoked destination.
    await expect(page.getByTestId(`webhook-enable-${row.id}`)).toHaveCount(0);
    await expect(page.getByTestId(`webhook-test-${row.id}`)).toHaveCount(0);
  });

  test("rotates the secret behind a confirmation, and issues a different one", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    const cafe = await createStampCafe({ name: "Rotate café" });
    await signIn(page, await emailOf(cafe.userId));
    await page.goto("/en/business/integrations");

    await addDestination(page, "Ops");
    await expect(page.getByTestId("webhook-secret")).toBeVisible({ timeout: 30_000 });
    const first = await page.getByTestId("webhook-secret-value").innerText();
    await page.getByTestId("webhook-secret-done").click();
    const [row] = await scoped(cafe.businessId).destinations();

    await page.getByTestId(`webhook-rotate-${row.id}`).click();
    await expect(page.getByTestId("webhook-confirm")).toContainText(/stops working immediately/i);
    await page.getByTestId("webhook-confirm-yes").click();

    await expect(page.getByTestId("webhook-secret")).toBeVisible({ timeout: 30_000 });
    const second = await page.getByTestId("webhook-secret-value").innerText();
    expect(second).not.toBe(first);
  });
});

test.describe("a disabled destination can be tested, and receives nothing else", () => {
  test("offers the test button while disabled, and says so", async ({ page }) => {
    /*
     * The point of a test is checking an address BEFORE turning it on, so the button is offered on
     * a disabled destination — the envelope it sends carries no customer data. The screen, the
     * service, the worker and the database trigger all agree on that, and this is the screen's half.
     */
    await page.setViewportSize(DESKTOP);
    const cafe = await createStampCafe({ name: "Disabled test caf\u00e9" });
    await signIn(page, await emailOf(cafe.userId));
    await page.goto("/en/business/integrations");

    await addDestination(page, "Ops");
    await expect(page.getByTestId("webhook-secret")).toBeVisible({ timeout: 30_000 });
    await page.getByTestId("webhook-secret-done").click();

    const [row] = await scoped(cafe.businessId).destinations();
    expect(row.state).toBe("DISABLED");

    // Both statements on screen at once: nothing is sent to it, and you may still test it.
    await expect(page.getByTestId(`webhook-disabled-${row.id}`)).toContainText(/Nothing is sent/i);
    await expect(page.getByTestId(`webhook-test-${row.id}`)).toBeVisible();

    await page.getByTestId(`webhook-test-${row.id}`).click();
    await expect(page.getByTestId("webhooks-message")).toContainText(/no customer data/i, { timeout: 30_000 });

    const deliveries = await scoped(cafe.businessId).deliveries();
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].isTest).toBe(true);
    await shot(page, "desktop-en-webhooks-disabled-test");
  });

  test("offers nothing at all once revoked", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    const cafe = await createStampCafe({ name: "Revoked nothing caf\u00e9" });
    await signIn(page, await emailOf(cafe.userId));
    await page.goto("/en/business/integrations");

    await addDestination(page, "Ops");
    await expect(page.getByTestId("webhook-secret")).toBeVisible({ timeout: 30_000 });
    await page.getByTestId("webhook-secret-done").click();
    const [row] = await scoped(cafe.businessId).destinations();

    await page.getByTestId(`webhook-revoke-${row.id}`).click();
    await page.getByTestId("webhook-confirm-yes").click();
    await expect(page.getByTestId(`webhook-state-${row.id}`)).toHaveText("Revoked", { timeout: 30_000 });

    // Neither real nor test: there is no control left to press.
    await expect(page.getByTestId(`webhook-test-${row.id}`)).toHaveCount(0);
    await expect(page.getByTestId(`webhook-enable-${row.id}`)).toHaveCount(0);
    await expect(page.getByTestId(`webhook-rotate-${row.id}`)).toHaveCount(0);
  });
});

test.describe("who may see it", () => {
  test("a manager sees the event history and no webhook section", async ({ page }) => {
    const cafe = await createStampCafe({ name: "Manager café" });
    await signIn(page, await emailOf(cafe.userId));

    // As the owner, the section is there.
    await page.goto("/en/business/integrations");
    await expect(page.getByTestId("webhooks")).toBeVisible();

    /*
     * Now the same person as a manager. The role is changed under the live session because
     * `createStaff` gives its user no usable password — and the tenant context is rebuilt from the
     * database on every request, so the next navigation is genuinely a manager's.
     */
    await prisma.businessMembership.updateMany({
      where: { businessId: cafe.businessId, userId: cafe.userId },
      data: { role: "MANAGER" },
    });

    const response = await page.goto("/en/business/integrations");
    expect(response?.status()).toBe(200);
    // The event history stays; the webhook half is gone entirely, not merely disabled.
    await expect(page.getByTestId("integration-events")).toBeVisible();
    await expect(page.getByTestId("webhooks")).toHaveCount(0);
    await expect(page.getByTestId("webhook-create")).toHaveCount(0);
  });

  test("a manager is refused at the route too, not only on the screen", async ({ page }) => {
    const cafe = await createStampCafe({ name: "Route café" });
    await signIn(page, await emailOf(cafe.userId));
    await prisma.businessMembership.updateMany({
      where: { businessId: cafe.businessId, userId: cafe.userId },
      data: { role: "MANAGER" },
    });
    await page.goto("/en/business/integrations");

    const res = await page.request.post("/api/staff/webhooks", {
      data: { action: "create", businessId: cafe.businessId, name: "Sneaky", url: URL_A },
    });
    expect(res.status()).toBe(403);
    expect(await scoped(cafe.businessId).count()).toBe(0);
  });

  test("a cashier cannot reach the page at all", async ({ page }) => {
    const cafe = await createStampCafe({ name: "Cashier café" });
    await signIn(page, await emailOf(cafe.userId));
    await prisma.businessMembership.updateMany({
      where: { businessId: cafe.businessId, userId: cafe.userId },
      data: { role: "CASHIER" },
    });

    const response = await page.goto("/en/business/integrations");
    expect(response?.status()).toBe(404);
    await expect(page.getByTestId("webhooks")).toHaveCount(0);

    const res = await page.request.post("/api/staff/webhooks", {
      data: { action: "create", businessId: cafe.businessId, name: "Sneaky", url: URL_A },
    });
    expect(res.status()).toBe(403);
  });
});

test.describe("Arabic", () => {
  test("reads right to left on a phone, and says at-least-once in Arabic", async ({ page }) => {
    const cafe = await createStampCafe({ name: "مقهى الويبهوك" });
    await signIn(page, await emailOf(cafe.userId), "ar");

    await page.goto("/ar/business/integrations");
    await expect(page.getByTestId("webhooks")).toBeVisible();

    // From the message file, so the test cannot pass against an English fallback.
    await expect(page.getByTestId("webhooks-at-least-once")).toContainText(ar.Integrations.atLeastOnce);
    await expect(page.getByTestId("webhooks-empty")).toContainText(ar.Integrations.destinationsEmptyTitle);
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await shot(page, "phone-ar-webhooks-empty");
  });

  test("shows a disabled destination and its secret warning in Arabic", async ({ page }) => {
    const cafe = await createStampCafe({ name: "مقهى السر" });
    await signIn(page, await emailOf(cafe.userId), "ar");
    await page.goto("/ar/business/integrations");

    await addDestination(page, "عمليات");
    await expect(page.getByTestId("webhook-secret")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("webhook-secret-warning")).toContainText(ar.Integrations.secretWarning);

    const [row] = await scoped(cafe.businessId).destinations();
    await expect(page.getByTestId(`webhook-state-${row.id}`)).toHaveText(ar.Integrations.stateDisabled);
    await expect(page.getByTestId(`webhook-disabled-${row.id}`)).toContainText(ar.Integrations.disabledNotice);
    await shot(page, "phone-ar-webhooks");
  });

  test("refuses a port other than 443 in Arabic", async ({ page }) => {
    const cafe = await createStampCafe({ name: "مقهى المنفذ" });
    await signIn(page, await emailOf(cafe.userId), "ar");
    await page.goto("/ar/business/integrations");

    await addDestination(page, "منفذ", "https://hooks.example.com:8443/walaaplus");
    const error = page.getByTestId("webhooks-error");
    await expect(error).toBeVisible({ timeout: 30_000 });
    // From the Arabic message file, so an English fallback fails this.
    await expect(error).toContainText(ar.Integrations.errorPort);
    await expect(error).not.toContainText(en.Integrations.errorPort);
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");

    expect(await scoped(cafe.businessId).count()).toBe(0);
    await shot(page, "phone-ar-webhook-port-refused");
  });

  test("shows the desktop screen in Arabic", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    const cafe = await createStampCafe({ name: "مقهى سطح المكتب للويبهوك" });
    await signIn(page, await emailOf(cafe.userId), "ar");
    await page.goto("/ar/business/integrations");
    await addDestination(page, "عمليات");
    await expect(page.getByTestId("webhook-secret")).toBeVisible({ timeout: 30_000 });
    await page.getByTestId("webhook-secret-done").click();
    await shot(page, "desktop-ar-webhooks");
  });
});

test.describe("the boundary holds", () => {
  test("B7 is unchanged, and no public webhook route exists", async ({ page }) => {
    expect((await page.request.get("/api/enroll")).status()).toBe(410);
    for (const path of ["/api/webhooks", "/api/integrations", "/api/staff/webhooks"]) {
      // GET is not a method any of these offers; the staff one is POST-only and authenticated.
      const res = await page.request.get(path);
      expect([404, 405, 401, 403], `${path} answered ${res.status()}`).toContain(res.status());
    }
  });

  test("signed out, the route refuses and the page redirects", async ({ page }) => {
    const res = await page.request.post("/api/staff/webhooks", {
      data: { action: "create", name: "Anon", url: URL_A },
    });
    expect([401, 403]).toContain(res.status());

    await page.goto("/en/business/integrations");
    expect(page.url()).toMatch(/\/auth\/login/);
  });
});
