import { randomUUID } from "node:crypto";
import { CardType, ProgramVersionStatus, TemplateStatus } from "@prisma/client";
import { AuditAction, recordAudit } from "../audit/audit";
import { CONTENDED_TX, prisma, type Tx } from "../db";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import { resolveEnrollmentLocationId } from "../program/available-locations";
import { readStampMechanics, type StampMechanics } from "../program/mechanics";
import { readPointsMechanics, type PointsMechanics } from "../program/points-mechanics";
import { MonetaryProgramKind, readMonetaryMechanics, type MonetaryMechanics } from "../monetary/mechanics";
import { getDefaultLocationId } from "../program/stamp-program";
import { grantWelcomePoints } from "../points/engine";
import { newCardTokens } from "../security/tokens";
import { grantWelcomeStamps } from "../stamp/engine";
import { normalizeSyrianPhone } from "./phone";

/**
 * Enrollment: a customer scans the café's QR, gives their phone number, and gets a card.
 *
 * This path is PUBLIC. There is no session, no tenant context and no merchant login anywhere in
 * it (PRODUCT-SPEC §6.1) — the enrollment link's opaque token is the only thing that says which
 * program is being joined, and every business fact is derived from it. Nothing here accepts a
 * businessId, templateId or cardId from the caller.
 *
 * ## Why this is written with `ON CONFLICT DO NOTHING` rather than `upsert`
 *
 * Two taps on a slow connection, or a customer and a cashier enrolling the same person at once,
 * must produce ONE customer, ONE profile and ONE card — not a duplicate identity that splits a
 * person's balance in half forever. Prisma's `upsert` is read-then-write and loses that race, and
 * catching P2002 inside a transaction is useless because the transaction is already poisoned.
 *
 * `INSERT … ON CONFLICT DO NOTHING` does not raise. When a concurrent transaction holds a
 * conflicting row, the statement WAITS for that transaction to finish, then does nothing, and the
 * follow-up SELECT sees the committed row. Both callers end up with the same card and neither
 * sees an error. The three inserts are always attempted in the same order — customer, profile,
 * card — so two concurrent enrollments queue rather than deadlock.
 *
 * ## Why the card insert decides the welcome bonus
 *
 * `RETURNING id` yields a row only for the transaction that actually inserted the card. That is
 * the arbiter: exactly one caller learns it created the card, and only that caller writes the
 * welcome stamps, inside the same transaction. No idempotency key is involved, so the bonus
 * cannot be duplicated by a retry that forgot one, and it cannot be lost by a retry that reused
 * one either.
 *
 * ## Card issuance is audited, not ledgered
 *
 * PRODUCT-SPEC §6.1 sketches a `CARD_ISSUED` operation. There is no such row, deliberately: the
 * ledger refuses zero-quantity operations (Phase 0, enforced in `validateOperations` and tested),
 * and issuing a card moves no loyalty value. Writing a fake `+0` or `+1` row to represent it would
 * either break that invariant or inflate a balance. Issuance is therefore recorded as an
 * `AuditLog` entry plus `CustomerCard.issuedAt`, which is where a question about when a card was
 * created is actually answered. The `CARD_ISSUED` enum value stays unused in Phase 1a.
 */

export interface EnrollCustomerInput {
  /** Opaque `publicToken` of an enrollment source. This is what the QR or link carries. */
  sourceToken: string;
  /** Any accepted Syrian spelling; stored canonically. Mandatory (PRODUCT-SPEC §2.8). */
  phone: string;
  firstName?: string;
  lastName?: string;
  marketingConsent?: boolean;
  /** Version of the consent text the customer actually saw, stored for later proof. */
  consentTextVersion?: string;
  /**
   * Who, if anyone, did this at a till (finding M-10).
   *
   * Absent for any other caller. When present, the `CARD_ISSUED_AT_COUNTER` attribution row is
   * written INSIDE this function's transaction, next to the issuance it attributes.
   *
   * It used to be written by `enrollAtCounter` afterwards, with the global client. A crash in the
   * few milliseconds between the two left the issuance audited and **unattributed** — a card that
   * appeared from nowhere, with no record of which member of staff handed it over, which is
   * exactly the question an audit of counter enrolment exists to answer. Passing the actor in is
   * what lets the two rows share a commit.
   *
   * It carries an actor, never a customer: no phone, no name, no token.
   */
  counterActor?: { userId: string; membershipId: string };
}

