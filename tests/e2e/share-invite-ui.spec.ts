import { expect, test } from "@playwright/test";
import qrcode from "qrcode-generator";
import ar from "../../messages/ar.json";
import en from "../../messages/en.json";
import { prisma } from "@/server/db";
import { mintShareLink, revokeShareLink } from "@/server/share/share-links";
import { createStampCafe, enrolCustomer, TEST_PASSWORD, uniqueSyrianPhone } from "../setup/fixtures";

/**
 * The public invitation page, driven the way a customer's friend meets it.
 *
 * What these hold beyond "the page renders":
 *
 *  - **the capability never reaches the server.** Every request the browser makes while opening the
 *    page is recorded, and the token is asserted absent from every URL — which is the one claim the
 *    whole fragment design exists to make;
 *  - **nothing personal reaches the DOM.** The real phone, name, serial, scanner QR, card link and
 *    the capability itself are read out of the database and asserted absent from the rendered HTML;
 *  - **revoking kills a live link**, and the page says so without confirming anything;
 *  - **the page joins nobody to anything** — no form, no field, no enrolment, and B7 unchanged;
 *  - **no copy promises a reward**, because no referral policy exists.
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

/** A café, one customer, and a live invitation capability for their card. */
async function cafeWithInvitation(name: string) {
  const cafe = await createStampCafe({ name });
  const customer = await enrolCustomer(cafe, { phone: uniqueSyrianPhone(), firstName: "ليلى" });
  const minted = await mintShareLink(cafe.ctx, customer.customerCardId, "WALLET_PASS");
  const card = await prisma.customerCard.findUniqueOrThrow({
    where: { id: customer.customerCardId },
    select: { qrToken: true, shareToken: true, serialNumber: true },
  });
  const business = await prisma.business.findUniqueOrThrow({
    where: { id: cafe.businessId },
    select: { name: true },
  });
  const phone = (
    await prisma.customer.findFirstOrThrow({
      where: { profiles: { some: { id: customer.customerBusinessProfileId } } },
      select: { normalizedPhone: true },
    })
  ).normalizedPhone;

  return { cafe, customer, card, phone, businessName: business.name, token: minted.rawToken };
}

