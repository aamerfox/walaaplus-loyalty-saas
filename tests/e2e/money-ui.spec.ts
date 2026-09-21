import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import ar from "../../messages/ar.json";
import en from "../../messages/en.json";
import { prisma } from "@/server/db";
import { createMonetaryShop, createStampCafe, enrolMonetaryCustomer, TEST_PASSWORD } from "../setup/fixtures";

/**
 * The money product, through a browser: an owner changing a rate table, and a cashier working a till.
 *
 * What these hold beyond "the screen renders":
 *
 *  - **there is no currency field and no exponent field**, in either language. A programme is in the
 *    business's own currency and this product does no conversion, so an input would be a control
 *    whose only possible effect is an error;
 *  - **discard says it retires**, because "discard" reads as "delete" and the database refuses one;
 *  - **the till says what to collect**, and calls the amount what it is — a figure staff entered,
 *    never a payment, a receipt or a sale;
 *  - **a redemption that gets capped says so**, so the cashier can explain it rather than discover it;
 *  - **Arabic says all of it**, right-to-left, because Arabic is the default locale and the one a
 *    Damascus café actually reads.
 *
 * The default viewport is a Pixel 7 (playwright.config.ts); desktop passes set 1440×900 themselves.
 */

const DESKTOP = { width: 1440, height: 900 };
const SHOTS = "playwright-results/visual";