export type EnrollmentResult = {
  /** True when THIS call issued the card. False when the customer was already enrolled. */
  created: boolean;
  businessId: string;
  templateId: string;
  programVersionId: string;
  customerId: string;
  customerBusinessProfileId: string;
  customerCardId: string;
  /** For the QR the staff scanner reads. */
  qrToken: string;
  /** For the card page URL. A different secret from the QR, by design. */
  shareToken: string;
  serialNumber: string;
  /** Which program this card belongs to. Decides which engine may transact on it. */
  cardType: CardType;
  stampBalance: number;
  pointBalance: number;
  rewardBalance: number;
  /**
   * Units granted by the welcome bonus on this call - stamps on a stamp card, points on a points
   * card - and 0 on a repeat enrollment.
   */
  welcomeUnitsGranted: number;
};

interface ResolvedSource {
  sourceId: string;
  businessId: string;
  templateId: string;
  programVersionId: string;
  /** STAMP or POINTS. Read from the template, never from the caller. */
  cardType: CardType;
  utmSource: string;
  utmMedium: string | null;
  utmCampaign: string | null;
  /**
   * Per-source override of the program's welcome bonus (PRODUCT-SPEC §6.1), already resolved to a
   * number of whichever unit this program uses.
   */
  welcomeUnits: number;
  /** The version's own location rule, so the welcome bonus is not written where it cannot run. */
  availableLocations: readonly string[] | null;
}

/**
 * Resolve an enrollment link to the program behind it.
 *
 * Everything must be live: an inactive link, an archived or draft template, or a program with no
 * active version all mean "this link no longer enrols anyone", and all produce the same
 * `NotFoundError` so a stale QR cannot be used to probe a business's configuration.
 */
