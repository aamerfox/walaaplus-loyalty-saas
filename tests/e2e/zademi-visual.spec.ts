import { expect, test, type Page } from "@playwright/test";
import ar from "../../messages/ar.json";
import en from "../../messages/en.json";
import { prisma } from "@/server/db";
import {
  createLocation,
  createPointsShop,
  createStampCafe,
  enrolCustomer,
  enrolPointsCustomer,
  TEST_PASSWORD,
  uniqueSyrianPhone,
} from "../setup/fixtures";

/**
 * The visual acceptance pass.
 *
 * The owner rejected the previous release on how it LOOKED — several old pages recoloured in navy
 * rather than one product — and a suite of passing DOM assertions is exactly what failed to catch
 * that. So this file does two different jobs, and both matter:
 *
 *  1. **It asserts the things a screenshot cannot.** Which logo treatment a surface uses, that the
 *     tenant's name is not being used as a heading, that the navigation is one structure in both
 *     locales.
 *  2. **It writes a screenshot of every merchant surface** at desktop and phone width, in Arabic and
 *     in English, into `playwright-results/visual/` — so a human (or the agent that built it) can
 *     open them and look. A test that renders a page and never shows it to anybody is how a visual
 *     regression ships.
 *
 * The business fixture is deliberately named after the staging tenant. If the tenant's name leaks
 * back into the product chrome, these tests fail on the screen it leaked into.
 */

/*
 * Playwright creates the directory for a screenshot path, so this is a plain string rather than a
 * resolved one: `import.meta.dirname` is not available in the module scope this spec is transpiled
 * into, and a spec that cannot load is a spec that proves nothing.
 */
const SHOTS = "playwright-results/visual";

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

/** Every merchant surface, in the order a merchant meets them. */
const ROUTES = ["/business", "/business/programs", "/business/customers", "/business/locations", "/business/team", "/scanner"];

/** The public chrome, which a merchant meets before any of the above. */
const PUBLIC_ROUTES = ["", "/pricing", "/auth/login", "/auth/register"];

/**
 * The rail, read from the message files rather than retyped.
 *
 * Retyping them is how the previous check passed while the Arabic rail said "geofencing": a test
 * that carries its own copy of a label agrees with itself, not with the product.
 */
const NAV_KEYS = ["dashboard", "programs", "scanner", "customers", "segments", "campaigns", "locations", "team"] as const;
const NAV = { en: en.Navigation, ar: ar.Navigation } as const;

async function signIn(page: Page, email: string, locale: "en" | "ar") {
  await page.goto(`/${locale}/auth/login`);
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(TEST_PASSWORD);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL(new RegExp(`/${locale}/business`), { timeout: 30_000 });
}

/**
 * A merchant with something on every screen.
 *
 * Empty screens photograph well and prove nothing: the point of these shots is to see a table with
 * rows in it, a dashboard with figures, a counter with a card loaded.
 */
async function seedMerchant(name: string) {
  const cafe = await createStampCafe({ name: `${name} stamps`, mechanics: { stampsRequiredPerReward: 5 } });
  await prisma.business.update({ where: { id: cafe.businessId }, data: { name } });
  const branch = await createLocation(cafe, "Branch");
  const shop = await createPointsShop({
    existing: { userId: cafe.userId, businessId: cafe.businessId, locationId: cafe.locationId },
    name: `${name} points`,
    mechanics: { availableLocations: [cafe.locationId, branch] },
  });

  const phone = uniqueSyrianPhone();
  await enrolCustomer(cafe, { phone, firstName: "ليلى" });
  await enrolPointsCustomer(shop, { phone });
  await enrolCustomer(cafe, { phone: uniqueSyrianPhone(), firstName: "Omar" });

  const owner = await prisma.user.findUniqueOrThrow({ where: { id: cafe.userId }, select: { email: true } });
  return { cafe, shop, phone, email: owner.email };
}

