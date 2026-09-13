import { MembershipRole, Permission } from "@prisma/client";
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
 * Approval, the audience snapshot, and the wall in front of delivery.
 *
 * What these hold, each of which is a way this feature could hurt a real person:
 *
 *  1. **an approval is a record, not a label.** It names one exact revision, it cannot be edited,
 *     and no request can set `APPROVED` directly;
 *  2. **editing approved words drops the approval.** The revision it covered stays approved in the
 *     history; the campaign does not;
 *  3. **a snapshot is frozen.** Its counts do not move when the live segment does — which is the
 *     whole reason it exists;
 *  4. **a snapshot holds no contact data.** Internal references and counts only, and no row at all
 *     for a customer who may not be contacted;
 *  5. **a consent withdrawal wins over an approval.** Proven, because the alternative is a person
 *     who said no receiving a message from a list taken before they said it;
 *  6. **nothing can send.** No action, no state, no code path, and no network call.
 */

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

const campaigns = (body: unknown) => call(campaignsRoute, "/api/staff/campaigns", body);
const segments = (body: unknown) => call(segmentsRoute, "/api/staff/segments", body);
const consent = (body: unknown) => call(consentRoute, "/api/staff/consent", body);

const EVERYONE = { version: 1, match: "all", conditions: [{ field: "stampBalance", range: { min: 0 } }] };

/** The runtime role is refused on privilege; the owner is refused by the trigger. Either is a pass. */
const REFUSED = /append-only|permission denied/i;

interface Setup {
  cafe: StampCafeFixture;
  segmentId: string;
  campaignId: string;
}

/** A café with one segment matching everybody and one draft pointed at it. */
async function setup(name = "Approval café"): Promise<Setup> {
  const cafe = await createStampCafe({ name });
  session.userId = cafe.userId;

  const segment = await segments({
    action: "create",
    businessId: cafe.businessId,
    name: "Everyone",
    definition: EVERYONE,
  });
  expect(segment.status).toBe(201);
  const segmentId = String((segment.body as unknown as { id: string }).id);

  const created = await campaigns({
    action: "create",
    businessId: cafe.businessId,
    name: "Autumn offer",
    locale: "en",
    channel: "SMS",
    segmentId,
    body: "Hello {{firstName}}",
  });
  expect(created.status).toBe(201);
  return { cafe, segmentId, campaignId: String((created.body as unknown as { id: string }).id) };
}

/** Enrol somebody and record an explicit, dated, versioned agreement for them. */
async function enrolConsenting(cafe: StampCafeFixture, firstName: string) {
  const customer = await enrolCustomer(cafe, { phone: uniqueSyrianPhone(), firstName });
  const recorded = await consent({
    businessId: cafe.businessId,
    customerBusinessProfileId: customer.customerBusinessProfileId,
    scope: "MARKETING",
    state: "GRANTED",
  });
  expect(recorded.status).toBe(200);
  return customer;
}

const approve = (s: Setup, revisionNumber: number, extra: Record<string, unknown> = {}) =>
  campaigns({
    action: "approve",
    businessId: s.cafe.businessId,
    campaignId: s.campaignId,
    revisionNumber,
    intendedChannel: "SMS",
    ...extra,
  });

