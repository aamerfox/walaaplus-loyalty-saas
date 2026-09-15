import { CardType, Permission, Prisma, ProgramVersionStatus, TemplateStatus } from "@prisma/client";
import { z } from "zod";
import { AuditAction, recordAudit } from "../audit/audit";
import { CONTENDED_TX, prisma, type DbClient, type Tx } from "../db";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import { opaqueToken } from "../security/tokens";
import { requirePermission, type TenantContext } from "../tenant/context";
import { assertLocationsBelongToBusiness } from "./available-locations";
import { readVersionAvailableLocations } from "./card-type-support";
import { parsePointsMechanics, type PointsMechanics, type PointsMechanicsInput } from "./points-mechanics";
import { DIRECT_SOURCE_NAME, DIRECT_UTM_SOURCE } from "./sources";

/**
 * Programs, in the plural.
 *
 * Phase 1a allowed a business exactly one live program, enforced in `createStampProgram` behind a
 * row lock. That was a pilot restriction, not a domain truth: a real merchant runs a stamp card at
 * the counter and a points card for the delivery app, or replaces one with the other over a month
 * while both keep working for the customers already holding them.
 *
 * ## Lifting it, deliberately and without breaking the screen that relied on it
 *
 * The restriction is lifted at the DOMAIN level: `createPointsProgram` and `createStampProgram`
 * both accept `allowAdditionalProgram`, and every downstream service — enrolment, the engines,
 * lookup, metrics — now resolves a program rather than assuming the business has one.
 *
 * It is NOT lifted for the Phase 1a caller that did not ask. `allowAdditionalProgram` defaults to
 * false, so the existing owner screen keeps its exact contract: a second submission returns the
 * program that already exists instead of creating another. That screen has no program picker and
 * no way to name which program a cashier is enrolling into; making its double-click create a second
 * live program would hand a merchant two cards, two QR codes and two balances for the same
 * customer, and they would find out weeks later. Prompt 2 replaces the screen and passes the flag.
 *
 * ## What stays immutable
 *
 *  - **Card type is pinned per template** and per version: a POINTS template creates POINTS
 *    versions, and `CustomerCard.programVersionId` freezes the mechanics a card was sold under.
 *  - **One card per customer per template** — the database's `@@unique([customerBusinessProfileId,
 *    templateId])`. Several programs means several cards, one per program, never two on one.
 *  - **One ACTIVE version per template** — the partial unique index from Phase 0.
 */

/** A business may hold this many live programs. Bounds enumeration and keeps a picker usable. */
export const MAX_LIVE_PROGRAMS_PER_BUSINESS = 20;
/** A points version may offer this many rewards. */
export const MAX_REWARD_TIERS = 20;

const MAX_MINOR_UNITS = 2_147_483_647;

export const rewardTierSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(500).optional(),
  /** Points this reward costs. Integer, positive: there is no half-point anywhere in this system. */
  requiredPoints: z.number().int().min(1).max(1_000_000),
  /** Merchant cost/value of the reward, integer minor units, for ROI reporting. */
  rewardValueMinor: z.number().int().min(0).max(MAX_MINOR_UNITS).optional(),
  /** How many times ONE CARD may redeem this tier. Absent = unlimited. */
  usageLimit: z.number().int().min(1).max(1_000).optional(),
  sortOrder: z.number().int().min(0).max(1_000).optional(),
});
export type RewardTierInput = z.input<typeof rewardTierSchema>;

const createPointsProgramSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  mechanics: z.unknown(),
  tiers: z.array(rewardTierSchema).min(1).max(MAX_REWARD_TIERS),
  /**
   * Explicit opt-in to a SECOND live program. Default false, so a caller written against the
   * Phase 1a contract cannot create one by accident.
   */
  allowAdditionalProgram: z.boolean().optional(),
});

export interface CreatePointsProgramInput {
  name: string;
  mechanics: PointsMechanicsInput;
  tiers: RewardTierInput[];
  allowAdditionalProgram?: boolean;
}

export interface PointsProgramSummary {
  templateId: string;
  programVersionId: string;
  tierIds: string[];
  /** The `direct` source's opaque public token. Server-side attribution only — see B7. */
  directSourceId: string;
  mechanics: PointsMechanics;
}

/**
 * Guard the program slot, under the caller's business row lock.
 *
 * Two rules, and they answer different questions. The name rule is permanent: two live programs a
 * merchant cannot tell apart are a support call waiting to happen, and a repeated submission is by
 * far the most likely way to create them. The count rule is the Phase 1a restriction, now opt-out
 * rather than absolute.
 */
export async function assertProgramSlotAvailable(
  tx: Tx,
  businessId: string,
  args: { name: string; allowAdditional: boolean },
): Promise<void> {
  const live = await tx.programTemplate.findMany({
    where: { businessId, status: { in: [TemplateStatus.ACTIVE, TemplateStatus.PAUSED] } },
    select: { id: true, name: true },
  });

  if (!args.allowAdditional && live.length > 0) {
    throw new ConflictError("This business already has a loyalty program; Phase 1a supports one");
  }
  if (live.length >= MAX_LIVE_PROGRAMS_PER_BUSINESS) {
    throw new ConflictError(`A business may run at most ${MAX_LIVE_PROGRAMS_PER_BUSINESS} live programs`);
  }
  const wanted = args.name.trim().toLocaleLowerCase();
  if (live.some((t) => t.name.trim().toLocaleLowerCase() === wanted)) {
    throw new ConflictError("This business already has a live program with that name");
  }
}

