import { expect, test, type Page } from "@playwright/test";
import ar from "../../messages/ar.json";
import en from "../../messages/en.json";
import { prisma } from "@/server/db";
import { createStampCafe, TEST_PASSWORD } from "../setup/fixtures";

/**
 * The owner creating, replacing and revoking an API key.
 *
 * What these hold beyond "the screen works":
 *
 *  - **the value is shown once**, with a warning and a copy button, and never comes back;
 *  - **nothing persists it** — a reload loses it, which is the behaviour a show-once value must
 *    have and the one a careless `localStorage` would quietly break;
 *  - **the scope is stated before a key exists**, so an owner knows what they are handing out;
 *  - **the list shows the public prefix and no secret**, and the digest never reaches the browser;
 *  - **a manager cannot see the section at all**;
 *  - **both languages say all of it**, because Arabic is the default locale and the one a Syrian
 *    café actually reads.
 *
 * The default viewport is a Pixel 7 (playwright.config.ts); the desktop passes set 1440×900.
 */

const DESKTOP = { width: 1440, height: 900 };
const SHOTS = "playwright-results/visual";

/** The browser suite shares one database and never truncates, so every read is scoped. */
function scoped(businessId: string) {
  return {
    keys: () => prisma.apiKey.findMany({ where: { businessId } }),
    count: () => prisma.apiKey.count({ where: { businessId } }),
  };
}

/** The shell scrolls `main`, not the document. */
async function shot(page: Page, name: string) {
  await page.locator("main").evaluate((el) => el.scrollTo(0, 0));
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
}

/**
 * A screenshot of the API-key section itself.
 *
 * `fullPage` is not enough here: the shell scrolls `main` rather than the document, so a full-page
 * capture returns the top of the page and this section — which sits below the event history and the
 * webhook destinations — never appears in it. Scrolling the element into view and capturing the
 * viewport is what makes the evidence show the thing it is evidence of.
 */
async function sectionShot(page: Page, name: string) {
  await page.getByTestId("api-keys").scrollIntoViewIfNeeded();
  await page.waitForTimeout(150);
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
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

async function createKey(page: Page, name: string) {
  await page.getByTestId("api-key-name").fill(name);
  await page.getByTestId("api-key-create-submit").click();
  await expect(page.getByTestId("api-key-secret")).toBeVisible();
}

test.describe("the owner creates a key", () => {
  test("states the scope and the lifetime before one exists", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    const cafe = await createStampCafe({ name: "Key café" });
    await signIn(page, await emailOf(cafe.userId));

    await page.goto("/en/business/integrations");
    await expect(page.getByTestId("api-keys")).toBeVisible();

    // What the key can and cannot do, before the owner hands one to anybody.
    const scope = await page.getByTestId("api-keys-scope").innerText();
    expect(scope).toMatch(/read/i);
    expect(scope).toMatch(/customers/i);
    await expect(page.getByTestId("api-keys-lifetime")).toContainText("90");
    await expect(page.getByTestId("api-keys-readonly")).toContainText(/read-only/i);
    await expect(page.getByTestId("api-keys-empty")).toBeVisible();

    await sectionShot(page, "desktop-en-api-keys-empty");
  });

  test("shows the value once, with a warning and a copy button, and never again", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    const cafe = await createStampCafe({ name: "Reveal café" });
    const db = scoped(cafe.businessId);
    await signIn(page, await emailOf(cafe.userId));

    await page.goto("/en/business/integrations");
    await createKey(page, "Reporting");

    const value = (await page.getByTestId("api-key-secret-value").innerText()).trim();
    expect(value).toMatch(/^wpk_[0-9a-f]{8}_[A-Za-z0-9_-]{43}$/);
    await expect(page.getByTestId("api-key-secret-warning")).toContainText(/only time/i);
    await expect(page.getByTestId("api-key-secret-copy")).toBeVisible();

    await sectionShot(page, "desktop-en-api-key-revealed");

    // What is stored is a digest, and the value is not in it.
    const [row] = await db.keys();
    expect(row.keyDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(row.keyDigest).not.toContain(value.slice(13));
    expect(row.keyPrefix).toBe(value.slice(0, 12));

    // Dismiss, and there is no way back to it.
    await page.getByTestId("api-key-secret-done").click();
    await expect(page.getByTestId("api-key-secret")).toBeHidden();
    await expect(page.getByTestId("api-key-row")).toBeVisible();
    expect(await page.content()).not.toContain(value.slice(13));

    // And a reload does not restore it, because nothing wrote it anywhere.
    await page.reload();
    await expect(page.getByTestId("api-key-row")).toBeVisible();
    expect(await page.content()).not.toContain(value.slice(13));
  });

  test("persists nothing in the browser, not even for a moment", async ({ page }) => {
    /*
     * The complement to the source scan in `tests/unit/api-contract.test.ts`.
     *
     * That one proves nobody WROTE a storage call. This one proves nothing ARRIVED in storage —
     * including anything a library or the framework might have put there on the way past.
     */
    await page.setViewportSize(DESKTOP);
    const cafe = await createStampCafe({ name: "Storage café" });
    await signIn(page, await emailOf(cafe.userId));

    await page.goto("/en/business/integrations");
    await createKey(page, "Ephemeral");
    const value = (await page.getByTestId("api-key-secret-value").innerText()).trim();
    const tail = value.slice(13);

    const stored = await page.evaluate(() => {
      const dump = (s: Storage) => Object.keys(s).map((k) => `${k}=${s.getItem(k) ?? ""}`).join("\n");
      return { local: dump(localStorage), session: dump(sessionStorage), cookie: document.cookie, url: location.href };
    });
    for (const [where, text] of Object.entries(stored)) {
      expect(text, `the key must not reach ${where}`).not.toContain(tail);
    }
  });

  test("shows the public prefix in the list and no secret anywhere", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    const cafe = await createStampCafe({ name: "List café" });
    const db = scoped(cafe.businessId);
    await signIn(page, await emailOf(cafe.userId));

    await page.goto("/en/business/integrations");
    await createKey(page, "Analytics");
    await page.getByTestId("api-key-secret-done").click();

    const [row] = await db.keys();
    await expect(page.getByTestId(`api-key-prefix-${row.id}`)).toContainText(row.keyPrefix);
    await expect(page.getByTestId(`api-key-state-${row.id}`)).toContainText(en.ApiKeys.stateActive);
    await expect(page.getByTestId(`api-key-dates-${row.id}`)).toContainText(en.ApiKeys.neverUsed);

    // The digest is a server-side value and must not be in the document at all.
    const html = await page.content();
    expect(html).not.toContain(row.keyDigest);
  });
});