test.describe("the Zademi shell", () => {
  test("uses one whole logo per surface, and never the tenant name as identity", async ({ page }) => {
    const { email } = await seedMerchant("TrueBiznes");
    await page.setViewportSize(DESKTOP);
    await signIn(page, email, "en");

    /*
     * The navy rail carries the approved WHITE treatment, whole. Two rules in one assertion: the
     * correct variant for a dark surface, and exactly one logo image in the rail — the previous
     * shell put the colour logo here and a standalone symbol in the bar, so a merchant met two
     * marks and read the small one as a fragment of the big one.
     */
    const rail = page.locator("aside");
    const railLogos = rail.locator("img");
    await expect(railLogos).toHaveCount(1);
    await expect(railLogos.first()).toHaveAttribute("src", /Zademi-Logo-White\.png/);

    // The top bar carries no logo at all: one brand surface, not two.
    await expect(page.locator("header img")).toHaveCount(0);

    /*
     * Every destination is in the rail, under the label the English message file gives it. This is
     * the assertion that would have failed on "Geofencing" and "Team Management" — labels inherited
     * from a product this one is not.
     */
    for (const key of NAV_KEYS) {
      await expect(rail.getByRole("link", { name: NAV.en[key], exact: true })).toBeVisible();
    }

    // The tenant name appears once, under a label, and never as a heading.
    const business = page.getByTestId("current-business");
    await expect(business).toHaveText("TrueBiznes");
    await expect(page.getByRole("heading", { name: "TrueBiznes" })).toHaveCount(0);
    for (const route of ["/en/business", "/en/business/programs", "/en/business/team"]) {
      await page.goto(route);
      await expect(page.getByRole("heading", { name: "TrueBiznes" })).toHaveCount(0);
      // Exactly one h1 per screen: the page's own title.
      await expect(page.locator("h1")).toHaveCount(1);
    }
  });

  test("keeps the whole logo and real navigation at phone width, in Arabic", async ({ page }) => {
    const { email } = await seedMerchant("TrueBiznes");
    await page.setViewportSize(PHONE);
    await signIn(page, email, "ar");

    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    // No logo in the bar at phone width either — the drawer carries it, whole.
    await expect(page.locator("header img")).toHaveCount(0);

    await page.getByTestId("open-menu").click();
    /*
     * `:visible` throughout: the navigation exists twice in the DOM at every width — once in the
     * desktop rail, once in the phone drawer — and only one of them is on screen. A test that
     * matched the hidden copy would pass while the drawer showed nothing.
     */
    await expect(page.locator("img[src*='Zademi-Logo-White']:visible").first()).toBeVisible();
    // The same six destinations, in Arabic, from the Arabic message file.
    for (const key of NAV_KEYS) {
      await expect(page.getByRole("link", { name: NAV.ar[key], exact: true }).locator("visible=true")).toBeVisible();
    }
    await expect(page.locator('[data-testid="sign-out"]:visible')).toBeVisible();

    // The drawer opens from the start edge, which in RTL is the right-hand side of the viewport.
    const drawer = page.locator("div.fixed.inset-0 > div").last();
    const box = await drawer.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x + box!.width).toBeGreaterThan(PHONE.width - 2);
  });

  test("the public surfaces use the colour logo on light ground", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await page.goto("/en");
    await expect(page.locator("img[src*='Zademi-Logo.svg']").first()).toBeVisible();

    /*
     * Sign-in used to render a navy tile with a white "W" in it — the old letter placeholder — in
     * the position the logo occupies. It now carries the real mark, and nothing else.
     */
    await page.goto("/en/auth/login");
    await expect(page.locator("img[src*='Zademi-Logo.svg']").first()).toBeVisible();
    await expect(page.locator("main, body").getByText(/^W$/)).toHaveCount(0);

    await page.goto("/en/auth/register");
    // The registration splash is navy, so it takes the approved white treatment.
    await expect(page.locator("img[src*='Zademi-Logo-White']").first()).toBeVisible();

    // B7: the withdrawn join route still says one thing, to everyone, and resolves no token.
    await page.goto("/en/join/anything-at-all");
    await expect(page.getByTestId("join-withdrawn")).toBeVisible();
    expect(await page.content()).not.toContain("TrueBiznes");
  });
});

test.describe("visual record", () => {
  for (const [label, viewport] of [
    ["desktop", DESKTOP],
    ["phone", PHONE],
  ] as const) {
    for (const locale of ["en", "ar"] as const) {
      test(`${label} · ${locale}`, async ({ page }) => {
        const { email, phone } = await seedMerchant("TrueBiznes");
        await page.setViewportSize(viewport);
        await signIn(page, email, locale);

        for (const route of ROUTES) {
          await page.goto(`/${locale}${route}`);
          // The counter is photographed with a card actually loaded: an empty scanner shows none of
          // the things this remediation had to fix.
          if (route === "/scanner") {
            await page.getByTestId("scanner-tab-phone").click();
            await page.getByTestId("scanner-phone-input").fill(`0${phone.slice(4)}`);
            await page.getByTestId("scanner-phone-lookup").click();
            await expect(page.getByTestId("scanner-card")).toBeVisible();
          }
          /*
           * Wait for the page's own first heading rather than for `networkidle`: the session
           * provider holds a connection open, so the network never goes idle and the screenshot
           * would be taken by a timeout rather than by a ready page. The scanner has no h1 until
           * its shell renders, which is exactly the thing being photographed.
           */
          await expect(page.locator("h1").first()).toBeVisible({ timeout: 15_000 });
          const name = route.replace(/\//g, "-").replace(/^-/, "");
          await page.screenshot({ path: `${SHOTS}/${label}-${locale}-${name}.png`, fullPage: true });
        }

        /*
         * The public chrome is photographed in the same pass. The owner's complaint was that the
         * landing page and the authenticated product did not look like one system, so a record that
         * shows only one half of that comparison is not a record of it.
         */
        for (const route of PUBLIC_ROUTES) {
          await page.goto(`/${locale}${route}`);
          await expect(page.locator("h1").first()).toBeVisible({ timeout: 15_000 });
          const name = route === "" ? "landing" : route.replace(/\//g, "-").replace(/^-/, "");
          await page.screenshot({ path: `${SHOTS}/${label}-${locale}-${name}.png`, fullPage: true });
        }
      });
    }
  }
});
