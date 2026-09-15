import { CardType, Permission } from "@prisma/client";
import { AuditAction, recordAudit } from "../audit/audit";
import { prisma } from "../db";
import { NotFoundError } from "../errors";
import { readVersionAvailableLocations, versionContractOf } from "../program/card-type-support";
import { resolveEnrollmentTarget } from "../program/programs";
import { publicCardUrl } from "../program/public-urls";
import { qrSvg } from "../qr";
import { requirePermission, type TenantContext } from "../tenant/context";
import { ENROLLMENT_CONSENT_VERSION } from "./consent";
import { enrollCustomer } from "./enrollment";

/**
 * Enrolment at the counter, by a signed-in member of staff.
 *
 * This replaces public self-service enrolment, which is gone — owner decision **B7, option 3**.
 * The reason is worth keeping next to the code that implements it: a public form that issues a
 * live card to a new phone number and reveals nothing for an existing one tells whoever submits it
 * which case they hit, because they either receive a card or they do not. No status code, redirect
 * or wording closes that; only proof that the submitter owns the number does, and Phase 1a has no
 * channel to obtain one. So the flow moved behind a counter, where the person handing over the
 * card can see who they are handing it to.
 *
 * **Nothing about the tenant, the program, the source or the location comes from the caller.** The
 * staff member supplies a phone number, a name and a consent confirmation; everything else is
 * resolved here from the membership that was already verified for this request. There is no
 * `sourceToken` parameter to forge and no `businessId` to point elsewhere.
 */

export interface CounterEnrollmentInput {
  /** Any accepted Syrian spelling; stored canonically by the enrolment service. */
  phone: string;
  firstName?: string;
  lastName?: string;
  /** Ticked at the counter, by the customer, on the staff member's device. */
  marketingConsent?: boolean;
  /**
   * Which of the business's programs to enrol into.
   *
   * Optional, and resolved server-side against THIS business: with one live program it is the
   * program, exactly as Phase 1a behaved, and with several the caller must name one rather than
   * have the server guess and hand over the wrong card. It is a program selector, not a tenant or
   * a source: it can only ever name a template this membership already owns, and the enrolment
   * token behind it is still resolved here and never accepted from a caller (B7).
   */
  templateId?: string;
}

export interface CounterEnrollmentResult {
  /** True when this call issued the card; false when the customer already had one. */
  created: boolean;
  customerCardId: string;
  /** The profile behind the card. Needed by referral attribution, which links by internal id only. */
  customerBusinessProfileId: string;
  serialNumber: string;
  /** Which program the card belongs to, so the counter screen knows which balance to show. */
  cardType: CardType;
  templateId: string;
  stampBalance: number;
  pointBalance: number;
  rewardBalance: number;
  /** The customer's own card link, for staff to show, send or print. */
  cardUrl: string;
  /** The same link as inline SVG, so the customer can photograph it before they leave. */
  cardQrSvg: string;
}

/**
 * Which program this enrolment targets, and the `direct` token to enrol through.
 *
 * The source rows still exist and still carry their public tokens - B7 removed the public *route*,
 * not the data - so a card enrolled at the counter is attributed exactly as before and every
 * existing card keeps working. What Phase 1b adds is that a business may run several programs, so
 * "the" source is no longer a single row: the template is resolved first (from the caller's choice
 * when they made one, from the only live program when there is one), and its own direct source is
 * read from it.
 */
/**
 * Create a customer's card at the counter, or return the one they already have.
 *
 * Repeats are safe and deliberate. `enrollCustomer` is idempotent — one customer, one profile, one
 * card per program, and the welcome bonus granted exactly once — so a staff member who does not
 * know whether someone is already a customer can simply enrol them and find out. Showing an
 * existing card here is not the disclosure the public route had: the person reading it is a
 * verified member of that business, standing at their own till.
 */
export async function enrollAtCounter(
  ctx: TenantContext,
  input: CounterEnrollmentInput,
): Promise<CounterEnrollmentResult> {
  requirePermission(ctx, Permission.EDIT_CUSTOMERS);

  // Tenant-scoped, inside this business only. A template id from another business is "not
  // available for enrolment" - the same answer as one that does not exist.
  const target = await resolveEnrollmentTarget(prisma, ctx.businessId, input.templateId);

  const result = await enrollCustomer({
    sourceToken: target.sourceToken,
    phone: input.phone,
    firstName: input.firstName,
    lastName: input.lastName,
    marketingConsent: input.marketingConsent === true,
    // Stamped from the server's constant, exactly as the public route used to. The counter screen
    // shows the same two sentences the join page showed, so the version means the same thing.
    consentTextVersion: ENROLLMENT_CONSENT_VERSION,
    /*
     * Finding M-10, closed. The attribution row is written inside the enrolment transaction, so
     * the issuance and the member of staff who made it commit together or not at all. This call
     * site used to write it afterwards with the global client, and a crash in that window left a
     * card issued with no record of who issued it.
     */
    counterActor: { userId: ctx.userId, membershipId: ctx.membershipId },
  });

  if (!result.created) {
    /*
     * Nothing was issued: this customer already had a card, and the staff member was shown it.
     * That is worth a row of its own — it is how a manager sees that a till is looking customers
     * up — but it is NOT an issuance, and recording it as one would inflate the count of cards a
     * member of staff created. Outside the transaction because there is no write to join.
     */
    await recordAudit(prisma, {
      action: AuditAction.CARD_LINK_REVEALED,
      entityType: "CustomerCard",
      entityId: result.customerCardId,
      businessId: ctx.businessId,
      actorUserId: ctx.userId,
      metadata: { via: "counter_enrollment_repeat" },
    });
  }

  const cardUrl = publicCardUrl(result.shareToken);
  return {
    created: result.created,
    customerCardId: result.customerCardId,
    customerBusinessProfileId: result.customerBusinessProfileId,
    serialNumber: result.serialNumber,
    cardType: result.cardType,
    templateId: result.templateId,
    stampBalance: result.stampBalance,
    pointBalance: result.pointBalance,
    rewardBalance: result.rewardBalance,
    cardUrl,
    cardQrSvg: qrSvg(cardUrl, { cellSize: 5, margin: 4 }),
  };
}

