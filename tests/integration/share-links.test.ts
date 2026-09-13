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

import { POST as resolveRoute } from "@/app/api/share/resolve/route";
import { GET as resolveGet } from "@/app/api/share/resolve/route";
import { POST as walletRoute } from "@/app/api/staff/wallet/route";
import { AuditAction } from "@/server/audit/audit";
import { prisma } from "@/server/db";
import { publicShareUrl } from "@/server/program/public-urls";
import { mintShareLink, resolveShareLink, revokeShareLink, shareTokenDigest } from "@/server/share/share-links";
import { issueWalletPassPayloads, previewWalletPass } from "@/server/wallet/wallet-pass";
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
 * The invitation capability end to end.
 *
 * The five things these hold, each of which is a way this could hurt somebody:
 *
 *  1. **the raw token is never stored, logged or audited** — only its digest reaches the database,
 *     and the audit row carries neither;
 *  2. **resolving one writes nothing.** No audit row, no counter, no timestamp. A capability that
 *     leaves a trail each time it is opened reports who has been looking at it;
 *  3. **the public answer is a business name and nothing else** — no customer, card, balance,
 *     programme, serial or token, and one identical shape for every failure;
 *  4. **revoking and re-issuing kill the old link**, in the database and through the route;
 *  5. **nothing this feature does creates a card, an enrolment, a ledger row or a reward.**
 */

/** Every shape the two triggers and the role grant refuse a write in. */
const REFUSED = /issue-once|never removed|revocation is final|permission denied|restrict/i;

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

const resolve = (body: unknown) => call(resolveRoute, "/api/share/resolve", body);
const wallet = (body: unknown) => call(walletRoute, "/api/staff/wallet", body);

const ISSUER_IDS = {
  apple: { passTypeIdentifier: "pass.test.zademi", teamIdentifier: "TEAMTEST12" },
  google: { objectId: "3388000000000000001.test", classId: "3388000000000000001.stamp" },
};

interface Setup {
  cafe: StampCafeFixture;
  cardId: string;
  profileId: string;
}

async function setup(name = "Invitation café"): Promise<Setup> {
  const cafe = await createStampCafe({ name });
  session.userId = cafe.userId;
  const customer = await enrolCustomer(cafe, { phone: uniqueSyrianPhone(), firstName: "ليلى" });
  return { cafe, cardId: customer.customerCardId, profileId: customer.customerBusinessProfileId };
}