describe("approval is a decision, not a label", () => {
  let s: Setup;

  beforeEach(async () => {
    await resetDatabase();
    s = await setup();
  });

  it("records who decided what, about which exact revision, for which declared channel", async () => {
    await enrolConsenting(s.cafe, "ليلى");

    const decided = await approve(s, 1, { note: "checked the wording with Omar" });
    expect(decided.status).toBe(201);
    const decision = decided.body as unknown as {
      decision: string;
      revisionNumber: number;
      intendedChannel: string;
      snapshot: { eligibleCount: number; matchedCount: number };
    };
    expect(decision.decision).toBe("APPROVED");
    expect(decision.revisionNumber).toBe(1);
    expect(decision.intendedChannel).toBe("SMS");

    const row = await prisma.campaignApproval.findFirstOrThrow({ where: { campaignId: s.campaignId } });
    expect(row.decidedByUserId).toBe(s.cafe.userId);
    expect(row.note).toBe("checked the wording with Omar");
    expect(row.audienceSnapshotId).not.toBeNull();

    const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: s.campaignId } });
    expect(campaign.state).toBe("APPROVED");
    expect(campaign.approvedRevisionNumber).toBe(1);
  });

  it("cannot be reached by setting a state", async () => {
    /*
     * The single most important assertion in this file. If `setState` accepted APPROVED, every
     * guarantee below it would be decoration: there would be a way to have the label without the
     * decision row, the snapshot or the person.
     */
    for (const state of ["APPROVED", "WITHDRAWN"]) {
      const result = await campaigns({
        action: "setState",
        businessId: s.cafe.businessId,
        campaignId: s.campaignId,
        state,
      });
      expect(result.status, `${state} must not be settable`).toBe(400);
    }
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: s.campaignId } })).state).toBe("DRAFT");
    expect(await prisma.campaignApproval.count()).toBe(0);
  });

  it("refuses an approval of a revision that is no longer the latest", async () => {
    await enrolConsenting(s.cafe, "ليلى");
    // A colleague saved an edit while the approval screen was open.
    await campaigns({ action: "revise", businessId: s.cafe.businessId, campaignId: s.campaignId, body: "New wording" });

    const stale = await approve(s, 1);
    expect(stale.status).toBe(409);
    expect(await prisma.campaignApproval.count()).toBe(0);

    // Reading it again and approving the real revision works.
    expect((await approve(s, 2)).status).toBe(201);
  });

  it("refuses to approve the same revision twice", async () => {
    await enrolConsenting(s.cafe, "ليلى");
    expect((await approve(s, 1)).status).toBe(201);
    expect((await approve(s, 1)).status).toBe(409);
    expect(await prisma.campaignApproval.count()).toBe(1);
  });

  it("refuses a campaign with no audience, because an approval records how many it covered", async () => {
    await campaigns({ action: "setAudience", businessId: s.cafe.businessId, campaignId: s.campaignId, segmentId: null });
    const result = await approve(s, 1);
    expect(result.status).toBe(400);
    expect(await prisma.campaignAudienceSnapshot.count()).toBe(0);
  });

  it("refuses an archived campaign", async () => {
    await campaigns({ action: "setState", businessId: s.cafe.businessId, campaignId: s.campaignId, state: "ARCHIVED" });
    expect((await approve(s, 1)).status).toBe(409);
  });

  it("is append-only: the decision row cannot be edited or removed", async () => {
    await enrolConsenting(s.cafe, "ليلى");
    await approve(s, 1);
    const row = await prisma.campaignApproval.findFirstOrThrow({ where: { campaignId: s.campaignId } });

    await expect(prisma.campaignApproval.update({ where: { id: row.id }, data: { note: "rewritten" } })).rejects.toThrow(REFUSED);
    await expect(prisma.campaignApproval.delete({ where: { id: row.id } })).rejects.toThrow(REFUSED);

    // And as the OWNER, who does hold UPDATE and DELETE: refused by the trigger.
    const owner = migratorPrisma();
    await expect(owner.$executeRawUnsafe(`UPDATE "CampaignApproval" SET note = 'rewritten'`)).rejects.toThrow(/append-only/);
    await expect(owner.$executeRawUnsafe(`DELETE FROM "CampaignApproval"`)).rejects.toThrow(/append-only/);
  });

  it("writes an audit row with counts and no recipient", async () => {
    const customer = await enrolConsenting(s.cafe, "ليلى");
    await approve(s, 1, { note: "a note that should not reach the audit row" });

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { businessId: s.cafe.businessId, action: AuditAction.CAMPAIGN_APPROVED },
    });
    const serialized = JSON.stringify(audit.metadata);
    expect(serialized).toContain("eligibleCount");
    expect(serialized).not.toContain(customer.customerBusinessProfileId);
    expect(serialized).not.toContain(customer.customerCardId);
    expect(serialized).not.toContain("ليلى");
    // The approver's free text stays on the decision row, which fewer people read and which is not
    // kept for the lifetime of the business.
    expect(serialized).not.toContain("should not reach");
  });
});

