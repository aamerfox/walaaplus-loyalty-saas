import { CardType, Permission } from "@prisma/client";
import { AuditAction, recordAudit } from "../audit/audit";
import { prisma } from "../db";
import { NotFoundError } from "../errors";
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
  });

  await recordAudit(prisma, {
    action: AuditAction.CARD_ISSUED_AT_COUNTER,
    entityType: "CustomerCard",
    entityId: result.customerCardId,
    businessId: ctx.businessId,
    actorUserId: ctx.userId,
    // No phone, no name, no token, no URL. Who did it, to which card, and whether it was new.
    metadata: { created: result.created, cardType: result.cardType, welcomeUnitsGranted: result.welcomeUnitsGranted },
  });

  const cardUrl = publicCardUrl(result.shareToken);
  return {
    created: result.created,
    customerCardId: result.customerCardId,
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
    select: { shareToken: true, serialNumber: true },
  });
  if (!card) throw new NotFoundError("Card not found");

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
