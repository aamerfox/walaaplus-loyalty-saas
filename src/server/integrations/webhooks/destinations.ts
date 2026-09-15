import { createHash } from "node:crypto";
import {
  MembershipRole,
  Permission,
  Prisma,
  WebhookCipher,
  WebhookDeliveryStatus,
  WebhookDestinationState,
  type WebhookErrorClass,
} from "@prisma/client";
import { z } from "zod";
import { AuditAction, recordAudit } from "../../audit/audit";
import { prisma } from "../../db";
import {
  ConflictCode,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
  WebhookPortError,
} from "../../errors";
import { requirePermission, type TenantContext } from "../../tenant/context";
import { assertSafeWebhookUrl, UnsafeWebhookAddressError, WEBHOOK_PORT } from "./address";
import {
  CURRENT_KEY_VERSION,
  encryptionAvailable,
  EncryptionUnavailableError,
  encryptSecret,
  newSigningSecret,
} from "./crypto";

/**
 * Webhook destinations: what the owner configures, and the rules around who may.
 *
 * ## Owner only, and only the owner
 *
 * Not "owner or manager", which is the bar everywhere else in this product. A destination is a
 * standing instruction to send this business's activity to a third party, for as long as it exists.
 * That is the same kind of decision as approving a campaign, and a manager who could create one
 * could arrange for every redemption to be copied somewhere without the owner ever seeing a screen.
 *
 * A manager holds `VIEW_INTEGRATIONS` and may read the *event* history. Their access stops there.
 *
 * ## The secret is shown once
 *
 * `createDestination` and `rotateSecret` are the only functions that ever return a signing secret,
 * and they return it in the value, not from a column — the column holds ciphertext and no selection
 * anywhere reads it back out. An owner who loses the secret rotates it; there is no reveal.
 *
 * The same is true of the URL: it is encrypted, and what the list shows is the **hostname**, which
 * is not a credential and which the owner needs in order to tell two destinations apart.
 *
 * ## Fail closed
 *
 * Every function here needs `INTEGRATION_ENCRYPTION_KEY`. Without it they refuse, and nothing else
 * in the product notices — no other module imports the crypto.
 */

/** A business may keep this many. Bounded because every enabled one is a fan-out per event. */
export const MAX_DESTINATIONS_PER_BUSINESS = 5;

const MAX_NAME = 60;

/** Owner only. See the note above on why this is stricter than everything else. */
function requireWebhookOwner(ctx: TenantContext): void {
  requirePermission(ctx, Permission.EDIT_INTEGRATIONS);
  if (ctx.role !== MembershipRole.OWNER) {
    throw new ForbiddenError("Only the owner may manage webhook destinations");
  }
}

/** `sha256(businessId ‖ normalised url)`. For the unique index, so one endpoint is one destination. */
function endpointDigest(businessId: string, href: string): string {
  return createHash("sha256").update(`${businessId}\0${href}`, "utf8").digest("hex");
}

/** What an owner may see about a destination. **No URL, no ciphertext, no secret.** */
export interface DestinationView {
  id: string;
  name: string;
  endpointHost: string;
  state: WebhookDestinationState;
  cipherKeyVersion: number;
  secretIssuedAt: Date;
  createdAt: Date;
  /** Counts only. What was sent is in the delivery history, not here. */
  pending: number;
  delivered: number;
  failed: number;
  /**
   * The most recent attempt's error class, so the screen can say what is happening in operational
   * words. **A category, never a detail** — there is no column here that could carry one.
   */
  lastErrorClass: WebhookErrorClass | null;
}

/** Listed literally. There is deliberately no `endpointCipher` or `signingSecretCipher` here. */
const DESTINATION_SELECT = {
  id: true,
  name: true,
  endpointHost: true,
  state: true,
  cipherKeyVersion: true,
  secretIssuedAt: true,
  createdAt: true,
} satisfies Prisma.WebhookDestinationSelect;

interface DestinationCounts {
  pending: number;
  delivered: number;
  failed: number;
  lastErrorClass: WebhookErrorClass | null;
}

