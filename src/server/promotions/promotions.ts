import { MembershipRole, Permission, Prisma, PromotionState, RedemptionEntry } from "@prisma/client";
import { createHash } from "node:crypto";
import { z } from "zod";
import { AuditAction, recordAudit } from "../audit/audit";
import { prisma } from "../db";
import { ConflictCode, ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../errors";
import { requirePermission, type TenantContext } from "../tenant/context";
import { codeDigest, digestsMatch, isUsableCode, MAX_CODE_INPUT, newCodeSalt } from "./codes";

/**
 * Promotions: the definition a merchant writes, and the lifecycle they drive.
 *
 * ## What a promotion is not
 *
 * There is no amount, percentage, currency, tax, invoice or total here, and no code path that
 * touches a balance. `benefitDescription` is the merchant's own sentence — "a free espresso" — and
 * nothing parses it. `docs/PROMOTIONS-CAPABILITY-MATRIX.md` was written before this file to make
 * that a constraint rather than a description.
 *
 * ## The code is written once and never read back
 *
 * Only a salted digest is stored. **A merchant who forgets their own code cannot recover it** — they
 * expire the promotion and make another. That is a real consequence of not storing it, and the
 * screen says so at the moment of creation rather than leaving it to be discovered.
 *
 * ## Who may do what
 *
 * Owner or manager, for everything in this file. A cashier redeems a code a customer presents; they
 * do not see the list of live promotions, because a list of live codes on a till screen is a list of
 * codes to hand out.
 */

/** A business may keep this many promotions. Bounded because redemption walks the candidates. */
export const MAX_PROMOTIONS_PER_BUSINESS = 200;

const MAX_NAME = 80;
const MAX_BENEFIT = 200;

/**
 * "Autumn offer", "autumn offer" and "  Autumn  offer " are one promotion, as for segments.
 *
 * **This value is advisory.** `walaaplus_promotion_guard` recomputes it from the name on every
 * insert and update and overwrites whatever the application sent, so the column is canonical even
 * if this function and PostgreSQL disagree — and they can: PostgreSQL's `\s` does not match U+00A0,
 * which arrives whenever a merchant pastes a name out of a word processor, and the two take
 * different views of dotted capital I. The whitespace class here is written out to match
 * PostgreSQL's rather than relying on JavaScript's wider one, and `toLowerCase` is used rather than
 * `toLocaleLowerCase` so a server running under a Turkish locale cannot quietly produce a different
 * answer from the database.
 */
export function normalizePromotionName(name: string): string {
  return name.replace(/[ \t\n\r\f\v]+/g, " ").trim().toLowerCase();
}

/**
 * The advisory-lock key that serialises promotion CREATION for one business.
 *
 * Two managers creating the same code at the same moment both read "no duplicate", both mint their
 * own salt, and both insert — and the unique index on `(businessId, codeDigest)` cannot see it,
 * because two salts produce two digests. That is the direct cost of salting, and a lock is what
 * pays it.
 *
 * **The key is derived from the business alone, never from the code.** Locking per code would mean
 * a number derived from a short human-chosen secret reaching PostgreSQL, where it is visible in
 * `pg_locks` and in any statement log for as long as it is held; sixty-four bits of a hash over a
 * six-character code is not a secret. Locking per business gives up nothing worth having: creating
 * a promotion is a manager pressing a button a handful of times a year, so the contention this adds
 * is not measurable, and the serialisation it buys is strictly wider than the one required.
 *
 * The key is ephemeral and is never stored in any column.
 */
const CREATE_LOCK_NAMESPACE = "walaaplus:promotion-create:v1";

export function promotionCreateLockKey(businessId: string): bigint {
  return createHash("sha256")
    .update(`${CREATE_LOCK_NAMESPACE}:${businessId}`, "utf8")
    .digest()
    .readBigInt64BE(0);
}

/** Owner and manager only. A promotion is a commercial decision, not counter work. */
function requirePromotionManager(ctx: TenantContext): void {
  requirePermission(ctx, Permission.EDIT_TEMPLATES);
  if (ctx.role !== MembershipRole.OWNER && ctx.role !== MembershipRole.MANAGER) {
    throw new ForbiddenError("Only an owner or a manager may manage promotions");
  }
}

export interface PromotionView {
  id: string;
  name: string;
  benefitDescription: string;
  state: PromotionState;
  startsAt: Date | null;
  endsAt: Date | null;
  totalLimit: number | null;
  perCustomerLimit: number | null;
  createdAt: Date;
  /** Redemptions that currently stand — voided ones are not counted. */
  redeemed: number;
  /** How many have been withdrawn. Shown because the difference is a real operational fact. */
  voided: number;
  /** Null when there is no total limit. */
  remaining: number | null;
}

const PROMOTION_SELECT = {
  id: true,
  name: true,
  benefitDescription: true,
  state: true,
  startsAt: true,
  endsAt: true,
  totalLimit: true,
  perCustomerLimit: true,
  createdAt: true,
  // The COUNT, never the codes and never who redeemed. There is deliberately no select anywhere
  // that reads `codeDigest` or `codeSalt` out to a caller.
  _count: { select: { redemptions: true } },
} satisfies Prisma.PromotionSelect;

/**
 * Redemption counts for a set of promotions, in two queries rather than per row.
 *
 * Counted over redemptions that have not been voided, because a void here means "that did not
 * happen" — see the note in the migration on why this differs from `ReferralAttribution`.
 */
async function countsFor(promotionIds: string[]): Promise<Map<string, { redeemed: number; voided: number }>> {
  const counts = new Map<string, { redeemed: number; voided: number }>();
  if (promotionIds.length === 0) return counts;

  const rows = await prisma.promotionRedemption.groupBy({
    by: ["promotionId", "entry"],
    where: { promotionId: { in: promotionIds } },
    _count: { _all: true },
  });
  for (const row of rows) {
    const current = counts.get(row.promotionId) ?? { redeemed: 0, voided: 0 };
    if (row.entry === RedemptionEntry.REDEEMED) current.redeemed = row._count._all;
    else current.voided = row._count._all;
    counts.set(row.promotionId, current);
  }
  return counts;
}

function toView(
  row: Prisma.PromotionGetPayload<{ select: typeof PROMOTION_SELECT }>,
  counts: { redeemed: number; voided: number } | undefined,
): PromotionView {
  const redeemed = Math.max((counts?.redeemed ?? 0) - (counts?.voided ?? 0), 0);
  return {
    id: row.id,
    name: row.name,
    benefitDescription: row.benefitDescription,
    state: row.state,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    totalLimit: row.totalLimit,
    perCustomerLimit: row.perCustomerLimit,
    createdAt: row.createdAt,
    redeemed,
    voided: counts?.voided ?? 0,
    remaining: row.totalLimit === null ? null : Math.max(row.totalLimit - redeemed, 0),
  };
}

export async function listPromotions(ctx: TenantContext): Promise<PromotionView[]> {
  requirePromotionManager(ctx);
  const rows = await prisma.promotion.findMany({
    where: { businessId: ctx.businessId },
    select: PROMOTION_SELECT,
    orderBy: [{ state: "asc" }, { createdAt: "desc" }],
    take: MAX_PROMOTIONS_PER_BUSINESS,
  });
  const counts = await countsFor(rows.map((row) => row.id));
  return rows.map((row) => toView(row, counts.get(row.id)));
}

const createSchema = z.strictObject({
  name: z.string().trim().min(1).max(MAX_NAME),
  benefitDescription: z.string().trim().min(1).max(MAX_BENEFIT),
  code: z.string().trim().min(1).max(MAX_CODE_INPUT),
  startsAt: z.date().optional(),
  endsAt: z.date().optional(),
  totalLimit: z.number().int().positive().max(1_000_000).optional(),
  perCustomerLimit: z.number().int().positive().max(1_000).optional(),
});
export type CreatePromotionInput = z.input<typeof createSchema>;

export async function createPromotion(ctx: TenantContext, input: CreatePromotionInput): Promise<PromotionView> {
  requirePromotionManager(ctx);
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError("Invalid promotion", parsed.error.issues);
  const data = parsed.data;

  if (!isUsableCode(data.code)) {
    throw new ValidationError("A code needs at least four letters or digits");
  }
  if (data.startsAt && data.endsAt && data.startsAt >= data.endsAt) {
    throw new ValidationError("A promotion cannot end before it starts");
  }

  const salt = newCodeSalt();
  try {
    const created = await prisma.$transaction(async (tx) => {
      /*
       * Everything that decides whether this promotion may exist happens AFTER this line.
       *
       * The duplicate check has to read every existing salt and hash the candidate against each of
       * them, which means it is a read followed by a decision followed by a write — and two
       * managers submitting the same code at the same moment would both read "no duplicate" and
       * both write. The unique index cannot catch that, because their salts differ and so do their
       * digests. A lock is the only thing that can, and it has to be taken before the read rather
       * than around the write.
       *
       * `pg_advisory_xact_lock` releases on commit or rollback, so no path leaks it. See
       * `promotionCreateLockKey` for why the key names the business and not the code.
       */
      // Called in FROM rather than in SELECT: the function returns `void`, and Prisma cannot
      // deserialise a void column.
      await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(${promotionCreateLockKey(ctx.businessId)}::bigint)`;

      const existing = await tx.promotion.findMany({
        where: { businessId: ctx.businessId },
        select: { codeSalt: true, codeDigest: true },
        take: MAX_PROMOTIONS_PER_BUSINESS,
      });
      if (existing.length >= MAX_PROMOTIONS_PER_BUSINESS) {
        throw new ConflictError(`A business may keep at most ${MAX_PROMOTIONS_PER_BUSINESS} promotions`);
      }

      /*
       * Duplicate codes, caught by walking the existing salts — because a per-promotion salt means
       * the unique index on `(businessId, codeDigest)` CANNOT catch one. Two promotions with the
       * same code hash differently, and redemption would then match whichever candidate it happened
       * to reach first, which is a coupon that works or does not depending on insertion order.
       *
       * That is the price of the salt, and it is paid here rather than discovered at a till. The
       * index stays as a backstop against the impossible case of a repeated salt.
       *
       * **Every** promotion is checked, including expired ones. Reusing an expired promotion's code
       * would make every copy already in the world start working again for a different offer, which
       * is precisely what making EXPIRED terminal exists to prevent.
       */
      if (existing.some((row) => digestsMatch(row.codeDigest, codeDigest(row.codeSalt, ctx.businessId, data.code)))) {
        throw new ConflictError("That name or code is already in use", ConflictCode.NAME_TAKEN);
      }

      const promotion = await tx.promotion.create({
        data: {
          businessId: ctx.businessId,
          name: data.name,
          // Advisory; `promotion_guard` recomputes it. See `normalizePromotionName`.
          normalizedName: normalizePromotionName(data.name),
          benefitDescription: data.benefitDescription,
          codeDigest: codeDigest(salt, ctx.businessId, data.code),
          codeSalt: salt,
          // The trigger insists on this too. A promotion that could be created already live would
          // skip the only moment a merchant reads back what they typed.
          state: PromotionState.DRAFT,
          startsAt: data.startsAt ?? null,
          endsAt: data.endsAt ?? null,
          totalLimit: data.totalLimit ?? null,
          perCustomerLimit: data.perCustomerLimit ?? null,
          createdByUserId: ctx.userId,
        },
        select: PROMOTION_SELECT,
      });

      await recordAudit(tx, {
        businessId: ctx.businessId,
        actorUserId: ctx.userId,
        action: AuditAction.PROMOTION_CREATED,
        entityType: "Promotion",
        entityId: promotion.id,
        /*
         * The name and the limits. **Never the code, and never its digest or salt** — an audit row
         * is read by more people and kept far longer than the request that carried the code, and a
         * digest in a log is still a way to confirm a guess at a short human-chosen string.
         */
        metadata: {
          name: data.name,
          totalLimit: data.totalLimit ?? null,
          perCustomerLimit: data.perCustomerLimit ?? null,
        },
      });

      return promotion;
    });
    return toView(created, undefined);
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      /*
       * Either the name or the code collided, and the message does not say which. Telling a manager
       * "that code is already in use" would let anybody with a staff session enumerate their own
       * business's codes one guess at a time, which is a smaller problem than a public oracle and
       * still not one worth having.
       */
      throw new ConflictError("That name or code is already in use", ConflictCode.NAME_TAKEN);
    }
    throw e;
  }
}

const updateSchema = z.strictObject({
  name: z.string().trim().min(1).max(MAX_NAME).optional(),
  benefitDescription: z.string().trim().min(1).max(MAX_BENEFIT).optional(),
  startsAt: z.union([z.date(), z.null()]).optional(),
  endsAt: z.union([z.date(), z.null()]).optional(),
  totalLimit: z.union([z.number().int().positive().max(1_000_000), z.null()]).optional(),
  perCustomerLimit: z.union([z.number().int().positive().max(1_000), z.null()]).optional(),
});
export type UpdatePromotionInput = z.input<typeof updateSchema>;

/**
 * Change what a promotion offers, or when, or how often.
 *
 * **The code is not here**, and the trigger refuses one anyway. Rotating a code under a live
 * promotion silently invalidates every copy already printed, handed out or written on a board; a
 * merchant who wants a different code expires this promotion and makes another.
 */
export async function updatePromotion(
  ctx: TenantContext,
  promotionId: string,
  input: UpdatePromotionInput,
): Promise<PromotionView> {
  requirePromotionManager(ctx);
  const parsed = updateSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError("Invalid promotion", parsed.error.issues);
  const data = parsed.data;

  const existing = await prisma.promotion.findFirst({
    // businessId in the WHERE: another tenant's promotion id does not exist for this caller.
    where: { id: promotionId, businessId: ctx.businessId },
    select: { id: true, state: true, startsAt: true, endsAt: true },
  });
  if (!existing) throw new NotFoundError("Promotion not found");
  if (existing.state === PromotionState.EXPIRED) {
    throw new ConflictError("An expired promotion cannot be edited");
  }

  const startsAt = data.startsAt === undefined ? existing.startsAt : data.startsAt;
  const endsAt = data.endsAt === undefined ? existing.endsAt : data.endsAt;
  if (startsAt && endsAt && startsAt >= endsAt) throw new ValidationError("A promotion cannot end before it starts");

  try {
    const updated = await prisma.$transaction(async (tx) => {
      const promotion = await tx.promotion.update({
        where: { id: existing.id },
        data: {
          ...(data.name !== undefined ? { name: data.name, normalizedName: normalizePromotionName(data.name) } : {}),
          ...(data.benefitDescription !== undefined ? { benefitDescription: data.benefitDescription } : {}),
          ...(data.startsAt !== undefined ? { startsAt: data.startsAt } : {}),
          ...(data.endsAt !== undefined ? { endsAt: data.endsAt } : {}),
          ...(data.totalLimit !== undefined ? { totalLimit: data.totalLimit } : {}),
          ...(data.perCustomerLimit !== undefined ? { perCustomerLimit: data.perCustomerLimit } : {}),
        },
        select: PROMOTION_SELECT,
      });
      await recordAudit(tx, {
        businessId: ctx.businessId,
        actorUserId: ctx.userId,
        action: AuditAction.PROMOTION_UPDATED,
        entityType: "Promotion",
        entityId: existing.id,
        metadata: { fields: Object.keys(data) },
      });
      return promotion;
    });
    const counts = await countsFor([updated.id]);
    return toView(updated, counts.get(updated.id));
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      throw new ConflictError("That name or code is already in use", ConflictCode.NAME_TAKEN);
    }
    throw e;
  }
}

/**
 * The lifecycle a merchant drives.
 *
 *   DRAFT   → ACTIVE | EXPIRED
 *   ACTIVE  → PAUSED | EXPIRED
 *   PAUSED  → ACTIVE | EXPIRED
 *   EXPIRED → nothing
 *
 * `EXPIRED` is terminal on purpose. Reviving one would silently re-honour every code already out in
 * the world, including the ones a merchant expired a promotion specifically to stop honouring. The
 * same table is enforced by `promotion_guard`, so this is the readable copy rather than the only
 * one.
 */
const TRANSITIONS: Readonly<Record<PromotionState, readonly PromotionState[]>> = {
  [PromotionState.DRAFT]: [PromotionState.ACTIVE, PromotionState.EXPIRED],
  [PromotionState.ACTIVE]: [PromotionState.PAUSED, PromotionState.EXPIRED],
  [PromotionState.PAUSED]: [PromotionState.ACTIVE, PromotionState.EXPIRED],
  [PromotionState.EXPIRED]: [],
};

export async function setPromotionState(
  ctx: TenantContext,
  promotionId: string,
  state: PromotionState,
): Promise<PromotionView> {
  requirePromotionManager(ctx);

  const existing = await prisma.promotion.findFirst({
    where: { id: promotionId, businessId: ctx.businessId },
    select: { id: true, state: true },
  });
  if (!existing) throw new NotFoundError("Promotion not found");
  if (existing.state === state) {
    const counts = await countsFor([existing.id]);
    const row = await prisma.promotion.findUniqueOrThrow({ where: { id: existing.id }, select: PROMOTION_SELECT });
    return toView(row, counts.get(existing.id));
  }
  if (!TRANSITIONS[existing.state].includes(state)) {
    throw new ConflictError(`A promotion cannot go from ${existing.state} to ${state}`);
  }

  const updated = await prisma.$transaction(async (tx) => {
    const promotion = await tx.promotion.update({
      where: { id: existing.id },
      data: { state },
      select: PROMOTION_SELECT,
    });
    await recordAudit(tx, {
      businessId: ctx.businessId,
      actorUserId: ctx.userId,
      action: AuditAction.PROMOTION_STATE_CHANGED,
      entityType: "Promotion",
      entityId: existing.id,
      metadata: { from: existing.state, to: state },
    });
    return promotion;
  });
  const counts = await countsFor([updated.id]);
  return toView(updated, counts.get(updated.id));
}
