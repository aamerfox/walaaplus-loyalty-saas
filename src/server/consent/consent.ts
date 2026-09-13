import { ConsentCapture, ConsentScope, ConsentState, MembershipRole, Permission } from "@prisma/client";
import { z } from "zod";
import { AuditAction, recordAudit } from "../audit/audit";
import { prisma } from "../db";
import { ForbiddenError, NotFoundError, ValidationError } from "../errors";
import { requirePermission, type TenantContext } from "../tenant/context";

/**
 * What a customer has agreed to, and when they changed their mind.
 *
 * ## The record this product actually has
 *
 * One question is asked, once, at the counter: **"I agree to receive offers from this business."**
 * It has no channel attached, so there is no push consent, no SMS consent and no email consent to
 * report — inventing a per-channel scope would be reporting a permission nobody was ever asked for.
 * `ConsentScope` therefore holds exactly one value, and it will gain more only when a screen asks a
 * customer a second question.
 *
 * The answer is stored on `CustomerBusinessProfile` at enrolment: `marketingConsent`,
 * `privacyConsentAt`, `consentTextVersion`. Those three fields are the **origin record** and this
 * module never writes to them. Every change afterwards is an appended `ConsentRecord`, and
 * `UPDATE`/`DELETE` on that table are rejected by trigger, exactly as they are on the ledger.
 *
 * ## Why the history was not backfilled
 *
 * A first record could have been written for every existing profile, copied from those three
 * fields. It was not, because for every enrolment taken before the consent version was wired up,
 * `privacyConsentAt` is NULL — the gap `src/server/customers/consent.ts` documents. Writing a
 * history row would mean inventing the moment somebody agreed to something, and an invented consent
 * timestamp is worse than an honest gap: it is the one field a consent record exists to hold.
 *
 * ## UNKNOWN is a state, not an absence
 *
 * | Origin fields | Reported as | Eligible for marketing |
 * |---|---|---|
 * | `marketingConsent = true`, with a timestamp **and** a text version | GRANTED | yes |
 * | `marketingConsent = true`, missing either | **UNKNOWN** | **no** |
 * | `marketingConsent = false` | WITHDRAWN | no |
 *
 * The second row is the one that matters. "They ticked a box, we do not know when or what it said"
 * is not a permission, and treating it as one is how a data gap becomes a message somebody never
 * agreed to receive. It is reported honestly on the customer record so a merchant can ask again.
 *
 * ## What is deliberately absent
 *
 * There is no customer-facing preference route and no unsubscribe link. Letting somebody change a
 * preference by opening a URL requires an authenticated customer session, which this product does
 * not have — and a URL that changes a record without one is an oracle and a vandalism tool at once.
 * It waits for the customer-access design.
 */

/** The state of one scope right now, and what it was built from. */
export interface ConsentStatus {
  scope: ConsentScope;
  state: ConsentState;
  /** True only for an explicit, dated, versioned GRANTED. Nothing else is ever eligible. */
  marketingEligible: boolean;
  /** The consent-text revision the current state refers to, when one is known. */
  policyVersion: string | null;
  /** When the current state was recorded. Null when the origin record has no timestamp. */
  recordedAt: Date | null;
  /** How the current state came to be. */
  capturedVia: ConsentCapture;
  /**
   * Why `UNKNOWN`, when it is unknown. A translated sentence belongs to the screen; this is the
   * reason code the screen translates.
   */
  ambiguity: "MISSING_TIMESTAMP" | "MISSING_POLICY_VERSION" | null;
}

export interface ConsentHistoryEntry {
  id: string;
  scope: ConsentScope;
  state: ConsentState;
  previousState: ConsentState;
  capturedVia: ConsentCapture;
  policyVersion: string | null;
  recordedAt: Date | null;
  /** The staff member who recorded it, by name. Never an email, never an id on a screen. */
  actorName: string | null;
  reason: string | null;
  /** True for the derived enrolment entry, which is a read of the profile and not a stored row. */
  isOrigin: boolean;
}

/** The enrolment fields, read as a consent status. Pure, so the rule is testable on its own. */
export function originStatus(profile: {
  marketingConsent: boolean;
  privacyConsentAt: Date | null;
  consentTextVersion: string | null;
}): ConsentStatus {
  const base = {
    scope: ConsentScope.MARKETING,
    capturedVia: ConsentCapture.ENROLMENT,
    policyVersion: profile.consentTextVersion,
    recordedAt: profile.privacyConsentAt,
  } as const;

  if (!profile.marketingConsent) {
    // An unticked box is a refusal, and it is complete: there is nothing ambiguous about "no".
    return { ...base, state: ConsentState.WITHDRAWN, marketingEligible: false, ambiguity: null };
  }
  if (profile.privacyConsentAt === null) {
    return { ...base, state: ConsentState.UNKNOWN, marketingEligible: false, ambiguity: "MISSING_TIMESTAMP" };
  }
  if (profile.consentTextVersion === null) {
    return { ...base, state: ConsentState.UNKNOWN, marketingEligible: false, ambiguity: "MISSING_POLICY_VERSION" };
  }
  return { ...base, state: ConsentState.GRANTED, marketingEligible: true, ambiguity: null };
}