async function countsFor(destinationIds: string[]): Promise<Map<string, DestinationCounts>> {
  const counts = new Map<string, DestinationCounts>();
  if (destinationIds.length === 0) return counts;

  const rows = await prisma.webhookDelivery.groupBy({
    by: ["destinationId", "status"],
    where: { destinationId: { in: destinationIds } },
    _count: { _all: true },
  });
  for (const id of destinationIds) counts.set(id, { pending: 0, delivered: 0, failed: 0, lastErrorClass: null });
  for (const row of rows) {
    const bucket = counts.get(row.destinationId);
    if (!bucket) continue;
    if (row.status === WebhookDeliveryStatus.PENDING) bucket.pending += row._count._all;
    else if (row.status === WebhookDeliveryStatus.DELIVERED) bucket.delivered += row._count._all;
    else bucket.failed += row._count._all;
  }

  // The most recent attempt per destination, for the status line. One row each, newest first.
  const recent = await prisma.webhookDelivery.findMany({
    where: { destinationId: { in: destinationIds }, lastOutcome: { not: null } },
    orderBy: { lastAttemptAt: "desc" },
    select: { destinationId: true, lastErrorClass: true },
  });
  for (const row of recent) {
    const bucket = counts.get(row.destinationId);
    if (bucket && bucket.lastErrorClass === null) bucket.lastErrorClass = row.lastErrorClass;
  }
  return counts;
}

function toView(
  row: Prisma.WebhookDestinationGetPayload<{ select: typeof DESTINATION_SELECT }>,
  counts: DestinationCounts | undefined,
): DestinationView {
  return {
    ...row,
    pending: counts?.pending ?? 0,
    delivered: counts?.delivered ?? 0,
    failed: counts?.failed ?? 0,
    lastErrorClass: counts?.lastErrorClass ?? null,
  };
}

export async function listDestinations(ctx: TenantContext): Promise<DestinationView[]> {
  requireWebhookOwner(ctx);
  const rows = await prisma.webhookDestination.findMany({
    where: { businessId: ctx.businessId },
    orderBy: { createdAt: "desc" },
    select: DESTINATION_SELECT,
  });
  const counts = await countsFor(rows.map((r) => r.id));
  return rows.map((row) => toView(row, counts.get(row.id)));
}

/** Whether the deployment can do any of this at all. For a screen that must say so plainly. */
export function webhooksConfigured(): boolean {
  return encryptionAvailable();
}

const createSchema = z.strictObject({
  name: z.string().trim().min(1).max(MAX_NAME),
  url: z.string().trim().min(1),
});
export type CreateDestinationInput = z.input<typeof createSchema>;

/** The one shape that carries a secret. Returned, never stored, never logged. */
export interface CreatedDestination {
  destination: DestinationView;
  /** **Shown once.** There is no route, service or column that can produce it again. */
  signingSecret: string;
}

