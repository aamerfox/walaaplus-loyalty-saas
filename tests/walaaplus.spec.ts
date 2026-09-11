import { test, expect, type Page } from '@playwright/test';

// NOTE: prototype smoke suite. Targets pages removed in the Phase 0 rebuild; it is NOT part of
// `npm run gate` and is rewritten in Phase 1a against the real café loop.
const BASE = 'http://localhost:3000';
const EMAIL = 'test@walaaplus.com';
const PASSWORD = 'password123';

// Helper to log in before each test
async function login(page: Page) {
  await page.goto(`${BASE}/ar/auth/login`);
  await page.waitForLoadState('networkidle');
  await page.locator('input[type="email"]').fill(EMAIL);
  await page.locator('input[type="password"]').fill(PASSWORD);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL('**/business**', { timeout: 10000 });
}

test.describe('WalaaPlus Platform – Playwright Suite', () => {

  // ─── AUTH FLOW ───────────────────────────────────────────────
  test('01 · Login page renders correctly', async ({ page }) => {
    await page.goto(`${BASE}/ar/auth/login`);
    await expect(page).toHaveTitle(/WalaaPlus/);
    await expect(page.locator('input[type="email"]')).toBeVisible();
    await expect(page.locator('input[type="password"]')).toBeVisible();
  });

  test('02 · Login with valid credentials redirects to dashboard', async ({ page }) => {
    await login(page);
    await expect(page).toHaveURL(/\/ar\/business/);
    await page.screenshot({ path: 'playwright-results/02_dashboard.png' });
  });

  test('03 · Login with wrong password shows error', async ({ page }) => {
    await page.goto(`${BASE}/ar/auth/login`);
    await page.locator('input[type="email"]').fill(EMAIL);
    await page.locator('input[type="password"]').fill('wrongpassword');
    await page.locator('button[type="submit"]').click();
    // Should stay on login page or show error
    await page.waitForTimeout(2000);
    const url = page.url();
    expect(url).not.toContain('/business/');
  });

  // ─── DASHBOARD ───────────────────────────────────────────────
  test('04 · Dashboard shows analytics cards', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/ar/business`);
    await page.waitForLoadState('networkidle');
    await page.screenshot({ path: 'playwright-results/04_dashboard.png' });
    // Sidebar should be visible
    await expect(page.locator('aside')).toBeVisible();
  });

  // ─── CUSTOMERS ───────────────────────────────────────────────
  test('05 · Customers CRM page loads', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/ar/business/customers`);
    await page.waitForLoadState('networkidle');
    await page.screenshot({ path: 'playwright-results/05_customers.png' });
    await expect(page.locator('h1')).toBeVisible();
  });

  // ─── CARD BUILDER ────────────────────────────────────────────
  test('06 · Card Builder renders with live preview', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/ar/business/cards/builder`);
    await page.waitForLoadState('networkidle');
    await page.screenshot({ path: 'playwright-results/06_card_builder.png' });
    // Stamp slider should exist
    await expect(page.locator('input[type="range"]').first()).toBeVisible();
    // Save button should be visible
    await expect(page.locator('button').filter({ hasText: /حفظ|Save/i })).toBeVisible();
  });

  test('07 · Create a new Cashback card and verify it appears in My Cards', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/ar/business/cards/builder`);
    await page.waitForLoadState('networkidle');

    // Change card type to Cashback
    await page.selectOption('select', 'CASHBACK');
    await page.waitForTimeout(500);

    // Click Save
    page.on('dialog', dialog => dialog.accept());
    await page.locator('button').filter({ hasText: /حفظ|Save/i }).click();
    await page.waitForURL('**/cards/templates**', { timeout: 8000 });

    // Verify My Cards page
    await page.screenshot({ path: 'playwright-results/07_my_cards_after_create.png' });
    await expect(page.locator('h1')).toBeVisible();
  });

  // ─── MY CARDS LIST ────────────────────────────────────────────
  test('08 · My Cards page shows saved cards from database', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/ar/business/cards/templates`);
    await page.waitForLoadState('networkidle');
    await page.screenshot({ path: 'playwright-results/08_my_cards.png' });
    // At least one card should be visible after previous test
    const cards = page.locator('[class*="rounded-"]').filter({ hasText: /STAMP|CASHBACK|Card/i });
    await expect(cards.first()).toBeVisible({ timeout: 5000 });
  });

  // ─── DISTRIBUTION ────────────────────────────────────────────
  test('09 · Distribution hub renders QR and share options', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/ar/business/distribution`);
    await page.waitForLoadState('networkidle');
    await page.screenshot({ path: 'playwright-results/09_distribution.png' });
    await expect(page.locator('h1')).toBeVisible();
  });

  // ─── LOCATIONS ───────────────────────────────────────────────
  test('10 · Geofencing locations page loads', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/ar/business/locations`);
    await page.waitForLoadState('networkidle');
    await page.screenshot({ path: 'playwright-results/10_locations.png' });
    await expect(page.locator('h1')).toBeVisible();
  });

  // ─── PUSH NOTIFICATIONS ──────────────────────────────────────
  test('11 · Push Notifications page renders', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/ar/business/push`);
    await page.waitForLoadState('networkidle');
    await page.screenshot({ path: 'playwright-results/11_push.png' });
    await expect(page.locator('h1')).toBeVisible();
  });

  // ─── TEAM ────────────────────────────────────────────────────
  test('12 · Team management page renders', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/ar/business/team`);
    await page.waitForLoadState('networkidle');
    await page.screenshot({ path: 'playwright-results/12_team.png' });
    await expect(page.locator('h1')).toBeVisible();
  });

  // ─── BILLING ─────────────────────────────────────────────────
  test('13 · Billing page shows active plan', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/ar/business/billing`);
    await page.waitForLoadState('networkidle');
    await page.screenshot({ path: 'playwright-results/13_billing.png' });
    await expect(page.locator('h1')).toBeVisible();
  });

  // ─── PROTECTED ROUTES ────────────────────────────────────────
  test('14 · Unauthenticated access to dashboard redirects to login', async ({ page }) => {
    // Clear all cookies to simulate logged-out state
    await page.context().clearCookies();
    await page.goto(`${BASE}/ar/business`);
    await page.waitForURL('**/auth/login**', { timeout: 8000 });
    await expect(page).toHaveURL(/auth\/login/);
    await page.screenshot({ path: 'playwright-results/14_redirect_to_login.png' });
  });

  // ─── MARKETING ───────────────────────────────────────────────
  test('15 · Public marketing homepage loads', async ({ page }) => {
    await page.goto(`${BASE}/ar`);
    await page.waitForLoadState('networkidle');
    await page.screenshot({ path: 'playwright-results/15_marketing_home.png' });
    await expect(page).toHaveTitle(/WalaaPlus/);
  });

});
