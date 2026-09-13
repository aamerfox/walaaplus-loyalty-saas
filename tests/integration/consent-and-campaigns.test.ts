import { MembershipRole, OperationSource, Permission } from "@prisma/client";
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

import { POST as campaignsRoute } from "@/app/api/staff/campaigns/route";
import { POST as consentRoute } from "@/app/api/staff/consent/route";
import { POST as segmentsRoute } from "@/app/api/staff/segments/route";
import { AuditAction } from "@/server/audit/audit";
import { getConsentHistory, getConsentStatus, marketingEligibleProfileIds } from "@/server/consent/consent";
import { prisma } from "@/server/db";
import { setMembershipPermissions } from "@/server/tenant/memberships";
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
 * Two defences, and either one refusing is a pass.
 *
 * The runtime role holds only SELECT and INSERT on these tables (scripts/db-roles.mjs), so the
 * services are stopped by PRIVILEGE before any trigger runs. The trigger is the second line, for
 * anyone connecting with more rights than the app has — it is asserted separately, as the owner.
 */
const REFUSED = /append-only|permission denied/i;

/**
 * Consent history and campaign drafts, at the HTTP boundary.
 *
 * The four things these hold, each of which is a way this feature could hurt somebody:
 *
 *  1. **a gap is never a permission**, and a staff action never rewrites the enrolment answer;
 *  2. **the history is append-only**, in the database, not by convention;
 *  3. **no draft, preview, response or audit row carries a recipient**, a phone, a card, a token or
 *     a URL;
 *  4. **nothing can send.** There is no action, no state and no code path that would.
 */

const key = () => `k-${Math.random().toString(36).slice(2)}-${Date.now()}`;