test.describe("replacing and revoking", () => {
  test("replaces a key, showing the new value once and retiring the old row", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    const cafe = await createStampCafe({ name: "Rotate café" });
    const db = scoped(cafe.businessId);
    await signIn(page, await emailOf(cafe.userId));

    await page.goto("/en/business/integrations");
    await createKey(page, "Before");
    const first = (await page.getByTestId("api-key-secret-value").innerText()).trim();
    await page.getByTestId("api-key-secret-done").click();

    const [original] = await db.keys();
    await page.getByTestId(`api-key-rotate-${original.id}`).click();
    await page.getByTestId(`api-key-rotate-name-${original.id}`).fill("After");
    await page.getByTestId(`api-key-rotate-yes-${original.id}`).click();

    await expect(page.getByTestId("api-key-secret")).toBeVisible();
    const second = (await page.getByTestId("api-key-secret-value").innerText()).trim();
    expect(second).not.toBe(first);
    await sectionShot(page, "desktop-en-api-key-rotated");

    await page.getByTestId("api-key-secret-done").click();
    // Two rows: the retired one and its replacement. Nothing is deleted — D31.
    expect(await db.count()).toBe(2);
    const states = (await db.keys()).map((k) => k.state).sort();
    expect(states).toEqual(["ACTIVE", "REVOKED"]);
    expect(await page.content()).not.toContain(first.slice(13));
  });

  test("replaces a key WITHOUT renaming it — the default path through the form", async ({ page }) => {
    /*
     * The release-gate finding, end to end.
     *
     * The form pre-fills the replacement name with the current one, so this is what happens when an
     * owner presses Replace and then Replace it. Against migration 18's unconditional unique index
     * it failed every time with "You already have a key with that name", because the predecessor's
     * row stays — which is the no-delete rule, working as intended. Migration 19 scopes the name to
     * ACTIVE keys.
     */
    await page.setViewportSize(DESKTOP);
    const cafe = await createStampCafe({ name: "Same name café" });
    const db = scoped(cafe.businessId);
    await signIn(page, await emailOf(cafe.userId));

    await page.goto("/en/business/integrations");
    await createKey(page, "Reporting");
    const first = (await page.getByTestId("api-key-secret-value").innerText()).trim();
    await page.getByTestId("api-key-secret-done").click();

    const [original] = await db.keys();
    await page.getByTestId(`api-key-rotate-${original.id}`).click();

    // The field already holds "Reporting". The owner changes nothing.
    await expect(page.getByTestId(`api-key-rotate-name-${original.id}`)).toHaveValue("Reporting");
    await page.getByTestId(`api-key-rotate-yes-${original.id}`).click();

    // A new value, and no error.
    await expect(page.getByTestId("api-key-secret")).toBeVisible();
    await expect(page.getByTestId("api-keys-error")).toHaveCount(0);
    const second = (await page.getByTestId("api-key-secret-value").innerText()).trim();
    expect(second).not.toBe(first);

    await page.getByTestId("api-key-secret-done").click();
    const rows = await db.keys();
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.name === "Reporting")).toBe(true);
    expect(rows.filter((r) => r.state === "ACTIVE")).toHaveLength(1);
  });

  test("lets a name be used again once the key holding it is revoked", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    const cafe = await createStampCafe({ name: "Recycle café" });
    const db = scoped(cafe.businessId);
    await signIn(page, await emailOf(cafe.userId));

    await page.goto("/en/business/integrations");
    await createKey(page, "Nightly export");
    await page.getByTestId("api-key-secret-done").click();

    const [first] = await db.keys();
    await page.getByTestId(`api-key-revoke-${first.id}`).click();
    await page.getByTestId(`api-key-revoke-yes-${first.id}`).click();
    await expect(page.getByTestId(`api-key-state-${first.id}`)).toContainText(en.ApiKeys.stateRevoked);

    // The same label again, because the key that held it is finished.
    await createKey(page, "Nightly export");
    await expect(page.getByTestId("api-keys-error")).toHaveCount(0);
    await page.getByTestId("api-key-secret-done").click();
    expect(await db.count()).toBe(2);
  });

  test("revokes a key behind a confirmation, and keeps the row", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    const cafe = await createStampCafe({ name: "Revoke café" });
    const db = scoped(cafe.businessId);
    await signIn(page, await emailOf(cafe.userId));

    await page.goto("/en/business/integrations");
    await createKey(page, "Doomed");
    await page.getByTestId("api-key-secret-done").click();

    const [row] = await db.keys();
    await page.getByTestId(`api-key-revoke-${row.id}`).click();
    await expect(page.getByTestId(`api-key-revoke-form-${row.id}`)).toContainText(/cannot be undone/i);
    await page.getByTestId(`api-key-revoke-yes-${row.id}`).click();

    await expect(page.getByTestId(`api-key-state-${row.id}`)).toContainText(en.ApiKeys.stateRevoked);
    // Revoked, not deleted: the record that this business held a credential stays.
    expect(await db.count()).toBe(1);
    expect((await db.keys())[0].state).toBe("REVOKED");
    // A revoked row offers neither action.
    await expect(page.getByTestId(`api-key-rotate-${row.id}`)).toHaveCount(0);
    await expect(page.getByTestId(`api-key-revoke-${row.id}`)).toHaveCount(0);

    await sectionShot(page, "desktop-en-api-key-revoked");
  });
});

