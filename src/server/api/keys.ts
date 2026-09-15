import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { ApiKeyState, ApiScope, MembershipRole, Permission, Prisma } from "@prisma/client";
import { z } from "zod";
import { AuditAction, recordAudit } from "../audit/audit";
import { prisma } from "../db";
import { ConflictCode, ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../errors";
import { requirePermission, type TenantContext } from "../tenant/context";

/**
 * API keys: what an owner creates, and the rules around who may.
 *
 * ## Owner only, and only the owner
 *
 * The same bar as a webhook destination, for the same reason. A key is a standing grant of read
 * access to this business's data, valid for ninety days, usable from anywhere, by anyone holding
 * it. A manager who could mint one could arrange for the business's event history to be read
 * continuously without the owner ever seeing a screen.
 *
 * ## The value is shown once
 *
 * `createKey` and `rotateKey` are the only functions that ever return a raw key, and they return it
 * from the value they just generated — **never from a column**, because the column holds a digest
 * and there is no way back. An owner who loses a key rotates it.
 *
 * This is the third bearer capability in this codebase built the same way, after share links and
 * coupon codes. The digest is unsalted, which is correct here and would be wrong for a coupon:
 * 256 bits of `randomBytes` has no dictionary to precompute, and authentication has to find the row
 * from the value alone in one indexed lookup before it knows which business is involved.
 *
 * ## What is NOT here
 *
 * No reveal. No rename — a key's label is frozen at creation, so there is no operation that can
 * make an owner's list disagree with what they were shown. No delete: a revoked key keeps its row,
 * because the row is the record that the credential existed.
 */

/** 256 bits. What makes an unsalted digest safe and guessing hopeless. */
export const KEY_BYTES = 32;

/** How long a key lives. The owner-approved v1 figure. */
export const KEY_TTL_DAYS = 90;

/**
 * How many ACTIVE keys one business may hold.
 *
 * Bounded because each is an independent standing grant, and because an unbounded number of them is
 * an unbounded number of things to revoke when something goes wrong. Five matches
 * `MAX_DESTINATIONS_PER_BUSINESS`.
 *
 * **This constant is not what enforces it.** `ApiKey_businessId_activeSlot_key` — a partial unique
 * index over five slots — is, and it holds against a direct writer and under concurrency. The
 * constant and the index must agree; `tests/integration/api-key-integrity.test.ts` asserts they do.
 */
export const MAX_ACTIVE_KEYS_PER_BUSINESS = 5;

const MAX_NAME = 60;

/** `wpk_` then eight hex characters. Public, and not part of the secret. */
export const KEY_PREFIX_PATTERN = /^wpk_[0-9a-f]{8}$/;

/** Owner only. A manager holds VIEW_INTEGRATIONS and may read history; minting a credential is not that. */
function requireApiKeyOwner(ctx: TenantContext): void {
  requirePermission(ctx, Permission.EDIT_INTEGRATIONS);
  if (ctx.role !== MembershipRole.OWNER) {
    throw new ForbiddenError("Only the owner may manage API keys");
  }
}

/**
 * The digest of a raw key.
 *
 * Exported because authentication needs it and tests assert on it. Takes the WHOLE key string,
 * prefix included, so a value with the right secret half and a different prefix is a different key.
 */
export function keyDigest(rawKey: string): string {
  return createHash("sha256").update(rawKey, "utf8").digest("hex");
}

/** Constant-time digest comparison, for the one place that compares two of them. */
export function digestsMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** A freshly minted key: the public identifier, and the value that is shown once. */
interface MintedKey {
  prefix: string;
  raw: string;
  digest: string;
}

function mint(): MintedKey {
  // Four public bytes for recognition, thirty-two secret ones. The prefix is generated separately
  // so no part of the secret is ever displayed in a list.
  const prefix = `wpk_${randomBytes(4).toString("hex")}`;
  const raw = `${prefix}_${randomBytes(KEY_BYTES).toString("base64url")}`;
  return { prefix, raw, digest: keyDigest(raw) };
}

/** What an owner may see about a key. **The digest is deliberately not in this list.** */
export interface ApiKeyView {
  id: string;
  name: string;
  keyPrefix: string;
  scope: ApiScope;
  state: ApiKeyState;
  issuedAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
  /** Derived, never stored: a key past its expiry authenticates nothing whatever its state says. */
  usable: boolean;
}

/** Listed literally. There is deliberately no `keyDigest` here. */
const KEY_SELECT = {
  id: true,
  name: true,
  keyPrefix: true,
  scope: true,
  state: true,
  issuedAt: true,
  expiresAt: true,
  revokedAt: true,
  lastUsedAt: true,
} as const;

type KeyRow = Prisma.ApiKeyGetPayload<{ select: typeof KEY_SELECT }>;

function toView(row: KeyRow, now: Date): ApiKeyView {
  return { ...row, usable: row.state === ApiKeyState.ACTIVE && row.expiresAt > now };
}

/** The one shape that carries a secret. Returned, never stored, never logged. */
export interface CreatedApiKey {
  key: ApiKeyView;
  /** **Shown once.** No route, service or column can produce it again. */
  apiKey: string;
}

const createSchema = z.strictObject({
  name: z.string().trim().min(1).max(MAX_NAME),
});
export type CreateApiKeyInput = z.input<typeof createSchema>;

/**
 * Release the slots of keys whose expiry has passed.
 *
 * Lazy rather than scheduled, on purpose: a job that flips states is a job that can be down, and
 * the security question does not depend on it — authentication checks `expiresAt` directly, so an
 * expired key is refused whether or not this has run. What this actually buys is that a business
 * whose five keys all lapsed is not locked out of issuing a sixth.
 */
async function releaseExpiredSlots(tx: Prisma.TransactionClient, businessId: string, now: Date): Promise<void> {
  await tx.apiKey.updateMany({
    where: { businessId, state: ApiKeyState.ACTIVE, expiresAt: { lte: now } },
    data: { state: ApiKeyState.EXPIRED, activeSlot: null },
  });
}

/**
 * A free slot, or null when the business is at its ceiling.
 *
 * **Chosen at random among the free ones**, not lowest-first. Lowest-first means every concurrent
 * caller picks the same number and then queues on one index entry, which turns a rare collision
 * into a guaranteed one: with five slots free and five callers, all five contend for slot 1 and
 * four of them wait. Choosing at random spreads them across the free slots, so the common case
 * takes nobody's lock at all.
 *
 * The number is not meaningful outside the ceiling and is never shown to anybody, so there is
 * nothing to prefer about a low one.
 */
async function freeSlot(tx: Prisma.TransactionClient, businessId: string): Promise<number | null> {
  const taken = await tx.apiKey.findMany({
    where: { businessId, activeSlot: { not: null } },
    select: { activeSlot: true },
  });
  const used = new Set(taken.map((row) => row.activeSlot));
  const free: number[] = [];
  for (let slot = 1; slot <= MAX_ACTIVE_KEYS_PER_BUSINESS; slot += 1) {
    if (!used.has(slot)) free.push(slot);
  }
  if (free.length === 0) return null;
  return free[randomInt(free.length)];
}

/**
 * Did this attempt lose a race for a slot, rather than hit a real refusal?
 *
 * Two shapes, because PostgreSQL reports contention in two ways depending on timing. The loser of a
 * committed race gets a unique violation on the slot index. A caller that was still WAITING on
 * another transaction's index entry when its own interactive transaction ran out of time gets a
 * transaction error instead - the same situation, reported from the other end.
 *
 * Both mean "that slot went to somebody else"; neither means the ceiling was reached. Treating the
 * second as fatal was a real defect found by the twelve-way concurrency test: the safety property
 * held, but an owner could be shown a transaction error instead of a key.
 */
function isSlotRace(e: unknown): boolean {
  if (e instanceof Prisma.PrismaClientKnownRequestError) {
    if (e.code === "P2002") return JSON.stringify(e.meta ?? {}).includes("activeSlot");
    // P2034 write conflict / deadlock, P2028 transaction API error - both are contention here.
    if (e.code === "P2034" || e.code === "P2028") return true;
  }
  return false;
}

async function issue(
  ctx: TenantContext,
  name: string,
  rotatedFromId: string | null,
): Promise<CreatedApiKey> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + KEY_TTL_DAYS * 24 * 60 * 60 * 1000);

  /*
   * One retry per slot, at most.
   *
   * The `freeSlot` read is advisory: two owners issuing at the same moment can both pick slot 3,
   * and the partial unique index refuses the loser. That refusal is not an error to report — a slot
   * is still free — so the loser looks again. What it must NOT do is loop forever, so it tries at
   * most once per slot and then reports the ceiling honestly.
   */
  for (let attempt = 0; attempt < MAX_ACTIVE_KEYS_PER_BUSINESS; attempt += 1) {
    const minted = mint();
    try {
      return await prisma.$transaction(async (tx) => {
        await releaseExpiredSlots(tx, ctx.businessId, now);
        const slot = await freeSlot(tx, ctx.businessId);
        if (slot === null) {
          throw new ConflictError(
            `A business may hold at most ${MAX_ACTIVE_KEYS_PER_BUSINESS} active API keys`,
            ConflictCode.API_KEY_LIMIT_REACHED,
          );
        }

        if (rotatedFromId) {
          // Revoke the predecessor in the SAME transaction, so a rotation never leaves two live
          // keys behind — and never leaves none if the insert fails.
          const revoked = await tx.apiKey.updateMany({
            where: { id: rotatedFromId, businessId: ctx.businessId, state: ApiKeyState.ACTIVE },
            data: { state: ApiKeyState.REVOKED, activeSlot: null },
          });
          if (revoked.count === 0) throw new NotFoundError("API key not found");
        }

        const row = await tx.apiKey.create({
          data: {
            businessId: ctx.businessId,
            name,
            keyPrefix: minted.prefix,
            keyDigest: minted.digest,
            scope: ApiScope.EVENTS_READ,
            activeSlot: slot,
            // The trigger overwrites this; supplied because the column is NOT NULL.
            issuedAt: now,
            expiresAt,
            rotatedFromId,
            createdByUserId: ctx.userId,
          },
          select: KEY_SELECT,
        });

        await recordAudit(tx, {
          businessId: ctx.businessId,
          actorUserId: ctx.userId,
          action: rotatedFromId ? AuditAction.API_KEY_ROTATED : AuditAction.API_KEY_CREATED,
          entityType: "ApiKey",
          entityId: row.id,
          /*
           * The name and the PUBLIC prefix. **Never the key and never the digest** — an audit row is
           * read by more people and kept far longer than the request that created it, and a digest
           * in one is a target for anybody who later obtains a candidate value.
           */
          metadata: { name, keyPrefix: row.keyPrefix, ...(rotatedFromId ? { rotatedFromId } : {}) },
        });

        return { key: toView(row, now), apiKey: minted.raw };
      });
    } catch (e) {
      if (isSlotRace(e)) continue;
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        // The only other unique constraints are the name and the digest. A digest collision at 256
        // bits is not a thing that happens; a duplicate name is.
        throw new ConflictError("That name is already in use", ConflictCode.NAME_TAKEN);
      }
      throw e;
    }
  }

  throw new ConflictError(
    `A business may hold at most ${MAX_ACTIVE_KEYS_PER_BUSINESS} active API keys`,
    ConflictCode.API_KEY_LIMIT_REACHED,
  );
}

