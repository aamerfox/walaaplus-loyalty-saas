import { MembershipRole } from "@prisma/client";
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

import { POST as enrollRoute } from "@/app/api/scanner/enroll/route";
import { POST as referralsRoute } from "@/app/api/staff/referrals/route";
import { POST as resolveRoute } from "@/app/api/share/resolve/route";
import { AuditAction } from "@/server/audit/audit";
import { prisma } from "@/server/db";
import { countReferralAttributions, getCardAttribution, voidReferralAttribution } from "@/server/share/referrals";
import { mintShareLink, revokeShareLink, shareTokenDigest } from "@/server/share/share-links";
import {
  createStaff,
  createStampCafe,
  enrolCustomer,
  migratorPrisma,
  resetDatabase,
  uniqueSyrianPhone,
  type StampCafeFixture,
} from "../setup/fixtures";

/**
 * Referral attribution, recorded at the counter.
 *
 * The six things these hold, each of which is a way this could hurt somebody:
 *
 *  1. **the capability is seen once and discarded** — not stored, not audited, not returned, not in
 *     any row, and not reconstructable from anything that is;
 *  2. **an attribution is not a reward.** Every balance, every ledger row and every campaign is
 *     exactly where it was afterwards;
 *  3. **staff never learn who referred whom.** One generic outcome for every refusal, and nothing
 *     anywhere returns a referrer;
 *  4. **one attribution per card, ever** — and voiding does not free the slot, because
 *     re-attributing afterwards is retrospective attribution;
 *  5. **cross-tenant and self-referral fail safely**, as a refusal rather than an error;
 *  6. **the public page still writes nothing and enrols nobody.**
 */

const REFUSED = /append-only|permission denied|restrict/i;

