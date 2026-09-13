import { CardType, Permission, Prisma, ProgramVersionStatus, TemplateStatus } from "@prisma/client";
import { z } from "zod";
import { AuditAction, recordAudit } from "../audit/audit";
import { CONTENDED_TX, prisma, type Tx } from "../db";
import { ConflictCode, ConflictError, NotFoundError, ValidationError } from "../errors";
import { requirePermission, type TenantContext } from "../tenant/context";
import { assertLocationsBelongToBusiness } from "./available-locations";
import { isStampMechanics, parseStampMechanics, readStampMechanics, type StampMechanics } from "./mechanics";
import { isPointsMechanics, parsePointsMechanics, readPointsMechanics, type PointsMechanics } from "./points-mechanics";
import { MAX_REWARD_TIERS, rewardTierSchema, type RewardTierInput } from "./programs";

/**
 * The program-version lifecycle: draft, review, publish.
 *
 * ## The problem this solves
 *
 * A live program cannot be edited. That is not a limitation to be worked around — it is the
 * guarantee the whole product rests on. `CustomerCard.programVersionId` pins the exact rules a card
 * was sold under, `walaaplus_protect_program_version` refuses to change the mechanics of anything
 * that has left DRAFT, and `reward_tier_protect` does the same for its rewards. A customer holding
 * a card for "8 stamps, free coffee" keeps that card even if the café moves to 10 stamps tomorrow.
 *
 * Until now the consequence was that a merchant who mistyped a threshold had to create a whole new
 * program, and a merchant opening a second branch could not open it to a program that already
 * existed. Prompt 2 recorded both as missing contracts rather than reaching past the service layer
 * from a screen. This module is that contract, and it changes none of the guarantees above.
 *
 * ## How a change reaches customers
 *
 * ```
 *   v1 ACTIVE  ──create draft──▶  v2 DRAFT  ──edit──▶  v2 DRAFT  ──publish──▶  v2 ACTIVE
 *       │                             │                                            │
 *       │                          discard                                  v1 RETIRED
 *       ▼                                                                          │
 *   cards keep v1 forever ◀───────────────────────────────────────────────────────┘
 * ```
 *
 * Publishing is **one transaction under the template's row lock**: retire the live version, activate
 * the draft, write the audit row. `ProgramVersion_one_active_per_template` is the backstop — two
 * publishes racing cannot both leave an ACTIVE row even if the lock were somehow bypassed — and
 * `ProgramVersion_one_draft_per_template` is the same idea for drafts.
 *
 * **No card is touched, ever.** There is no UPDATE against `CustomerCard` anywhere in this file.
 * Existing cards keep their `programVersionId`, and therefore their thresholds, their rewards,
 * their locations and their limits. New cards issued after publication resolve the template's
 * ACTIVE version and pin the new one. That is the entire behaviour change.
 *
 * ## Stamps and points stay two programs
 *
 * A draft inherits the template's `cardType` and is validated with that card type's contract. A
 * POINTS draft is parsed by `parsePointsMechanics` and carries explicit reward tiers; a STAMP draft
 * is parsed by `parseStampMechanics` and its single tier is DERIVED from the mechanics, exactly as
 * `createStampProgram` derives it. Neither can be handed the other's shape: the contracts are
 * discriminated on `kind`, and `program_template_protect_card_type` refuses to move a template
 * between them once a version is live.
 */

/** A program keeps this many versions of history before the list is paged. Generous for a decade. */
export const MAX_VERSIONS_LISTED = 50;

export interface VersionTier {
  name: string;
  description: string | null;
  /** Points for a POINTS program; the stamp threshold for a STAMP one. */
  requiredPoints: number;
  rewardValueMinor: number | null;
  usageLimit: number | null;
}