describe("minting a capability", () => {
  let s: Setup;

  beforeEach(async () => {
    await resetDatabase();
    s = await setup();
  });

  it("stores a digest and never the raw value", async () => {
    const minted = await mintShareLink(s.cafe.ctx, s.cardId, "WALLET_PASS");

    const row = await prisma.cardShareLink.findFirstOrThrow({ where: { customerCardId: s.cardId } });
    expect(row.tokenDigest).toBe(shareTokenDigest(minted.rawToken));
    // The obvious check, and the one that catches somebody adding a "for debugging" column.
    expect(JSON.stringify(row)).not.toContain(minted.rawToken);
    expect(minted.rawToken.length).toBeGreaterThanOrEqual(40);
  });

  it("draws a value unrelated to every other secret the card carries", async () => {
    const minted = await mintShareLink(s.cafe.ctx, s.cardId, "WALLET_PASS");
    const card = await prisma.customerCard.findUniqueOrThrow({
      where: { id: s.cardId },
      select: { qrToken: true, shareToken: true, serialNumber: true, id: true },
    });
    for (const other of [card.qrToken, card.shareToken, card.serialNumber, card.id]) {
      expect(minted.rawToken).not.toContain(other);
      expect(other).not.toContain(minted.rawToken);
    }
  });

  it("writes an audit row that carries neither the token nor its digest", async () => {
    const minted = await mintShareLink(s.cafe.ctx, s.cardId, "WALLET_PASS");
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { businessId: s.cafe.businessId, action: AuditAction.SHARE_LINK_ISSUED },
    });
    const serialized = JSON.stringify(audit.metadata);
    expect(serialized).not.toContain(minted.rawToken);
    // A digest in an audit log is still a way to confirm a guess.
    expect(serialized).not.toContain(shareTokenDigest(minted.rawToken));
    expect(serialized).toContain("WALLET_PASS");
  });

  it("retires the previous link, so a card never has two live ones", async () => {
    const first = await mintShareLink(s.cafe.ctx, s.cardId, "WALLET_PASS");
    const second = await mintShareLink(s.cafe.ctx, s.cardId, "WALLET_PASS");

    expect(await resolveShareLink(first.rawToken)).toBeNull();
    expect(await resolveShareLink(second.rawToken)).not.toBeNull();
    expect(await prisma.cardShareLink.count({ where: { customerCardId: s.cardId, revokedAt: null } })).toBe(1);
    // Nothing is deleted: what was handed out stays on the record.
    expect(await prisma.cardShareLink.count({ where: { customerCardId: s.cardId } })).toBe(2);
  });

  it("builds a fragment URL, which is the whole reason no server sees the token", async () => {
    const minted = await mintShareLink(s.cafe.ctx, s.cardId, "WALLET_PASS");
    const url = publicShareUrl(minted.rawToken);
    expect(url).toMatch(/\/share#/);
    // Everything before the `#` is what reaches a request line. The token must not be in it.
    expect(url.split("#")[0]).not.toContain(minted.rawToken);
    expect(url).not.toContain("?");
  });

  it("refuses a card that is not this tenant's", async () => {
    const theirs = await setup("Another café");
    session.userId = s.cafe.userId;
    // A 404 shape, not a 403: the id does not exist for this caller.
    await expect(mintShareLink(s.cafe.ctx, theirs.cardId, "WALLET_PASS")).rejects.toThrow(/not found/i);
    expect(await prisma.cardShareLink.count({ where: { businessId: s.cafe.businessId } })).toBe(0);
  });

  it("lets a cashier mint, because adding a card to a wallet is a counter action", async () => {
    /*
     * A cashier holds EDIT_CUSTOMERS because enrolling a customer is their job (owner decision B7
     * option 3), and adding the card they have just handed over to a wallet is the same moment.
     * `src/server/tenant/permissions.ts` asks every later guard on that bit to decide this
     * explicitly rather than inherit it, so it is decided here and asserted.
     */
    const cashier = await createStaff(s.cafe, MembershipRole.CASHIER, [s.cafe.locationId]);
    const minted = await mintShareLink(cashier.ctx, s.cardId, "WALLET_PASS");
    expect(await resolveShareLink(minted.rawToken)).not.toBeNull();
  });

  it("refuses a cashier the two actions that are not counter work", async () => {
    // Revoking destroys something the customer already holds; reading a card's link history is
    // reading their record. Neither is serving whoever is standing in front of you.
    const cashier = await createStaff(s.cafe, MembershipRole.CASHIER, [s.cafe.locationId]);
    await mintShareLink(s.cafe.ctx, s.cardId, "WALLET_PASS");
    await expect(revokeShareLink(cashier.ctx, s.cardId)).rejects.toThrow(/cashier/i);
    await expect(previewWalletPass(cashier.ctx, s.cardId, "en")).rejects.toThrow(/cashier/i);
  });
});

