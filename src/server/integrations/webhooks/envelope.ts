import type { IntegrationEntityType, IntegrationEventType } from "@prisma/client";

/**
 * What actually goes over the wire, and nothing else.
 *
 * The body is the `IntegrationEvent` envelope Prompt 1 built, serialised. **Seven fields**, all of
 * which are already in a table that has no column for a contact detail, a capability, a code, a
 * secret, a wallet payload or an amount. Delivery does not read a customer, a card, a promotion or
 * an audit row — there is no code path here that could, because this module imports nothing that
 * can query one.
 *
 * A receiver that wants detail asks for it through an authorized read it does not have. That is the
 * point: the envelope says *something happened, here is its internal id*, and resolving that id is a
 * decision this product still owns.
 *
 * ## Canonical, because it is signed
 *
 * `JSON.stringify` over a literal with the keys written in a fixed order. Not `Object.keys().sort()`
 * over an arbitrary object — that is a rule somebody can accidentally change by renaming a field.
 * The bytes here are the bytes that get signed and the bytes that get sent; there is one
 * serialisation and no reformatting between signing and sending.
 */

/** Bumped only with a deliberate change to the shape below. Mirrors `IntegrationEvent.envelopeVersion`. */
export const WEBHOOK_ENVELOPE_VERSION = 1;

export interface WebhookEnvelopeInput {
  eventId: string;
  envelopeVersion: number;
  eventType: IntegrationEventType | "TEST";
  entityType: IntegrationEntityType | "TEST";
  entityId: string;
  occurredAt: Date;
  businessId: string;
}

/**
 * The canonical body.
 *
 * Key order is fixed by the literal. `occurredAt` is ISO-8601 in UTC with milliseconds, which is
 * what the column holds; a receiver parsing it gets the same instant the database recorded.
 */
export function canonicalBody(input: WebhookEnvelopeInput): string {
  return JSON.stringify({
    id: input.eventId,
    envelopeVersion: input.envelopeVersion,
    eventType: input.eventType,
    entityType: input.entityType,
    entityId: input.entityId,
    occurredAt: input.occurredAt.toISOString(),
    businessId: input.businessId,
  });
}

/**
 * The fixed synthetic envelope an owner-triggered test sends.
 *
 * It describes **no real event**: the type is `TEST`, the entity id is a constant, and no row in any
 * table corresponds to it. A test delivery that carried a real recent redemption would be a way to
 * exfiltrate one by pressing a button, which is the opposite of what a test is for.
 *
 * The delivery id is mixed into the entity id so two tests are distinguishable to a receiver that
 * de-duplicates, without either of them naming anything real.
 */
export const TEST_EVENT_ENTITY_PREFIX = "test-delivery";

export function testEnvelope(deliveryId: string, businessId: string, occurredAt: Date): WebhookEnvelopeInput {
  return {
    eventId: deliveryId,
    envelopeVersion: WEBHOOK_ENVELOPE_VERSION,
    eventType: "TEST",
    entityType: "TEST",
    entityId: `${TEST_EVENT_ENTITY_PREFIX}:${deliveryId}`,
    occurredAt,
    businessId,
  };
}

/** A body this size is a bug, not a message. Checked before sending, never after. */
export const MAX_BODY_BYTES = 4096;

/** Header names, in one place so the tests and the docs cannot drift from the sender. */
export const HEADER = {
  /** Stable across every attempt and every destination. **This is what a receiver de-duplicates on.** */
  eventId: "x-walaaplus-event-id",
  /** Distinguishes one destination's obligation from another's for the same event. */
  deliveryId: "x-walaaplus-delivery-id",
  /** Attempt number, so a receiver can see it is a retry rather than a second event. */
  attempt: "x-walaaplus-attempt",
  /** Seconds since the epoch. Inside the signed string, so it cannot be swapped. */
  timestamp: "x-walaaplus-timestamp",
  /** `v1=<hex>`. */
  signature: "x-walaaplus-signature",
} as const;