test.describe("the invitation page", () => {
  test("opens from a fragment, and the capability never reaches the server", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    const fx = await cafeWithInvitation("Invitation café");

    /*
     * Every request the browser makes, recorded before navigation. The claim under test is that the
     * token is in none of their URLs — not the document request, not the RSC payload, not the
     * resolve call, not a font. A platform or a framework that moved the fragment into a query
     * string would break this silently, which is exactly why it is asserted rather than reasoned
     * about.
     */
    const requestUrls: string[] = [];
    page.on("request", (request) => requestUrls.push(request.url()));

    await page.goto(`/en/share#${fx.token}`);
    await expect(page.getByTestId("share-invite")).toBeVisible();

    expect(requestUrls.length).toBeGreaterThan(0);
    for (const url of requestUrls) {
      expect(url, `the capability must not appear in a request: ${url}`).not.toContain(fx.token);
    }

    // The one request that legitimately carries it does so in a POST body, never in the URL.
    const resolveCalls = requestUrls.filter((u) => u.includes("/api/share/resolve"));
    expect(resolveCalls).toHaveLength(1);
    expect(resolveCalls[0]).not.toContain("#");
    expect(resolveCalls[0]).not.toContain("?");
  });

  test("shows the business, a QR of its own link, and nothing about anybody", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    const fx = await cafeWithInvitation("Sharing café");

    await page.goto(`/en/share#${fx.token}`);
    await expect(page.getByTestId("share-business")).toContainText(fx.businessName);
    await expect(page.getByTestId("share-qr").locator("svg")).toBeVisible();
    await expect(page.getByTestId("share-copy")).toBeVisible();

    await page.screenshot({ path: `${SHOTS}/desktop-en-share-invite.png`, fullPage: true });

    /*
     * The rendered page, checked against the real values. The capability itself is exempt: it is in
     * the URL the visitor is meant to forward, so it is on screen on purpose. Everything else must
     * be absent.
     */
    const html = await page.content();
    for (const secret of [fx.card.qrToken, fx.card.shareToken, fx.card.serialNumber, fx.phone, "ليلى"]) {
      expect(html, `the invitation page must not carry ${secret}`).not.toContain(secret);
    }
    expect(html).not.toContain(fx.customer.customerCardId);
    expect(html).not.toContain(fx.customer.customerBusinessProfileId);
    expect(html).not.toContain(fx.cafe.businessId);

    // No balance, no programme, no card page link.
    const visible = await page.locator("main").innerText();
    expect(visible).not.toMatch(/stamp|balance|programme|program/i);
    expect(html).not.toContain("/card/");
  });

  test("offers share targets that need no SDK, and a link nobody has to click to read", async ({ page }) => {
    const fx = await cafeWithInvitation("Targets café");
    await page.goto(`/en/share#${fx.token}`);

    /*
     * Facebook's sharer takes a URL and nothing else — it has no text parameter — so the business
     * name appears in the other seven. Asserted per target rather than uniformly, because a blanket
     * expectation here would have to be weakened to the point of proving nothing.
     */
    const carriesText = new Set(["whatsapp", "telegram", "x", "reddit", "bluesky", "threads", "email"]);
    for (const id of ["whatsapp", "telegram", "facebook", "x", "reddit", "bluesky", "threads", "email"]) {
      const link = page.getByTestId(`share-to-${id}`);
      await expect(link, `${id} must be offered`).toBeVisible();
      const href = (await link.getAttribute("href")) ?? "";

      // Every target carries the link itself.
      expect(href, `${id} must carry the invitation link`).toContain(encodeURIComponent("/share#"));
      if (carriesText.has(id)) {
        expect(decodeURIComponent(href), `${id} must name the business`).toContain(fx.businessName);
      }
      // None of them carries anything about the person whose card it is.
      expect(href).not.toContain(fx.card.qrToken);
      expect(href).not.toContain(fx.card.shareToken);
      expect(href).not.toContain(fx.card.serialNumber);
      expect(href).not.toContain(fx.phone);
      expect(decodeURIComponent(href)).not.toContain("ليلى");
    }

    // The URL is readable and selectable, so a refused clipboard is a missing convenience rather
    // than a dead end — and it is the canonical one, with no locale in it.
    await expect(page.getByTestId("share-url")).toContainText(`/share#${fx.token}`);
    await expect(page.getByTestId("share-url")).not.toContainText("/en/share");

    /*
     * No third-party script reaches this page. Every share target is a plain link a browser follows,
     * not an SDK — which is the difference between a share button and a tracking surface, and the
     * reason Messenger is absent (its web dialog needs a registered Facebook app id).
     *
     * Compared against the page's own origin rather than a host allowlist, so this keeps working
     * wherever the suite runs.
     */
    const origin = new URL(page.url()).origin;
    const scripts = await page.locator("script[src]").evaluateAll((els) =>
      els.map((el) => (el as HTMLScriptElement).src),
    );
    expect(scripts.length).toBeGreaterThan(0);
    for (const src of scripts) {
      expect(src.startsWith(origin) || src.startsWith("/"), `${src} is third-party`).toBe(true);
    }
  });

  test("copies the link", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const fx = await cafeWithInvitation("Copy café");
    await page.goto(`/en/share#${fx.token}`);

    await page.getByTestId("share-copy").click();
    await expect(page.getByTestId("share-copy")).toHaveText("Link copied");
    const clipboard = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboard).toBe(`${new URL(page.url()).origin}/share#${fx.token}`);
  });

  test("uses the Web Share API when the device has one, and does not pretend otherwise", async ({ page }) => {
    const fx = await cafeWithInvitation("Native café");

    // Installed before the page's script runs, so detection sees it.
    await page.addInitScript(() => {
      const shared: unknown[] = [];
      (window as unknown as { __shared: unknown[] }).__shared = shared;
      Object.defineProperty(navigator, "share", {
        configurable: true,
        value: async (data: unknown) => {
          shared.push(data);
        },
      });
    });

    await page.goto(`/en/share#${fx.token}`);
    await page.getByTestId("share-native").click();

    const shared = await page.evaluate(() => (window as unknown as { __shared: { url: string; text: string }[] }).__shared);
    expect(shared).toHaveLength(1);
    expect(shared[0].url).toBe(`${new URL(page.url()).origin}/share#${fx.token}`);
    expect(shared[0].text).toContain(fx.businessName);
    // The share sheet gets the business name and the link. Nothing else.
    expect(shared[0].text).not.toContain("ليلى");
  });

  test("falls back safely where there is no Web Share API", async ({ page }) => {
    const fx = await cafeWithInvitation("Fallback café");
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "share", { configurable: true, value: undefined });
    });

    await page.goto(`/en/share#${fx.token}`);
    // The button is absent rather than present and dead, and everything else still works.
    await expect(page.getByTestId("share-native")).toHaveCount(0);
    await expect(page.getByTestId("share-copy")).toBeVisible();
    await expect(page.getByTestId("share-to-whatsapp")).toBeVisible();
    await expect(page.getByTestId("share-qr")).toBeVisible();
  });

  test("says nothing about rewards, in either language", async ({ page }) => {
    const fx = await cafeWithInvitation("Honest café");
    for (const locale of ["en", "ar"] as const) {
      await page.goto(`/${locale}/share#${fx.token}`);
      await expect(page.getByTestId("share-invite")).toBeVisible();
      const visible = await page.locator("main").innerText();
      expect(visible, `${locale} must promise no reward`).not.toMatch(REWARD_WORDS);
    }
  });

  test("reads right to left in Arabic, on a phone", async ({ page }) => {
    const fx = await cafeWithInvitation("مقهى الدعوات");
    await page.goto(`/ar/share#${fx.token}`);

    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await expect(page.getByTestId("share-heading")).toHaveText(ar.Share.title);
    await expect(page.getByTestId("share-qr").locator("svg")).toBeVisible();
    // The URL itself stays left to right inside an RTL page; a reversed URL is a different URL.
    await expect(page.getByTestId("share-url")).toHaveAttribute("dir", "ltr");

    await page.screenshot({ path: `${SHOTS}/phone-ar-share-invite.png`, fullPage: true });
  });

  test("is keyboard reachable and announces the copy", async ({ page }) => {
    const fx = await cafeWithInvitation("Keyboard café");
    await page.goto(`/en/share#${fx.token}`);
    // The page resolves its link in the browser, so it starts as a one-line loading state. Waiting
    // for the resolved view is the difference between testing the page and testing a race.
    await expect(page.getByTestId("share-invite")).toBeVisible();

    // Every control is a real button or link, so tabbing reaches them and Enter activates them.
    const focusable = page.locator("main button, main a");
    expect(await focusable.count()).toBeGreaterThanOrEqual(9);
    await page.keyboard.press("Tab");
    await expect(page.locator("main :focus")).toBeVisible();

    // The QR is labelled rather than being an unnamed graphic.
    await expect(page.getByTestId("share-qr")).toHaveAttribute("aria-label", /.+/);
    // The copy result is announced without stealing focus.
    await expect(page.getByTestId("share-copy-status")).toHaveAttribute("aria-live", "polite");
  });
});