describe("resolving a capability", () => {
  let s: Setup;
  let raw: string;

  beforeEach(async () => {
    await resetDatabase();
    s = await setup("Resolve café");
    raw = (await mintShareLink(s.cafe.ctx, s.cardId, "WALLET_PASS")).rawToken;
  });

  it("returns the business name and nothing else", async () => {
    // The business name, not the programme name: `createStampCafe({ name })` names the programme,
    // and the page shows whose business the invitation is for.
    const business = await prisma.business.findUniqueOrThrow({
      where: { id: s.cafe.businessId },
      select: { name: true },
    });
    const result = await resolve({ token: raw });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ ok: true, businessName: business.name });
  });

  it("leaks no customer, card, balance, programme, serial or token", async () => {
    const card = await prisma.customerCard.findUniqueOrThrow({
      where: { id: s.cardId },
      select: { qrToken: true, shareToken: true, serialNumber: true },
    });
    const phone = (await prisma.customer.findFirstOrThrow({ select: { normalizedPhone: true } })).normalizedPhone;

    const serialized = JSON.stringify((await resolve({ token: raw })).body);
    for (const secret of [card.qrToken, card.shareToken, card.serialNumber, phone, "ليلى", s.cardId, s.profileId, raw]) {
      expect(serialized, `the public answer must not carry ${secret}`).not.toContain(secret);
    }
  });

  it("writes absolutely nothing", async () => {
    /*
     * The rule, asserted rather than trusted. No audit row, no counter, no last-seen timestamp. A
     * capability that leaves a trail each time it is opened is a capability that reports who has
     * been looking at it, and an invitation page has no business knowing that.
     */
    const before = {
      audit: await prisma.auditLog.count(),
      links: await prisma.cardShareLink.count(),
      operations: await prisma.loyaltyOperation.count(),
      cards: await prisma.customerCard.count(),
      customers: await prisma.customer.count(),
    };
    const row = await prisma.cardShareLink.findFirstOrThrow({ where: { customerCardId: s.cardId } });

    for (let i = 0; i < 3; i++) await resolve({ token: raw });

    expect({
      audit: await prisma.auditLog.count(),
      links: await prisma.cardShareLink.count(),
      operations: await prisma.loyaltyOperation.count(),
      cards: await prisma.customerCard.count(),
      customers: await prisma.customer.count(),
    }).toEqual(before);
    expect(await prisma.cardShareLink.findFirstOrThrow({ where: { id: row.id } })).toEqual(row);
  });

  it("answers every failure in one shape", async () => {
    /*
     * Unknown, revoked, malformed, empty, wrong type, absurdly long. Distinguishing "never existed"
     * from "existed and was revoked" is the only difference worth probing for, and a visitor has no
     * use for it either way.
     */
    await revokeShareLink(s.cafe.ctx, s.cardId);
    for (const token of [raw, "not-a-real-token-but-long-enough-to-pass-the-shape-check", "", 42, null, "x".repeat(500)]) {
      const result = await resolve({ token });
      expect(result.status, `token ${String(token).slice(0, 20)}`).toBe(200);
      expect(result.body).toEqual({ ok: false });
    }
    // And a body that is not JSON at all.
    const malformed = await resolveRoute(
      new Request("http://localhost:3000/api/share/resolve", { method: "POST", body: "{{{" }),
    );
    expect(malformed.status).toBe(200);
    expect(await malformed.json()).toEqual({ ok: false });
  });

  it("refuses GET, the shape that would put a token in a URL", async () => {
    const response = resolveGet();
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
  });

  it("is never cached", async () => {
    const response = await resolveRoute(
      new Request("http://localhost:3000/api/share/resolve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: raw }),
      }),
    );
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("stops working when the card stops being a card", async () => {
    await prisma.customerCard.update({ where: { id: s.cardId }, data: { status: "DELETED" } });
    expect(await resolve({ token: raw })).toMatchObject({ body: { ok: false } });
  });

  it("stops working when the business is deactivated", async () => {
    await prisma.business.update({ where: { id: s.cafe.businessId }, data: { active: false } });
    expect(await resolve({ token: raw })).toMatchObject({ body: { ok: false } });
  });
});