export interface ProgramVersionSummary {
  /** Opaque to the UI: screens address a version by its NUMBER, never by this. */
  id: string;
  versionNumber: number;
  status: ProgramVersionStatus;
  createdAt: Date;
  activatedAt: Date | null;
  /**
   * When this version stopped being live. Null while it is live, while it is a draft, and for
   * anything retired before the column existed — which is not backfilled, so the screen says
   * "not recorded" rather than showing a made-up date.
   */
  retiredAt: Date | null;
  /** Cards pinned to this version. They keep its rules whatever happens to the program. */
  cardCount: number;
  tiers: VersionTier[];
  /** Parsed through the card type's own contract. Null when the row parses as neither. */
  mechanics: StampMechanics | PointsMechanics | null;
}

export interface ProgramVersionHistory {
  templateId: string;
  name: string;
  cardType: CardType;
  status: TemplateStatus;
  versions: ProgramVersionSummary[];
  /** The draft, if one is open. At most one per program, enforced in SQL. */
  draftVersionNumber: number | null;
}

/** Load a template inside the caller's tenant, or refuse exactly as if it did not exist. */
async function requireOwnTemplate(db: Tx | typeof prisma, ctx: TenantContext, templateId: string) {
  const template = await db.programTemplate.findFirst({
    where: { id: templateId, businessId: ctx.businessId },
    select: { id: true, name: true, cardType: true, status: true },
  });
  if (!template) throw new NotFoundError("Program not found");
  return template;
}

/** Mechanics read through whichever contract owns them, or null for a row that is neither. */
function parseStored(mechanics: unknown): StampMechanics | PointsMechanics | null {
  if (isPointsMechanics(mechanics)) return readPointsMechanics(mechanics);
  if (isStampMechanics(mechanics)) return readStampMechanics(mechanics);
  return null;
}

/**
 * Every version this program has ever had, newest first.
 *
 * This is the screen that makes immutability legible: a merchant can see that v1 still holds 40
 * cards and that those 40 cards still run on v1's rules. Without it, "existing cards keep their
 * version" is a sentence in a document rather than something anyone can check.
 */
