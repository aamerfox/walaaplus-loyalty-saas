import { expect, test } from "@playwright/test";
import { createStampCafe, uniqueSyrianPhone } from "../setup/fixtures";

/**
 * The enrolment-existence oracle, reproduced through the browser.
 *
 * **These tests assert a defect that is NOT fixed.** They are characterization tests: they pin the
 * current, known-bad behaviour so it cannot change silently, and they will FAIL the day someone
 * closes the oracle — which is the moment to invert them. They exist because the fix requires a
 * product decision that Phase 1a has not authorized; see `docs/evidence/phase-1a-prompt-3.md` §12.
 *
 * WHY THE API-SHAPE FIX WAS NOT ENOUGH. `POST /api/enroll` answers a first and a repeat enrolment
 * with the same status, the same keys and a token of the same shape. That was verified, and it is
 * true. But the token is not the end of the flow: `JoinForm` redirects to `/card/<token>`
 * unconditionally, and the card route resolves a real token and calls `notFound()` for the decoy.
 * So the caller does not need to inspect the response at all — they follow their own browser and
 * read the outcome. **The full browser flow is the security boundary, not the JSON.**
 *
 * That is the correction to this gate: the audit checked the API and stopped there.
 */

test.describe("enrolment existence, through the public form", () => {
  test("a repeat enrolment is still distinguishable from a first one — the open defect", async ({ page }) => {
    const cafe = await createStampCafe({ name: "مقهى الاختبار" });
    const joinUrl = `/ar/join/${cafe.program.directSourceToken}`;
    const phone = uniqueSyrianPhone();
    const localPhone = `0${phone.slice(4)}`;

    // ── a genuinely new customer joins, exactly as a customer does ────────────
    await page.goto(joinUrl);
    await page.locator("#phone").fill(localPhone);
    await page.locator("#firstName").fill("ليلى");
    await page.getByTestId("join-submit").click();

    await page.waitForURL(/\/ar\/card\/[A-Za-z0-9_-]{20,}/);
    await expect(page.getByTestId("card-qr")).toBeVisible();
    const firstOutcome = { url: page.url(), cardVisible: true };

    // ── now someone who merely KNOWS that number submits it on the same link ──
    const prober = await page.context().browser()!.newContext();
    const proberPage = await prober.newPage();
    await proberPage.goto(joinUrl);
    await proberPage.locator("#phone").fill(localPhone);
    await proberPage.locator("#firstName").fill("Probe");
    await proberPage.getByTestId("join-submit").click();

    // The API answered identically, so the browser redirects identically...
    await proberPage.waitForURL(/\/ar\/card\/[A-Za-z0-9_-]{20,}/);
    const proberUrl = proberPage.url();
    expect(proberUrl).not.toBe(firstOutcome.url);

    // ...and then the page tells them what the API would not.
    const cardVisible = await proberPage
      .getByTestId("card-qr")
      .isVisible()
      .catch(() => false);

    /*
     * THE ORACLE. A new number lands on a card; a known number lands on nothing. The caller needs
     * no access to the response body, no timing measurement and no special tooling — they watch
     * their own screen.
     *
     * Asserting the defect rather than the fix, deliberately: this test is the reproduction the
     * correction was asked for, and it must be inverted — `expect(cardVisible).toBe(true)` for
     * both — when phone-ownership verification is authorized and the flow is made uniform.
     */
    expect(cardVisible, "KNOWN OPEN DEFECT: a repeat enrolment must not be distinguishable").toBe(false);

    await prober.close();
  });

  test("the oracle does not fire for a number that was never enrolled", async ({ page }) => {
    // The other half of the comparison: two DIFFERENT new numbers both land on a card, so the
    // signal above really is "this number is already a customer" and not noise.
    const cafe = await createStampCafe();
    const joinUrl = `/ar/join/${cafe.program.directSourceToken}`;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const phone = uniqueSyrianPhone();
      await page.goto(joinUrl);
      await page.locator("#phone").fill(`0${phone.slice(4)}`);
      await page.getByTestId("join-submit").click();
      await page.waitForURL(/\/ar\/card\/[A-Za-z0-9_-]{20,}/);
      await expect(page.getByTestId("card-qr")).toBeVisible();
    }
  });

  test("a repeat still reveals nothing ABOUT the existing card", async ({ page }) => {
    /*
     * The part of the earlier fix that does hold, and must keep holding whatever the decision on
     * verification turns out to be: the probe learns THAT the number is enrolled, and nothing
     * else. No name, no balance, no serial, no scanner token, no share token.
     */
    const cafe = await createStampCafe({ mechanics: { welcomeStamps: 3 } });
    const joinUrl = `/ar/join/${cafe.program.directSourceToken}`;
    const phone = uniqueSyrianPhone();
    const localPhone = `0${phone.slice(4)}`;

    await page.goto(joinUrl);
    await page.locator("#phone").fill(localPhone);
    await page.locator("#firstName").fill("ليلى");
    await page.getByTestId("join-submit").click();
    await page.waitForURL(/\/ar\/card\/[A-Za-z0-9_-]{20,}/);
    const realToken = page.url().split("/card/")[1];

    const prober = await page.context().browser()!.newContext();
    const proberPage = await prober.newPage();
    await proberPage.goto(joinUrl);
    await proberPage.locator("#phone").fill(localPhone);
    await proberPage.locator("#firstName").fill("Probe");
    await proberPage.getByTestId("join-submit").click();
    await proberPage.waitForURL(/\/ar\/card\/[A-Za-z0-9_-]{20,}/);

    const decoyToken = proberPage.url().split("/card/")[1];
    const body = (await proberPage.content()).toLowerCase();

    // Not the real token, and nothing of the real customer anywhere on the page.
    expect(decoyToken).not.toBe(realToken);
    expect(body).not.toContain(realToken.toLowerCase());
    expect(body).not.toContain("ليلى");
    expect(body).not.toContain(localPhone);
    // No balance leaked either: the welcome bonus was 3.
    expect(proberPage.getByTestId("card-progress")).toHaveCount(0);

    await prober.close();
  });
});