test.describe("what gets shared is locale-neutral", () => {
  /*
   * The page is locale-routed, so a visitor reaches it at `/en/share#…` or `/ar/share#…`. What they
   * then hand to somebody else must NOT carry that prefix: a link forwarded from a chat outlives the
   * moment it was sent and has no business choosing a language for whoever opens it. The server
   * builds `publicShareUrl` with no prefix for exactly this reason, and the browser has to agree.
   *
   * This is a correction. The page used to share `window.location.href`, so a link sent by an
   * Arabic-speaking customer opened in Arabic for an English-speaking recipient, and the other way
   * round. Every surface that hands the URL to somebody is checked here, including the QR — which is
   * the one artefact a recipient cannot read before acting on it.
   */
  for (const locale of ["en", "ar"] as const) {
    test(`renders in ${locale} but shares the canonical URL everywhere`, async ({ page, context }) => {
      await context.grantPermissions(["clipboard-read", "clipboard-write"]);
      await page.addInitScript(() => {
        const shared: unknown[] = [];
        (window as unknown as { __shared: unknown[] }).__shared = shared;
        Object.defineProperty(navigator, "share", {
          configurable: true,
          value: async (data: unknown) => {
            shared.push(data);
          },
        });
      });

      const fx = await cafeWithInvitation(`Locale ${locale} café`);
      await page.goto(`/${locale}/share#${fx.token}`);
      await expect(page.getByTestId("share-invite")).toBeVisible();

      // The PAGE still honours the locale it was opened in: the visitor reads their own language.
      await expect(page.locator("html")).toHaveAttribute("lang", locale);
      await expect(page.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
      await expect(page.getByTestId("share-heading")).toHaveText(locale === "ar" ? ar.Share.title : en.Share.title);

      // And the browser's own address still carries the prefix and the capability, untouched. The
      // fix builds a different URL; it does not rewrite the one the visitor arrived on.
      expect(page.url()).toContain(`/${locale}/share#${fx.token}`);

      const canonical = `${new URL(page.url()).origin}/share#${fx.token}`;

      // 1. The visible copy.
      await expect(page.getByTestId("share-url")).toHaveText(canonical);

      /*
       * 2. The QR, compared against a symbol generated from the canonical URL with the same
       *    settings the component uses. `qrcode-generator` is deterministic, so an identical module
       *    pattern means an identical encoded payload — and a locale-prefixed URL is four characters
       *    longer and produces a visibly different symbol. No decoder, and no new dependency.
       */
      const expected = qrcode(0, "M");
      expected.addData(canonical);
      expected.make();
      const modulesOf = (markup: string) => [...markup.matchAll(/d="([^"]+)"/g)].map((m) => m[1]).join("|");
      const rendered = await page.getByTestId("share-qr").innerHTML();
      expect(modulesOf(rendered)).toBe(modulesOf(expected.createSvgTag({ cellSize: 6, margin: 4 })));
      expect(modulesOf(rendered).length).toBeGreaterThan(0);

      // 3. The clipboard.
      await page.getByTestId("share-copy").click();
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(canonical);

      // 4. Native share.
      await page.getByTestId("share-native").click();
      const shared = await page.evaluate(() => (window as unknown as { __shared: { url: string }[] }).__shared);
      expect(shared[0].url).toBe(canonical);

      // 5. Every social target.
      for (const id of ["whatsapp", "telegram", "facebook", "x", "reddit", "bluesky", "threads", "email"]) {
        const href = (await page.getByTestId(`share-to-${id}`).getAttribute("href")) ?? "";
        const decoded = decodeURIComponent(href);
        expect(decoded, `${id} must carry the canonical URL`).toContain(canonical);
        expect(decoded, `${id} must not carry a locale prefix`).not.toContain(`/${locale}/share`);
      }

      // Nothing anywhere on the page offers the locale-prefixed address as something to share.
      expect(await page.content()).not.toContain(`/${locale}/share#${fx.token}`);
    });
  }
});

test.describe("a link that is not live", () => {
  test("says the same thing for revoked, unknown and missing, and confirms nothing", async ({ page }) => {
    // Desktop, because the screenshot this takes is named for it.
    await page.setViewportSize(DESKTOP);
    const fx = await cafeWithInvitation("Revoked café");
    await revokeShareLink(fx.cafe.ctx, fx.customer.customerCardId);

    for (const hash of [`#${fx.token}`, "#a".padEnd(60, "b"), ""]) {
      await page.goto(`/en/share${hash}`);
      await expect(page.getByTestId("share-unavailable"), `hash "${hash.slice(0, 8)}"`).toBeVisible();
      await expect(page.getByTestId("share-invite")).toHaveCount(0);

      const visible = await page.locator("main").innerText();
      // It confirms no business, no card and no customer — including for the revoked link, whose
      // business really does exist.
      expect(visible).not.toContain(fx.businessName);
      expect(visible).not.toContain(fx.card.serialNumber);
    }

    await page.screenshot({ path: `${SHOTS}/desktop-en-share-unavailable.png`, fullPage: true });
  });
});

test.describe("the boundary holds", () => {
  test("the invitation page enrols nobody and offers no form", async ({ page }) => {
    const fx = await cafeWithInvitation("Boundary café");
    const before = {
      cards: await prisma.customerCard.count(),
      customers: await prisma.customer.count(),
      operations: await prisma.loyaltyOperation.count(),
    };

    await page.goto(`/en/share#${fx.token}`);
    await expect(page.getByTestId("share-invite")).toBeVisible();

    // No form, no input, nothing to submit. Public self-service enrolment was withdrawn (B7), and a
    // page reachable by a forwarded link is the last place to reintroduce one.
    await expect(page.locator("main form")).toHaveCount(0);
    await expect(page.locator("main input")).toHaveCount(0);
    await expect(page.locator("main textarea")).toHaveCount(0);

    expect({
      cards: await prisma.customerCard.count(),
      customers: await prisma.customer.count(),
      operations: await prisma.loyaltyOperation.count(),
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

  test("offers no public route that resolves a link by URL", async ({ page }) => {
    /*
     * A GET with a token in the path or query is the shape this whole design exists to avoid, so
     * the resolver names its GET handler explicitly and refuses. The other paths are asserted on
     * CONTENT as well as status: an unknown path under this shell can answer 200 with the app's own
     * not-found chrome, and what matters is that none of them ever answers with a business.
     */
    const fx = await cafeWithInvitation("No-GET café");

    const viaQuery = await page.request.get(`/api/share/resolve?token=${fx.token}`);
    expect(viaQuery.status(), "a GET on the resolver must be refused outright").toBe(405);

    for (const path of [`/api/share/${fx.token}`, "/api/share", "/api/share/resolve"]) {
      const response = await page.request.get(path);
      const body = await response.text();
      expect(body, `${path} must reveal nothing`).not.toContain(fx.businessName);
      expect(body, `${path} must reveal nothing`).not.toContain(fx.card.qrToken);
      expect(body).not.toContain('"ok":true');
    }
  });
});

test.describe("the owner never sees the capability", () => {
  test("shows a redacted wallet payload and can revoke the link", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    const fx = await cafeWithInvitation("Owner café");

    await page.goto("/en/auth/login");
    await page.locator('input[type="email"]').fill(await emailOf(fx.cafe.userId));
    await page.locator('input[type="password"]').fill(TEST_PASSWORD);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL(/\/en\/business/, { timeout: 30_000 });

    await page.goto(`/en/business/customers/${fx.customer.customerBusinessProfileId}`);
    await page.getByTestId("wallet-open").click();
    await expect(page.getByTestId("wallet-panel")).toBeVisible();
    await expect(page.getByTestId("wallet-apple-payload")).toBeVisible();

    /*
     * The point of this screen: it answers "does this pass carry the invitation link, and where"
     * without answering "and what is it".
     */
    const html = await page.content();
    expect(html).not.toContain(fx.token);
    expect(html).toContain("token-not-shown");
    await expect(page.getByTestId("wallet-not-signed")).toBeVisible();
    await expect(page.getByTestId("wallet-reinstall-note")).toBeVisible();
    await expect(page.getByTestId("wallet-device-gate")).toBeVisible();

    // The scanner QR is in the payload on purpose — it is the barcode — but the invitation is not.
    await expect(page.getByTestId("wallet-apple-payload")).toContainText(fx.card.qrToken);
    await expect(page.getByTestId("wallet-google-payload")).not.toContainText(fx.token);

    await page.getByTestId("wallet-panel").scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${SHOTS}/desktop-en-wallet-preview.png`, fullPage: true });

    // Revoking takes two steps, because the customer's saved pass loses its link.
    await page.getByTestId("wallet-revoke").click();
    await expect(page.getByTestId("wallet-revoke-confirm")).toBeVisible();
    await page.getByTestId("wallet-revoke-yes").click();
    await expect(page.getByTestId("wallet-message")).toBeVisible();

    await page.goto(`/en/share#${fx.token}`);
    await expect(page.getByTestId("share-unavailable")).toBeVisible();
  });
});