export async function createDestination(
  ctx: TenantContext,
  input: CreateDestinationInput,
): Promise<CreatedDestination> {
  requireWebhookOwner(ctx);
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError("Invalid destination", parsed.error.issues);
  const data = parsed.data;

  // Refused here, before anything is written, and refused again before every request.
  let safe;
  try {
    safe = assertSafeWebhookUrl(data.url);
  } catch (e) {
    if (e instanceof UnsafeWebhookAddressError) throw new ValidationError(e.message);
    throw e;
  }

  /*
   * The port, refused at the moment the owner presses Save.
   *
   * The egress gateway has always refused anything but 443, correctly — but it refuses at DISPATCH,
   * which meant an owner who typed `:8443` got a destination that saved, sat in the list looking
   * configured, and then failed every attempt with GATEWAY_REJECTED. A rule the product only tells
   * you about after you have already used it is not a rule the product has explained.
   *
   * This is where "before" is worth being exact about. Nothing has happened yet at this line: no
   * signing secret has been generated, nothing has been encrypted, no row has been written, no
   * audit entry exists, no delivery has been queued, and the owner has not been shown a secret. The
   * refusal costs a round trip and leaves no trace.
   *
   * The gateway's own check is NOT relaxed in exchange. It still covers everything this one cannot:
   * a row written before this rule existed, one restored from a backup, or one inserted by
   * something that is not this function.
   */
  if (safe.port !== WEBHOOK_PORT) throw new WebhookPortError();

  const existing = await prisma.webhookDestination.count({ where: { businessId: ctx.businessId } });
  if (existing >= MAX_DESTINATIONS_PER_BUSINESS) {
    throw new ConflictError(`A business may keep at most ${MAX_DESTINATIONS_PER_BUSINESS} destinations`);
  }

  const signingSecret = newSigningSecret();
  let endpointCipher: string;
  let signingSecretCipher: string;
  try {
    endpointCipher = encryptSecret(safe.href);
    signingSecretCipher = encryptSecret(signingSecret);
  } catch (e) {
    if (e instanceof EncryptionUnavailableError) throw new ConflictError(e.message);
    throw e;
  }

  try {
    const created = await prisma.$transaction(async (tx) => {
      const row = await tx.webhookDestination.create({
        data: {
          businessId: ctx.businessId,
          name: data.name,
          endpointHost: safe.host,
          endpointDigest: endpointDigest(ctx.businessId, safe.href),
          endpointCipher,
          signingSecretCipher,
          cipherAlgorithm: WebhookCipher.AES_256_GCM,
          cipherKeyVersion: CURRENT_KEY_VERSION,
          // The trigger insists on this too. Nothing is sent until the owner says so.
          state: WebhookDestinationState.DISABLED,
          secretIssuedAt: new Date(),
          createdByUserId: ctx.userId,
        },
        select: DESTINATION_SELECT,
      });

      await recordAudit(tx, {
        businessId: ctx.businessId,
        actorUserId: ctx.userId,
        action: AuditAction.WEBHOOK_DESTINATION_CREATED,
        entityType: "WebhookDestination",
        entityId: row.id,
        // The name and the HOST. **Never the URL, never the secret, never either ciphertext** — an
        // audit row is read by more people and kept far longer than the request that created it.
        metadata: { name: data.name, endpointHost: safe.host },
      });

      return row;
    });
    return { destination: toView(created, undefined), signingSecret };
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      // Name or endpoint; the message does not say which, for the same reason a coupon refusal
      // does not say which field collided.
      throw new ConflictError("That name or address is already in use", ConflictCode.NAME_TAKEN);
    }
    throw e;
  }
}

/** The lifecycle. `REVOKED` is terminal; the trigger enforces the same table. */
const TRANSITIONS: Readonly<Record<WebhookDestinationState, readonly WebhookDestinationState[]>> = {
  [WebhookDestinationState.DISABLED]: [WebhookDestinationState.ENABLED, WebhookDestinationState.REVOKED],
  [WebhookDestinationState.ENABLED]: [WebhookDestinationState.DISABLED, WebhookDestinationState.REVOKED],
  [WebhookDestinationState.REVOKED]: [],
};

export async function setDestinationState(
  ctx: TenantContext,
  destinationId: string,
  state: WebhookDestinationState,
): Promise<DestinationView> {
  requireWebhookOwner(ctx);
  const existing = await prisma.webhookDestination.findFirst({
    // businessId in the WHERE: another tenant's destination does not exist for this caller.
    where: { id: destinationId, businessId: ctx.businessId },
    select: { id: true, state: true },
  });
  if (!existing) throw new NotFoundError("Destination not found");
  if (!TRANSITIONS[existing.state].includes(state)) {
    throw new ConflictError(`A ${existing.state.toLowerCase()} destination cannot become ${state.toLowerCase()}`);
  }

  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.webhookDestination.update({
      where: { id: existing.id },
      data: { state },
      select: DESTINATION_SELECT,
    });
    await recordAudit(tx, {
      businessId: ctx.businessId,
      actorUserId: ctx.userId,
      action: AuditAction.WEBHOOK_DESTINATION_STATE_CHANGED,
      entityType: "WebhookDestination",
      entityId: existing.id,
      metadata: { from: existing.state, to: state },
    });
    return row;
  });
  const counts = await countsFor([updated.id]);
  return toView(updated, counts.get(updated.id));
}