export interface CardLinkReveal {
  cardUrl: string;
  cardQrSvg: string;
  serialNumber: string;
}

/**
 * May this member of staff see a card at all? (Finding L-17, closed.)
 *
 * Phase 1a was Main-only, so there was nothing to cross and the reveal checked only the tenant and
 * `VIEW_CUSTOMERS`. Phase 1b creates the boundary this closes: with several counters, a cashier
 * assigned to one branch could otherwise reveal the card link — a live capability that opens the
 * customer's card — for a customer served only at another.
 *
 * The rule is the one the write path already uses, read-only:
 *
 *  - **OWNER and MANAGER** (`locationIds === null`) see every card of their business. They are the
 *    people who answer a support call about a branch they are not standing in.
 *  - **A cashier** sees a card whose pinned version runs at one of the counters they are assigned
 *    to. A version that names no counters runs at Main, so serving it means being assigned to Main.
 *  - **A cashier with no assignment at all** sees nothing. An empty assignment list is not
 *    "unrestricted" anywhere in this system, and this is not the place to make it the exception.
 *
 * The refusal is a 404, matching the tenant miss above: a member who may not serve a card learns
 * only that they cannot, not that it exists.
 */
async function assertCardWithinMemberScope(ctx: TenantContext, mechanics: unknown): Promise<void> {
  if (ctx.locationIds === null) return;
  if (ctx.locationIds.length === 0) throw new NotFoundError("Card not found");

  /*
   * Exhaustive over the contracts, so a money version's pinned locations are honoured rather than
   * being read as "no contract". Before this, a money card fell to `null` and every cashier with a
   * location assignment was told "Card not found" - which failed CLOSED, and was therefore safe,
   * but for the wrong reason and with a misleading sentence.
   *
   * `null` here now means what it has always meant: Main only. A row that parses as no contract at
   * all lands in the same place, and failing closed remains the only safe reading when the thing
   * being handed over is a capability.
   */
  // Fail closed FIRST. A row that parses as no contract at all is corrupt, and the most permissive
  // reading is the wrong one when the thing being handed over is a capability. Consolidating the
  // two-contract ladder briefly lost this, which is why it is now an explicit, separately named
  // check rather than a side effect of `readVersionAvailableLocations` returning null.
  if (versionContractOf(mechanics) === null) throw new NotFoundError("Card not found");

  const allowed = readVersionAvailableLocations(mechanics);
  if (allowed === null) {
    const main = await prisma.location.findFirst({
      where: { businessId: ctx.businessId, isDefault: true },
      select: { id: true },
    });
    if (!main || !ctx.locationIds.includes(main.id)) throw new NotFoundError("Card not found");
    return;
  }
  if (!allowed.some((id) => ctx.locationIds!.includes(id))) throw new NotFoundError("Card not found");
}

/**
 * Show a customer their own card link again, at the counter.
 *
 * This is the restore path, and the only one Phase 1a has. A customer who lost their link cannot
 * recover it by typing their number into a public page — that was the enumeration oracle — so they
 * ask the staff member in front of them, who can already see them.
 *
 * **The reveal is audited and the token is not.** `shareToken` opens the card, so writing it into
 * an audit row would put a live capability somewhere read by more people and kept far longer than
 * the screen that legitimately shows it. The row records who revealed which card, and when; the
 * card id is enough to answer every question an audit needs to answer.
 */
export async function revealCardLink(ctx: TenantContext, customerCardId: string): Promise<CardLinkReveal> {
  requirePermission(ctx, Permission.VIEW_CUSTOMERS);

  // Tenant-filtered, not checked afterwards: another business's card id is simply not found.
  const card = await prisma.customerCard.findFirst({
    where: { id: customerCardId, businessId: ctx.businessId },
    select: {
      shareToken: true,
      serialNumber: true,
      // The card's PINNED mechanics, never the template's current ones: the question is which
      // counters THIS card is served at, and that was decided when it was issued.
      programVersion: { select: { mechanics: true } },
    },
  });
  if (!card) throw new NotFoundError("Card not found");
  await assertCardWithinMemberScope(ctx, card.programVersion.mechanics);

  await recordAudit(prisma, {
    action: AuditAction.CARD_LINK_REVEALED,
    entityType: "CustomerCard",
    entityId: customerCardId,
    businessId: ctx.businessId,
    actorUserId: ctx.userId,
    // Deliberately empty of anything that could open the card or identify the customer.
    metadata: {},
  });

  const cardUrl = publicCardUrl(card.shareToken);
  return { cardUrl, cardQrSvg: qrSvg(cardUrl, { cellSize: 5, margin: 4 }), serialNumber: card.serialNumber };
}