describe("editing approved content invalidates the approval", () => {
  let s: Setup;

  beforeEach(async () => {
    await resetDatabase();
    s = await setup("Editing café");
    await enrolConsenting(s.cafe, "ليلى");
    await approve(s, 1);
  });

  it("creates a new revision and drops the campaign back to draft", async () => {
    const revised = await campaigns({
      action: "revise",
      businessId: s.cafe.businessId,
      campaignId: s.campaignId,
      body: "Different wording entirely",
    });
    expect(revised.status).toBe(200);

    const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: s.campaignId } });
    expect(campaign.state).toBe("DRAFT");
    expect(campaign.approvedRevisionNumber).toBeNull();
    expect(campaign.approvedSnapshotId).toBeNull();
    expect(campaign.approvedAt).toBeNull();
  });

  it("never mutates the approved content in place", async () => {
    const before = await prisma.campaignRevision.findFirstOrThrow({ where: { campaignId: s.campaignId, revisionNumber: 1 } });
    await campaigns({ action: "revise", businessId: s.cafe.businessId, campaignId: s.campaignId, body: "Different wording" });

    const after = await prisma.campaignRevision.findFirstOrThrow({ where: { campaignId: s.campaignId, revisionNumber: 1 } });
    expect(after.body).toBe(before.body);
    expect(await prisma.campaignRevision.count({ where: { campaignId: s.campaignId } })).toBe(2);
  });

  it("leaves the approval row standing, still true about the revision it named", async () => {
    await campaigns({ action: "revise", businessId: s.cafe.businessId, campaignId: s.campaignId, body: "Different wording" });

    const approval = await prisma.campaignApproval.findFirstOrThrow({ where: { campaignId: s.campaignId } });
    expect(approval.revisionNumber).toBe(1);
    expect(approval.decision).toBe("APPROVED");
    // History is not rewritten by an edit; what changed is which revision is current.
    expect(await prisma.campaignApproval.count()).toBe(1);
  });

  it("records the invalidation, because it happened as a side effect of something else", async () => {
    await campaigns({ action: "revise", businessId: s.cafe.businessId, campaignId: s.campaignId, body: "Different wording" });
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { businessId: s.cafe.businessId, action: AuditAction.CAMPAIGN_APPROVAL_INVALIDATED },
    });
    expect(audit.metadata).toMatchObject({ approvedRevisionNumber: 1, newRevisionNumber: 2, reason: "CONTENT_EDITED" });
  });

  it("refuses to change who it is for while it stands approved", async () => {
    // Unlike a content edit, this is refused rather than silently invalidated: the snapshot was
    // taken over THIS segment, and swapping it underneath would leave an approval whose audience
    // came from a group nobody approved.
    const other = await segments({
      action: "create",
      businessId: s.cafe.businessId,
      name: "Somebody else",
      definition: EVERYONE,
    });
    const result = await campaigns({
      action: "setAudience",
      businessId: s.cafe.businessId,
      campaignId: s.campaignId,
      segmentId: String((other.body as unknown as { id: string }).id),
    });
    expect(result.status).toBe(409);
  });
});

describe("withdrawal", () => {
  let s: Setup;

  beforeEach(async () => {
    await resetDatabase();
    s = await setup("Withdrawal café");
    await enrolConsenting(s.cafe, "ليلى");
    await approve(s, 1);
  });

  it("adds a row rather than removing one, and points at what it took back", async () => {
    const result = await campaigns({
      action: "withdraw",
      businessId: s.cafe.businessId,
      campaignId: s.campaignId,
      note: "wrong month",
    });
    expect(result.status).toBe(201);

    const rows = await prisma.campaignApproval.findMany({ where: { campaignId: s.campaignId }, orderBy: { decidedAt: "asc" } });
    expect(rows.map((r) => r.decision)).toEqual(["APPROVED", "WITHDRAWN"]);
    expect(rows[1].withdrawsApprovalId).toBe(rows[0].id);
    // A withdrawal takes nothing new; it refers to what it undid.
    expect(rows[1].audienceSnapshotId).toBeNull();
  });

  it("blocks readiness and clears the campaign's approval pointers", async () => {
    await campaigns({ action: "withdraw", businessId: s.cafe.businessId, campaignId: s.campaignId });
    const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: s.campaignId } });
    expect(campaign.state).toBe("WITHDRAWN");
    expect(campaign.approvedRevisionNumber).toBeNull();
    expect(campaign.approvedSnapshotId).toBeNull();
  });

  it("keeps the snapshot it was taken with, as the record of a decision that was made", async () => {
    const snapshotId = (await prisma.campaignAudienceSnapshot.findFirstOrThrow({ where: { campaignId: s.campaignId } })).id;
    await campaigns({ action: "withdraw", businessId: s.cafe.businessId, campaignId: s.campaignId });
    expect(await prisma.campaignAudienceSnapshot.findUnique({ where: { id: snapshotId } })).not.toBeNull();
  });

  it("refuses to withdraw what is not approved", async () => {
    await campaigns({ action: "withdraw", businessId: s.cafe.businessId, campaignId: s.campaignId });
    expect((await campaigns({ action: "withdraw", businessId: s.cafe.businessId, campaignId: s.campaignId })).status).toBe(409);
  });

  it("lets a merchant start again, which writes a new decision and a NEW snapshot", async () => {
    await campaigns({ action: "withdraw", businessId: s.cafe.businessId, campaignId: s.campaignId });
    await campaigns({ action: "setState", businessId: s.cafe.businessId, campaignId: s.campaignId, state: "DRAFT" });
    expect((await approve(s, 1)).status).toBe(201);

    expect(await prisma.campaignApproval.count({ where: { campaignId: s.campaignId } })).toBe(3);
    expect(await prisma.campaignAudienceSnapshot.count({ where: { campaignId: s.campaignId } })).toBe(2);
  });
});

