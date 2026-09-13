import { CardType, Permission, ProgramVersionStatus, TemplateStatus } from "@prisma/client";
import { prisma } from "../db";
import { NotFoundError } from "../errors";
import { requirePermission, type TenantContext } from "../tenant/context";
import { readAvailableLocations } from "./available-locations";
import { isStampMechanics, readStampMechanics } from "./mechanics";
import { isPointsMechanics, readPointsMechanics } from "./points-mechanics";

/**
 * One program, as a merchant reads it.
 *
 * A read model, not a second source of truth: every field comes from the template, its ACTIVE
 * version's pinned mechanics, and its tier rows. Nothing is stored twice and nothing is computed
 * that the ledger already answers — the activity figures on the program screen come from
 * `getBusinessMetrics` with this template's id, which is the same function the dashboard uses.
 *
 * **It returns no capability.** The program's `direct` source token is what enrols customers, and
 * owner decision B7 keeps it on the server: there is no field for it here, so no screen can print
 * it and no response can leak it.
 */

export interface ProgramRewardTier {
  id: string;
  name: string;
  description: string | null;
  requiredPoints: number;
  rewardValueMinor: number | null;
  usageLimit: number | null;
  sortOrder: number;
}

/** The earning rule in the shape a screen renders it, with the unit named rather than implied. */
export type ProgramEarnRule =
  | { mode: "MANUAL"; unitsPerAward: null }
  | { mode: "PER_VISIT"; unitsPerAward: number }
  | { mode: "SPEND_BLOCK"; spendAmountPerBlockMinor: number; unitsPerBlock: number };

export interface ProgramDetail {
  templateId: string;
  name: string;
  cardType: CardType;
  status: TemplateStatus;
  programVersionId: string;
  versionNumber: number;
  activatedAt: Date | null;
  createdAt: Date;

  earnRule: ProgramEarnRule;
  /** Award operations allowed per card per business-timezone day. Null = no limit. */
  dailyAwardLimit: number | null;
  requirePurchaseAmount: boolean;
  /** Units granted once on enrolment, in this program's own unit. */
  welcomeUnits: number;
  /** STAMP only: the threshold and what it pays out. */
  stampReward: { stampsRequiredPerReward: number; rewardName: string; rewardValueMinor: number | null } | null;
  /** POINTS only: what a point is called on screen, when the merchant named it. */
  pointsLabel: string | null;
  /** Configured rewards. One for a stamp program, one or more for a points program. */
  tiers: ProgramRewardTier[];
  /** Null means "the business's Main location only", which is what a Phase 1a program says. */
  availableLocations: { id: string; name: string }[] | null;
  /** Cards issued into this program, all time. A count, never a customer. */
  cardCount: number;
}

/**
 * Load one program of the caller's business.
 *
 * Tenant-scoped by filter rather than by a check afterwards, so another business's template id is
 * "not found" — the same answer as one that never existed. `VIEW_TEMPLATES` gates it, which an owner
 * and a manager hold and a cashier does not.
 */
export async function getProgramDetail(ctx: TenantContext, templateId: string): Promise<ProgramDetail> {
  requirePermission(ctx, Permission.VIEW_TEMPLATES);

  const template = await prisma.programTemplate.findFirst({
    where: { id: templateId, businessId: ctx.businessId },
    select: {
      id: true,
      name: true,
      cardType: true,
      status: true,
      createdAt: true,
      _count: { select: { cards: true } },
      versions: {
        where: { status: ProgramVersionStatus.ACTIVE },
        select: {
          id: true,
          versionNumber: true,
          activatedAt: true,
          mechanics: true,
          rewardTiers: {
            select: {
              id: true,
              name: true,
              description: true,
              requiredPoints: true,
              rewardValueMinor: true,
              usageLimit: true,
              sortOrder: true,
            },
            orderBy: [{ sortOrder: "asc" }, { requiredPoints: "asc" }],
          },
        },
        take: 1,
      },
    },
  });

  const version = template?.versions[0];
  if (!template || !version) throw new NotFoundError("Program not found");

  const base = {
    templateId: template.id,
    name: template.name,
    cardType: template.cardType,
    status: template.status,
    programVersionId: version.id,
    versionNumber: version.versionNumber,
    activatedAt: version.activatedAt,
    createdAt: template.createdAt,
    tiers: version.rewardTiers,
    cardCount: template._count.cards,
  };

  // Read through the contract that owns the row, chosen by the template's own card type. A version
  // that parses as neither is corrupt, and a 422 from the reader is the right answer for a screen
  // that would otherwise render a guess.
  const mechanics =
    template.cardType === CardType.POINTS
      ? readPointsMechanics(version.mechanics, { programVersionId: version.id })
      : readStampMechanics(version.mechanics, { programVersionId: version.id });

  const locationIds = readAvailableLocations(mechanics);
  const locations =
    locationIds === null
      ? null
      : await prisma.location.findMany({
          where: { id: { in: [...locationIds] }, businessId: ctx.businessId },
          select: { id: true, name: true },
          orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
        });

  if (mechanics.kind === "POINTS") {
    const earnRule: ProgramEarnRule =
      mechanics.earnMode === "PER_VISIT"
        ? { mode: "PER_VISIT", unitsPerAward: mechanics.pointsPerVisit! }
        : mechanics.earnMode === "SPEND_BLOCK"
          ? {
              mode: "SPEND_BLOCK",
              spendAmountPerBlockMinor: mechanics.spendAmountPerBlockMinor!,
              unitsPerBlock: mechanics.pointsPerBlock!,
            }
          : { mode: "MANUAL", unitsPerAward: null };

    return {
      ...base,
      earnRule,
      dailyAwardLimit: mechanics.dailyAwardLimit ?? null,
      requirePurchaseAmount: mechanics.requirePurchaseAmount,
      welcomeUnits: mechanics.welcomePoints ?? 0,
      stampReward: null,
      pointsLabel: mechanics.pointsLabel ?? null,
      availableLocations: locations,
    };
  }

  const earnRule: ProgramEarnRule =
    mechanics.earnMode === "PER_VISIT"
      ? { mode: "PER_VISIT", unitsPerAward: 1 }
      : mechanics.earnMode === "SPEND_BLOCK"
        ? {
            mode: "SPEND_BLOCK",
            spendAmountPerBlockMinor: mechanics.spendAmountPerBlockMinor!,
            unitsPerBlock: mechanics.stampsPerBlock!,
          }
        : { mode: "MANUAL", unitsPerAward: null };

  return {
    ...base,
    earnRule,
    dailyAwardLimit: mechanics.dailyAwardLimit ?? null,
    requirePurchaseAmount: mechanics.requirePurchaseAmount,
    welcomeUnits: mechanics.welcomeStamps ?? 0,
    stampReward: {
      stampsRequiredPerReward: mechanics.stampsRequiredPerReward,
      rewardName: mechanics.rewardName,
      rewardValueMinor: mechanics.rewardValueMinor ?? null,
    },
    pointsLabel: null,
    availableLocations: locations,
  };
}