/**
 * Create a points program: template, version 1, its reward tiers, and its `direct` source.
 *
 * Order is forced by the database. `reward_tier_protect` refuses a tier once its version leaves
 * DRAFT, so tiers are written while the version is still DRAFT and the version is activated last —
 * which is also what makes the set of tiers immutable for every card that pins it.
 */
export async function createPointsProgram(ctx: TenantContext, input: CreatePointsProgramInput): Promise<PointsProgramSummary> {
  requirePermission(ctx, Permission.EDIT_TEMPLATES);
  const parsed = createPointsProgramSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError("Invalid points program", parsed.error.issues);

  const mechanics = parsePointsMechanics(parsed.data.mechanics);
  const tiers = parsed.data.tiers.map((t) => rewardTierSchema.parse(t));
  const name = parsed.data.name;

  // Tier names identify a reward to staff and to the customer. Two called "Free coffee" in one
  // version make the redemption screen a guess.
  const names = tiers.map((t) => t.name.trim().toLocaleLowerCase());
  if (new Set(names).size !== names.length) throw new ValidationError("Reward tier names must be unique within a program");

  // The points equivalent of the stamp contract's welcome-bonus rule: a welcome bonus that already
  // pays for a reward hands one out to anyone who enrols.
  const cheapest = Math.min(...tiers.map((t) => t.requiredPoints));
  if (mechanics.welcomePoints !== undefined && mechanics.welcomePoints >= cheapest) {
    throw new ValidationError(
      `welcomePoints must be fewer than the cheapest reward (${cheapest}); a welcome bonus may not pay for a reward on its own`,
    );
  }

  return prisma.$transaction(async (tx) => {
    // Serialise program creation for this business, exactly as the stamp path does: two owners
    // clicking at once would otherwise both pass the checks below.
    await tx.$executeRaw`SELECT id FROM "Business" WHERE id = ${ctx.businessId} FOR UPDATE`;
    await assertProgramSlotAvailable(tx, ctx.businessId, { name, allowAdditional: input.allowAdditionalProgram === true });

    if (mechanics.availableLocations) {
      await assertLocationsBelongToBusiness(tx, ctx.businessId, mechanics.availableLocations);
    }

    const template = await tx.programTemplate.create({
      data: {
        businessId: ctx.businessId,
        name,
        cardType: CardType.POINTS,
        status: TemplateStatus.ACTIVE,
        defaultLocale: "ar",
      },
      select: { id: true },
    });

    const version = await tx.programVersion.create({
      data: {
        templateId: template.id,
        versionNumber: 1,
        status: ProgramVersionStatus.DRAFT,
        mechanics: mechanics as unknown as Prisma.InputJsonObject,
      },
      select: { id: true },
    });

    const tierIds: string[] = [];
    for (const [index, tier] of tiers.entries()) {
      const row = await tx.rewardTier.create({
        data: {
          programVersionId: version.id,
          name: tier.name,
          description: tier.description ?? null,
          requiredPoints: tier.requiredPoints,
          rewardValueMinor: tier.rewardValueMinor ?? null,
          usageLimit: tier.usageLimit ?? null,
          sortOrder: tier.sortOrder ?? index,
        },
        select: { id: true },
      });
      tierIds.push(row.id);
    }

    // Freeze it. From here the mechanics and the tiers are immutable, enforced by triggers.
    await tx.programVersion.update({
      where: { id: version.id },
      data: { status: ProgramVersionStatus.ACTIVE, activatedAt: new Date() },
    });

    /*
     * Every template gets its `direct` source, so every card carries attribution (PRODUCT-SPEC §4).
     * Owner decision B7 means the token is **server-side only**: nothing publishes it, no public
     * route accepts it, and counter enrolment resolves it from the staff member's own membership.
     */
    const directSource = await tx.utmSourceLink.create({
      data: {
        templateId: template.id,
        name: DIRECT_SOURCE_NAME,
        publicToken: opaqueToken(),
        utmSource: DIRECT_UTM_SOURCE,
        welcomeUnitQuantity: mechanics.welcomePoints ?? null,
        active: true,
      },
      select: { id: true },
    });

    const common = { businessId: ctx.businessId, actorUserId: ctx.userId };
    await recordAudit(tx, {
      ...common,
      action: AuditAction.PROGRAM_CREATED,
      entityType: "ProgramTemplate",
      entityId: template.id,
      metadata: {
        cardType: CardType.POINTS,
        programVersionId: version.id,
        rewardTierIds: tierIds,
        mechanics: mechanics as unknown as Prisma.InputJsonObject,
      },
    });
    await recordAudit(tx, {
      ...common,
      action: AuditAction.ENROLLMENT_SOURCE_CREATED,
      entityType: "UtmSourceLink",
      entityId: directSource.id,
      // The token is a capability and is never written to the audit log.
      metadata: { templateId: template.id, utmSource: DIRECT_UTM_SOURCE, welcomePoints: mechanics.welcomePoints ?? 0 },
    });

    return { templateId: template.id, programVersionId: version.id, tierIds, directSourceId: directSource.id, mechanics };
  }, CONTENDED_TX);
}