/**
 * A new signing secret, shown once.
 *
 * The old value stops working the moment this commits, so the receiver has to be updated in the
 * same sitting — which the screen says before the owner presses it rather than afterwards.
 */
export async function rotateSecret(ctx: TenantContext, destinationId: string): Promise<CreatedDestination> {
  requireWebhookOwner(ctx);
  const existing = await prisma.webhookDestination.findFirst({
    where: { id: destinationId, businessId: ctx.businessId },
    select: { id: true, state: true },
  });
  if (!existing) throw new NotFoundError("Destination not found");
  if (existing.state === WebhookDestinationState.REVOKED) {
    throw new ConflictError("A revoked destination cannot be rotated");
  }

  const signingSecret = newSigningSecret();
  let signingSecretCipher: string;
  try {
    signingSecretCipher = encryptSecret(signingSecret);
  } catch (e) {
    if (e instanceof EncryptionUnavailableError) throw new ConflictError(e.message);
    throw e;
  }

  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.webhookDestination.update({
      where: { id: existing.id },
      // The trigger requires these two to move together: a rotated secret the owner was never shown
      // would be a row claiming a disclosure that did not happen.
      data: { signingSecretCipher, cipherKeyVersion: CURRENT_KEY_VERSION, secretIssuedAt: new Date() },
      select: DESTINATION_SELECT,
    });
    await recordAudit(tx, {
      businessId: ctx.businessId,
      actorUserId: ctx.userId,
      action: AuditAction.WEBHOOK_SECRET_ROTATED,
      entityType: "WebhookDestination",
      entityId: existing.id,
      // The row id and the key version. Never the secret, never its ciphertext.
      metadata: { cipherKeyVersion: CURRENT_KEY_VERSION },
    });
    return row;
  });
  const counts = await countsFor([updated.id]);
  return { destination: toView(updated, counts.get(updated.id)), signingSecret };
}

/**
 * Queue one fixed synthetic test delivery.
 *
 * It **queues**; it does not send. The worker sends, like everything else, because a request handler
 * that made an outbound call would be a till waiting on somebody else's server.
 *
 * The envelope describes no real event — see `testEnvelope`. A test that carried a recent redemption
 * would be a way to exfiltrate one by pressing a button.
 *
 * Never triggered automatically, by a schedule, or by another user's action: this is the only caller
 * and it requires an owner.
 */