describe("revoking", () => {
  let s: Setup;

  beforeEach(async () => {
    await resetDatabase();
    s = await setup("Revoke café");
  });

  it("kills the link and keeps the row", async () => {
    const raw = (await mintShareLink(s.cafe.ctx, s.cardId, "WALLET_PASS")).rawToken;
    expect(await revokeShareLink(s.cafe.ctx, s.cardId)).toBe(true);

    expect(await resolveShareLink(raw)).toBeNull();
    const row = await prisma.cardShareLink.findFirstOrThrow({ where: { customerCardId: s.cardId } });
    expect(row.revokedAt).not.toBeNull();
  });

  it("reports honestly when there was nothing to revoke", async () => {
    expect(await revokeShareLink(s.cafe.ctx, s.cardId)).toBe(false);
  });

  it("is final: a revocation cannot be rewritten back to live", async () => {
    await mintShareLink(s.cafe.ctx, s.cardId, "WALLET_PASS");
    await revokeShareLink(s.cafe.ctx, s.cardId);
    const row = await prisma.cardShareLink.findFirstOrThrow({ where: { customerCardId: s.cardId } });

    await expect(
      prisma.cardShareLink.update({ where: { id: row.id }, data: { revokedAt: null } }),
    ).rejects.toThrow(REFUSED);
  });

  it("freezes everything except revokedAt", async () => {
    const minted = await mintShareLink(s.cafe.ctx, s.cardId, "WALLET_PASS");
    await expect(
      prisma.cardShareLink.update({ where: { id: minted.id }, data: { tokenDigest: shareTokenDigest("swapped") } }),
    ).rejects.toThrow(REFUSED);
    await expect(
      prisma.cardShareLink.update({ where: { id: minted.id }, data: { issuedFor: "SOMETHING_ELSE" } }),
    ).rejects.toThrow(REFUSED);
  });

  it("is never deleted, by the app or by the owner", async () => {
    const minted = await mintShareLink(s.cafe.ctx, s.cardId, "WALLET_PASS");
    await expect(prisma.cardShareLink.delete({ where: { id: minted.id } })).rejects.toThrow(REFUSED);

    const owner = migratorPrisma();
    await expect(owner.$executeRawUnsafe(`DELETE FROM "CardShareLink"`)).rejects.toThrow(/never removed/);
    await expect(owner.$executeRawUnsafe(`TRUNCATE "CardShareLink"`)).rejects.toThrow(/never removed/);
    // And the owner is refused the same rewrite the app is.
    await expect(
      owner.$executeRawUnsafe(`UPDATE "CardShareLink" SET "tokenDigest" = 'x'`),
    ).rejects.toThrow(/issue-once/);
  });

  it("cannot be revoked across tenants", async () => {
    const theirs = await setup("Somebody else");
    session.userId = s.cafe.userId;
    await expect(revokeShareLink(s.cafe.ctx, theirs.cardId)).rejects.toThrow(/not found/i);
  });
});

