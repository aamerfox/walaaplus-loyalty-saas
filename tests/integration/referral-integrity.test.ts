import { beforeEach, describe, expect, it, vi } from "vitest";

const session = vi.hoisted(() => ({ userId: null as string | null }));

vi.mock("@/server/auth/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/auth/session")>();
  const { UnauthorizedError } = await import("@/server/errors");
  return {
    ...actual,
    getCurrentUserId: async () => session.userId,
    requireUserId: async () => {
      if (!session.userId) throw new UnauthorizedError();
      return session.userId;
    },
  };
});

import { prisma } from "@/server/db";
import { mintShareLink } from "@/server/share/share-links";
import { createStampCafe, enrolCustomer, resetDatabase, uniqueSyrianPhone, type StampCafeFixture } from "../setup/fixtures";

/**
 * What the DATABASE refuses, with the service taken out of the picture.
 *
 * ## Why this file exists separately
 *
 * `referral-attribution.test.ts` proves the service builds correct rows. This one proves that a
 * correct row is the only kind the database will accept — every insert below goes through
 * `prisma`, the **restricted runtime client**, with no service in the way, exactly as a second
 * service, a backfill script or a console session would.
 *
 * Append-only protects history from being rewritten. It does nothing about a row that was wrong the
 * moment it was written: a void pointing at another void, an attribution carrying a withdrawal
 * reason, or a link, card and profile belonging to three different businesses. Foreign keys check
 * that each id EXISTS; nothing in a foreign key checks that they AGREE.
 *
 * A guarantee that lives only in one service ends the first time somebody writes a second one.
 */

/** The trigger raises `check_violation`; each message names the rule that refused the row. */
const REFUSED = /ReferralAttribution:/;

interface World {
  cafe: StampCafeFixture;
  /** A live invitation, and the card it belongs to. */
  linkId: string;
  referrerCardId: string;
  referrerProfileId: string;
  /** Somebody else, newly enrolled, with no attribution yet. */
  enrolledCardId: string;
  enrolledProfileId: string;
}

async function build(name: string): Promise<World> {
  const cafe = await createStampCafe({ name });
  session.userId = cafe.userId;

  const referrer = await enrolCustomer(cafe, { phone: uniqueSyrianPhone(), firstName: "ليلى" });
  const enrolled = await enrolCustomer(cafe, { phone: uniqueSyrianPhone(), firstName: "Omar" });
  const minted = await mintShareLink(cafe.ctx, referrer.customerCardId, "WALLET_PASS");

  return {
    cafe,
    linkId: minted.id,
    referrerCardId: referrer.customerCardId,
    referrerProfileId: referrer.customerBusinessProfileId,
    enrolledCardId: enrolled.customerCardId,
    enrolledProfileId: enrolled.customerBusinessProfileId,
  };
}

/** A correct ATTRIBUTED row for `w`, which each test then breaks in exactly one way. */
function attributed(w: World, overrides: Record<string, unknown> = {}) {
  return {
    businessId: w.cafe.businessId,
    entry: "ATTRIBUTED" as const,
    referringShareLinkId: w.linkId,
    referringCustomerCardId: w.referrerCardId,
    enrolledCustomerCardId: w.enrolledCardId,
    enrolledProfileId: w.enrolledProfileId,
    method: "COUNTER_PRESENTED_INVITATION" as const,
    recordedAt: new Date(),
    ...overrides,
  };
}