test.describe("the one moment the key exists is announced", () => {
  test("puts the reveal in a live region and moves focus into it", async ({ page }) => {
    /*
     * A sighted owner sees the card arrive. Without this, somebody using a screen reader gets
     * nothing: the card is not a live region and focus stays on the button they pressed — so the
     * one moment this value exists can pass unnoticed, and it cannot be recovered.
     *
     * That is a worse failure here than anywhere else in the product, because every other screen's
     * content is still there tomorrow.
     */
    await page.setViewportSize(DESKTOP);
    const cafe = await createStampCafe({ name: "Announce café" });
    await signIn(page, await emailOf(cafe.userId));

    await page.goto("/en/business/integrations");
    await createKey(page, "Announced");

    // The same convention `Notice` already uses for every transient message in this product.
    const reveal = page.locator('[role="status"]').filter({ has: page.getByTestId("api-key-secret") });
    await expect(reveal).toHaveCount(1);
    await expect(reveal).toHaveAttribute("aria-live", "polite");

    // Focus is inside the revealed region, so a keyboard or screen-reader user is standing next to
    // the value rather than still on the Create button.
    const focused = await page.evaluate(() => {
      const el = document.activeElement;
      return { inReveal: el?.closest('[role="status"]')?.querySelector('[data-testid="api-key-secret"]') !== null };
    });
    expect(focused.inReveal).toBe(true);
  });

  test("announces the copy confirmation from a region that was already there", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    const cafe = await createStampCafe({ name: "Copy café" });
    await signIn(page, await emailOf(cafe.userId));

    await page.goto("/en/business/integrations");
    await createKey(page, "Copyable");

    /*
     * Present and empty BEFORE the copy, not created by it: a live region that appears at the same
     * moment its text does is one some readers never announce, because they were not watching an
     * element that did not exist yet.
     */
    const confirmation = page.getByTestId("api-key-secret-copied");
    await expect(confirmation).toHaveCount(1);
    await expect(confirmation).toHaveAttribute("aria-live", "polite");
    await expect(confirmation).toHaveText("");

    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.getByTestId("api-key-secret-copy").click();
    await expect(confirmation).toHaveText(en.ApiKeys.copied);
  });
});