describe("the audience snapshot", () => {
  let s: Setup;

  beforeEach(async () => {
    await resetDatabase();
    s = await setup("Snapshot café");
  });

  it("counts eligible, unknown and withdrawn separately, and stores a row only for the eligible", async () => {
    const yes = await enrolConsenting(s.cafe, "ليلى");
    // Said no at enrolment: WITHDRAWN, and complete on its own.
    const no = await enrolCustomer(s.cafe, { phone: uniqueSyrianPhone(), firstName: "Omar" });
    // The real historical row — a tick with no date and no wording. UNKNOWN, never a permission.
    const maybe = await enrolCustomer(s.cafe, { phone: uniqueSyrianPhone(), firstName: "Sara" });
    await prisma.customerBusinessProfile.update({
      where: { id: maybe.customerBusinessProfileId },
      data: { marketingConsent: true, privacyConsentAt: null, consentTextVersion: null },
    });

    await approve(s, 1);
    const snapshot = await prisma.campaignAudienceSnapshot.findFirstOrThrow({ where: { campaignId: s.campaignId } });
    expect(snapshot.matchedCount).toBe(3);
    expect(snapshot.eligibleCount).toBe(1);
    expect(snapshot.unknownCount).toBe(1);
    expect(snapshot.withdrawnCount).toBe(1);

    const members = await prisma.campaignAudienceMember.findMany({ where: { snapshotId: snapshot.id } });
    expect(members).toHaveLength(1);
    expect(members[0].customerBusinessProfileId).toBe(yes.customerBusinessProfileId);
    // Nobody who may not be contacted is listed at all: a person who never agreed to be contacted
    // has not agreed to appear in a marketing artefact either.
    const listed = members.map((m) => m.customerBusinessProfileId);
    expect(listed).not.toContain(no.customerBusinessProfileId);
    expect(listed).not.toContain(maybe.customerBusinessProfileId);
  });

  it("holds internal references and nothing that could contact anybody", async () => {
    const customer = await enrolConsenting(s.cafe, "ليلى");
    await approve(s, 1);

    const snapshot = await prisma.campaignAudienceSnapshot.findFirstOrThrow({ where: { campaignId: s.campaignId } });
    const members = await prisma.campaignAudienceMember.findMany({ where: { snapshotId: snapshot.id } });
    const card = await prisma.customerCard.findUniqueOrThrow({
      where: { id: customer.customerCardId },
      select: { qrToken: true, shareToken: true, serialNumber: true, utmSourceLink: { select: { publicToken: true } } },
    });
    const phone = (await prisma.customer.findFirstOrThrow({ select: { normalizedPhone: true } })).normalizedPhone;

    const serialized = JSON.stringify({ snapshot, members });
    for (const secret of [card.qrToken, card.shareToken, card.serialNumber, card.utmSourceLink!.publicToken, phone, "ليلى"]) {
      expect(serialized, `a snapshot must not carry ${secret}`).not.toContain(secret);
    }
    // What it DOES carry: an internal profile reference, the observed state, and the record behind it.
    expect(members[0].consentState).toBe("GRANTED");
    expect(members[0].consentRecordId).not.toBeNull();
  });

  it("distinguishes a permission that came from a record from one that came from enrolment", async () => {
    // Enrolled with a complete, dated, versioned agreement and never touched since: eligible, with
    // nothing to point at. Null says that truthfully rather than inventing a reference.
    // Both fields: `privacyConsentAt` is stamped only when the customer saw a versioned text,
    // which is the whole reason a tick on its own reads as UNKNOWN elsewhere in this suite.
    const customer = await enrolCustomer(s.cafe, {
      phone: uniqueSyrianPhone(),
      marketingConsent: true,
      consentTextVersion: "2026-09-12.1",
    });
    expect(
      (await prisma.customerBusinessProfile.findUniqueOrThrow({ where: { id: customer.customerBusinessProfileId } }))
        .privacyConsentAt,
    ).not.toBeNull();

    await approve(s, 1);
    const member = await prisma.campaignAudienceMember.findFirstOrThrow({});
    expect(member.consentState).toBe("GRANTED");
    expect(member.consentRecordId).toBeNull();
  });

  it("does not move when the live segment does", async () => {
    await enrolConsenting(s.cafe, "ليلى");
    await approve(s, 1);

    const before = await prisma.campaignAudienceSnapshot.findFirstOrThrow({ where: { campaignId: s.campaignId } });
    expect(before.eligibleCount).toBe(1);

    // Two more consenting customers join, which the LIVE segment matches immediately.
    await enrolConsenting(s.cafe, "Omar");
    await enrolConsenting(s.cafe, "Sara");
    const live = await campaigns({ action: "preview", businessId: s.cafe.businessId, campaignId: s.campaignId });
    expect((live.body as unknown as { marketingEligible: number }).marketingEligible).toBe(3);

    // The snapshot is what a person approved. It says what it said.
    const after = await prisma.campaignAudienceSnapshot.findUniqueOrThrow({ where: { id: before.id } });
    expect(after.eligibleCount).toBe(1);
    expect(after.matchedCount).toBe(before.matchedCount);
    expect(await prisma.campaignAudienceMember.count({ where: { snapshotId: before.id } })).toBe(1);
  });

  it("keeps the segment's name as it was, so a rename does not rewrite a decision", async () => {
    await enrolConsenting(s.cafe, "ليلى");
    await approve(s, 1);
    await segments({ action: "update", businessId: s.cafe.businessId, segmentId: s.segmentId, name: "Renamed later" });

    const snapshot = await prisma.campaignAudienceSnapshot.findFirstOrThrow({ where: { campaignId: s.campaignId } });
    expect(snapshot.segmentName).toBe("Everyone");
  });

  it("is append-only, header and members alike", async () => {
    await enrolConsenting(s.cafe, "ليلى");
    await approve(s, 1);
    const snapshot = await prisma.campaignAudienceSnapshot.findFirstOrThrow({});
    const member = await prisma.campaignAudienceMember.findFirstOrThrow({});

    await expect(
      prisma.campaignAudienceSnapshot.update({ where: { id: snapshot.id }, data: { eligibleCount: 9_999 } }),
    ).rejects.toThrow(REFUSED);
    await expect(prisma.campaignAudienceMember.delete({ where: { id: member.id } })).rejects.toThrow(REFUSED);

    const owner = migratorPrisma();
    await expect(owner.$executeRawUnsafe(`UPDATE "CampaignAudienceSnapshot" SET "eligibleCount" = 9999`)).rejects.toThrow(
      /append-only/,
    );
    await expect(owner.$executeRawUnsafe(`DELETE FROM "CampaignAudienceMember"`)).rejects.toThrow(/append-only/);
  });

  it("never evaluates a definition it cannot read as everybody", async () => {
    await enrolConsenting(s.cafe, "ليلى");
    // The one wrong answer: an unreadable definition producing an empty `where` would snapshot the
    // whole customer base and call it approved.
    await migratorPrisma().$executeRawUnsafe(
      `UPDATE "CustomerSegment" SET definition = '{"version":999,"match":"all","conditions":[]}'::jsonb WHERE id = $1`,
      s.segmentId,
    );
    expect((await approve(s, 1)).status).toBe(400);
    expect(await prisma.campaignAudienceSnapshot.count()).toBe(0);
  });
});

