/**
 * Public self-service enrolment is withdrawn — owner decision B7, option 3.
 *
 * This file replaces `public-enrollment-route.test.ts`, which tested the endpoint that no longer
 * exists. Its job now is the opposite: prove the route cannot do anything, and prove it cannot be
 * turned back into the oracle it was removed for.
 *
 * The oracle was structural. A public form that issues a live card to a number that has never
 * enrolled, and reveals nothing for a number that has, tells whoever submits it which case they
 * hit — they either receive a card or they do not. Matching status codes and response shapes does
 * not close that; only proof the submitter owns the number does, and Phase 1a has no channel to
 * obtain one. So the endpoint answers everyone identically, at identical cost, having read
 * nothing.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { GET as enrollGet, POST as enrollPost } from "@/app/api/enroll/route";
import { prisma } from "@/server/db";
import { createStampCafe, enrolCustomer, resetDatabase, uniqueSyrianPhone, type StampCafeFixture } from "../setup/fixtures";

interface Answer {
  status: number;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

async function post(): Promise<Answer> {
  const res = await enrollPost();
  return {
    status: res.status,
    body: (await res.json()) as Record<string, unknown>,
    headers: Object.fromEntries(res.headers.entries()),
  };
}

describe("POST /api/enroll — withdrawn", () => {
  let cafe: StampCafeFixture;
  let enrolledPhone: string;

  beforeAll(async () => {
    await resetDatabase();
    cafe = await createStampCafe();
    enrolledPhone = uniqueSyrianPhone();
    // A real customer, enrolled through the service the counter now uses.
    await enrolCustomer(cafe, { phone: enrolledPhone });
  });

  it("refuses every caller with the same answer", async () => {
    const a = await post();
    const b = await post();

    expect(a.status).toBe(410);
    expect(a.body).toEqual(b.body);
    expect(a.body).toMatchObject({ error: { code: "ENROLLMENT_MOVED" } });
    // It points somewhere real rather than just failing.
    expect(String((a.body.error as { message: string }).message).toLowerCase()).toContain("counter");
  });

  it("answers a GET the same way, so a different verb learns nothing", async () => {
    const res = await enrollGet();
    expect(res.status).toBe(410);
    expect(await res.json()).toMatchObject({ error: { code: "ENROLLMENT_MOVED" } });
  });

  it("is not an oracle: the handler takes no input at all", async () => {
    /*
     * The strongest form of this guarantee is structural, not behavioural. The handler signature
     * accepts no Request, so there is no body to branch on: an enrolled number, a stranger's
     * number, a valid source token and an invented one are indistinguishable because none of them
     * can reach the code.
     */
    expect(enrollPost.length).toBe(0);
    expect(enrollGet.length).toBe(0);
  });

  it("creates nothing, finds nothing and reveals nothing", async () => {
    const cardsBefore = await prisma.customerCard.count();
    const customersBefore = await prisma.customer.count();

    const answer = await post();

    expect(await prisma.customerCard.count()).toBe(cardsBefore);
    expect(await prisma.customer.count()).toBe(customersBefore);

    // No token, no phone, no id anywhere in the response.
    const serialized = JSON.stringify(answer);
    expect(serialized).not.toContain(enrolledPhone);
    expect(serialized).not.toContain(cafe.program.directSourceToken);
    expect(serialized.toLowerCase()).not.toContain("cardtoken");
  });

  it("leaves the existing customer's card working", async () => {
    // Withdrawing the route must not strand anyone who already has a link.
    const card = await prisma.customerCard.findFirstOrThrow({
      where: { businessId: cafe.businessId, profile: { customer: { normalizedPhone: enrolledPhone } } },
      select: { shareToken: true, stampBalance: true },
    });
    const { getPublicCardView } = await import("@/server/customers/card-view");
    await expect(getPublicCardView(card.shareToken)).resolves.toMatchObject({
      businessName: expect.any(String),
    });
  });

  it("leaves the enrolment source row intact, because the counter still uses it", async () => {
    // B7 removed the public ROUTE, not the data. Cards enrolled at the till are still attributed
    // to the `direct` source, and deleting it would break that.
    const source = await prisma.utmSourceLink.findFirst({
      where: { publicToken: cafe.program.directSourceToken },
      select: { active: true, utmSource: true },
    });
    expect(source).toMatchObject({ active: true, utmSource: "direct" });
  });
});