export async function createKey(ctx: TenantContext, input: CreateApiKeyInput): Promise<CreatedApiKey> {
  requireApiKeyOwner(ctx);
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError("Invalid API key", parsed.error.issues);
  return issue(ctx, parsed.data.name, null);
}

/**
 * Replace a key: revoke the old one and issue a new one, in one transaction.
 *
 * The old value stops working the instant this commits. There is no grace period and no overlap
 * window — a rotation that left the old key working would be a rotation that did not rotate
 * anything, and an owner who needs both at once can create a second key instead.
 */
export async function rotateKey(ctx: TenantContext, keyId: string, name: string): Promise<CreatedApiKey> {
  requireApiKeyOwner(ctx);
  const parsed = createSchema.safeParse({ name });
  if (!parsed.success) throw new ValidationError("Invalid API key", parsed.error.issues);

  const existing = await prisma.apiKey.findFirst({
    // businessId in the WHERE: another tenant's key does not exist for this caller.
    where: { id: keyId, businessId: ctx.businessId },
    select: { id: true, state: true },
  });
  if (!existing) throw new NotFoundError("API key not found");
  if (existing.state !== ApiKeyState.ACTIVE) {
    throw new ConflictError("Only an active key can be rotated", ConflictCode.API_KEY_NOT_ACTIVE);
  }
  return issue(ctx, parsed.data.name, existing.id);
}