export async function queueTestDelivery(ctx: TenantContext, destinationId: string): Promise<{ deliveryId: string }> {
  requireWebhookOwner(ctx);
  if (!webhooksConfigured()) {
    throw new ConflictError(new EncryptionUnavailableError("is not set").message);
  }
  const existing = await prisma.webhookDestination.findFirst({
    where: { id: destinationId, businessId: ctx.businessId },
    select: { id: true, state: true },
  });
  if (!existing) throw new NotFoundError("Destination not found");
  if (existing.state === WebhookDestinationState.REVOKED) {
    throw new ConflictError("A revoked destination cannot be tested");
  }

  /*
   * One test delivery in flight per destination, and no more.
   *
   * Not a nicety. `claimDue` takes ten rows per minute ACROSS EVERY BUSINESS, ordered by when they
   * became due, and a test delivery is created due immediately - so an owner who called this in a
   * loop would put thousands of their own rows at the front of a queue every other tenant shares.
   * Nothing would be exposed and nobody's delivery would be marked failed, but every other
   * business's webhooks would wait behind them for as long as the caller kept going. One tenant
   * must not be able to set another tenant's delivery latency.
   *
   * A destination that already has a test waiting does not need a second one: the button means
   * "check this address", and the first press is still checking it. Outstanding test deliveries are
   * therefore bounded by the number of destinations, which is itself bounded at
   * MAX_DESTINATIONS_PER_BUSINESS.
   *
   * **This count is advisory and is not what makes the rule true.** Two overlapping requests can
   * both run it, both find nothing, and both go on to insert. What serializes them is the partial
   * unique index `WebhookDelivery_one_pending_test_key` (migration 17): the second inserter blocks
   * on the first's uncommitted index entry and is refused when the first commits. The count is here
   * so the ordinary case - an owner pressing the button twice - costs one cheap query rather than a
   * transaction that has to roll back, and the `catch` below turns the index's refusal into exactly
   * the same answer for the caller that raced.
   */
  const waiting = await prisma.webhookDelivery.count({
    where: {
      destinationId: existing.id,
      businessId: ctx.businessId,
      isTest: true,
      status: WebhookDeliveryStatus.PENDING,
    },
  });
  if (waiting > 0) {
    throw new ConflictError("A test is already queued for this destination", ConflictCode.WEBHOOK_TEST_PENDING);
  }

  try {
    return await queueTestDeliveryRow(ctx, existing.id);
  } catch (e) {
    /*
     * The race, answered identically to the ordinary case.
     *
     * P2002 on this table means the partial unique index refused a second waiting test - the caller
     * lost a genuine concurrent insert. A 500 would be the wrong answer to a request that was
     * refused correctly, and "something went wrong" is the wrong sentence for "your first test is
     * still queued".
     *
     * The trigger's own `check_violation` arrives as a raw database error rather than P2002, so it
     * is matched on the sentence it raises - the one written in migration 17 and asserted by
     * `webhook-release-gate.test.ts`.
     */
    const raced =
      (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") ||
      (e instanceof Error && e.message.includes("a test is already queued for this destination"));
    if (raced) {
      throw new ConflictError("A test is already queued for this destination", ConflictCode.WEBHOOK_TEST_PENDING);
    }
    throw e;
  }
}

/** The write itself, kept separate so the refusal mapping above reads as one thought. */
async function queueTestDeliveryRow(ctx: TenantContext, destinationId: string): Promise<{ deliveryId: string }> {
  return prisma.$transaction(async (tx) => {
    const delivery = await tx.webhookDelivery.create({
      data: {
        businessId: ctx.businessId,
        destinationId,
        isTest: true,
        // Due immediately; the worker picks it up on its next pass.
        nextAttemptAt: new Date(),
      },
      select: { id: true },
    });
    await recordAudit(tx, {
      businessId: ctx.businessId,
      actorUserId: ctx.userId,
      action: AuditAction.WEBHOOK_TEST_QUEUED,
      entityType: "WebhookDestination",
      entityId: destinationId,
      // Two row ids. No URL, no host, no secret.
      metadata: { deliveryId: delivery.id },
    });
    return { deliveryId: delivery.id };
  });
}

/** One line of a destination's delivery history. Operational facts only. */
export interface DeliveryView {
  id: string;
  isTest: boolean;
  status: WebhookDeliveryStatus;
  attemptCount: number;
  lastErrorClass: string;
  lastHttpStatus: number | null;
  lastAttemptAt: Date | null;
  createdAt: Date;
}

export const DELIVERY_PAGE_SIZE = 20;

export async function listDeliveries(ctx: TenantContext, destinationId: string): Promise<DeliveryView[]> {
  requireWebhookOwner(ctx);
  const destination = await prisma.webhookDestination.findFirst({
    where: { id: destinationId, businessId: ctx.businessId },
    select: { id: true },
  });
  if (!destination) throw new NotFoundError("Destination not found");

  return prisma.webhookDelivery.findMany({
    where: { destinationId: destination.id, businessId: ctx.businessId },
    orderBy: { createdAt: "desc" },
    take: DELIVERY_PAGE_SIZE,
    // Listed literally. There is no body, header or URL column to leave out.
    select: {
      id: true,
      isTest: true,
      status: true,
      attemptCount: true,
      lastErrorClass: true,
      lastHttpStatus: true,
      lastAttemptAt: true,
      createdAt: true,
    },
  });
}