describe("the parts of a row have to agree", () => {
  let mine: World;
  let theirs: World;

  beforeEach(async () => {
    await resetDatabase();
    mine = await build("Integrity café");
    theirs = await build("Another café");
    session.userId = mine.cafe.userId;
  });

  it("accepts a row whose parts all agree", async () => {
    // The control. Everything below is this row with one thing wrong.
    const row = await prisma.referralAttribution.create({ data: attributed(mine), select: { id: true } });
    expect(row.id).toBeTruthy();
  });

  it("refuses a share link from another business", async () => {
    await expect(
      prisma.referralAttribution.create({ data: attributed(mine, { referringShareLinkId: theirs.linkId }) }),
    ).rejects.toThrow(REFUSED);
  });

  it("refuses a share link that belongs to a different card", async () => {
    /*
     * Both ids are this business's and both exist, so every foreign key is satisfied. What is wrong
     * is the relationship between them — the row claims an invitation came from a card it did not
     * come from, which is the one thing that would make an attribution point at the wrong customer.
     */
    const otherCard = await enrolCustomer(mine.cafe, { phone: uniqueSyrianPhone() });
    const otherLink = await mintShareLink(mine.cafe.ctx, otherCard.customerCardId, "WALLET_PASS");

    await expect(
      prisma.referralAttribution.create({ data: attributed(mine, { referringShareLinkId: otherLink.id }) }),
    ).rejects.toThrow(REFUSED);
  });

  it("refuses a referring card from another business", async () => {
    await expect(
      prisma.referralAttribution.create({
        data: attributed(mine, { referringShareLinkId: theirs.linkId, referringCustomerCardId: theirs.referrerCardId }),
      }),
    ).rejects.toThrow(REFUSED);
  });

  it("refuses an enrolled card from another business", async () => {
    await expect(
      prisma.referralAttribution.create({
        data: attributed(mine, { enrolledCustomerCardId: theirs.enrolledCardId }),
      }),
    ).rejects.toThrow(REFUSED);
  });

  it("refuses an enrolled card that belongs to a different profile", async () => {
    await expect(
      prisma.referralAttribution.create({ data: attributed(mine, { enrolledProfileId: mine.referrerProfileId }) }),
    ).rejects.toThrow(REFUSED);
  });

  it("refuses an enrolled profile from another business", async () => {
    await expect(
      prisma.referralAttribution.create({
        data: attributed(mine, {
          enrolledCustomerCardId: theirs.enrolledCardId,
          enrolledProfileId: theirs.enrolledProfileId,
        }),
      }),
    ).rejects.toThrow(REFUSED);
  });

  it("refuses a row that mixes two businesses on either side", async () => {
    // The shape a cross-tenant attribution would actually take: my business, their customer.
    await expect(
      prisma.referralAttribution.create({
        data: attributed(mine, {
          businessId: theirs.cafe.businessId,
          enrolledCustomerCardId: theirs.enrolledCardId,
          enrolledProfileId: theirs.enrolledProfileId,
        }),
      }),
    ).rejects.toThrow(REFUSED);
  });
});

describe("an ATTRIBUTED row withdraws nothing", () => {
  let mine: World;

  beforeEach(async () => {
    await resetDatabase();
    mine = await build("Attributed café");
    session.userId = mine.cafe.userId;
  });

  it("refuses one that names something to void", async () => {
    const first = await prisma.referralAttribution.create({ data: attributed(mine), select: { id: true } });
    const other = await enrolCustomer(mine.cafe, { phone: uniqueSyrianPhone() });

    await expect(
      prisma.referralAttribution.create({
        data: attributed(mine, {
          enrolledCustomerCardId: other.customerCardId,
          enrolledProfileId: other.customerBusinessProfileId,
          voidsAttributionId: first.id,
        }),
      }),
    ).rejects.toThrow(REFUSED);
  });

  it("refuses one carrying a void reason", async () => {
    // A withdrawal note attached to a record that was never withdrawn.
    await expect(
      prisma.referralAttribution.create({ data: attributed(mine, { reason: "changed my mind" }) }),
    ).rejects.toThrow(REFUSED);
  });
});