/** End a key now. Exactly once: the trigger refuses a second revocation. */
export async function revokeKey(ctx: TenantContext, keyId: string): Promise<ApiKeyView> {
  requireApiKeyOwner(ctx);
  const now = new Date();

  const existing = await prisma.apiKey.findFirst({
    where: { id: keyId, businessId: ctx.businessId },
    select: { id: true, state: true },
  });
  if (!existing) throw new NotFoundError("API key not found");
  if (existing.state === ApiKeyState.REVOKED) {
    throw new ConflictError("That key is already revoked", ConflictCode.API_KEY_NOT_ACTIVE);
  }

  return prisma.$transaction(async (tx) => {
    const moved = await tx.apiKey.updateMany({
      // The state in the WHERE, so two concurrent revocations cannot both succeed: the second
      // matches zero rows.
      where: { id: existing.id, businessId: ctx.businessId, state: { not: ApiKeyState.REVOKED } },
      data: { state: ApiKeyState.REVOKED, activeSlot: null },
    });
    if (moved.count === 0) {
      throw new ConflictError("That key is already revoked", ConflictCode.API_KEY_NOT_ACTIVE);
    }

    await recordAudit(tx, {
      businessId: ctx.businessId,
      actorUserId: ctx.userId,
      action: AuditAction.API_KEY_REVOKED,
      entityType: "ApiKey",
      entityId: existing.id,
      metadata: {},
    });

    const row = await tx.apiKey.findFirstOrThrow({ where: { id: existing.id }, select: KEY_SELECT });
    return toView(row, now);
  });
}

/** Every key this business has ever held, newest first. Metadata only. */
export async function listKeys(ctx: TenantContext): Promise<ApiKeyView[]> {
  requireApiKeyOwner(ctx);
  const now = new Date();
  const rows = await prisma.apiKey.findMany({
    where: { businessId: ctx.businessId },
    orderBy: { createdAt: "desc" },
    select: KEY_SELECT,
  });
  return rows.map((row) => toView(row, now));
}