/**
 * Which programs and locations a staff member may actually operate right now.
 *
 * The scanner needs this before it can write anything: with one program and one counter there is
 * nothing to choose, and with several the core **refuses to guess** — so the screen has to ask, and
 * it can only ask about combinations the server would accept.
 *
 * Everything here is resolved from the caller's own membership. A location the member is not
 * assigned to never appears, so the picker cannot offer an option the write would then refuse.
 */
export interface ScannerScope {
  programs: {
    templateId: string;
    name: string;
    cardType: CardType;
    /** Null = Main only. Otherwise the counters this program runs at that the member may use. */
    locations: { id: string; name: string }[] | null;
  }[];
  /** The business's Main location, which is where a Main-only program writes. */
  defaultLocationId: string | null;
  /**
   * Every ACTIVE counter this member may operate at, whatever program it belongs to.
   *
   * The counter screen intersects this with the CARD's own pinned locations, which is the only pair
   * that gives the right answer: the card says where its rules allow, and this says where the
   * business is still open and this member is still assigned. A counter closed this morning
   * disappears from here without any card changing.
   */
  usableLocations: { id: string; name: string }[];
}

export async function getScannerScope(ctx: TenantContext): Promise<ScannerScope> {
  requirePermission(ctx, Permission.VIEW_CUSTOMERS);

  const [templates, locations] = await Promise.all([
    prisma.programTemplate.findMany({
      where: {
        businessId: ctx.businessId,
        status: TemplateStatus.ACTIVE,
        versions: { some: { status: ProgramVersionStatus.ACTIVE } },
      },
      select: {
        id: true,
        name: true,
        cardType: true,
        versions: { where: { status: ProgramVersionStatus.ACTIVE }, select: { mechanics: true }, take: 1 },
      },
      orderBy: { createdAt: "asc" },
    }),
    prisma.location.findMany({
      where: { businessId: ctx.businessId, active: true },
      select: { id: true, name: true, isDefault: true },
      orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
    }),
  ]);

  const byId = new Map(locations.map((l) => [l.id, l]));
  const mayUse = (id: string) => ctx.locationIds === null || ctx.locationIds.includes(id);

  return {
    programs: templates.map((t) => {
      const mechanics = t.versions[0]?.mechanics;
      const listed =
        mechanics === undefined
          ? null
          : isPointsMechanics(mechanics)
            ? readAvailableLocations(readPointsMechanics(mechanics))
            : isStampMechanics(mechanics)
              ? readAvailableLocations(readStampMechanics(mechanics))
              : null;

      return {
        templateId: t.id,
        name: t.name,
        cardType: t.cardType,
        locations:
          listed === null
            ? null
            : listed
                .filter((id) => byId.has(id) && mayUse(id))
                .map((id) => ({ id, name: byId.get(id)!.name })),
      };
    }),
    defaultLocationId: locations.find((l) => l.isDefault)?.id ?? null,
    usableLocations: locations.filter((l) => mayUse(l.id)).map((l) => ({ id: l.id, name: l.name })),
  };
}