async function call(route: (req: Request) => Promise<Response>, url: string, body: unknown) {
  const res = await route(
    new Request(`http://localhost:3000${url}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, body: (await res.json()) as Record<string, never> & { error?: { code?: string } } };
}

const consent = (body: unknown) => call(consentRoute, "/api/staff/consent", body);
const campaigns = (body: unknown) => call(campaignsRoute, "/api/staff/campaigns", body);
const segments = (body: unknown) => call(segmentsRoute, "/api/staff/segments", body);

const EVERYONE = { version: 1, match: "all", conditions: [{ field: "stampBalance", range: { min: 0 } }] };

describe("consent history", () => {
  let cafe: StampCafeFixture;
  let profileId: string;

  beforeEach(async () => {
    await resetDatabase();
    cafe = await createStampCafe({ name: "Consent café" });
    session.userId = cafe.userId;
    // Enrolled through the real service, which stamps the consent version exactly as the counter
    // does. `enrolCustomer` passes no `marketingConsent`, so this customer did not agree.
    profileId = (await enrolCustomer(cafe, { phone: uniqueSyrianPhone() })).customerBusinessProfileId;
  });

  it("never reads an incomplete enrolment record as permission", async () => {
    // The real historical shape: a tick with no date and no text version. It exists in the
    // database for every enrolment taken before the consent version was wired up.
    await prisma.customerBusinessProfile.update({
      where: { id: profileId },
      data: { marketingConsent: true, privacyConsentAt: null, consentTextVersion: null },
    });

    const status = await getConsentStatus(cafe.ctx, profileId);
    expect(status.state).toBe("UNKNOWN");
    expect(status.marketingEligible).toBe(false);
    expect(await marketingEligibleProfileIds(cafe.ctx, [profileId])).toEqual(new Set());
  });

  it("appends a change without touching the enrolment answer", async () => {
    const before = await prisma.customerBusinessProfile.findUniqueOrThrow({
      where: { id: profileId },
      select: { marketingConsent: true, privacyConsentAt: true, consentTextVersion: true, updatedAt: true },
    });

    const recorded = await consent({
      businessId: cafe.businessId,
      customerBusinessProfileId: profileId,
      scope: "MARKETING",
      state: "GRANTED",
      reason: "said yes at the counter",
    });
    expect(recorded.status).toBe(200);

    // The enrolment record is byte-identical: a staff action does not manufacture an opt-in on it.
    const after = await prisma.customerBusinessProfile.findUniqueOrThrow({
      where: { id: profileId },
      select: { marketingConsent: true, privacyConsentAt: true, consentTextVersion: true, updatedAt: true },
    });
    expect(after).toEqual(before);

    const status = await getConsentStatus(cafe.ctx, profileId);
    expect(status.state).toBe("GRANTED");
    expect(status.capturedVia).toBe("STAFF_UPDATE");
    // A spoken agreement refers to no consent text, and nothing pretends it did.
    expect(status.policyVersion).toBeNull();

    const history = await getConsentHistory(cafe.ctx, profileId);
    expect(history).toHaveLength(2);
    expect(history[0].isOrigin).toBe(false);
    expect(history[0].previousState).toBe("WITHDRAWN");
    expect(history[0].reason).toBe("said yes at the counter");
    // The last entry is always the enrolment, derived from the profile and flagged as such.
    expect(history[1].isOrigin).toBe(true);
  });

  it("keeps every state ever recorded, and refuses to rewrite one", async () => {
    for (const state of ["GRANTED", "WITHDRAWN", "GRANTED"]) {
      const answer = await consent({
        businessId: cafe.businessId,
        customerBusinessProfileId: profileId,
        scope: "MARKETING",
        state,
      });
      expect(answer.status).toBe(200);
    }
    const rows = await prisma.consentRecord.findMany({
      where: { customerBusinessProfileId: profileId },
      orderBy: { recordedAt: "asc" },
      select: { id: true, state: true, previousState: true },
    });
    expect(rows.map((r) => r.state)).toEqual(["GRANTED", "WITHDRAWN", "GRANTED"]);
    expect(rows.map((r) => r.previousState)).toEqual(["WITHDRAWN", "GRANTED", "WITHDRAWN"]);

    // Append-only in the DATABASE, not by convention. As the app connects: refused on privilege.
    await expect(
      prisma.consentRecord.update({ where: { id: rows[0].id }, data: { state: "WITHDRAWN" } }),
    ).rejects.toThrow(REFUSED);
    await expect(prisma.consentRecord.delete({ where: { id: rows[0].id } })).rejects.toThrow(REFUSED);
    // And as the OWNER, who does hold UPDATE and DELETE: refused by the trigger.
    const owner = migratorPrisma();
    await expect(
      owner.$executeRawUnsafe(`UPDATE "ConsentRecord" SET state = 'WITHDRAWN'`),
    ).rejects.toThrow(/append-only/);
    await expect(owner.$executeRawUnsafe(`DELETE FROM "ConsentRecord"`)).rejects.toThrow(/append-only/);
  });

  it("writes no customer detail into the audit row", async () => {
    // GRANTED, because the fixture customer did not agree at enrolment and recording the state
    // they are already in writes nothing — which the test below asserts on purpose.
    await consent({
      businessId: cafe.businessId,
      customerBusinessProfileId: profileId,
      scope: "MARKETING",
      state: "GRANTED",
      reason: "called and asked to stop",
    });
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { businessId: cafe.businessId, action: AuditAction.CONSENT_RECORDED },
    });
    const serialized = JSON.stringify(audit.metadata);
    expect(serialized).toContain("MARKETING");
    // The reason is about a person and stays on the consent record, which fewer people read.
    expect(serialized).not.toContain("called and asked to stop");
    expect(serialized).toContain("hasReason");
  });

  it("records nothing when the state is already what it would be", async () => {
    // The customer already has no consent, so recording WITHDRAWN describes no change.
    const answer = await consent({
      businessId: cafe.businessId,
      customerBusinessProfileId: profileId,
      scope: "MARKETING",
      state: "WITHDRAWN",
    });
    expect(answer.status).toBe(200);
    expect(await prisma.consentRecord.count({ where: { customerBusinessProfileId: profileId } })).toBe(0);
  });

  it("is tenant-scoped and refused for a cashier", async () => {
    const theirs = await createStampCafe({ name: "Theirs" });
    const theirCustomer = await enrolCustomer(theirs, { phone: uniqueSyrianPhone() });

    session.userId = cafe.userId;
    const crossTenant = await consent({
      businessId: cafe.businessId,
      customerBusinessProfileId: theirCustomer.customerBusinessProfileId,
      scope: "MARKETING",
      state: "GRANTED",
    });
    expect(crossTenant.status).toBe(404);
    expect(await prisma.consentRecord.count()).toBe(0);

    const cashier = await createStaff(cafe, MembershipRole.CASHIER, [cafe.locationId]);
    session.userId = cashier.userId;
    const byCashier = await consent({
      businessId: cafe.businessId,
      customerBusinessProfileId: profileId,
      scope: "MARKETING",
      state: "GRANTED",
    });
    // A cashier holds EDIT_CUSTOMERS for counter enrolment; changing a standing preference is not
    // a counter action, and reading the history is not a counter action either.
    expect(byCashier.status).toBe(403);
    await expect(getConsentHistory(cashier.ctx, profileId)).rejects.toThrow();
  });
});

describe("campaign drafts cannot send, and carry no recipients", () => {
  let cafe: StampCafeFixture;
  let segmentId: string;

  beforeEach(async () => {
    await resetDatabase();
    cafe = await createStampCafe({ name: "Draft café" });
    session.userId = cafe.userId;
    const created = await segments({ action: "create", businessId: cafe.businessId, name: "Everyone", definition: EVERYONE });
    segmentId = String((created.body as unknown as { id: string }).id);
  });

  it("offers no send, schedule or queue action, and no state to reach one", async () => {
    const created = await campaigns({
      action: "create",
      businessId: cafe.businessId,
      name: "Autumn offer",
      locale: "ar",
      channel: "SMS",
      segmentId,
      body: "مرحباً {{firstName}}",
    });
    expect(created.status).toBe(201);
    const campaignId = String((created.body as unknown as { id: string }).id);

    // Every word a delivery action could be called. The route's schema is a discriminated union,
    // so an unknown action is a 400 before anything runs.
    for (const action of ["send", "schedule", "queue", "dispatch", "publish", "deliver"]) {
      const refused = await campaigns({ action, businessId: cafe.businessId, campaignId });
      expect(refused.status, `${action} must not exist`).toBe(400);
    }
    // And no state that would mean "gone out".
    for (const state of ["SENT", "SCHEDULED", "QUEUED", "SENDING"]) {
      const refused = await campaigns({ action: "setState", businessId: cafe.businessId, campaignId, state });
      expect(refused.status, `${state} must not exist`).toBe(400);
    }
    const row = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    expect(row.state).toBe("DRAFT");
  });

  it("keeps every revision, and refuses to rewrite one", async () => {
    const created = await campaigns({
      action: "create",
      businessId: cafe.businessId,
      name: "Revised",
      locale: "en",
      channel: "PUSH",
      body: "First draft",
    });
    const campaignId = String((created.body as unknown as { id: string }).id);

    await campaigns({ action: "revise", businessId: cafe.businessId, campaignId, body: "Second draft" });
    await campaigns({ action: "revise", businessId: cafe.businessId, campaignId, subject: "Hello", body: "Third draft" });

    const revisions = await prisma.campaignRevision.findMany({
      where: { campaignId },
      orderBy: { revisionNumber: "asc" },
      select: { id: true, revisionNumber: true, body: true },
    });
    expect(revisions.map((r) => r.body)).toEqual(["First draft", "Second draft", "Third draft"]);

    await expect(
      prisma.campaignRevision.update({ where: { id: revisions[0].id }, data: { body: "rewritten" } }),
    ).rejects.toThrow(REFUSED);
    await expect(prisma.campaignRevision.delete({ where: { id: revisions[0].id } })).rejects.toThrow(REFUSED);
    const owner = migratorPrisma();
    await expect(owner.$executeRawUnsafe(`UPDATE "CampaignRevision" SET body = 'rewritten'`)).rejects.toThrow(
      /append-only/,
    );
    await expect(owner.$executeRawUnsafe(`DELETE FROM "CampaignRevision"`)).rejects.toThrow(/append-only/);
  });

  it("refuses an unknown or withheld placeholder server-side", async () => {
    for (const body of [
      "Hi {{nickname}}",
      "You have stamps on {{programName}}",
      'Hi {{firstName || "friend"}}',
      "Hi {{customer.firstName}}",
    ]) {
      const refused = await campaigns({
        action: "create",
        businessId: cafe.businessId,
        name: `Bad ${body.slice(0, 12)}`,
        locale: "en",
        channel: "PUSH",
        body,
      });
      expect(refused.status, `${body} must be refused`).toBe(400);
    }
    expect(await prisma.campaign.count({ where: { businessId: cafe.businessId } })).toBe(0);

    // And `check` reports the same problems without writing anything.
    const checked = await campaigns({ action: "check", businessId: cafe.businessId, body: "Hi {{nickname}}" });
    expect(checked.status).toBe(200);
    expect((checked.body as unknown as { problems: { reason: string }[] }).problems[0].reason).toBe("UNKNOWN");
  });

  it("previews an audience as counts, with no recipient anywhere in it", async () => {
    const withConsent = await enrolCustomer(cafe, { phone: uniqueSyrianPhone(), firstName: "ليلى" });
    const withoutConsent = await enrolCustomer(cafe, { phone: uniqueSyrianPhone(), firstName: "Omar" });
    // Enrolled, in the segment, and never asked properly: the second half of the two numbers.
    await consent({
      businessId: cafe.businessId,
      customerBusinessProfileId: withConsent.customerBusinessProfileId,
      scope: "MARKETING",
      state: "GRANTED",
    });

    const created = await campaigns({
      action: "create",
      businessId: cafe.businessId,
      name: "Audience test",
      locale: "en",
      channel: "PUSH",
      segmentId,
      body: "Hello {{firstName}}",
    });
    const campaignId = String((created.body as unknown as { id: string }).id);

    const preview = await campaigns({ action: "preview", businessId: cafe.businessId, campaignId });
    expect(preview.status).toBe(200);
    const audience = preview.body as unknown as { matched: number; marketingEligible: number; notEligible: number };
    expect(audience.matched).toBe(2);
    // Only the one with an explicit recorded permission. The other has an enrolment answer of "no".
    expect(audience.marketingEligible).toBe(1);
    expect(audience.notEligible).toBe(1);

    // Three integers and a segment name. Nothing that identifies a person.
    const serialized = JSON.stringify(preview.body);
    expect(serialized).not.toContain("ليلى");
    expect(serialized).not.toContain("Omar");
    expect(serialized).not.toContain(withConsent.customerCardId);
    expect(serialized).not.toContain(withConsent.customerBusinessProfileId);
    expect(serialized).not.toContain(withConsent.shareToken);
    expect(serialized).not.toContain(withoutConsent.customerBusinessProfileId);
    expect(serialized).not.toContain(withoutConsent.shareToken);
  });

  it("stores no recipient, token or URL anywhere in a campaign row", async () => {
    const card = await enrolCustomer(cafe, { phone: uniqueSyrianPhone(), firstName: "ليلى" });
    const created = await campaigns({
      action: "create",
      businessId: cafe.businessId,
      name: "Nothing personal",
      locale: "ar",
      channel: "WHATSAPP",
      segmentId,
      subject: "عرض",
      body: "مرحباً {{firstName}}",
    });
    const campaignId = String((created.body as unknown as { id: string }).id);
    await campaigns({ action: "preview", businessId: cafe.businessId, campaignId });

    const row = await prisma.customerCard.findUniqueOrThrow({
      where: { id: card.customerCardId },
      select: { qrToken: true, shareToken: true, utmSourceLink: { select: { publicToken: true } } },
    });
    const everything = JSON.stringify([
      await prisma.campaign.findMany({ where: { businessId: cafe.businessId } }),
      await prisma.campaignRevision.findMany({ where: { campaign: { businessId: cafe.businessId } } }),
      await prisma.auditLog.findMany({ where: { businessId: cafe.businessId, entityType: "Campaign" } }),
      created.body,
    ]);
    for (const secret of [row.qrToken, row.shareToken, row.utmSourceLink!.publicToken, card.customerCardId]) {
      expect(everything).not.toContain(secret);
    }
    expect(everything).not.toMatch(/https?:\/\//);
    expect(everything).not.toContain("/join/");
  });

  it("archives without destroying, and blocks editing until restored", async () => {
    const created = await campaigns({
      action: "create",
      businessId: cafe.businessId,
      name: "Archive me",
      locale: "en",
      channel: "EMAIL",
      body: "Body",
    });
    const campaignId = String((created.body as unknown as { id: string }).id);

    expect((await campaigns({ action: "setState", businessId: cafe.businessId, campaignId, state: "ARCHIVED" })).status).toBe(200);
    expect(await prisma.campaign.count({ where: { id: campaignId } })).toBe(1);

    const edited = await campaigns({ action: "revise", businessId: cafe.businessId, campaignId, body: "Changed" });
    expect(edited.status).toBe(409);

    expect((await campaigns({ action: "setState", businessId: cafe.businessId, campaignId, state: "DRAFT" })).status).toBe(200);
    const restored = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    expect(restored.archivedAt).toBeNull();
  });

  it("is tenant-scoped for every verb, and permission-gated", async () => {
    const theirs = await createStampCafe({ name: "Theirs" });
    session.userId = theirs.userId;
    const theirCampaign = await campaigns({
      action: "create",
      businessId: theirs.businessId,
      name: "Theirs",
      locale: "en",
      channel: "PUSH",
      body: "Theirs",
    });
    const theirId = String((theirCampaign.body as unknown as { id: string }).id);

    session.userId = cafe.userId;
    for (const action of ["revise", "setState", "preview", "setAudience"] as const) {
      const payload: Record<string, unknown> = { action, businessId: cafe.businessId, campaignId: theirId };
      if (action === "revise") payload.body = "Mine now";
      if (action === "setState") payload.state = "ARCHIVED";
      if (action === "setAudience") payload.segmentId = segmentId;
      const refused = await campaigns(payload);
      expect(refused.status, `${action} across a tenant must be refused`).toBe(404);
    }
    // Untouched, and still theirs.
    const row = await prisma.campaign.findUniqueOrThrow({ where: { id: theirId } });
    expect(row.state).toBe("DRAFT");
    expect(row.segmentId).toBeNull();

    /*
     * A segment from another business cannot become an audience of one of MINE either. The check
     * is run as me, on my own campaign, with their segment id — which is the only shape an attempt
     * could actually take, since acting as them on their business is refused at the membership.
     */
    const mine = await campaigns({
      action: "create",
      businessId: cafe.businessId,
      name: "Mine",
      locale: "en",
      channel: "PUSH",
      body: "Mine",
    });
    const mineId = String((mine.body as unknown as { id: string }).id);

    session.userId = theirs.userId;
    const theirSegment = await segments({
      action: "create",
      businessId: theirs.businessId,
      name: "Theirs",
      definition: EVERYONE,
    });
    const theirSegmentId = String((theirSegment.body as unknown as { id: string }).id);

    session.userId = cafe.userId;
    const foreignAudience = await campaigns({
      action: "setAudience",
      businessId: cafe.businessId,
      campaignId: mineId,
      segmentId: theirSegmentId,
    });
    expect(foreignAudience.status).toBe(400);
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: mineId } })).segmentId).toBeNull();
  });

  it("refuses a cashier, and refuses a branch-scoped member an audience number", async () => {
    const cashier = await createStaff(cafe, MembershipRole.CASHIER, [cafe.locationId]);
    session.userId = cashier.userId;
    const byCashier = await campaigns({
      action: "create",
      businessId: cafe.businessId,
      name: "Not mine",
      locale: "en",
      channel: "PUSH",
      body: "Body",
    });
    expect(byCashier.status).toBe(403);

    // Granted the engagement permissions explicitly, a branch-scoped member may still read drafts —
    // and is still refused a COUNT, because a number that shrank to their branch would be a
    // different number from the one anybody else sees.
    session.userId = cafe.userId;
    const created = await campaigns({
      action: "create",
      businessId: cafe.businessId,
      name: "Scoped preview",
      locale: "en",
      channel: "PUSH",
      segmentId,
      body: "Body",
    });
    const campaignId = String((created.body as unknown as { id: string }).id);
    await setMembershipPermissions(cafe.ctx, cashier.membershipId, [Permission.VIEW_PUSHES]);

    session.userId = cashier.userId;
    const refused = await campaigns({ action: "preview", businessId: cafe.businessId, campaignId });
    expect(refused.status).toBe(403);
  });
});

describe("nothing in this feature can reach a network", () => {
  it("has no provider client, queue, worker or outbound call in its source", async () => {
    const { readFileSync, readdirSync, statSync } = await import("node:fs");
    const path = await import("node:path");
    const root = path.resolve(import.meta.dirname, "../..");

    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const full = path.join(dir, name);
        return statSync(full).isDirectory() ? walk(full) : full.endsWith(".ts") ? [full] : [];
      });

    /*
     * A source-level assertion, because "cannot send" is a claim about what exists rather than
     * about what a test happened to call. If somebody adds a provider SDK to this domain, this
     * fails before any behaviour does.
     */
    const files = [
      ...walk(path.join(root, "src/server/campaigns")),
      ...walk(path.join(root, "src/server/consent")),
      path.join(root, "src/app/api/staff/campaigns/route.ts"),
      path.join(root, "src/app/api/staff/consent/route.ts"),
    ];
    const forbidden = /\bfetch\s*\(|axios|nodemailer|twilio|web-push|pg-boss|\.enqueue\(|sendMail|sendMessage\(/;
    const offenders = files.filter((file) => forbidden.test(readFileSync(file, "utf8")));
    expect(offenders, `an outbound call appeared in: ${offenders.join(", ")}`).toEqual([]);
  });
});

describe("B7 is unchanged", () => {
  it("still answers the withdrawn enrolment endpoint identically, and opens no window", async () => {
    await resetDatabase();
    const { GET, POST } = await import("@/app/api/enroll/route");
    const before = await prisma.authRateLimit.count();
    for (const response of [await POST(), await GET()]) {
      expect(response.status).toBe(410);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe("ENROLLMENT_MOVED");
    }
    expect(await prisma.authRateLimit.count()).toBe(before);
  });

  it("keeps the counter enrolment path and its ledger untouched by any of this", async () => {
    await resetDatabase();
    const cafe = await createStampCafe();
    session.userId = cafe.userId;
    const card = await enrolCustomer(cafe, { phone: uniqueSyrianPhone() });
    const { awardManualStamps } = await import("@/server/stamp/engine");
    const award = await awardManualStamps(cafe.ctx, {
      customerCardId: card.customerCardId,
      quantity: 3,
      idempotencyKey: key(),
      source: OperationSource.SCANNER,
    });
    expect(award.stampBalance).toBe(3);
  });
});