/** The latest appended record, read as a status. A stored record is never ambiguous: it was chosen. */
function recordStatus(record: {
  scope: ConsentScope;
  state: ConsentState;
  policyVersion: string | null;
  recordedAt: Date;
  capturedVia: ConsentCapture;
}): ConsentStatus {
  return {
    scope: record.scope,
    state: record.state,
    marketingEligible: record.state === ConsentState.GRANTED,
    policyVersion: record.policyVersion,
    recordedAt: record.recordedAt,
    capturedVia: record.capturedVia,
    ambiguity: null,
  };
}

/**
 * Reading a customer's consent is reading their record.
 *
 * Gated the same way the customer record is: `VIEW_CUSTOMERS`, and refused for a CASHIER, whose
 * permission is to serve whoever is at the counter rather than to read the book.
 */
function assertMayRead(ctx: TenantContext): void {
  requirePermission(ctx, Permission.VIEW_CUSTOMERS);
  if (ctx.role === MembershipRole.CASHIER) {
    throw new ForbiddenError("Cashiers may serve a customer at the counter, not read their consent history");
  }
}

/** Load a profile inside the caller's tenant, or refuse exactly as if it did not exist. */
async function requireOwnProfile(ctx: TenantContext, profileId: string) {
  const profile = await prisma.customerBusinessProfile.findFirst({
    where: { id: profileId, businessId: ctx.businessId },
    select: { id: true, marketingConsent: true, privacyConsentAt: true, consentTextVersion: true },
  });
  if (!profile) throw new NotFoundError("Customer not found");
  return profile;
}

/** One customer's current marketing consent: the latest appended record, or the origin. */
export async function getConsentStatus(ctx: TenantContext, profileId: string): Promise<ConsentStatus> {
  assertMayRead(ctx);
  const profile = await requireOwnProfile(ctx, profileId);
  const latest = await prisma.consentRecord.findFirst({
    where: { customerBusinessProfileId: profile.id, businessId: ctx.businessId, scope: ConsentScope.MARKETING },
    orderBy: [{ recordedAt: "desc" }, { createdAt: "desc" }],
    select: { scope: true, state: true, policyVersion: true, recordedAt: true, capturedVia: true },
  });
  return latest ? recordStatus(latest) : originStatus(profile);
}

/**
 * The same question for many customers at once, without an N+1.
 *
 * Used by the campaign audience preview, which needs to know how many of a segment's matches may be
 * contacted. One query for the origins, one for the records, and the same rule applied to both.
 */
export async function marketingEligibleProfileIds(
  ctx: TenantContext,
  profileIds: readonly string[],
): Promise<Set<string>> {
  if (profileIds.length === 0) return new Set();

  const [profiles, records] = await Promise.all([
    prisma.customerBusinessProfile.findMany({
      where: { id: { in: [...profileIds] }, businessId: ctx.businessId },
      select: { id: true, marketingConsent: true, privacyConsentAt: true, consentTextVersion: true },
    }),
    prisma.consentRecord.findMany({
      where: {
        customerBusinessProfileId: { in: [...profileIds] },
        businessId: ctx.businessId,
        scope: ConsentScope.MARKETING,
      },
      orderBy: [{ recordedAt: "desc" }, { createdAt: "desc" }],
      select: { customerBusinessProfileId: true, state: true },
    }),
  ]);

  // The first row per profile wins: the query is already ordered newest-first.
  const latest = new Map<string, ConsentState>();
  for (const record of records) {
    if (!latest.has(record.customerBusinessProfileId)) latest.set(record.customerBusinessProfileId, record.state);
  }

  const eligible = new Set<string>();
  for (const profile of profiles) {
    const state = latest.get(profile.id);
    if (state === undefined ? originStatus(profile).marketingEligible : state === ConsentState.GRANTED) {
      eligible.add(profile.id);
    }
  }
  return eligible;
}

/**
 * Everything recorded about one customer's marketing preference, newest first.
 *
 * The enrolment is included as the last entry, derived from the profile and flagged `isOrigin`. It
 * is not a stored row and is not presented as one: the screen shows it as the sign-up answer, with
 * whatever the record actually holds — including "no date recorded" where that is the truth.
 */