describe("wallet passes", () => {
  let s: Setup;

  beforeEach(async () => {
    await resetDatabase();
    s = await setup("Wallet café");
  });

  it("mints lazily: a card with no pass prepared has no row at all", async () => {
    expect(await prisma.cardShareLink.count()).toBe(0);
    await previewWalletPass(s.cafe.ctx, s.cardId, "en");
    // A preview that minted would retire the link already in the customer's wallet.
    expect(await prisma.cardShareLink.count()).toBe(0);
  });

  it("mints on issuance, and puts the live URL in both payloads", async () => {
    const issued = await issueWalletPassPayloads(s.cafe.ctx, s.cardId, { locale: "en", ids: ISSUER_IDS });
    const row = await prisma.cardShareLink.findFirstOrThrow({ where: { customerCardId: s.cardId } });

    const appleField = issued.apple.storeCard.backFields.find((f) => f.key === "invitations");
    const googleUri = issued.google.linksModuleData?.uris[0].uri;
    expect(appleField?.value).toMatch(/\/share#/);
    expect(googleUri).toBe(appleField?.value);
    // The URL in the pass really is the one the digest was taken from.
    expect(shareTokenDigest(appleField!.value.split("#")[1])).toBe(row.tokenDigest);
  });

  it("re-issuing retires the link the customer already has", async () => {
    const first = await issueWalletPassPayloads(s.cafe.ctx, s.cardId, { locale: "en", ids: ISSUER_IDS });
    const second = await issueWalletPassPayloads(s.cafe.ctx, s.cardId, { locale: "en", ids: ISSUER_IDS });
    const tokenOf = (p: typeof first) => p.apple.storeCard.backFields.find((f) => f.key === "invitations")!.value.split("#")[1];

    expect(await resolveShareLink(tokenOf(first))).toBeNull();
    expect(await resolveShareLink(tokenOf(second))).not.toBeNull();
  });

  it("shows staff the payload with the capability removed", async () => {
    await issueWalletPassPayloads(s.cafe.ctx, s.cardId, { locale: "en", ids: ISSUER_IDS });
    const row = await prisma.cardShareLink.findFirstOrThrow({ where: { customerCardId: s.cardId } });

    const preview = await wallet({ action: "preview", businessId: s.cafe.businessId, customerCardId: s.cardId, locale: "en" });
    expect(preview.status).toBe(200);

    const serialized = JSON.stringify(preview.body);
    expect(serialized).toContain("token-not-shown");
    expect(serialized).not.toContain(row.tokenDigest);
    expect(serialized).toMatch(/"live":true/);
    // Nothing in this build can sign a pass, and the response says so rather than implying it.
    expect(serialized).toMatch(/"signed":false/);
  });

  it("puts no capability in either barcode, on a real card", async () => {
    const issued = await issueWalletPassPayloads(s.cafe.ctx, s.cardId, { locale: "ar", ids: ISSUER_IDS });
    const card = await prisma.customerCard.findUniqueOrThrow({
      where: { id: s.cardId },
      select: { qrToken: true },
    });
    const token = issued.apple.storeCard.backFields.find((f) => f.key === "invitations")!.value.split("#")[1];

    expect(issued.apple.barcodes[0].message).toBe(card.qrToken);
    expect(issued.google.barcode.value).toBe(card.qrToken);
    expect(JSON.stringify(issued.apple.barcodes)).not.toContain(token);
    expect(JSON.stringify(issued.google.barcode)).not.toContain(token);
  });

  it("refuses another tenant's card, through the route", async () => {
    const theirs = await setup("Their café");
    session.userId = s.cafe.userId;
    const result = await wallet({
      action: "preview",
      businessId: s.cafe.businessId,
      customerCardId: theirs.cardId,
      locale: "en",
    });
    expect(result.status).toBe(404);
  });

  it("offers no issue action on the route, because nothing can sign a pass", async () => {
    // A route returning an unsigned payload with a live capability would be a token-disclosure
    // surface built for no consumer.
    for (const action of ["issue", "download", "sign", "send"]) {
      const result = await wallet({ action, businessId: s.cafe.businessId, customerCardId: s.cardId, locale: "en" });
      expect(result.status, `${action} must not be an action`).toBe(400);
    }
  });
});

describe("the invitation grants nothing and enrols nobody", () => {
  it("creates no card, no enrolment, no ledger row and no reward, however often it is opened", async () => {
    await resetDatabase();
    const s = await setup("Nothing-happens café");
    const raw = (await mintShareLink(s.cafe.ctx, s.cardId, "WALLET_PASS")).rawToken;

    const before = {
      cards: await prisma.customerCard.count(),
      customers: await prisma.customer.count(),
      profiles: await prisma.customerBusinessProfile.count(),
      operations: await prisma.loyaltyOperation.count(),
    };

    for (let i = 0; i < 5; i++) expect((await resolve({ token: raw })).body).toMatchObject({ ok: true });

    expect({
      cards: await prisma.customerCard.count(),
      customers: await prisma.customer.count(),
      profiles: await prisma.customerBusinessProfile.count(),
      operations: await prisma.loyaltyOperation.count(),
    }).toEqual(before);

    // And the card that produced the link is untouched: no stamp, no reward, no referral credit.
    const card = await prisma.customerCard.findUniqueOrThrow({ where: { id: s.cardId } });
    expect({ stamps: card.stampBalance, rewards: card.rewardBalance, points: card.pointBalance }).toEqual({
      stamps: 0,
      rewards: 0,
      points: 0,
    });
  });

  it("has no referral model to credit anybody in", async () => {
    // Asserted structurally: if a referral table or column ever appears, this test is where the
    // phase that adds it has to come and say so. D15 owns the policy.
    const tables = await migratorPrisma().$queryRaw<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name ILIKE '%referral%'`;
    expect(tables).toEqual([]);
  });
});