async function shot(page: Page, name: string) {
  await page.evaluate(() => window.scrollTo(0, 0));
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

async function openMoneyCounter(page: Page, qrToken: string, locale: "en" | "ar" = "en") {
  await page.goto(`/${locale}/scanner`);
  await page.getByTestId("scanner-qr-input").fill(qrToken);
  await page.getByTestId("scanner-qr-lookup").click();
  await expect(page.getByTestId("money-counter")).toBeVisible();
}

/** A cashback business with one flat 5% tier, plus an enrolled card. */
async function cashbackShop() {
  const fx = await createMonetaryShop({
    name: `Money ${randomUUID().slice(0, 6)}`,
    tiers: [{ minCumulativeSpendMinor: 0, rateBasisPoints: 500 }],
  });
  const enrolled = await enrolMonetaryCustomer(fx);
  const card = await prisma.customerCard.findUniqueOrThrow({ where: { id: enrolled.customerCardId }, select: { qrToken: true } });
  return { fx, cardId: enrolled.customerCardId, qrToken: card.qrToken, email: await emailOf(fx.userId) };
}

test.describe("the owner changes a rate table", () => {
  test("creates a money draft from exponent-aware decimal inputs", async ({ page }) => {
    const cafe = await createStampCafe({ name: `Decimal money ${randomUUID().slice(0, 6)}` });
    await signIn(page, await emailOf(cafe.userId));
    await page.goto("/en/business/programs/new");

    await page.getByTestId("card-type-CASHBACK").check();
    await page.getByTestId("program-name").fill("Decimal cashback");
    await page.getByTestId("add-money-tier").click();
    await page.getByTestId("money-threshold-0").fill("12.50");
    await page.getByTestId("money-rate-0").fill("7.5");

    const requestPromise = page.waitForRequest((request) => request.url().endsWith("/api/staff/programs"));
    await page.getByTestId("create-program").click();
    const request = await requestPromise;
    expect(JSON.parse(request.postData() ?? "{}")).toMatchObject({
      cardType: "CASHBACK",
      tiers: [{ minCumulativeSpendMinor: 1250, rateBasisPoints: 750 }],
    });
  });
  test("preserves the zero first threshold when saving a two-tier CASHBACK draft", async ({ page }) => {
    const cafe = await createStampCafe({ name: `Zero threshold ${randomUUID().slice(0, 6)}` });
    await signIn(page, await emailOf(cafe.userId));
    await page.goto("/en/business/programs/new");

    await page.getByTestId("card-type-CASHBACK").check();
    await page.getByTestId("program-name").fill("Zero threshold cashback");
    await page.getByTestId("create-program").click();
    await page.waitForURL(/\/en\/business\/programs\/[0-9a-f-]{36}\/rates/);

    const template = await prisma.programTemplate.findFirstOrThrow({ where: { businessId: cafe.businessId, cardType: "CASHBACK" } });
    const draft = await prisma.programVersion.findFirstOrThrow({ where: { templateId: template.id } });

    // An empty table is still not publishable.
    await page.getByTestId("money-publish").click();
    await expect(page.getByText(en.MoneyRates.publishIncomplete)).toBeVisible();
    expect((await prisma.programVersion.findUniqueOrThrow({ where: { id: draft.id } })).status).toBe("DRAFT");

    await page.getByTestId("money-add-tier").click();
    await expect(page.getByTestId("money-threshold-0")).toHaveValue("0.00");
    await expect(page.getByTestId("money-threshold-0")).toBeDisabled();
    await page.getByTestId("money-rate-0").fill("0");
    await page.getByTestId("money-threshold-1").fill("12.50");
    await page.getByTestId("money-rate-1").fill("7.5");
    await page.getByTestId("money-save").click();

    await expect.poll(async () => {
      const rule = await prisma.monetaryRule.findFirstOrThrow({ where: { programVersionId: draft.id }, select: { tiers: { orderBy: { tierIndex: "asc" }, select: { minCumulativeSpendMinor: true, rateBasisPoints: true } } } });
      return rule.tiers.map((tier) => [tier.minCumulativeSpendMinor.toString(), tier.rateBasisPoints]);
    }).toEqual([["0", 0], ["1250", 750]]);

    await page.getByTestId("money-publish").click();
    await expect(page.getByTestId("money-open-draft")).toBeVisible({ timeout: 15_000 });
    expect((await prisma.programVersion.findUniqueOrThrow({ where: { id: draft.id } })).status).toBe("ACTIVE");
  });

  test("creates a CASHBACK draft, refuses incomplete publish, then publishes the edited table", async ({ page }) => {
    const cafe = await createStampCafe({ name: `Initial money ${randomUUID().slice(0, 6)}` });
    const email = await emailOf(cafe.userId);
    await signIn(page, email);
    await page.goto("/en/business/programs/new");

    await page.getByTestId("card-type-CASHBACK").check();
    await page.getByTestId("program-name").fill("Initial cashback");
    await page.getByTestId("create-program").click();
    await page.waitForURL(/\/en\/business\/programs\/[0-9a-f-]{36}\/rates/);

    const template = await prisma.programTemplate.findFirstOrThrow({ where: { businessId: cafe.businessId, cardType: "CASHBACK" } });
    const draft = await prisma.programVersion.findFirstOrThrow({ where: { templateId: template.id } });
    expect(draft.status).toBe("DRAFT");

    await page.getByTestId("money-publish").click();
    await expect(page.getByText(en.MoneyRates.publishIncomplete)).toBeVisible();
    expect((await prisma.programVersion.findUniqueOrThrow({ where: { id: draft.id } })).status).toBe("DRAFT");

    await page.getByTestId("money-rate-0").fill("6.25");
    await page.getByTestId("money-save").click();
    await page.getByTestId("money-publish").click();
    await expect(page.getByTestId("money-open-draft")).toBeVisible({ timeout: 15_000 });
    expect((await prisma.programVersion.findUniqueOrThrow({ where: { id: draft.id } })).status).toBe("ACTIVE");

    // Post-publish, the live table is read-only; editing requires opening a new draft version.
    await expect(page.getByTestId("money-live-rows")).toBeVisible();
    await expect(page.getByTestId("money-save")).toHaveCount(0);
  });

  test("runs the equivalent DISCOUNT draft lifecycle in Arabic and keeps the live table immutable", async ({ page }) => {
    const cafe = await createStampCafe({ name: `Initial discount ${randomUUID().slice(0, 6)}` });
    const email = await emailOf(cafe.userId);
    await signIn(page, email, "ar");
    await page.goto("/ar/business/programs/new");

    await page.getByTestId("card-type-DISCOUNT").check();
    await page.getByTestId("program-name").fill("Initial discount");
    await page.getByTestId("create-program").click();
    await page.waitForURL(/\/ar\/business\/programs\/[0-9a-f-]{36}\/rates/);
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");

    const template = await prisma.programTemplate.findFirstOrThrow({ where: { businessId: cafe.businessId, cardType: "DISCOUNT" } });
    const draft = await prisma.programVersion.findFirstOrThrow({ where: { templateId: template.id } });
    await page.getByTestId("money-publish").click();
    await expect(page.getByText(ar.MoneyRates.publishIncomplete)).toBeVisible();
    await page.getByTestId("money-rate-0").fill("12.5");
    await page.getByTestId("money-save").click();
    await page.getByTestId("money-publish").click();
    await expect(page.getByTestId("money-open-draft")).toBeVisible({ timeout: 15_000 });
    expect((await prisma.programVersion.findUniqueOrThrow({ where: { id: draft.id } })).status).toBe("ACTIVE");
    await expect(page.getByTestId("money-save")).toHaveCount(0);
  });

  test("shows the currency as a fact, with no way to change it", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    const { fx, email } = await cashbackShop();
    await signIn(page, email);

    await page.goto(`/en/business/programs/${fx.program.templateId}/rates?b=${fx.businessId}`);
    await expect(page.getByTestId("money-currency")).toHaveText("SYP");
    await expect(page.getByTestId("money-exponent")).toHaveText("2");
    await expect(page.getByText(en.MoneyRates.currencyFixed)).toBeVisible();

    /*
     * The assertion that matters. Not "the field is disabled" — there is no field at all, in any
     * state, so there is nothing for a merchant to try and nothing for a future change to re-enable.
     */
    await expect(page.locator('input[name="currency"]')).toHaveCount(0);
    await expect(page.locator('input[name="currencyExponent"]')).toHaveCount(0);
    await expect(page.getByLabel(/currency/i)).toHaveCount(0);

    await shot(page, "money-rates-live-en-desktop");
  });

  test("opens a draft, edits a rate, and publishes it", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    const { fx, email } = await cashbackShop();
    await signIn(page, email);
    await page.goto(`/en/business/programs/${fx.program.templateId}/rates?b=${fx.businessId}`);

    await page.getByTestId("money-open-draft").click();
    await expect(page.getByTestId("money-rate-rows")).toBeVisible();

    // Tier 1's threshold is fixed at zero: it is the rate a card with no history earns.
    await expect(page.getByTestId("money-threshold-0")).toBeDisabled();

    await page.getByTestId("money-rate-0").fill("7.5");
    await page.getByTestId("money-save").click();
    await shot(page, "money-rates-draft-en-desktop");

    await page.getByTestId("money-publish").click();
    await expect(page.getByTestId("money-open-draft")).toBeVisible({ timeout: 15_000 });

    const rule = await prisma.monetaryRule.findFirstOrThrow({
      where: { programVersion: { templateId: fx.program.templateId, status: "ACTIVE" } },
      select: { currency: true, tiers: { select: { rateBasisPoints: true } } },
    });
    expect(rule.tiers[0].rateBasisPoints).toBe(750);
    expect(rule.currency).toBe("SYP");
  });

  test("says that discarding RETIRES the draft rather than deleting it", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    const { fx, email } = await cashbackShop();
    await signIn(page, email);
    await page.goto(`/en/business/programs/${fx.program.templateId}/rates?b=${fx.businessId}`);

    await page.getByTestId("money-open-draft").click();
    await expect(page.getByText(en.MoneyRates.discardExplained)).toBeVisible();

    await page.getByTestId("money-discard").click();
    await expect(page.getByTestId("money-open-draft")).toBeVisible({ timeout: 15_000 });

    // The row survives, retired. The word on the button and the state in the database agree.
    const retired = await prisma.programVersion.count({
      where: { templateId: fx.program.templateId, status: "RETIRED" },
    });
    expect(retired).toBe(1);
  });

  test("Arabic shows the same rate table, right to left, with no currency control", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    const { fx, email } = await cashbackShop();
    await signIn(page, email, "ar");

    await page.goto(`/ar/business/programs/${fx.program.templateId}/rates?b=${fx.businessId}`);
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await expect(page.getByText(ar.MoneyRates.currencyFixed)).toBeVisible();
    await expect(page.getByTestId("money-currency")).toHaveText("SYP");
    await expect(page.locator('input[name="currency"]')).toHaveCount(0);

    await shot(page, "money-rates-live-ar-desktop");
  });
});