describe("an approval is not permission to contact anybody", () => {
  it("is overridden by a later withdrawal, which is why delivery must re-check consent", async () => {
    await resetDatabase();
    const s = await setup("Consent café");
    const customer = await enrolConsenting(s.cafe, "ليلى");
    await approve(s, 1);

    const snapshot = await prisma.campaignAudienceSnapshot.findFirstOrThrow({ where: { campaignId: s.campaignId } });
    expect(await prisma.campaignAudienceMember.count({ where: { snapshotId: snapshot.id } })).toBe(1);

    // The customer changes their mind AFTER the approval.
    const withdrawn = await consent({
      businessId: s.cafe.businessId,
      customerBusinessProfileId: customer.customerBusinessProfileId,
      scope: "MARKETING",
      state: "WITHDRAWN",
      reason: "asked us to stop",
    });
    expect(withdrawn.status).toBe(200);

    /*
     * The snapshot still lists them — it is a record of what was true, and rewriting it would make
     * it useless as one. What must never happen is a message going out on its authority, which is
     * why `delivery.ts` refuses and why `consentMustBeRecheckedAtDispatch` is in the contract.
     *
     * The live consult, which is what a dispatch would have to do, now says no.
     */
    expect(await prisma.campaignAudienceMember.count({ where: { snapshotId: snapshot.id } })).toBe(1);

    const { marketingEligibleProfileIds } = await import("@/server/consent/consent");
    expect(await marketingEligibleProfileIds(s.cafe.ctx, [customer.customerBusinessProfileId])).toEqual(new Set());

    const live = await campaigns({ action: "preview", businessId: s.cafe.businessId, campaignId: s.campaignId });
    expect((live.body as unknown as { marketingEligible: number }).marketingEligible).toBe(0);
  });

  it("refuses at the delivery port, before a recipient can be resolved", async () => {
    const { disabledDelivery, DeliveryDisabledError } = await import("@/server/campaigns/delivery");
    await expect(disabledDelivery.dispatchApprovedSnapshot("any-snapshot")).rejects.toBeInstanceOf(DeliveryDisabledError);
  });

  it("reports readiness as false with a blocker that never clears", async () => {
    await resetDatabase();
    const s = await setup("Readiness café");
    await enrolConsenting(s.cafe, "ليلى");
    await approve(s, 1);

    const campaign = await campaigns({ action: "preview", businessId: s.cafe.businessId, campaignId: s.campaignId });
    expect(campaign.status).toBe(200);

    const { getCampaign } = await import("@/server/campaigns/campaigns");
    const view = await getCampaign(s.cafe.ctx, s.campaignId);
    expect(view.readiness.deliverable).toBe(false);
    expect(view.readiness.blockers).toContain("NO_DELIVERY_CHANNEL_EXISTS");
    expect(view.readiness.consentMustBeRecheckedAtDispatch).toBe(true);
  });
});