async function resolveSource(db: Tx, sourceToken: string): Promise<ResolvedSource> {
  if (typeof sourceToken !== "string" || sourceToken.length < 8) throw new NotFoundError("Enrollment link not found");

  const link = await db.utmSourceLink.findFirst({
    where: {
      publicToken: sourceToken,
      active: true,
      // Any live program, not only a stamp one: Phase 1b issues points cards through the same
      // path. Which engine owns the card is decided by the template's `cardType` below, and by the
      // discriminator inside the version's pinned mechanics - never by the caller.
      template: { status: TemplateStatus.ACTIVE },
    },
    select: {
      id: true,
      utmSource: true,
      utmMedium: true,
      utmCampaign: true,
      welcomeUnitQuantity: true,
      template: {
        select: {
          id: true,
          businessId: true,
          cardType: true,
          business: { select: { active: true } },
          versions: {
            where: { status: ProgramVersionStatus.ACTIVE },
            select: { id: true, mechanics: true },
            take: 1,
          },
        },
      },
    },
  });

  const version = link?.template.versions[0];
  if (!link || !version || !link.template.business.active) throw new NotFoundError("Enrollment link not found");

  /*
   * The program's own welcome bonus, read through the contract that owns it, with the named
   * source's override taking precedence (PRODUCT-SPEC §6.1). Reading through the contract rather
   * than the raw JSON is what stops a points version's `welcomePoints` being handed to the stamp
   * engine as stamps.
   *
   * THE DISPATCH IS EXHAUSTIVE, not "points or else stamp". Phase 4 added `CASHBACK` and `DISCOUNT`
   * to `CardType`, and with an `else` here a cashback version's mechanics would have been read
   * through the STAMP contract - which fails as a corrupt-row invariant error, so enrolling into a
   * money program was impossible and the message blamed the data.
   */
  let mechanics: StampMechanics | PointsMechanics | MonetaryMechanics;
  switch (link.template.cardType) {
    case CardType.POINTS:
      mechanics = readPointsMechanics(version.mechanics, { programVersionId: version.id });
      break;
    case CardType.STAMP:
      mechanics = readStampMechanics(version.mechanics, { programVersionId: version.id });
      break;
    case CardType.CASHBACK:
      mechanics = readMonetaryMechanics(version.mechanics, MonetaryProgramKind.CASHBACK, { programVersionId: version.id });
      break;
    case CardType.DISCOUNT:
      mechanics = readMonetaryMechanics(version.mechanics, MonetaryProgramKind.DISCOUNT, { programVersionId: version.id });
      break;
  }

  /*
   * A MONEY PROGRAM HAS NO WELCOME BONUS, and this is where that is enforced rather than assumed.
   *
   * The money mechanics contract has no welcome field at all, and `createMonetaryProgram` writes
   * `welcomeUnitQuantity: null` on the source. But a named source is a row somebody could later set
   * a quantity on, and `welcomeUnits` here feeds the ledger - so a money card must resolve to zero
   * whatever the row says. A welcome balance on a cashback card is the business handing real money
   * to anybody who enrols, with no invoice and no member of staff present.
   */
  const programWelcome =
    mechanics.kind === "POINTS" ? (mechanics.welcomePoints ?? 0) : mechanics.kind === "STAMP" ? (mechanics.welcomeStamps ?? 0) : 0;
  const isMoney = mechanics.kind === "CASHBACK" || mechanics.kind === "DISCOUNT";

  return {
    sourceId: link.id,
    businessId: link.template.businessId,
    templateId: link.template.id,
    programVersionId: version.id,
    cardType: link.template.cardType,
    utmSource: link.utmSource,
    utmMedium: link.utmMedium,
    utmCampaign: link.utmCampaign,
    welcomeUnits: isMoney ? 0 : (link.welcomeUnitQuantity ?? programWelcome),
    availableLocations: mechanics.availableLocations ?? null,
  };
}

/** Race-safe get-or-create of the global phone identity. */
async function getOrCreateCustomer(tx: Tx, normalizedPhone: string, now: Date): Promise<string> {
  const inserted = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO "Customer" ("id", "normalizedPhone", "createdAt", "updatedAt")
    VALUES (${randomUUID()}, ${normalizedPhone}, ${now}, ${now})
    ON CONFLICT ("normalizedPhone") DO NOTHING
    RETURNING "id"`;
  if (inserted[0]) return inserted[0].id;

  const existing = await tx.customer.findUnique({ where: { normalizedPhone }, select: { id: true } });
  if (!existing) throw new ConflictError("Customer identity could not be resolved; retry the enrollment");
  return existing.id;
}

/**
 * Race-safe get-or-create of the per-business profile.
 *
 * On a repeat enrollment the stored name and consent are LEFT ALONE. Anyone who knows a phone
 * number can open a public enrollment form, so letting a second submission overwrite the first
 * would let a stranger rename another person's profile or flip their marketing consent.
 */
async function getOrCreateProfile(
  tx: Tx,
  source: ResolvedSource,
  customerId: string,
  input: EnrollCustomerInput,
  now: Date,
): Promise<string> {
  const firstName = input.firstName?.trim() || null;
  const lastName = input.lastName?.trim() || null;
  const consentAt = input.consentTextVersion ? now : null;

  const inserted = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO "CustomerBusinessProfile" (
      "id", "businessId", "customerId", "firstName", "lastName", "marketingConsent",
      "privacyConsentAt", "consentTextVersion", "utmSource", "utmMedium", "utmCampaign",
      "firstSeenAt", "lastSeenAt", "createdAt", "updatedAt")
    VALUES (
      ${randomUUID()}, ${source.businessId}, ${customerId}, ${firstName}, ${lastName},
      ${input.marketingConsent === true}, ${consentAt}, ${input.consentTextVersion ?? null},
      ${source.utmSource}, ${source.utmMedium}, ${source.utmCampaign},
      ${now}, ${now}, ${now}, ${now})
    ON CONFLICT ("businessId", "customerId") DO NOTHING
    RETURNING "id"`;
  if (inserted[0]) return inserted[0].id;

  const existing = await tx.customerBusinessProfile.findUnique({
    where: { businessId_customerId: { businessId: source.businessId, customerId } },
    select: { id: true },
  });
  if (!existing) throw new ConflictError("Customer profile could not be resolved; retry the enrollment");
  return existing.id;
}