export async function getConsentHistory(ctx: TenantContext, profileId: string): Promise<ConsentHistoryEntry[]> {
  assertMayRead(ctx);
  const profile = await requireOwnProfile(ctx, profileId);

  const records = await prisma.consentRecord.findMany({
    where: { customerBusinessProfileId: profile.id, businessId: ctx.businessId },
    orderBy: [{ recordedAt: "desc" }, { createdAt: "desc" }],
    select: {
      id: true,
      scope: true,
      state: true,
      previousState: true,
      capturedVia: true,
      policyVersion: true,
      recordedAt: true,
      reason: true,
      // A name, never an email and never an id: a history screen answers "who", and an email
      // address on it is a staff member's personal data shown to everyone who can open a customer.
      actor: { select: { firstName: true, lastName: true } },
    },
    take: 100,
  });

  const origin = originStatus(profile);
  return [
    ...records.map((record) => ({
      id: record.id,
      scope: record.scope,
      state: record.state,
      previousState: record.previousState,
      capturedVia: record.capturedVia,
      policyVersion: record.policyVersion,
      recordedAt: record.recordedAt,
      actorName: [record.actor?.firstName, record.actor?.lastName].filter(Boolean).join(" ") || null,
      reason: record.reason,
      isOrigin: false,
    })),
    {
      id: `origin:${profile.id}`,
      scope: ConsentScope.MARKETING,
      state: origin.state,
      // The origin has nothing before it, and saying UNKNOWN would imply a prior answer existed.
      previousState: ConsentState.UNKNOWN,
      capturedVia: ConsentCapture.ENROLMENT,
      policyVersion: origin.policyVersion,
      recordedAt: origin.recordedAt,
      actorName: null,
      reason: null,
      isOrigin: true,
    },
  ];
}

const recordConsentSchema = z.strictObject({
  /** The only scope that exists. Named explicitly so a second one cannot arrive by default. */
  scope: z.literal(ConsentScope.MARKETING),
  state: z.enum([ConsentState.GRANTED, ConsentState.WITHDRAWN]),
  /** What the customer said, in the merchant's words. Never a phone number, never a token. */
  reason: z.string().trim().min(1).max(280).optional(),
});
export type RecordConsentInput = z.input<typeof recordConsentSchema>;

/**
 * Record that a customer changed their mind, at the counter, to a member of staff.
 *
 * ## Why this is allowed to record a GRANT at all
 *
 * Because it already happens: a customer says "yes, text me about offers" to the person serving
 * them, and the alternative to recording it is a merchant with no record of a conversation that
 * took place. What makes it safe is that it is **attributed** — the row names the staff member,
 * the moment, and the reason they typed — so a grant that nobody can account for is visible as
 * such rather than indistinguishable from one the customer gave themselves.
 *
 * What it explicitly does not do:
 *
 *  - it does not touch `CustomerBusinessProfile`. The enrolment answer is history and stays exactly
 *    as it was recorded;
 *  - it does not carry a policy version for a GRANT. The customer did not read a consent text; they
 *    spoke to somebody. Stamping the current text revision would claim they had;
 *  - it does not accept `recordedAt` from a caller. The moment is the server's.
 *
 * Requires `EDIT_CUSTOMERS`, which an owner and a manager hold — and a CASHIER also holds, for
 * counter enrolment. A cashier is refused here anyway: changing a standing preference is not a
 * counter action, and the refusal is the same one that keeps them out of the customer record.
 */
export async function recordConsentChange(
  ctx: TenantContext,
  profileId: string,
  input: RecordConsentInput,
): Promise<ConsentStatus> {
  requirePermission(ctx, Permission.EDIT_CUSTOMERS);
  if (ctx.role === MembershipRole.CASHIER) {
    throw new ForbiddenError("Changing a customer's marketing preference is not a counter action");
  }
  const parsed = recordConsentSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError("Invalid consent change", parsed.error.issues);
  const data = parsed.data;

  const current = await getConsentStatus(ctx, profileId);
  if (current.state === data.state) {
    // Not an error, and not a row either: appending an identical state would fill a history with
    // events that describe no change.
    return current;
  }

  return prisma.$transaction(async (tx) => {
    const now = new Date();
    const created = await tx.consentRecord.create({
      data: {
        businessId: ctx.businessId,
        customerBusinessProfileId: profileId,
        scope: data.scope,
        state: data.state,
        previousState: current.state,
        capturedVia: ConsentCapture.STAFF_UPDATE,
        // Deliberately null: a spoken agreement refers to no consent text.
        policyVersion: null,
        recordedAt: now,
        actorUserId: ctx.userId,
        reason: data.reason ?? null,
      },
      select: { scope: true, state: true, policyVersion: true, recordedAt: true, capturedVia: true },
    });

    await recordAudit(tx, {
      businessId: ctx.businessId,
      actorUserId: ctx.userId,
      action: AuditAction.CONSENT_RECORDED,
      entityType: "ConsentRecord",
      entityId: profileId,
      /*
       * What changed and who changed it. Deliberately absent: the customer's name, their phone, and
       * the free-text reason — an audit row is read by more people and kept far longer than the
       * screen the reason was typed into, and "said stop when I called him" is about a person.
       */
      metadata: { scope: data.scope, from: current.state, to: data.state, hasReason: data.reason !== undefined },
    });

    return recordStatus(created);
  });
}
