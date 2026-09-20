import { CardType, Permission, ProgramVersionStatus, TemplateStatus } from "@prisma/client";
import { prisma } from "../db";
import { NotFoundError } from "../errors";
import { requirePermission, type TenantContext } from "../tenant/context";
import { MonetaryProgramKind, readMonetaryMechanics } from "../monetary/mechanics";
import { assertNeverCardType, isMonetaryCardType, readVersionAvailableLocations } from "./card-type-support";
import { readStampMechanics, type StampMechanics } from "./mechanics";
import { readPointsMechanics, type PointsMechanics } from "./points-mechanics";

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

  /**
   * How units are earned, in the unit this programme counts.
   *
   * **Null for a money programme**, and not as a placeholder: cashback and discount do not earn
   * "units per visit" or "units per block of spend" at all. They apply a rate in basis points to an
   * invoice a member of staff typed, which is a different shape of rule and has its own screen in
   * Phase 4 Prompt 2. Rendering a money programme's rate through this field would mean inventing a
   * unit for it; rendering `MANUAL, null` would be a plausible lie.
   */
  earnRule: ProgramEarnRule | null;
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

  /*
   * Locations first, through the resolver that knows every contract. A money version's pinned
   * counters are read here exactly as a stamp version's are - this screen shows WHERE a programme
   * runs, which is a question every programme can answer.
   */
  const locationIds = readVersionAvailableLocations(version.mechanics);
  const locations =
    locationIds === null
      ? null
      : await prisma.location.findMany({
          where: { id: { in: [...locationIds] }, businessId: ctx.businessId },
          select: { id: true, name: true },
          orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
        });

  /*
   * A MONEY PROGRAMME RETURNS THE COMMON FIELDS AND NOTHING IT DOES NOT HAVE.
   *
   * This dispatch was `POINTS ? readPoints : readStamp`, so a cashback template's detail page read
   * its mechanics through the STAMP contract and the screen failed with "does not hold valid stamp
   * mechanics" - a 422 blaming the data on a page an owner reaches by clicking their own programme
   * in the list.
   *
   * The honest answer is not a stamp-shaped guess and not an error: it is the name, the type, the
   * version, the card count and the counters - all of which are true of a money programme - with
   * every stamp/points-specific field null. Its rates are frozen in `MonetaryRule`/`MonetaryTier`
   * and get their own screen in Prompt 2.
   */
  if (isMonetaryCardType(template.cardType)) {
    readMonetaryMechanics(
      version.mechanics,
      template.cardType === CardType.CASHBACK ? MonetaryProgramKind.CASHBACK : MonetaryProgramKind.DISCOUNT,
      { programVersionId: version.id },
    );
    return {
      ...base,
      earnRule: null,
      dailyAwardLimit: null,
      requirePurchaseAmount: false,
      welcomeUnits: 0,
      stampReward: null,
      pointsLabel: null,
      availableLocations: locations,
    };
  }

  /*
   * Read through the contract that owns the row, chosen by the template's own card type. A version
   * that parses as neither is corrupt, and a 422 from the reader is the right answer for a screen
   * that would otherwise render a guess.
   *
   * EXHAUSTIVE, not a ternary with an implicit stamp arm. The money types have already returned
   * above, so a `default` here can only be a card type nobody has thought about - and
   * `assertNeverCardType` makes that a COMPILE error rather than a stamp-shaped guess.
   */
  const mechanics = ((): StampMechanics | PointsMechanics => {
    switch (template.cardType) {
      case CardType.POINTS:
        return readPointsMechanics(version.mechanics, { programVersionId: version.id });
      case CardType.STAMP:
        return readStampMechanics(version.mechanics, { programVersionId: version.id });
      case CardType.CASHBACK:
      case CardType.DISCOUNT:
        // Unreachable: handled by the early return above. Named so the switch stays exhaustive.
        throw new Error("unreachable: money card types return earlier");
      default:
        return assertNeverCardType(template.cardType);
    }
  })();

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
/**
 * Card types the counter screen can actually operate.
 *
 * Phase 4 added `CASHBACK` and `DISCOUNT` to `CardType`, and THIS screen does not understand either:
 * its controls are stamp counts and reward ladders, and a money card has a currency balance and a
 * spend-dependent rate instead. Listing one here would put a program in the picker that every write
 * refuses - the cashier would have a customer in front of them and no way to tell why nothing works.
 *
 * Prompt 2 did not grow this set. It built money its own counter at `/scanner/money`, reached by
 * its dedicated lookup flow. The two screens stay separate because they share no control, not because
 * one is unfinished.
 */
export const SCANNER_CARD_TYPES = [CardType.STAMP, CardType.POINTS] as const;
export type ScannerCardType = (typeof SCANNER_CARD_TYPES)[number];

export interface ScannerScope {
  programs: {
    templateId: string;
    name: string;
    cardType: ScannerCardType;
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
        // See SCANNER_CARD_TYPES: a money program is served by its own counter, and offering one
        // here - where every write would refuse it - is worse than not offering it at all.
        cardType: { in: [...SCANNER_CARD_TYPES] },
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
      // Narrowed by the query above; asserted here so the cast is a single, named line.
      const cardType = t.cardType as ScannerCardType;
      // One resolver, exhaustive over every contract. The query above already restricts this list
      // to SCANNER_CARD_TYPES, so money cannot arrive here - but the ladder this replaces is the
      // shape that dropped money versions everywhere else, and leaving one behind invites the next.
      const mechanics = t.versions[0]?.mechanics;
      const listed = mechanics === undefined ? null : readVersionAvailableLocations(mechanics);

      return {
        templateId: t.id,
        name: t.name,
        cardType,
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
