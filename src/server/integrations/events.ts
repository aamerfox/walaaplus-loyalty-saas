import {
  IntegrationEntityType,
  IntegrationEventType,
  MembershipRole,
  Permission,
  type Prisma,
} from "@prisma/client";
import { prisma } from "../db";
import { ForbiddenError } from "../errors";
import { requirePermission, type TenantContext } from "../tenant/context";

/**
 * The internal record that a completed workflow happened.
 *
 * ## This is not an integration
 *
 * Nothing here sends anything. There is no endpoint, no subscription, no credential, no signature,
 * no queue, no worker, no retry and no delivery status — and no `fetch`, HTTP client or timer
 * anywhere in this directory, which `tests/unit/integration-boundary.test.ts` asserts by reading the
 * source. `docs/INTEGRATIONS-CAPABILITY-MATRIX.md` was written before this file to make that a
 * constraint rather than a description of what happened to get built.
 *
 * What this is: the **input** a delivery mechanism would one day read. Building the record first,
 * with nothing able to publish it, is the order that keeps a half-finished integration from being
 * mistaken for a working one.
 *
 * ## The envelope, and why it is this small
 *
 * The business, the event type, the entity type and its internal id, the moment the **database**
 * assigned, and a version. Nothing else, and there is **no JSON metadata column** for anything else
 * to go in.
 *
 * That absence is the design. A free-form bag does not leak a phone number because somebody is
 * careless; it leaks one because somebody debugging a failed delivery at two in the morning adds
 * "just the recipient, temporarily". Typed columns mean the table has nowhere to put a contact
 * detail, a capability or its digest, a coupon code, a secret, a wallet payload or an amount, and a
 * column-name check fails if one is ever added.
 *
 * A consumer that needs detail asks for it through an authorized read. That keeps the authorization
 * decision in one place rather than copying a customer's data into a row nobody re-checks.
 *
 * ## Written with the action, or not at all
 *
 * `emitIntegrationEvent` takes a transaction client and nothing else. It is called inside the
 * transaction that performs the action, so the two commit together: a redemption that fails leaves
 * no event, and an event that fails takes the redemption with it. There is no "best effort" path,
 * because a best-effort event is one a consumer will eventually be missing without knowing.
 */

/** The one envelope shape that exists. A consumer meeting anything else should stop, not guess. */
export const ENVELOPE_VERSION = 1;

/** A transaction client. Emission is never offered outside one — see the note above. */
type TxClient = Prisma.TransactionClient;

export interface EmitIntegrationEventInput {
  businessId: string;
  eventType: IntegrationEventType;
  entityType: IntegrationEntityType;
  /** An internal row id belonging to `businessId`. The trigger checks that it does. */
  entityId: string;
}

/**
 * Record that something happened.
 *
 * Deliberately takes `tx` rather than reaching for the shared client: a caller cannot accidentally
 * emit outside the transaction that did the work, because there is no overload that lets them.
 *
 * `occurredAt` is not a parameter. The database assigns it, so the ordering a future consumer
 * depends on cannot be chosen by whoever is writing — which is the same rule `PromotionRedemption`
 * learned the hard way.
 */
export async function emitIntegrationEvent(tx: TxClient, input: EmitIntegrationEventInput): Promise<void> {
  await tx.integrationEvent.create({
    data: {
      businessId: input.businessId,
      envelopeVersion: ENVELOPE_VERSION,
      eventType: input.eventType,
      entityType: input.entityType,
      entityId: input.entityId,
    },
    select: { id: true },
  });
}

/** One row of the merchant's own event history. Internal references and times, nothing else. */
export interface IntegrationEventView {
  id: string;
  envelopeVersion: number;
  eventType: IntegrationEventType;
  entityType: IntegrationEntityType;
  entityId: string;
  occurredAt: Date;
}

/** How many rows the history screen reads. A page, not an export. */
export const EVENT_PAGE_SIZE = 50;

/**
 * The merchant's own event history.
 *
 * **Owner and manager only**, twice over: `VIEW_INTEGRATIONS` — which a cashier does not hold and
 * which `ROLE_DEFAULT_PERMISSIONS` gives to `OWNER` and `MANAGER` — and an explicit role check on
 * top of it, because a permission bit can be granted to a membership individually and this is not a
 * decision to leave to a checkbox.
 *
 * A cashier serves the customer in front of them. A feed of everything the business has done is a
 * different thing entirely, and the screen 404s for them rather than rendering empty.
 */
export async function listIntegrationEvents(ctx: TenantContext): Promise<IntegrationEventView[]> {
  requirePermission(ctx, Permission.VIEW_INTEGRATIONS);
  if (ctx.role !== MembershipRole.OWNER && ctx.role !== MembershipRole.MANAGER) {
    throw new ForbiddenError("Only an owner or a manager may read the integration history");
  }

  return prisma.integrationEvent.findMany({
    // businessId in the WHERE: another tenant's events do not exist for this caller.
    where: { businessId: ctx.businessId },
    orderBy: { occurredAt: "desc" },
    take: EVENT_PAGE_SIZE,
    // Listed literally. There is no other column to omit, which is the point of the table's shape.
    select: {
      id: true,
      envelopeVersion: true,
      eventType: true,
      entityType: true,
      entityId: true,
      occurredAt: true,
    },
  });
}