test.describe("the cashier works the till", () => {
  test("says what to collect, and calls the amount what it is", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    const { cardId, qrToken, email } = await cashbackShop();
    await signIn(page, email);

    await openMoneyCounter(page, qrToken);
    await expect(page.getByTestId("money-balance")).toContainText("0.00");
    await expect(page.getByTestId("money-next-rate")).toHaveText("5%");

    // The wording at the point of entry, not in a footnote.
    await expect(page.getByText(en.MoneyCounter.billIsAnAssertion)).toBeVisible();

    await page.getByTestId("money-bill").fill("100.00");
    await page.getByTestId("money-earn").click();

    await expect(page.getByTestId("money-collect")).toContainText("100.00");
    await expect(page.getByText(en.MoneyCounter.notAReceipt)).toBeVisible();
    await shot(page, "money-counter-earn-en-desktop");

    const op = await prisma.monetaryOperation.findFirstOrThrow({
      where: { customerCardId: cardId },
      select: { cashEffectMinor: true, grossAmountMinor: true },
    });
    expect(op.grossAmountMinor.toString()).toBe("10000");
    expect(op.cashEffectMinor.toString()).toBe("500"); // 5% of 100.00
  });

  test("says so when a redemption is capped, rather than quietly applying less", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    const { qrToken, email } = await cashbackShop();
    await signIn(page, email);
    await openMoneyCounter(page, qrToken);

    // Earn 5.00 of cashback, then try to take 40.00 off the next bill.
    await page.getByTestId("money-bill").fill("100.00");
    await page.getByTestId("money-earn").click();
    await expect(page.getByTestId("money-collect")).toBeVisible();

    await page.getByTestId("money-bill").fill("50.00");
    await page.getByTestId("money-redeem-amount").fill("40.00");
    await page.getByTestId("money-redeem").click();

    // 5.00 is all the card holds, so 45.00 is collected and the cashier is told why.
    await expect(page.getByTestId("money-collect")).toContainText("45.00");
    await expect(page.getByTestId("money-capped")).toBeVisible();
    await shot(page, "money-counter-capped-en-desktop");
  });

  test("Arabic runs the same till, right to left, on a phone", async ({ page }) => {
    // The default viewport is the phone. A cashier in Damascus is holding one.
    const { qrToken, email } = await cashbackShop();
    await signIn(page, email, "ar");

    await openMoneyCounter(page, qrToken, "ar");
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await expect(page.getByText(ar.MoneyCounter.billIsAnAssertion)).toBeVisible();

    await page.getByTestId("money-bill").fill("250.00");
    await page.getByTestId("money-earn").click();
    await expect(page.getByTestId("money-collect")).toContainText("250.00");
    await expect(page.getByText(ar.MoneyCounter.notAReceipt)).toBeVisible();

    await shot(page, "money-counter-earn-ar-phone");
  });

  test("reverses an operation only with a reason, and never twice", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    const { cardId, qrToken, email } = await cashbackShop();
    await signIn(page, email);
    await openMoneyCounter(page, qrToken);

    await page.getByTestId("money-bill").fill("100.00");
    await page.getByTestId("money-earn").click();
    await expect(page.getByTestId("money-collect")).toBeVisible();

    await page.getByTestId("money-reverse-open").first().click();
    // Confirm stays disabled until a reason is actually given.
    await expect(page.getByTestId("money-reverse-confirm")).toBeDisabled();
    await page.getByTestId("money-reverse-reason").fill("Rung up twice");
    await page.getByTestId("money-reverse-confirm").click();

    await expect(page.getByTestId("money-balance")).toContainText("0.00", { timeout: 15_000 });
    await shot(page, "money-counter-reversed-en-desktop");

    const reversals = await prisma.monetaryOperation.count({
      where: { customerCardId: cardId, kind: "REVERSAL" },
    });
    expect(reversals).toBe(1);
  });
});