describe("authorization and tenant isolation", () => {
  let s: Setup;

  beforeEach(async () => {
    await resetDatabase();
    s = await setup("Authorization café");
    await enrolConsenting(s.cafe, "ليلى");
  });

  it("refuses a cashier, who holds neither engagement permission", async () => {
    const cashier = await createStaff(s.cafe, MembershipRole.CASHIER, [s.cafe.locationId]);
    session.userId = cashier.userId;
    expect((await approve(s, 1)).status).toBe(403);
    expect((await campaigns({ action: "withdraw", businessId: s.cafe.businessId, campaignId: s.campaignId })).status).toBe(403);
    expect(await prisma.campaignApproval.count()).toBe(0);
  });

  it("refuses a branch-scoped member even when they hold EDIT_PUSHES", async () => {
    /*
     * A snapshot is taken across the whole business. An approver who can only see one branch would
     * be signing off on a number they cannot verify, and authorising a future message to people
     * outside anything they can see.
     */
    const scoped = await createStaff(s.cafe, MembershipRole.CASHIER, [s.cafe.locationId]);
    await setMembershipPermissions(s.cafe.ctx, scoped.membershipId, [
      Permission.VIEW_PUSHES,
      Permission.EDIT_PUSHES,
      Permission.VIEW_CUSTOMERS,
    ]);
    session.userId = scoped.userId;
    expect((await approve(s, 1)).status).toBe(403);
  });

  it("refuses a member whose account was deactivated between requests", async () => {
    const manager = await createStaff(s.cafe, MembershipRole.MANAGER);
    session.userId = manager.userId;
    expect((await approve(s, 1)).status).toBe(201);

    await prisma.businessMembership.update({ where: { id: manager.membershipId }, data: { active: false } });
    // The context is rebuilt from the database on every request, never from a cached role.
    expect((await campaigns({ action: "withdraw", businessId: s.cafe.businessId, campaignId: s.campaignId })).status).toBe(403);
  });

  it("cannot see, approve or withdraw another business's campaign", async () => {
    const theirs = await setup("Someone else's café");
    session.userId = s.cafe.userId;

    for (const action of [
      { action: "approve", revisionNumber: 1, intendedChannel: "SMS" },
      { action: "withdraw" },
      { action: "decisions" },
    ]) {
      const result = await campaigns({ ...action, businessId: s.cafe.businessId, campaignId: theirs.campaignId });
      // A 404, not a 403: the id is filtered out in the WHERE, so it does not exist for this caller.
      expect(result.status, `${action.action} across tenants`).toBe(404);
    }
    expect(await prisma.campaignApproval.count()).toBe(0);
  });

  it("cannot approve using another business's segment", async () => {
    const theirs = await setup("Another café");
    session.userId = s.cafe.userId;
    const result = await campaigns({
      action: "setAudience",
      businessId: s.cafe.businessId,
      campaignId: s.campaignId,
      segmentId: theirs.segmentId,
    });
    expect(result.status).toBe(400);
  });

  it("lists decisions with a name and never a user id or an email", async () => {
    await approve(s, 1);
    const listed = await campaigns({ action: "decisions", businessId: s.cafe.businessId, campaignId: s.campaignId });
    expect(listed.status).toBe(200);

    const serialized = JSON.stringify(listed.body);
    expect(serialized).not.toContain(s.cafe.userId);
    expect(serialized).not.toContain("@");
  });
});