test.describe("Arabic", () => {
  test("says all of it in Arabic, and keeps the key left-to-right", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    const cafe = await createStampCafe({ name: "مقهى المفاتيح" });
    await signIn(page, await emailOf(cafe.userId), "ar");

    await page.goto("/ar/business/integrations");
    await expect(page.getByTestId("api-keys")).toBeVisible();
    await expect(page.getByTestId("api-keys-scope")).toContainText(ar.ApiKeys.scopeNotice);
    await expect(page.getByTestId("api-keys-readonly")).toContainText(ar.ApiKeys.readOnlyNotice);
    await sectionShot(page, "desktop-ar-api-keys-empty");

    await createKey(page, "التقارير");
    await expect(page.getByTestId("api-key-secret-warning")).toContainText(ar.ApiKeys.secretWarning);
    await expect(page.getByTestId("api-key-secret-copy")).toContainText(ar.ApiKeys.copy);

    // The value is a left-to-right token inside a right-to-left paragraph, so it is isolated.
    const isolated = page.locator('bdi[data-testid="api-key-secret-value"]');
    await expect(isolated).toHaveCount(1);
    expect((await isolated.innerText()).trim()).toMatch(/^wpk_/);

    await sectionShot(page, "desktop-ar-api-key-revealed");
  });

  test("works at phone width in Arabic", async ({ page }) => {
    const cafe = await createStampCafe({ name: "مقهى الهاتف" });
    await signIn(page, await emailOf(cafe.userId), "ar");

    await page.goto("/ar/business/integrations");
    await expect(page.getByTestId("api-keys")).toBeVisible();
    await createKey(page, "الهاتف");
    await expect(page.getByTestId("api-key-secret-value")).toBeVisible();
    await sectionShot(page, "phone-ar-api-key-revealed");
  });
});

test.describe("the boundary holds", () => {
  test("a manager cannot see the section at all", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    const cafe = await createStampCafe({ name: "Manager café" });
    await signIn(page, await emailOf(cafe.userId));

    /*
     * Demote this user rather than sign in as a fixture manager: `createStaff` gives its user no
     * usable password, and the tenant context is rebuilt from the database on every request, so the
     * next navigation is genuinely a manager's.
     */
    await prisma.businessMembership.updateMany({
      where: { businessId: cafe.businessId, userId: cafe.userId },
      data: { role: "MANAGER" },
    });

    await page.goto("/en/business/integrations");
    // The event history is theirs; the keys are not, and there is no disabled form either.
    await expect(page.getByTestId("integration-events")).toBeVisible();
    await expect(page.getByTestId("api-keys")).toHaveCount(0);
    await expect(page.getByTestId("api-key-create")).toHaveCount(0);
    await shot(page, "desktop-en-api-keys-manager-denied");
  });

  test("the public API is not reachable from the browser session, only with a key", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    const cafe = await createStampCafe({ name: "Session café" });
    await signIn(page, await emailOf(cafe.userId));

    /*
     * A signed-in owner's cookie is not a key.
     *
     * Worth asserting in a browser rather than only in an integration test: this is the exact
     * request a developer would try first, and the answer must be the same generic 401 a stranger
     * gets — not a page of their own events because the session happened to be there.
     */
    const refused = await page.evaluate(async () => {
      const res = await fetch("/api/v1/events");
      return { status: res.status, body: await res.text(), cors: res.headers.get("access-control-allow-origin") };
    });
    expect(refused.status).toBe(401);
    expect(refused.cors).toBeNull();
    expect(refused.body).not.toMatch(/revoked|expired|unknown|malformed/i);
  });

  test("B7 is unchanged, and no new public route appeared", async ({ page }) => {
    for (const path of ["/api/enroll", "/api/v1"]) {
      const res = await page.request.get(path);
      // B7 answers a constant 410; /api/v1 itself has no handler and is a 404.
      expect([404, 410]).toContain(res.status());
    }
    const enroll = await page.request.post("/api/enroll", { data: {} });
    expect(enroll.status()).toBe(410);

    // And no write verb exists on the one route that does answer.
    for (const method of ["post", "put", "patch", "delete"] as const) {
      const res = await page.request[method]("/api/v1/events", { data: {} });
      expect(res.status(), method).toBeGreaterThanOrEqual(400);
      expect(res.status(), method).not.toBe(200);
    }
  });
});