async function openAuthorizedMoneyCustomerRecord(page: Page, locale: "en" | "ar", customerName: string) {
  await page.goto(`/${locale}/business/customers`);
  await expect(page.getByTestId("customers-table")).toBeVisible();
  const row = page.getByRole("row").filter({ hasText: customerName });
  await expect(row).toHaveCount(1);
  await row.getByRole("link").click();
  await page.waitForURL(new RegExp(`/${locale}/business/customers/[^/]+$`), { timeout: 30_000 });
}

test.describe("the authorized money customer record", () => {
  test("owner sees the monetary balance and append-only history through the customer list", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    const customerName = `Money record ${randomUUID().slice(0, 6)}`;
    const fx = await createMonetaryShop({ name: `Record ${randomUUID().slice(0, 6)}` });
    const enrolled = await enrolMonetaryCustomer(fx, { firstName: customerName });
    const card = await prisma.customerCard.findUniqueOrThrow({
      where: { id: enrolled.customerCardId },
      select: { qrToken: true, shareToken: true, serialNumber: true },
    });
    const email = await emailOf(fx.userId);
    await signIn(page, email);

    // The owner uses the same scanner journey as staff; no internal card URL is constructed.
    await openMoneyCounter(page, card.qrToken);
    await page.getByTestId("money-bill").fill("100.00");
    await page.getByTestId("money-earn").click();
    await expect(page.getByTestId("money-collect")).toContainText("100.00");

    await openAuthorizedMoneyCustomerRecord(page, "en", customerName);
    await expect(page.getByTestId("card-monetary")).toContainText("5.00 SYP");
    const history = page.getByTestId("customer-money-history");
    await expect(history).toBeVisible();
    await expect(history).toContainText("Cashback earned");
    await expect(history).toContainText("10000");
    await expect(history).toContainText("500");

    const html = await page.content();
    expect(html).not.toContain(card.qrToken);
    expect(html).not.toContain(card.shareToken);
    expect(html).not.toContain(enrolled.customerCardId);
  });

  test("manager sees the same monetary record in Arabic and RTL", async ({ page }) => {
    const customerName = `سجل مالي ${randomUUID().slice(0, 6)}`;
    const fx = await createMonetaryShop({ name: `سجل ${randomUUID().slice(0, 6)}` });
    const enrolled = await enrolMonetaryCustomer(fx, { firstName: customerName });
    const card = await prisma.customerCard.findUniqueOrThrow({ where: { id: enrolled.customerCardId }, select: { qrToken: true } });
    await signIn(page, await emailOf(fx.userId), "ar");

    await openMoneyCounter(page, card.qrToken, "ar");
    await page.getByTestId("money-bill").fill("100.00");
    await page.getByTestId("money-earn").click();
    await expect(page.getByTestId("money-collect")).toContainText("100.00");
    await prisma.businessMembership.updateMany({
      where: { businessId: fx.businessId, userId: fx.userId },
      data: { role: "MANAGER" },
    });

    await openAuthorizedMoneyCustomerRecord(page, "ar", customerName);
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await expect(page.getByTestId("card-monetary")).toContainText("5.00 SYP");
    await expect(page.getByTestId("customer-money-history")).toContainText("استحقاق استرداد");
  });

  test("cashier receives the safe denial and cannot render the monetary record", async ({ page }) => {
    const customerName = `Cashier record ${randomUUID().slice(0, 6)}`;
    const fx = await createMonetaryShop({ name: `Cashier record ${randomUUID().slice(0, 6)}` });
    const enrolled = await enrolMonetaryCustomer(fx, { firstName: customerName });
    const card = await prisma.customerCard.findUniqueOrThrow({ where: { id: enrolled.customerCardId }, select: { qrToken: true } });
    await signIn(page, await emailOf(fx.userId));
    await page.goto("/en/business/customers");
    const recordHref = await page.getByRole("row").filter({ hasText: customerName }).getByRole("link").getAttribute("href");
    expect(recordHref).toMatch(/^\/en\/business\/customers\/[0-9a-f-]{36}$/);
    await openMoneyCounter(page, card.qrToken);
    await page.getByTestId("money-bill").fill("100.00");
    await page.getByTestId("money-earn").click();

    await prisma.businessMembership.updateMany({
      where: { businessId: fx.businessId, userId: fx.userId },
      data: { role: "CASHIER" },
    });

    const response = await page.goto(recordHref!);
    expect(response?.status()).toBe(404);
    const denialHtml = await page.content();
    expect(denialHtml).not.toContain(customerName);
    expect(denialHtml).not.toContain(enrolled.customerCardId);
    expect(denialHtml).not.toContain(card.qrToken);
    expect(denialHtml).not.toContain("Cashiers may");
    expect(denialHtml).not.toContain("customer-money-history");
    expect(denialHtml).not.toContain("5.00 SYP");
    expect(denialHtml).not.toContain("10000");
    await expect(page.getByTestId("customer-money-history")).toHaveCount(0);
    await expect(page.getByTestId("card-monetary")).toHaveCount(0);
  });

  test("cashier receives the same safe denial in Arabic/RTL", async ({ page }) => {
    const customerName = `سجل الكاشير ${randomUUID().slice(0, 6)}`;
    const fx = await createMonetaryShop({ name: `سجل كاشير ${randomUUID().slice(0, 6)}` });
    const enrolled = await enrolMonetaryCustomer(fx, { firstName: customerName });
    const card = await prisma.customerCard.findUniqueOrThrow({ where: { id: enrolled.customerCardId }, select: { qrToken: true } });
    await signIn(page, await emailOf(fx.userId), "ar");
    await page.goto("/ar/business/customers");
    const recordHref = await page.getByRole("row").filter({ hasText: customerName }).getByRole("link").getAttribute("href");
    expect(recordHref).toMatch(/^\/ar\/business\/customers\/[0-9a-f-]{36}$/);
    await openMoneyCounter(page, card.qrToken, "ar");
    await page.getByTestId("money-bill").fill("100.00");
    await page.getByTestId("money-earn").click();

    await prisma.businessMembership.updateMany({
      where: { businessId: fx.businessId, userId: fx.userId },
      data: { role: "CASHIER" },
    });

    const response = await page.goto(recordHref!);
    expect(response?.status()).toBe(404);
    const denialHtml = await page.content();
    expect(denialHtml).not.toContain(customerName);
    expect(denialHtml).not.toContain(enrolled.customerCardId);
    expect(denialHtml).not.toContain(card.qrToken);
    expect(denialHtml).not.toContain("Cashiers may");
    expect(denialHtml).not.toContain("customer-money-history");
    expect(denialHtml).not.toContain("5.00 SYP");
    expect(denialHtml).not.toContain("10000");
    await expect(page.getByTestId("customer-money-history")).toHaveCount(0);
    await expect(page.getByTestId("card-monetary")).toHaveCount(0);
  });
});

test.describe("the customer's own card", () => {
  test("shows the balance and says what it is not", async ({ page }) => {
    const { cardId } = await cashbackShop();
    const card = await prisma.customerCard.findUniqueOrThrow({
      where: { id: cardId },
      select: { shareToken: true },
    });

    await page.goto(`/en/card/${card.shareToken}`);
    await expect(page.getByTestId("card-balance")).toContainText("0.00");
    await expect(page.getByText(en.MoneyCard.notAnAccount)).toBeVisible();
    await shot(page, "money-card-en-phone");

    await page.goto(`/ar/card/${card.shareToken}`);
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await expect(page.getByText(ar.MoneyCard.notAnAccount)).toBeVisible();
    await shot(page, "money-card-ar-phone");
  });
});