interface CardRow {
  id: string;
  qrToken: string;
  shareToken: string;
  serialNumber: string;
  stampBalance: number;
  pointBalance: number;
  rewardBalance: number;
}

/**
 * Enrol a customer through a public enrollment link.
 *
 * Idempotent by construction: calling it twice with the same phone and link returns the same card
 * with `created: false` and writes nothing the second time.
 */
export async function enrollCustomer(input: EnrollCustomerInput): Promise<EnrollmentResult> {
  // Normalise before opening a transaction: a malformed number is a client error, not a rollback.
  const normalizedPhone = normalizeSyrianPhone(input.phone);
  for (const [field, value] of Object.entries({ firstName: input.firstName, lastName: input.lastName })) {
    if (value !== undefined && value.trim().length > 80) throw new ValidationError(`${field} must be 80 characters or fewer`);
  }

  return prisma.$transaction(async (tx) => {
    const now = new Date();
    const source = await resolveSource(tx, input.sourceToken);
    // Main, unless the program runs at exactly one other counter - see `resolveEnrollmentLocationId`.
    const locationId = resolveEnrollmentLocationId(
      { availableLocations: source.availableLocations ?? undefined },
      await getDefaultLocationId(tx, source.businessId),
    );

    const customerId = await getOrCreateCustomer(tx, normalizedPhone, now);
    const profileId = await getOrCreateProfile(tx, source, customerId, input, now);

    // The arbiter. Only the transaction that inserts the card gets a row back, and only it goes
    // on to write the welcome bonus. `status` and `deviceChannel` are left to their defaults
    // (ISSUED, UNKNOWN) so no enum cast is needed here.
    const tokens = newCardTokens();
    const created = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO "CustomerCard" (
        "id", "businessId", "templateId", "programVersionId", "customerBusinessProfileId",
        "serialNumber", "qrToken", "shareToken", "issuedAt", "utmSourceLinkId", "createdAt", "updatedAt")
      VALUES (
        ${randomUUID()}, ${source.businessId}, ${source.templateId}, ${source.programVersionId}, ${profileId},
        ${tokens.serialNumber}, ${tokens.qrToken}, ${tokens.shareToken}, ${now}, ${source.sourceId}, ${now}, ${now})
      ON CONFLICT ("customerBusinessProfileId", "templateId") DO NOTHING
      RETURNING "id"`;

    let welcomeUnitsGranted = 0;
    if (created[0]) {
      const customerCardId = created[0].id;

      await recordAudit(tx, {
        action: AuditAction.CARD_ISSUED,
        entityType: "CustomerCard",
        entityId: customerCardId,
        businessId: source.businessId,
        // No staff member is involved: this is the customer acting on a public link.
        actorUserId: null,
        // Deliberately absent: the phone number, and every one of the card's tokens. The audit
        // log answers "when was this card issued and where did it come from", not "who is this".
        metadata: {
          templateId: source.templateId,
          programVersionId: source.programVersionId,
          customerBusinessProfileId: profileId,
          utmSource: source.utmSource,
          utmMedium: source.utmMedium,
          utmCampaign: source.utmCampaign,
          cardType: source.cardType,
          welcomeUnits: source.welcomeUnits,
        },
      });

      /*
       * The attribution row, in the same transaction as the issuance it describes (M-10).
       *
       * Written only on the call that actually CREATED the card, which is the same arbiter the
       * welcome bonus uses: `RETURNING id` yields a row to exactly one transaction. A repeat
       * enrolment of a customer who already has a card is recorded by `enrollAtCounter` instead,
       * because nothing was issued and there is no issuance to attribute.
       */
      if (input.counterActor) {
        await recordAudit(tx, {
          action: AuditAction.CARD_ISSUED_AT_COUNTER,
          entityType: "CustomerCard",
          entityId: customerCardId,
          businessId: source.businessId,
          actorUserId: input.counterActor.userId,
          // No phone, no name, no token, no URL. Who did it, to which card, and what it granted.
          metadata: {
            created: true,
            cardType: source.cardType,
            welcomeUnitsGranted: source.welcomeUnits,
            membershipId: input.counterActor.membershipId,
          },
        });
      }

      if (source.welcomeUnits > 0) {
        const reason = `welcome bonus on enrollment via ${source.utmSource}`;
        // One branch, in one place. Each engine refuses a card pinned to the other kind, so a
        // mis-branch here fails loudly rather than writing points onto a stamp card.
        if (source.cardType === CardType.POINTS) {
          await grantWelcomePoints(tx, {
            businessId: source.businessId,
            customerCardId,
            locationId,
            points: source.welcomeUnits,
            reason,
          });
        } else {
          await grantWelcomeStamps(tx, {
            businessId: source.businessId,
            customerCardId,
            locationId,
            stamps: source.welcomeUnits,
            reason,
          });
        }
        welcomeUnitsGranted = source.welcomeUnits;
      }
    }

    const card = await tx.$queryRaw<CardRow[]>`
      SELECT "id", "qrToken", "shareToken", "serialNumber", "stampBalance", "pointBalance", "rewardBalance"
        FROM "CustomerCard"
       WHERE "customerBusinessProfileId" = ${profileId} AND "templateId" = ${source.templateId}`;
    const row = card[0];
    if (!row) throw new ConflictError("Card could not be resolved after enrollment; retry");

    return {
      created: created.length > 0,
      businessId: source.businessId,
      templateId: source.templateId,
      programVersionId: source.programVersionId,
      customerId,
      customerBusinessProfileId: profileId,
      customerCardId: row.id,
      qrToken: row.qrToken,
      shareToken: row.shareToken,
      serialNumber: row.serialNumber,
      cardType: source.cardType,
      stampBalance: row.stampBalance,
      pointBalance: row.pointBalance,
      rewardBalance: row.rewardBalance,
      welcomeUnitsGranted,
    };
  }, CONTENDED_TX);
}

export interface EnrollmentSourceView {
  businessName: string;
  templateName: string;
  stampsRequiredPerReward: number;
  rewardName: string;
  rewardDescription: string | null;
  welcomeStamps: number;
}

/**
 * What the public enrollment page may display before anyone has enrolled.
 *
 * Deliberately thin: enough to render the offer, nothing that identifies other customers, no
 * internal ids and no tokens. Prompt 2 renders this; it lives here so the page never has to
 * reach for a model itself.
 */
export async function getEnrollmentSourceView(sourceToken: string): Promise<EnrollmentSourceView> {
  return prisma.$transaction(async (tx) => {
    const source = await resolveSource(tx, sourceToken);
    const template = await tx.programTemplate.findUniqueOrThrow({
      where: { id: source.templateId },
      select: { name: true, business: { select: { name: true } } },
    });
    // Deliberately stamp-only. This described the offer on the public join page, which owner
    // decision B7 withdrew, and a points program's offer is a list of tiers rather than one
    // threshold - a different view, for a screen that does not exist yet.
    const version = await tx.programVersion.findUniqueOrThrow({
      where: { id: source.programVersionId },
      select: { id: true, mechanics: true },
    });
    const mechanics = readStampMechanics(version.mechanics, { programVersionId: version.id });
    return {
      businessName: template.business.name,
      templateName: template.name,
      stampsRequiredPerReward: mechanics.stampsRequiredPerReward,
      rewardName: mechanics.rewardName,
      rewardDescription: mechanics.rewardDescription ?? null,
      welcomeStamps: source.welcomeUnits,
    };
  }, CONTENDED_TX);
}