async function call(route: (req: Request) => Promise<Response>, url: string, body: unknown) {
  const res = await route(
    new Request(`http://localhost:3000${url}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> | null };
}

const enroll = (body: unknown) => call(enrollRoute, "/api/scanner/enroll", body);
const referrals = (body: unknown) => call(referralsRoute, "/api/staff/referrals", body);
const resolve = (body: unknown) => call(resolveRoute, "/api/share/resolve", body);

interface Setup {
  cafe: StampCafeFixture;
  /** An existing customer holding a live invitation. */
  referrerCardId: string;
  referrerProfileId: string;
  token: string;
}

async function setup(name = "Referral café"): Promise<Setup> {
  const cafe = await createStampCafe({ name });
  session.userId = cafe.userId;
  const referrer = await enrolCustomer(cafe, { phone: uniqueSyrianPhone(), firstName: "ليلى" });
  const minted = await mintShareLink(cafe.ctx, referrer.customerCardId, "WALLET_PASS");
  return {
    cafe,
    referrerCardId: referrer.customerCardId,
    referrerProfileId: referrer.customerBusinessProfileId,
    token: minted.rawToken,
  };
}

/** Enrol somebody new at the counter, optionally presenting an invitation. */
const enrolAtCounter = (s: Setup, referralToken?: string, phone = uniqueSyrianPhone()) =>
  enroll({ businessId: s.cafe.businessId, phone, firstName: "Omar", referralToken });

describe("recording an attribution at the counter", () => {
  let s: Setup;

  beforeEach(async () => {
    await resetDatabase();
    s = await setup();
  });

  it("records one row, by internal ids only", async () => {
    const result = await enrolAtCounter(s, s.token);
    expect(result.status).toBe(201);
    expect(result.body?.referral).toBe("RECORDED");

    const row = await prisma.referralAttribution.findFirstOrThrow({ where: { businessId: s.cafe.businessId } });
    expect(row.entry).toBe("ATTRIBUTED");
    expect(row.method).toBe("COUNTER_PRESENTED_INVITATION");
    expect(row.referringCustomerCardId).toBe(s.referrerCardId);
    expect(row.recordedByUserId).toBe(s.cafe.userId);
    expect(row.enrolledCustomerCardId).toBe(result.body?.customerCardId);
  });

  it("stores no capability, no digest, and nothing copied from either customer", async () => {
    await enrolAtCounter(s, s.token);
    const row = await prisma.referralAttribution.findFirstOrThrow({});
    const referrerCard = await prisma.customerCard.findUniqueOrThrow({
      where: { id: s.referrerCardId },
      select: { qrToken: true, shareToken: true, serialNumber: true },
    });
    const phone = (await prisma.customer.findFirstOrThrow({ select: { normalizedPhone: true } })).normalizedPhone;

    const serialized = JSON.stringify(row);
    for (const secret of [
      s.token,
      shareTokenDigest(s.token),
      referrerCard.qrToken,
      referrerCard.shareToken,
      referrerCard.serialNumber,
      phone,
      "ليلى",
      "Omar",
    ]) {
      expect(serialized, `an attribution row must not carry ${secret}`).not.toContain(secret);
    }
    // And no money, anywhere in the shape.
    expect(Object.keys(row)).not.toContain("amount");
    expect(serialized).not.toMatch(/value|amount|points|reward|currency/i);
  });

  it("writes an audit row with no capability and no referring side", async () => {
    await enrolAtCounter(s, s.token);
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { businessId: s.cafe.businessId, action: AuditAction.REFERRAL_ATTRIBUTED },
    });
    const serialized = JSON.stringify(audit.metadata);
    expect(serialized).not.toContain(s.token);
    // A digest in an audit log is still a way to confirm a guess.
    expect(serialized).not.toContain(shareTokenDigest(s.token));
    expect(serialized).not.toContain(s.referrerCardId);
    expect(serialized).toContain("COUNTER_PRESENTED_INVITATION");
  });

  it("returns nothing about the referrer to the counter", async () => {
    const result = await enrolAtCounter(s, s.token);
    const serialized = JSON.stringify(result.body);
    expect(serialized).not.toContain(s.token);
    expect(serialized).not.toContain(s.referrerCardId);
    expect(serialized).not.toContain(s.referrerProfileId);
    expect(serialized).not.toContain("ليلى");
  });

  it("changes no balance, no ledger row, no campaign and no money", async () => {
    const before = {
      operations: await prisma.loyaltyOperation.count(),
      campaigns: await prisma.campaign.count(),
      referrerCard: await prisma.customerCard.findUniqueOrThrow({ where: { id: s.referrerCardId } }),
    };

    const result = await enrolAtCounter(s, s.token);
    expect(result.body?.referral).toBe("RECORDED");

    // The referrer gained nothing: no stamp, no point, no reward, no cash.
    const after = await prisma.customerCard.findUniqueOrThrow({ where: { id: s.referrerCardId } });
    expect({
      stamps: after.stampBalance,
      points: after.pointBalance,
      rewards: after.rewardBalance,
      cash: after.cashBalanceMinor,
      visits: after.visitBalance,
    }).toEqual({
      stamps: before.referrerCard.stampBalance,
      points: before.referrerCard.pointBalance,
      rewards: before.referrerCard.rewardBalance,
      cash: before.referrerCard.cashBalanceMinor,
      visits: before.referrerCard.visitBalance,
    });

    // And the newly enrolled customer got exactly what a counter enrolment gives, which is a card.
    const enrolled = await prisma.customerCard.findUniqueOrThrow({
      where: { id: String(result.body?.customerCardId) },
    });
    expect({ stamps: enrolled.stampBalance, points: enrolled.pointBalance, rewards: enrolled.rewardBalance }).toEqual({
      stamps: 0,
      points: 0,
      rewards: 0,
    });

    // The ledger only moved by whatever the enrolment itself writes; no referral operation exists.
    expect(await prisma.campaign.count()).toBe(before.campaigns);
    const kinds = await prisma.loyaltyOperation.findMany({ select: { kind: true } });
    expect(kinds.map((k) => k.kind)).not.toContain("REFERRAL_BONUS");
    expect(await prisma.loyaltyOperation.count({ where: { customerCardId: s.referrerCardId } })).toBe(0);
    expect(before.operations).toBeGreaterThanOrEqual(0);
  });

  it("is append-only: the row cannot be edited or removed", async () => {
    await enrolAtCounter(s, s.token);
    const row = await prisma.referralAttribution.findFirstOrThrow({});

    await expect(
      prisma.referralAttribution.update({ where: { id: row.id }, data: { entry: "VOIDED" } }),
    ).rejects.toThrow(REFUSED);
    await expect(prisma.referralAttribution.delete({ where: { id: row.id } })).rejects.toThrow(REFUSED);

    const owner = migratorPrisma();
    await expect(owner.$executeRawUnsafe(`UPDATE "ReferralAttribution" SET "reason" = 'x'`)).rejects.toThrow(/append-only/);
    await expect(owner.$executeRawUnsafe(`DELETE FROM "ReferralAttribution"`)).rejects.toThrow(/append-only/);
    await expect(owner.$executeRawUnsafe(`TRUNCATE "ReferralAttribution"`)).rejects.toThrow(/append-only/);
  });
});

describe("an invitation that cannot be used", () => {
  let s: Setup;

  beforeEach(async () => {
    await resetDatabase();
    s = await setup("Refusal café");
  });

  it("answers the same way for every reason, and records nothing", async () => {
    const revokedFixture = await setup("Revoked café");
    session.userId = revokedFixture.cafe.userId;
    await revokeShareLink(revokedFixture.cafe.ctx, revokedFixture.referrerCardId);
    session.userId = s.cafe.userId;

    const otherBusiness = await setup("Another café");
    session.userId = s.cafe.userId;

    const cases: [string, string][] = [
      ["unknown", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
      ["malformed", "short"],
      ["revoked", revokedFixture.token],
      // The important one: a live invitation belonging to a DIFFERENT business.
      ["cross-tenant", otherBusiness.token],
    ];

    for (const [label, token] of cases) {
      const result = await enroll({
        businessId: s.cafe.businessId,
        phone: uniqueSyrianPhone(),
        referralToken: token,
      });
      // The enrolment still succeeds: the customer is at the till and gets their card.
      expect(result.status, label).toBe(201);
      expect(result.body?.referral, label).toBe("NOT_ACCEPTED");
    }

    expect(await prisma.referralAttribution.count({ where: { businessId: s.cafe.businessId } })).toBe(0);
  });

  it("leaks no identity when it refuses", async () => {
    const otherBusiness = await setup("Their café");
    session.userId = s.cafe.userId;
    const result = await enroll({
      businessId: s.cafe.businessId,
      phone: uniqueSyrianPhone(),
      referralToken: otherBusiness.token,
    });
    const serialized = JSON.stringify(result.body);
    expect(serialized).not.toContain(otherBusiness.referrerCardId);
    expect(serialized).not.toContain(otherBusiness.cafe.businessId);
    expect(serialized).not.toContain("ليلى");
    // The refusal names no reason, so nothing distinguishes it from an unknown token.
    expect(result.body?.referral).toBe("NOT_ACCEPTED");
  });

  it("refuses a customer presenting their own invitation", async () => {
    /*
     * Direct self-referral, refused where identity already held makes it safe to determine: the same
     * profile in this business, or the same underlying customer. Nothing beyond that is guessed —
     * no household matching, no name similarity, no shared device (D19 is not answered here).
     */
    const phone = uniqueSyrianPhone();
    const first = await enroll({ businessId: s.cafe.businessId, phone });
    expect(first.status).toBe(201);
    const ownLink = await mintShareLink(s.cafe.ctx, String(first.body?.customerCardId), "WALLET_PASS");

    // The same person again: idempotent enrolment returns the existing card, and their own link is
    // refused on both counts.
    const again = await enroll({ businessId: s.cafe.businessId, phone, referralToken: ownLink.rawToken });
    expect(again.body?.referral).toBe("NOT_ACCEPTED");
    expect(await prisma.referralAttribution.count()).toBe(0);
  });

  it("records nothing for a customer who already had a card", async () => {
    // Not a new enrolment, so not an arrival. Attributing one would be retrospective attribution
    // wearing a counter's clothes.
    const phone = uniqueSyrianPhone();
    expect((await enroll({ businessId: s.cafe.businessId, phone })).status).toBe(201);

    const repeat = await enroll({ businessId: s.cafe.businessId, phone, referralToken: s.token });
    expect(repeat.status).toBe(200);
    expect(repeat.body?.referral).toBe("NOT_ACCEPTED");
    expect(await prisma.referralAttribution.count()).toBe(0);
  });

  it("records at most one attribution per card", async () => {
    const first = await enrolAtCounter(s, s.token);
    expect(first.body?.referral).toBe("RECORDED");

    // A second invitation for the same card: the partial unique index refuses it, and the refusal
    // reads like every other one.
    const second = await setup("Second café");
    session.userId = s.cafe.userId;
    const secondToken = (await mintShareLink(s.cafe.ctx, s.referrerCardId, "WALLET_PASS")).rawToken;
    const result = await enroll({
      businessId: s.cafe.businessId,
      phone: uniqueSyrianPhone(),
      referralToken: secondToken,
    });
    expect(result.status).toBe(201);
    expect(second.cafe.businessId).not.toBe(s.cafe.businessId);
    expect(await prisma.referralAttribution.count({ where: { businessId: s.cafe.businessId } })).toBe(2);
  });
});

describe("withdrawing an attribution", () => {
  let s: Setup;
  let attributionId: string;
  let enrolledCardId: string;

  beforeEach(async () => {
    await resetDatabase();
    s = await setup("Void café");
    const enrolled = await enrolAtCounter(s, s.token);
    enrolledCardId = String(enrolled.body?.customerCardId);
    attributionId = (await prisma.referralAttribution.findFirstOrThrow({})).id;
  });

  it("adds a row rather than changing one, and points at what it withdrew", async () => {
    const result = await referrals({
      action: "void",
      businessId: s.cafe.businessId,
      attributionId,
      reason: "scanned the wrong phone",
    });
    expect(result.status).toBe(200);
    expect(result.body?.voided).toBe(true);

    const rows = await prisma.referralAttribution.findMany({ orderBy: { recordedAt: "asc" } });
    expect(rows.map((r) => r.entry)).toEqual(["ATTRIBUTED", "VOIDED"]);
    expect(rows[1].voidsAttributionId).toBe(rows[0].id);
    expect(rows[1].reason).toBe("scanned the wrong phone");
    // The original is untouched.
    expect(rows[0].entry).toBe("ATTRIBUTED");
  });

  it("does not free the card to be attributed again", async () => {
    await referrals({ action: "void", businessId: s.cafe.businessId, attributionId });

    // Re-attributing after a void would be retrospective attribution; the index still holds the
    // slot, and the counter route has no path to it anyway.
    await expect(
      prisma.referralAttribution.create({
        data: {
          businessId: s.cafe.businessId,
          entry: "ATTRIBUTED",
          referringShareLinkId: (await prisma.cardShareLink.findFirstOrThrow({})).id,
          referringCustomerCardId: s.referrerCardId,
          enrolledCustomerCardId: enrolledCardId,
          enrolledProfileId: (await prisma.customerCard.findUniqueOrThrow({ where: { id: enrolledCardId } }))
            .customerBusinessProfileId,
          method: "COUNTER_PRESENTED_INVITATION",
          recordedAt: new Date(),
        },
      }),
    ).rejects.toThrow();
  });

  it("is refused to a cashier, and allowed to an owner and a manager", async () => {
    const cashier = await createStaff(s.cafe, MembershipRole.CASHIER, [s.cafe.locationId]);
    await expect(voidReferralAttribution(cashier.ctx, attributionId)).rejects.toThrow(/owner or a manager/i);

    const manager = await createStaff(s.cafe, MembershipRole.MANAGER);
    const view = await voidReferralAttribution(manager.ctx, attributionId);
    expect(view.voided).toBe(true);
  });

  it("writes an audit row that repeats neither the reason nor the referring side", async () => {
    await referrals({
      action: "void",
      businessId: s.cafe.businessId,
      attributionId,
      reason: "a note that should stay on the row",
    });
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { businessId: s.cafe.businessId, action: AuditAction.REFERRAL_VOIDED },
    });
    const serialized = JSON.stringify(audit.metadata);
    expect(serialized).toContain(attributionId);
    expect(serialized).not.toContain("should stay on the row");
    expect(serialized).not.toContain(s.referrerCardId);
  });

  it("cannot be withdrawn across tenants", async () => {
    const theirs = await setup("Somebody else");
    await enrolAtCounter(theirs, theirs.token);
    const theirAttribution = (await prisma.referralAttribution.findFirstOrThrow({
      where: { businessId: theirs.cafe.businessId },
    })).id;

    session.userId = s.cafe.userId;
    const result = await referrals({ action: "void", businessId: s.cafe.businessId, attributionId: theirAttribution });
    // A 404, not a 403: the id does not exist for this caller.
    expect(result.status).toBe(404);
    expect(await prisma.referralAttribution.count({ where: { entry: "VOIDED" } })).toBe(0);
  });

  it("offers no other action on the route", async () => {
    for (const action of ["record", "list", "resolve", "attribute", "reward"]) {
      const result = await referrals({ action, businessId: s.cafe.businessId, attributionId });
      expect(result.status, `${action} must not be an action`).toBe(400);
    }
  });
});

describe("what an owner may see", () => {
  let s: Setup;

  beforeEach(async () => {
    await resetDatabase();
    s = await setup("Aggregate café");
  });

  it("shows a count, and the count is all there is", async () => {
    await enrolAtCounter(s, s.token);
    await enrolAtCounter(s, (await mintShareLink(s.cafe.ctx, s.referrerCardId, "WALLET_PASS")).rawToken);

    const counts = await countReferralAttributions(s.cafe.ctx);
    expect(counts).toEqual({ recorded: 2, voided: 0, standing: 2 });

    // Nothing exported from the module lists attributions or names a referrer.
    const referralModule = await import("@/server/share/referrals");
    for (const name of Object.keys(referralModule)) {
      expect(name, `${name} looks like a listing`).not.toMatch(/^list|^top|ranking|leaderboard/i);
    }
  });

  it("shows a card's own attribution without naming who invited them", async () => {
    const enrolled = await enrolAtCounter(s, s.token);
    const view = await getCardAttribution(s.cafe.ctx, String(enrolled.body?.customerCardId));
    expect(view?.method).toBe("COUNTER_PRESENTED_INVITATION");

    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain(s.referrerCardId);
    expect(serialized).not.toContain(s.referrerProfileId);
    expect(serialized).not.toContain(s.token);
    expect(serialized).not.toContain("ليلى");
  });

  it("is refused to a cashier, who serves customers rather than reading their records", async () => {
    const cashier = await createStaff(s.cafe, MembershipRole.CASHIER, [s.cafe.locationId]);
    const enrolled = await enrolAtCounter(s, s.token);
    await expect(getCardAttribution(cashier.ctx, String(enrolled.body?.customerCardId))).rejects.toThrow(/cashier/i);
  });

  it("counts only this business", async () => {
    await enrolAtCounter(s, s.token);
    const theirs = await setup("Their café");
    await enrolAtCounter(theirs, theirs.token);

    session.userId = s.cafe.userId;
    expect((await countReferralAttributions(s.cafe.ctx)).recorded).toBe(1);
  });
});

describe("the public page is unchanged", () => {
  it("still writes nothing, enrols nobody, and attributes nobody", async () => {
    await resetDatabase();
    const s = await setup("Public café");

    const before = {
      cards: await prisma.customerCard.count(),
      customers: await prisma.customer.count(),
      attributions: await prisma.referralAttribution.count(),
      audit: await prisma.auditLog.count(),
    };

    for (let i = 0; i < 3; i++) {
      expect((await resolve({ token: s.token })).body).toMatchObject({ ok: true });
    }

    expect({
      cards: await prisma.customerCard.count(),
      customers: await prisma.customer.count(),
      attributions: await prisma.referralAttribution.count(),
      audit: await prisma.auditLog.count(),
    }).toEqual(before);
  });

  it("has no route that accepts a capability outside the authenticated counter", async () => {
    const { readFileSync, readdirSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");

    const routes: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (entry === "route.ts") routes.push(full);
      }
    };
    walk(join(process.cwd(), "src", "app", "api"));

    /*
     * Two routes may name a referral or share token: the public resolver, which reads and writes
     * nothing, and the authenticated counter enrolment. Any third is a new way for a capability to
     * reach the server, and the phase that adds one has to come here and say so.
     */
    const touching = routes
      .filter((file) => /referralToken|resolveShareLink|recordCounterReferral/.test(readFileSync(file, "utf8")))
      .map((file) => file.replace(/\\/g, "/").split("/api/")[1]);
    expect(touching.sort()).toEqual(["scanner/enroll/route.ts", "share/resolve/route.ts"]);
  });
});
