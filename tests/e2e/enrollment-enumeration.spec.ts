import { expect, test } from "@playwright/test";
import { prisma } from "@/server/db";
import { createStampCafe, enrolCustomer, uniqueSyrianPhone } from "../setup/fixtures";

/**
 * The public enrolment path is withdrawn, and answers everyone identically.
 *
 * This file used to reproduce an oracle: the public form issued a live card to a number that had
 * never enrolled and nothing to a number that had, so whoever submitted a number learned which
 * case they hit by watching their own screen. Matching the API's status and shape did not close
 * it, because the signal was the card itself.
 *
 * Owner decision **B7, option 3** removed the flow rather than hardening it. These tests are the
 * inverted version of the ones that pinned the defect: they prove the page and the endpoint now
 * behave the same way for every visitor, and that withdrawing them stranded nobody.
 */

test.describe("the withdrawn public enrolment path", () => {
  test("answers an enrolled number, a stranger's number and an invented link identically", async ({ page }) => {
    const cafe = await createStampCafe();
    const enrolled = uniqueSyrianPhone();
    await enrolCustomer(cafe, { phone: enrolled });

    // A real printed link, and one that never existed.
    const realLink = `/ar/join/${cafe.program.directSourceToken}`;
    const inventedLink = "/ar/join/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

    const rendered: string[] = [];
    for (const link of [realLink, inventedLink]) {
      const response = await page.goto(link);
      expect(response?.status(), `${link} must render, not 404`).toBe(200);
      await expect(page.getByTestId("join-withdrawn")).toBeVisible();
      rendered.push((await page.getByTestId("join-withdrawn").textContent()) ?? "");
    }

    /*
     * Byte-identical. A dead link and a live one must not be distinguishable either: replacing
     * "is this number enrolled" with "does this business exist" would be a smaller oracle, not
     * an absent one.
     */
    expect(rendered[0]).toBe(rendered[1]);

    // No form to submit, so no phone number can be tested against anything.
    await expect(page.getByTestId("join-form")).toHaveCount(0);
    await expect(page.locator("#phone")).toHaveCount(0);
  });

  test("the endpoint itself refuses every caller the same way", async ({ request }) => {
    const cafe = await createStampCafe();
    const enrolled = uniqueSyrianPhone();
    await enrolCustomer(cafe, { phone: enrolled });

    const bodies = [
      { sourceToken: cafe.program.directSourceToken, phone: enrolled },
      { sourceToken: cafe.program.directSourceToken, phone: uniqueSyrianPhone() },
      { sourceToken: "not-a-real-token", phone: enrolled },
      {},
    ];

    const answers = [] as { status: number; text: string }[];
    for (const body of bodies) {
      const response = await request.post("/api/enroll", { data: body });
      answers.push({ status: response.status(), text: await response.text() });
    }

    // Same status and same bytes for an enrolled number, a new number, a dead token and no body.
    for (const answer of answers) {
      expect(answer.status).toBe(410);
      expect(answer.text).toBe(answers[0].text);
      expect(answer.text.toLowerCase()).not.toContain("cardtoken");
    }

    // And nothing was created by any of it.
    expect(
      await prisma.customerCard.count({
        where: { businessId: cafe.businessId, profile: { customer: { normalizedPhone: bodies[1].phone as string } } },
      }),
    ).toBe(0);
  });

  test("a customer who already has their link keeps using it", async ({ page }) => {
    // Withdrawing a route must not strand the people who acted on it while it existed.
    const cafe = await createStampCafe({ mechanics: { welcomeStamps: 1 } });
    const phone = uniqueSyrianPhone();
    await enrolCustomer(cafe, { phone, firstName: "ليلى" });

    const card = await prisma.customerCard.findFirstOrThrow({
      where: { businessId: cafe.businessId, profile: { customer: { normalizedPhone: phone } } },
      select: { shareToken: true },
    });

    await page.goto(`/ar/card/${card.shareToken}`);
    await expect(page.getByTestId("card-qr")).toBeVisible();
    await expect(page.getByTestId("card-progress")).toContainText("1");
  });
});