describe("nothing in this feature can send", () => {
  it("has no provider client, queue, worker, scheduler or outbound call in its source", async () => {
    const { readFileSync, readdirSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");

    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (full.endsWith(".ts") || full.endsWith(".tsx")) files.push(full);
      }
    };
    walk(join(process.cwd(), "src", "server", "campaigns"));
    walk(join(process.cwd(), "src", "server", "consent"));

    /*
     * Deliberately blunt. A precise check would be a check somebody argues with; this one says that
     * nothing in the campaign or consent source may reach a network, a queue or a provider at all,
     * and a phase that legitimately needs one has to come here and change the rule on the record.
     */
    const forbidden =
      /\bfetch\(|axios|node-fetch|undici|https?:\/\/(?!localhost)|twilio|sendgrid|nodemailer|firebase|web-push|pg-boss|pgboss|\.enqueue\(|setInterval\(|\bcron\b/i;

    const offenders = files.filter((file) => forbidden.test(readFileSync(file, "utf8")));
    expect(offenders, `these must not reach a provider, a network or a queue:\n${offenders.join("\n")}`).toEqual([]);
    expect(files.length).toBeGreaterThan(3);
  });

  it("offers no action a request could use to send, schedule or queue", async () => {
    await resetDatabase();
    const s = await setup("No-send café");
    for (const action of ["send", "schedule", "queue", "dispatch", "retry", "deliver"]) {
      const result = await campaigns({ action, businessId: s.cafe.businessId, campaignId: s.campaignId });
      expect(result.status, `${action} must not be an action`).toBe(400);
    }
  });

  it("creates no queue, job or scheduled row when a campaign is approved", async () => {
    await resetDatabase();
    const s = await setup("Quiet café");
    await enrolConsenting(s.cafe, "ليلى");

    const before = await prisma.pushMessage.count();
    await approve(s, 1);
    // The reserved delivery model from Phase 0 is untouched: approval writes nothing into it.
    expect(await prisma.pushMessage.count()).toBe(before);
    expect(await prisma.pushDelivery.count()).toBe(0);
  });
});