export interface ProgramListItem {
  templateId: string;
  name: string;
  cardType: CardType;
  status: TemplateStatus;
  programVersionId: string | null;
  /** Rewards on the ACTIVE version, cheapest first. Empty for a template with no active version. */
  tiers: { id: string; name: string; requiredPoints: number }[];
  /** Locations this version runs at, or null for "Main only". */
  availableLocations: readonly string[] | null;
  createdAt: Date;
}

/**
 * Every program this business runs. Tenant-scoped, and the only read a picker needs.
 *
 * Returns no source tokens. A program list is shown on screens a manager opens; an enrolment token
 * is a capability, and B7 keeps it on the server.
 */
export async function listBusinessPrograms(ctx: TenantContext): Promise<ProgramListItem[]> {
  requirePermission(ctx, Permission.VIEW_TEMPLATES);
  const templates = await prisma.programTemplate.findMany({
    where: { businessId: ctx.businessId, status: { in: [TemplateStatus.ACTIVE, TemplateStatus.PAUSED] } },
    select: {
      id: true,
      name: true,
      cardType: true,
      status: true,
      createdAt: true,
      versions: {
        where: { status: ProgramVersionStatus.ACTIVE },
        select: {
          id: true,
          mechanics: true,
          rewardTiers: {
            select: { id: true, name: true, requiredPoints: true },
            orderBy: [{ requiredPoints: "asc" }, { sortOrder: "asc" }],
          },
        },
        take: 1,
      },
    },
    orderBy: { createdAt: "asc" },
  });

  return templates.map((t) => {
    const version = t.versions[0];
    return {
      templateId: t.id,
      name: t.name,
      cardType: t.cardType,
      status: t.status,
      programVersionId: version?.id ?? null,
      tiers: version?.rewardTiers ?? [],
      availableLocations: version ? locationsOf(version.mechanics) : null,
      createdAt: t.createdAt,
    };
  });
}

/**
 * A version's location rule, read through whichever contract owns it.
 *
 * Never `mechanics.availableLocations` off the raw JSON: that is the habit the contracts exist to
 * prevent. A row that parses as neither contract is corrupt, and a LIST is the wrong place to throw
 * for it - one bad program would empty a merchant's whole picker - so it reports "Main only", which
 * is the safe reading, and the engines refuse the card loudly when someone tries to transact on it.
 */
function locationsOf(mechanics: unknown): readonly string[] | null {
  // Exhaustive over the contracts, including the money ones. Before this went through
  // `readVersionAvailableLocations`, a cashback programme pinned to a branch was listed as
  // Main-only, because its mechanics parsed as neither stamp nor points and fell off the end.
  return readVersionAvailableLocations(mechanics);
}

export interface EnrollmentTarget {
  templateId: string;
  cardType: CardType;
  /** The template's `direct` source token, resolved server-side. Never returned to a client. */
  sourceToken: string;
}

/**
 * Which program a counter enrolment targets, and the source token to enrol through.
 *
 * With one live program this is the program, exactly as Phase 1a behaved. With several, the caller
 * must name one: guessing would issue the wrong card, and the customer would find out when the
 * reward they were promised is not on it.
 *
 * `PAUSED` templates are excluded on purpose — `PAUSED` means "no new enrolment, existing cards keep
 * working" (PRODUCT-SPEC §4), so a paused program is not a target even when it is the only one.
 */
export async function resolveEnrollmentTarget(db: DbClient, businessId: string, templateId?: string): Promise<EnrollmentTarget> {
  const templates = await db.programTemplate.findMany({
    where: {
      businessId,
      status: TemplateStatus.ACTIVE,
      ...(templateId ? { id: templateId } : {}),
      versions: { some: { status: ProgramVersionStatus.ACTIVE } },
    },
    select: {
      id: true,
      cardType: true,
      utmLinks: {
        where: { utmSource: DIRECT_UTM_SOURCE, active: true },
        select: { publicToken: true },
        take: 1,
      },
    },
    orderBy: { createdAt: "asc" },
    take: MAX_LIVE_PROGRAMS_PER_BUSINESS + 1,
  });

  if (templates.length === 0) {
    // Same answer for "you have no program", "that program is not yours" and "that program is
    // paused": a caller learns only that it cannot enrol into it.
    throw new NotFoundError(
      templateId
        ? "That loyalty program is not available for enrolment"
        : "This business has no active loyalty card yet; create one first",
    );
  }
  if (templates.length > 1) {
    throw new ValidationError("This business runs several loyalty programs; name the one to enrol into");
  }

  const target = templates[0];
  const token = target.utmLinks[0]?.publicToken;
  if (!token) throw new NotFoundError("This program has no active enrolment source");
  return { templateId: target.id, cardType: target.cardType, sourceToken: token };
}