describe("a VOIDED row has to be a faithful account of what it withdraws", () => {
  let mine: World;
  let theirs: World;
  let attributionId: string;

  /** A correct VOIDED row for `mine`, which each test then breaks in exactly one way. */
  function voided(overrides: Record<string, unknown> = {}) {
    return attributed(mine, {
      entry: "VOIDED" as const,
      voidsAttributionId: attributionId,
      ...overrides,
    });
  }

  beforeEach(async () => {
    await resetDatabase();
    mine = await build("Void café");
    theirs = await build("Their café");
    session.userId = mine.cafe.userId;
    attributionId = (await prisma.referralAttribution.create({ data: attributed(mine), select: { id: true } })).id;
  });

  it("accepts a faithful withdrawal", async () => {
    const row = await prisma.referralAttribution.create({
      data: voided({ reason: "scanned the wrong phone" }),
      select: { id: true },
    });
    expect(row.id).toBeTruthy();
  });

  it("refuses one that names nothing", async () => {
    await expect(prisma.referralAttribution.create({ data: voided({ voidsAttributionId: null }) })).rejects.toThrow(
      REFUSED,
    );
  });

  it("refuses one that targets a row which does not exist", async () => {
    await expect(
      prisma.referralAttribution.create({ data: voided({ voidsAttributionId: "00000000-0000-0000-0000-000000000000" }) }),
    ).rejects.toThrow();
  });

  it("refuses one that targets another void", async () => {
    const firstVoid = await prisma.referralAttribution.create({ data: voided(), select: { id: true } });
    await expect(
      prisma.referralAttribution.create({ data: voided({ voidsAttributionId: firstVoid.id }) }),
    ).rejects.toThrow(REFUSED);
  });

  it("refuses one from another business", async () => {
    /*
     * The row itself is internally consistent for the OTHER business, and it points at my
     * attribution. Without this rule a second tenant could withdraw my records.
     */
    await expect(
      prisma.referralAttribution.create({
        data: {
          businessId: theirs.cafe.businessId,
          entry: "VOIDED",
          referringShareLinkId: theirs.linkId,
          referringCustomerCardId: theirs.referrerCardId,
          enrolledCustomerCardId: theirs.enrolledCardId,
          enrolledProfileId: theirs.enrolledProfileId,
          method: "COUNTER_PRESENTED_INVITATION",
          voidsAttributionId: attributionId,
          recordedAt: new Date(),
        },
      }),
    ).rejects.toThrow(REFUSED);
  });

  it("refuses one that changes any copied field", async () => {
    /*
     * Copying the fields rather than joining for them is what lets one row be read on its own. This
     * is what makes the copy true — a void that quietly named a different referring card would
     * produce a decision history that says two different things about one event.
     */
    const otherCard = await enrolCustomer(mine.cafe, { phone: uniqueSyrianPhone() });
    const otherLink = await mintShareLink(mine.cafe.ctx, otherCard.customerCardId, "WALLET_PASS");

    const mutations: [string, Record<string, unknown>][] = [
      ["referring link", { referringShareLinkId: otherLink.id, referringCustomerCardId: otherCard.customerCardId }],
      ["enrolled card", { enrolledCustomerCardId: mine.referrerCardId, enrolledProfileId: mine.referrerProfileId }],
    ];

    for (const [label, override] of mutations) {
      await expect(
        prisma.referralAttribution.create({ data: voided(override) }),
        `a void that changed the ${label} must be refused`,
      ).rejects.toThrow(REFUSED);
    }
  });

  it("still allows only one void per attribution", async () => {
    await prisma.referralAttribution.create({ data: voided() });
    // The pre-existing partial unique index, unaffected by the new trigger.
    await expect(prisma.referralAttribution.create({ data: voided() })).rejects.toThrow();
  });
});

describe("nothing the hardening added weakened anything", () => {
  it("keeps the table append-only and the runtime role restricted", async () => {
    await resetDatabase();
    const mine = await build("Unchanged café");
    session.userId = mine.cafe.userId;
    const row = await prisma.referralAttribution.create({ data: attributed(mine), select: { id: true } });

    await expect(
      prisma.referralAttribution.update({ where: { id: row.id }, data: { reason: "edited" } }),
    ).rejects.toThrow(/append-only|permission denied/i);
    await expect(prisma.referralAttribution.delete({ where: { id: row.id } })).rejects.toThrow(
      /append-only|permission denied/i,
    );

    const privileges = await prisma.$queryRaw<{ s: boolean; i: boolean; u: boolean; d: boolean; t: boolean }[]>`
      SELECT has_table_privilege('"ReferralAttribution"', 'SELECT')   AS s,
             has_table_privilege('"ReferralAttribution"', 'INSERT')   AS i,
             has_table_privilege('"ReferralAttribution"', 'UPDATE')   AS u,
             has_table_privilege('"ReferralAttribution"', 'DELETE')   AS d,
             has_table_privilege('"ReferralAttribution"', 'TRUNCATE') AS t`;
    expect(privileges[0]).toEqual({ s: true, i: true, u: false, d: false, t: false });
  });

  it("adds no column that could hold a reward, and none that could hold a capability", async () => {
    const columns = await prisma.$queryRaw<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'ReferralAttribution'`;
    for (const { column_name } of columns) {
      expect(column_name, `${column_name} looks like a reward`).not.toMatch(
        /amount|value|minor|currency|point|stamp|reward|credit|bonus|payout|eligib|expir/i,
      );
      expect(column_name, `${column_name} looks like a capability`).not.toMatch(/token|digest|secret|url/i);
    }
  });
});