export async function listProgramVersions(ctx: TenantContext, templateId: string): Promise<ProgramVersionHistory> {
  requirePermission(ctx, Permission.VIEW_TEMPLATES);
  const template = await requireOwnTemplate(prisma, ctx, templateId);

  const [versions, cardCounts] = await Promise.all([
    prisma.programVersion.findMany({
      where: { templateId: template.id },
      select: {
        id: true,
        versionNumber: true,
        status: true,
        createdAt: true,
        activatedAt: true,
        retiredAt: true,
        mechanics: true,
        rewardTiers: {
          select: { name: true, description: true, requiredPoints: true, rewardValueMinor: true, usageLimit: true },
          orderBy: [{ sortOrder: "asc" }, { requiredPoints: "asc" }],
        },
      },
      orderBy: { versionNumber: "desc" },
      take: MAX_VERSIONS_LISTED,
    }),
    // Grouped in one query rather than counted per version: the templateId index serves it, and a
    // program with a decade of versions would otherwise be a decade of round trips.
    prisma.customerCard.groupBy({
      by: ["programVersionId"],
      where: { templateId: template.id },
      _count: { _all: true },
    }),
  ]);

  const cards = new Map(cardCounts.map((row) => [row.programVersionId, row._count._all]));

  return {
    templateId: template.id,
    name: template.name,
    cardType: template.cardType,
    status: template.status,
    draftVersionNumber: versions.find((v) => v.status === ProgramVersionStatus.DRAFT)?.versionNumber ?? null,
    versions: versions.map((v) => ({
      id: v.id,
      versionNumber: v.versionNumber,
      status: v.status,
      createdAt: v.createdAt,
      activatedAt: v.activatedAt,
      retiredAt: v.retiredAt,
      cardCount: cards.get(v.id) ?? 0,
      tiers: v.rewardTiers,
      mechanics: parseStored(v.mechanics),
    })),
  };
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Drafting
 * ────────────────────────────────────────────────────────────────────────── */

const updateDraftSchema = z.strictObject({
  /** The whole mechanics object, validated by the card type's own contract. Never a patch. */
  mechanics: z.unknown(),
  /** POINTS only. A STAMP draft's single tier is derived from its mechanics. */
  tiers: z.array(rewardTierSchema).min(1).max(MAX_REWARD_TIERS).optional(),
});
export interface UpdateDraftInput {
  mechanics: unknown;
  tiers?: RewardTierInput[];
}

/**
 * Validate a draft's mechanics and rewards the way publishing will.
 *
 * Called on every edit AND again inside the publish transaction. Twice, deliberately: the edit-time
 * call is what gives a merchant a field-level error while they are typing, and the publish-time
 * call is the one that counts, because a location can be deactivated between the two.
 */
async function validateDraft(
  db: Tx,
  ctx: TenantContext,
  cardType: CardType,
  input: UpdateDraftInput,
): Promise<{ mechanics: StampMechanics | PointsMechanics; tiers: RewardTierInput[] }> {
  if (cardType === CardType.POINTS) {
    const mechanics = parsePointsMechanics(input.mechanics);
    const tiers = (input.tiers ?? []).map((t) => rewardTierSchema.parse(t));
    if (tiers.length === 0) throw new ValidationError("A points program must offer at least one reward");

    const names = tiers.map((t) => t.name.trim().toLocaleLowerCase());
    if (new Set(names).size !== names.length) {
      throw new ValidationError("Reward tier names must be unique within a program");
    }
    // The same rule `createPointsProgram` applies, applied again here rather than imported from it:
    // a welcome bonus that already pays for a reward hands one out to everybody who enrols.
    const cheapest = Math.min(...tiers.map((t) => t.requiredPoints));
    if (mechanics.welcomePoints !== undefined && mechanics.welcomePoints >= cheapest) {
      throw new ValidationError(
        `welcomePoints must be fewer than the cheapest reward (${cheapest}); a welcome bonus may not pay for a reward on its own`,
      );
    }
    if (mechanics.availableLocations) {
      await assertLocationsBelongToBusiness(db, ctx.businessId, mechanics.availableLocations);
    }
    return { mechanics, tiers };
  }

  const mechanics = parseStampMechanics(input.mechanics);
  if (input.tiers !== undefined) {
    // Not ignored: a caller sending tiers to a stamp program believes they will be honoured, and
    // the reward would silently come from `rewardName` instead.
    throw new ValidationError("A stamp program's reward comes from its mechanics; tiers cannot be supplied");
  }
  if (mechanics.availableLocations) {
    await assertLocationsBelongToBusiness(db, ctx.businessId, mechanics.availableLocations);
  }
  return { mechanics, tiers: [] };
}

/** Write a draft's reward rows. Always a full replacement: a draft is edited as a whole. */
async function writeDraftTiers(
  tx: Tx,
  programVersionId: string,
  cardType: CardType,
  mechanics: StampMechanics | PointsMechanics,
  tiers: RewardTierInput[],
): Promise<void> {
  // Legal only because the version is still DRAFT — `reward_tier_protect` refuses both the delete
  // and the insert the moment it is not.
  await tx.rewardTier.deleteMany({ where: { programVersionId } });

  if (cardType === CardType.STAMP) {
    const stamp = mechanics as StampMechanics;
    await tx.rewardTier.create({
      data: {
        programVersionId,
        name: stamp.rewardName,
        description: stamp.rewardDescription ?? null,
        requiredPoints: stamp.stampsRequiredPerReward,
        rewardValueMinor: stamp.rewardValueMinor ?? null,
        sortOrder: 0,
      },
    });
    return;
  }

  for (const [index, tier] of tiers.entries()) {
    await tx.rewardTier.create({
      data: {
        programVersionId,
        name: tier.name,
        description: tier.description ?? null,
        requiredPoints: tier.requiredPoints,
        rewardValueMinor: tier.rewardValueMinor ?? null,
        usageLimit: tier.usageLimit ?? null,
        sortOrder: tier.sortOrder ?? index,
      },
    });
  }
}

export interface DraftCreated {
  versionNumber: number;
  /** True when the draft was already open: creating one twice is not an error, it is a no-op. */
  existed: boolean;
}

/**
 * Open a draft from the live version.
 *
 * The draft starts as an exact copy — same mechanics, same rewards — so "what changed" means what
 * the merchant changed, and a publish with no edits is a no-op rather than a surprise.
 *
 * Calling it twice returns the open draft instead of refusing. A merchant who left the tab open
 * yesterday and clicks the button again today means "let me edit the draft", and a second draft is
 * refused by the database anyway.
 */
export async function createDraftVersion(ctx: TenantContext, templateId: string): Promise<DraftCreated> {
  requirePermission(ctx, Permission.EDIT_TEMPLATES);

  return prisma.$transaction(async (tx) => {
    const template = await requireOwnTemplate(tx, ctx, templateId);
    if (template.status === TemplateStatus.ARCHIVED) {
      throw new ConflictError("This program is archived and cannot take a new version");
    }
    // Serialise every lifecycle verb for this program on one row, so two managers cannot open two
    // drafts, or open one while another is publishing.
    await tx.$executeRaw`SELECT id FROM "ProgramTemplate" WHERE id = ${template.id} FOR UPDATE`;

    const open = await tx.programVersion.findFirst({
      where: { templateId: template.id, status: ProgramVersionStatus.DRAFT },
      select: { versionNumber: true },
    });
    if (open) return { versionNumber: open.versionNumber, existed: true };

    const live = await tx.programVersion.findFirst({
      where: { templateId: template.id, status: ProgramVersionStatus.ACTIVE },
      select: {
        mechanics: true,
        versionNumber: true,
        rewardTiers: {
          select: { name: true, description: true, requiredPoints: true, rewardValueMinor: true, usageLimit: true, sortOrder: true },
          orderBy: { sortOrder: "asc" },
        },
      },
    });
    if (!live) throw new ConflictError("This program has no live version to copy");

    const highest = await tx.programVersion.findFirst({
      where: { templateId: template.id },
      select: { versionNumber: true },
      orderBy: { versionNumber: "desc" },
    });
    const versionNumber = (highest?.versionNumber ?? 0) + 1;

    const draft = await tx.programVersion.create({
      data: {
        templateId: template.id,
        versionNumber,
        status: ProgramVersionStatus.DRAFT,
        mechanics: live.mechanics as Prisma.InputJsonObject,
      },
      select: { id: true },
    });
    for (const tier of live.rewardTiers) {
      await tx.rewardTier.create({ data: { programVersionId: draft.id, ...tier } });
    }

    await recordAudit(tx, {
      businessId: ctx.businessId,
      actorUserId: ctx.userId,
      action: AuditAction.PROGRAM_DRAFT_CREATED,
      entityType: "ProgramVersion",
      entityId: draft.id,
      metadata: { templateId: template.id, versionNumber, copiedFromVersion: live.versionNumber },
    });

    return { versionNumber, existed: false };
  }, CONTENDED_TX);
}

/**
 * Replace the draft's mechanics and rewards.
 *
 * A whole-object replacement, never a patch. A patch over a JSON column means the server has to
 * merge two states it did not both validate, and the field a merchant cleared is exactly the field
 * a merge silently puts back.
 */
export async function updateDraftVersion(ctx: TenantContext, templateId: string, input: UpdateDraftInput): Promise<void> {
  requirePermission(ctx, Permission.EDIT_TEMPLATES);
  const parsed = updateDraftSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError("Invalid draft", parsed.error.issues);

  await prisma.$transaction(async (tx) => {
    const template = await requireOwnTemplate(tx, ctx, templateId);
    await tx.$executeRaw`SELECT id FROM "ProgramTemplate" WHERE id = ${template.id} FOR UPDATE`;

    const draft = await tx.programVersion.findFirst({
      where: { templateId: template.id, status: ProgramVersionStatus.DRAFT },
      select: { id: true, versionNumber: true },
    });
    if (!draft) throw new NotFoundError("This program has no open draft");

    const { mechanics, tiers } = await validateDraft(tx, ctx, template.cardType, input);

    await tx.programVersion.update({
      where: { id: draft.id },
      data: { mechanics: mechanics as unknown as Prisma.InputJsonObject },
    });
    await writeDraftTiers(tx, draft.id, template.cardType, mechanics, tiers);

    await recordAudit(tx, {
      businessId: ctx.businessId,
      actorUserId: ctx.userId,
      action: AuditAction.PROGRAM_DRAFT_UPDATED,
      entityType: "ProgramVersion",
      entityId: draft.id,
      // The draft's contents are audited when it is PUBLISHED, which is the moment they start
      // affecting customers. An edit records that one happened.
      metadata: { templateId: template.id, versionNumber: draft.versionNumber },
    });
  }, CONTENDED_TX);
}

/** Throw away the draft. Only DRAFT rows can be deleted at all — the trigger sees to that. */
export async function discardDraftVersion(ctx: TenantContext, templateId: string): Promise<void> {
  requirePermission(ctx, Permission.EDIT_TEMPLATES);

  await prisma.$transaction(async (tx) => {
    const template = await requireOwnTemplate(tx, ctx, templateId);
    await tx.$executeRaw`SELECT id FROM "ProgramTemplate" WHERE id = ${template.id} FOR UPDATE`;

    const draft = await tx.programVersion.findFirst({
      where: { templateId: template.id, status: ProgramVersionStatus.DRAFT },
      select: { id: true, versionNumber: true },
    });
    if (!draft) throw new NotFoundError("This program has no open draft");

    await tx.rewardTier.deleteMany({ where: { programVersionId: draft.id } });
    await tx.programVersion.delete({ where: { id: draft.id } });

    await recordAudit(tx, {
      businessId: ctx.businessId,
      actorUserId: ctx.userId,
      action: AuditAction.PROGRAM_DRAFT_DISCARDED,
      entityType: "ProgramVersion",
      entityId: draft.id,
      metadata: { templateId: template.id, versionNumber: draft.versionNumber },
    });
  }, CONTENDED_TX);
}

export interface PublishResult {
  publishedVersionNumber: number;
  retiredVersionNumber: number;
  /** Cards that keep the retired version's rules. Reported so the screen can say so plainly. */
  cardsOnRetiredVersion: number;
}

/**
 * Make the draft live.
 *
 * `expectedVersionNumber` is the draft the merchant was looking at when they pressed the button.
 * If someone else published in the meantime the draft they reviewed no longer exists, and this
 * refuses rather than publishing a version nobody read. That is the whole of the concurrency
 * story at the application level; underneath it, the template row lock serialises publishes and
 * `ProgramVersion_one_active_per_template` is the constraint that cannot be argued with.
 *
 * Order inside the transaction matters and is forced by that index: **retire, then activate.**
 * Activating first would put two ACTIVE rows on one template for the width of a statement, and the
 * partial unique index would reject it.
 */
export async function publishDraftVersion(
  ctx: TenantContext,
  templateId: string,
  expectedVersionNumber: number,
): Promise<PublishResult> {
  requirePermission(ctx, Permission.EDIT_TEMPLATES);
  if (!Number.isInteger(expectedVersionNumber) || expectedVersionNumber < 1) {
    throw new ValidationError("expectedVersionNumber must be the draft's version number");
  }

  return prisma.$transaction(async (tx) => {
    const template = await requireOwnTemplate(tx, ctx, templateId);
    if (template.status === TemplateStatus.ARCHIVED) {
      throw new ConflictError("This program is archived and cannot publish a new version");
    }
    await tx.$executeRaw`SELECT id FROM "ProgramTemplate" WHERE id = ${template.id} FOR UPDATE`;

    const draft = await tx.programVersion.findFirst({
      where: { templateId: template.id, status: ProgramVersionStatus.DRAFT },
      select: { id: true, versionNumber: true, mechanics: true, rewardTiers: { select: { name: true, description: true, requiredPoints: true, rewardValueMinor: true, usageLimit: true, sortOrder: true } } },
    });
    if (!draft) throw new NotFoundError("This program has no open draft");
    if (draft.versionNumber !== expectedVersionNumber) {
      throw new ConflictError(
        "This program's draft changed while you were reviewing it; open the draft again and re-check the changes",
        ConflictCode.DRAFT_STALE,
      );
    }

    /*
     * Validated AGAIN, here, inside the transaction that publishes it. The edit-time check was a
     * courtesy to the person typing; this one is the gate. Between the two, a location named by
     * these mechanics may have been deactivated, and publishing a version that runs nowhere would
     * be an outage a merchant discovers at the till.
     */
    // The tiers come back validated and are deliberately NOT rewritten: they are already the
    // draft's own rows, and rewriting them after the status change is exactly what the trigger
    // refuses. Validation is the point of the call, not the returned value.
    const { mechanics } = await validateDraft(tx, ctx, template.cardType, {
      mechanics: draft.mechanics,
      tiers: template.cardType === CardType.POINTS ? draft.rewardTiers.map((t) => ({
        name: t.name,
        description: t.description ?? undefined,
        requiredPoints: t.requiredPoints,
        rewardValueMinor: t.rewardValueMinor ?? undefined,
        usageLimit: t.usageLimit ?? undefined,
        sortOrder: t.sortOrder,
      })) : undefined,
    });

    const live = await tx.programVersion.findFirst({
      where: { templateId: template.id, status: ProgramVersionStatus.ACTIVE },
      select: { id: true, versionNumber: true },
    });
    if (!live) throw new ConflictError("This program has no live version to replace");

    const cardsOnRetiredVersion = await tx.customerCard.count({ where: { programVersionId: live.id } });

    const now = new Date();
    // Retire first. The partial unique index permits exactly one ACTIVE row per template, so the
    // opposite order cannot commit.
    await tx.programVersion.update({
      where: { id: live.id },
      data: { status: ProgramVersionStatus.RETIRED, retiredAt: now },
    });
    await tx.programVersion.update({
      where: { id: draft.id },
      data: { status: ProgramVersionStatus.ACTIVE, activatedAt: now },
    });

    await recordAudit(tx, {
      businessId: ctx.businessId,
      actorUserId: ctx.userId,
      action: AuditAction.PROGRAM_VERSION_PUBLISHED,
      entityType: "ProgramVersion",
      entityId: draft.id,
      // The published mechanics are written in full. "What were the rules when this card was sold"
      // is the question a loyalty program's audit has to answer, and a retired version can be read
      // back from here even if the row were ever lost.
      metadata: {
        templateId: template.id,
        versionNumber: draft.versionNumber,
        retiredVersionNumber: live.versionNumber,
        cardsOnRetiredVersion,
        mechanics: mechanics as unknown as Prisma.InputJsonObject,
      },
    });

    return { publishedVersionNumber: draft.versionNumber, retiredVersionNumber: live.versionNumber, cardsOnRetiredVersion };
  }, CONTENDED_TX);
}

/**
 * Pause a program, or resume it.
 *
 * `PAUSED` means exactly one thing (PRODUCT-SPEC §4): **no new enrolment.** Every existing card
 * keeps working — stamps are awarded, points are earned, rewards are redeemed, reversals happen —
 * because a customer who holds a card did nothing wrong when a merchant paused the program.
 * `resolveEnrollmentTarget` already excludes PAUSED templates, so this verb has no special case
 * anywhere else.
 *
 * There is no destructive verb here, and there will not be one in this module: a program is paused,
 * not deleted, and `ARCHIVED` is deliberately not reachable from a screen while the consequences
 * for cards pinned to its versions have not been designed.
 */
export async function setTemplateStatus(
  ctx: TenantContext,
  templateId: string,
  status: typeof TemplateStatus.ACTIVE | typeof TemplateStatus.PAUSED,
): Promise<{ status: TemplateStatus }> {
  requirePermission(ctx, Permission.EDIT_TEMPLATES);
  if (status !== TemplateStatus.ACTIVE && status !== TemplateStatus.PAUSED) {
    throw new ValidationError("A program can be paused or resumed; nothing else");
  }

  return prisma.$transaction(async (tx) => {
    const template = await requireOwnTemplate(tx, ctx, templateId);
    if (template.status === TemplateStatus.ARCHIVED) {
      throw new ConflictError("This program is archived");
    }
    if (template.status === status) return { status };

    await tx.programTemplate.update({ where: { id: template.id }, data: { status } });
    await recordAudit(tx, {
      businessId: ctx.businessId,
      actorUserId: ctx.userId,
      action: AuditAction.PROGRAM_STATUS_CHANGED,
      entityType: "ProgramTemplate",
      entityId: template.id,
      metadata: { from: template.status, to: status },
    });
    return { status };
  }, CONTENDED_TX);
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Reviewing a draft before it reaches customers
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * One difference between the live version and the draft.
 *
 * `field` is a key the UI translates, never a sentence: an Arabic merchant must not be shown an
 * English field name because the diff was rendered on the server. `before` and `after` are already
 * human values — a location is its NAME, a boolean is a boolean, an absent setting is null — so no
 * screen has to reach for a raw identifier to display a change.
 */
export interface VersionChange {
  field: string;
  before: string | number | boolean | null;
  after: string | number | boolean | null;
}

export interface ProgramDraftReview {
  templateId: string;
  name: string;
  cardType: CardType;
  draftVersionNumber: number;
  liveVersionNumber: number;
  /** Cards that will keep the live version's rules after publication. */
  cardsOnLiveVersion: number;
  mechanics: StampMechanics | PointsMechanics;
  tiers: VersionTier[];
  /** Empty when the draft is still an exact copy. Publishing then changes nothing, and says so. */
  changes: VersionChange[];
  /** Every active counter of the business, so the editor can offer names rather than ids. */
  locations: { id: string; name: string }[];
}

/** Mechanics keys that are presentation or defaults rather than a rule worth diffing loudly. */
const NEVER_DIFFED = new Set(["kind", "contractVersion", "availableLocations"]);

function diffMechanics(before: Record<string, unknown>, after: Record<string, unknown>): VersionChange[] {
  const changes: VersionChange[] = [];
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (NEVER_DIFFED.has(key)) continue;
    const a = before[key] ?? null;
    const b = after[key] ?? null;
    if (a === b) continue;
    changes.push({ field: key, before: a as VersionChange["before"], after: b as VersionChange["after"] });
  }
  return changes;
}

/** Reward differences, as rows a merchant recognises: a reward's NAME is what they know it by. */
function diffTiers(before: VersionTier[], after: VersionTier[]): VersionChange[] {
  const changes: VersionChange[] = [];
  const byName = new Map(before.map((t) => [t.name, t]));
  for (const tier of after) {
    const was = byName.get(tier.name);
    if (!was) {
      changes.push({ field: "rewardAdded", before: null, after: `${tier.name} (${tier.requiredPoints})` });
      continue;
    }
    byName.delete(tier.name);
    if (was.requiredPoints !== tier.requiredPoints) {
      changes.push({ field: `reward:${tier.name}`, before: was.requiredPoints, after: tier.requiredPoints });
    }
  }
  for (const removed of byName.values()) {
    changes.push({ field: "rewardRemoved", before: `${removed.name} (${removed.requiredPoints})`, after: null });
  }
  return changes;
}

/**
 * The draft, the live version, and exactly what differs between them.
 *
 * The review screen this serves exists because publishing is irreversible in the direction that
 * matters: a merchant cannot un-publish a version, they can only publish another. Being shown
 * "8 stamps → 10 stamps, Main → Main + Branch" before pressing the button is the difference
 * between a considered change and a typo that reaches every new customer.
 */
export async function getProgramDraft(ctx: TenantContext, templateId: string): Promise<ProgramDraftReview | null> {
  requirePermission(ctx, Permission.VIEW_TEMPLATES);
  const template = await requireOwnTemplate(prisma, ctx, templateId);

  const [draft, live, locations] = await Promise.all([
    prisma.programVersion.findFirst({
      where: { templateId: template.id, status: ProgramVersionStatus.DRAFT },
      select: {
        versionNumber: true,
        mechanics: true,
        rewardTiers: {
          select: { name: true, description: true, requiredPoints: true, rewardValueMinor: true, usageLimit: true },
          orderBy: [{ sortOrder: "asc" }, { requiredPoints: "asc" }],
        },
      },
    }),
    prisma.programVersion.findFirst({
      where: { templateId: template.id, status: ProgramVersionStatus.ACTIVE },
      select: {
        id: true,
        versionNumber: true,
        mechanics: true,
        rewardTiers: {
          select: { name: true, description: true, requiredPoints: true, rewardValueMinor: true, usageLimit: true },
          orderBy: [{ sortOrder: "asc" }, { requiredPoints: "asc" }],
        },
      },
    }),
    prisma.location.findMany({
      where: { businessId: ctx.businessId, active: true },
      select: { id: true, name: true },
      orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
    }),
  ]);
  if (!draft || !live) return null;

  const draftMechanics = parseStored(draft.mechanics);
  const liveMechanics = parseStored(live.mechanics);
  if (!draftMechanics || !liveMechanics) {
    // A stored row that parses as neither contract is corrupt, not bad input. Refusing here is
    // better than rendering a review of mechanics nobody can read.
    throw new ValidationError("This program's stored mechanics cannot be read");
  }

  const names = new Map(locations.map((l) => [l.id, l.name]));
  const defaultName = locations[0]?.name ?? null;
  /** A version that names nothing runs at the main counter — which is what a merchant should read. */
  const where = (m: StampMechanics | PointsMechanics): string | null =>
    m.availableLocations === undefined
      ? defaultName
      : m.availableLocations.map((id) => names.get(id) ?? null).filter((n): n is string => n !== null).join(", ") || null;

  const changes = diffMechanics(
    liveMechanics as unknown as Record<string, unknown>,
    draftMechanics as unknown as Record<string, unknown>,
  );
  const beforeWhere = where(liveMechanics);
  const afterWhere = where(draftMechanics);
  if (beforeWhere !== afterWhere) changes.push({ field: "availableLocations", before: beforeWhere, after: afterWhere });
  /*
   * Only a POINTS program diffs its rewards. A stamp program's single tier is DERIVED from its
   * mechanics — the reward name and the threshold are `rewardName` and `stampsRequiredPerReward` —
   * so diffing it as well reported every stamp change twice, once in its own words and once as
   * "Reward: free coffee, 10 → 5". One change, one line.
   */
  if (template.cardType === CardType.POINTS) changes.push(...diffTiers(live.rewardTiers, draft.rewardTiers));

  return {
    templateId: template.id,
    name: template.name,
    cardType: template.cardType,
    draftVersionNumber: draft.versionNumber,
    liveVersionNumber: live.versionNumber,
    cardsOnLiveVersion: await prisma.customerCard.count({ where: { programVersionId: live.id } }),
    mechanics: draftMechanics,
    tiers: draft.rewardTiers,
    changes,
    locations,
  };
}
