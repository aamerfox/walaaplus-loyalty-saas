import { CardType, OperationKind, Permission, UnitType } from "@prisma/client";
import { prisma } from "../db";
import { ValidationError } from "../errors";
import { AWARD_KINDS } from "../ledger/visits";
import { requirePermission, type TenantContext } from "../tenant/context";

/**
 * What a merchant's dashboard is allowed to say.
 *
 * Every number here is **derived from the ledger and the cards**. Nothing is stored as a counter,
 * nothing is incremented on write, and nothing is invented. That is not a stylistic preference: a
 * cached metric is a second source of truth, and the first time it disagrees with the ledger the
 * merchant is left choosing which of their own screens to believe. Recomputing is cheap at pilot
 * scale and correct at every scale.
 *
 * Read-only, tenant-scoped, and gated on `VIEW_DASHBOARD` — which an owner and a manager hold and a
 * cashier does not. There is no write path in this file.
 *
 * ## The definitions, stated once so two screens cannot disagree
 *
 * | Metric | Exactly |
 * |---|---|
 * | **transactions** | distinct `transactionGroupId` of non-reversal rows in the range. One counter event — an award that also completed a reward — is ONE transaction, not three |
 * | **reversals** | distinct groups whose rows are `REVERSAL` |
 * | **visits** | rows with the frozen `countsAsVisit` flag. The flag is decided once, at write time, by the Phase 0 visit policy; this read never re-derives it |
 * | **rewardsRedeemed** | `REWARD_REDEEMED` rows **minus** those since reversed. A redemption the merchant took back is not a reward given |
 * | **rewardValueMinorRedeemed** | sum of `redemptionValueMinor` over those same rows: what the rewards cost the merchant |
 * | **unitsAwarded** | sum of positive quantities on award kinds, per unit. Stamps and points are reported separately because adding them would be meaningless |
 * | **newCustomers** | profiles whose `firstSeenAt` falls inside the range |
 * | **repeatCustomers** | profiles that transacted inside the range and were first seen BEFORE it |
 * | **cardsIssued** | cards whose `issuedAt` falls inside the range |
 *
 * "New vs repeat" is the one worth defending. It counts people, not cards: a customer holding a
 * stamp card and a points card from the same business is one customer, because
 * `CustomerBusinessProfile` is per business and both cards hang off it. And it is anchored on
 * `firstSeenAt` rather than on "first operation in this range", so a customer who enrolled in
 * January and came back in March is repeat in March — which is what the merchant means by the word.
 */

export interface MetricsRange {
  /** Inclusive. */
  from: Date;
  /** Exclusive, so adjacent ranges never double-count the boundary row. */
  to: Date;
}

export interface MetricsQuery extends MetricsRange {
  /** Narrow to one program. Must belong to the caller's business. */
  templateId?: string;
  /** Narrow to one counter. Must belong to the caller's business. */
  locationId?: string;
}

export interface LocationBreakdown {
  locationId: string;
  name: string;
  transactions: number;
  visits: number;
  rewardsRedeemed: number;
}

export interface TemplateBreakdown {
  templateId: string;
  name: string;
  cardType: CardType;
  cardsIssued: number;
  transactions: number;
  rewardsRedeemed: number;
}

export interface BusinessMetrics {
  range: MetricsRange;
  transactions: number;
  reversals: number;
  visits: number;
  newCustomers: number;
  repeatCustomers: number;
  cardsIssued: number;
  rewardsRedeemed: number;
  rewardValueMinorRedeemed: number;
  unitsAwarded: { stamps: number; points: number };
  byLocation: LocationBreakdown[];
  byTemplate: TemplateBreakdown[];
}

/** A range longer than this is refused: it is a report, not a dashboard, and it scans the ledger. */
export const MAX_RANGE_DAYS = 400;

function assertRange(range: MetricsRange): void {
  if (!(range.from instanceof Date) || !(range.to instanceof Date) || Number.isNaN(range.from.getTime()) || Number.isNaN(range.to.getTime())) {
    throw new ValidationError("from and to must be dates");
  }
  if (range.to.getTime() <= range.from.getTime()) throw new ValidationError("to must be after from");
  const days = (range.to.getTime() - range.from.getTime()) / 86_400_000;
  if (days > MAX_RANGE_DAYS) throw new ValidationError(`A range may cover at most ${MAX_RANGE_DAYS} days`);
}

/**
 * The tenant filter every query in this file starts from.
 *
 * `ctx.locationIds` is applied when it is not null. Today only a CASHIER is location-restricted and
 * a cashier does not hold `VIEW_DASHBOARD`, so this is defence in depth rather than a live path —
 * but the moment Phase 1b's permission editor can grant `VIEW_DASHBOARD` to a restricted
 * membership, a dashboard that ignored the restriction would show them every branch's takings.
 */
function operationScope(ctx: TenantContext, query: MetricsQuery) {
  const locationIds =
    ctx.locationIds === null
      ? query.locationId
        ? [query.locationId]
        : undefined
      : query.locationId
        ? ctx.locationIds.filter((id) => id === query.locationId)
        : [...ctx.locationIds];

  return {
    businessId: ctx.businessId,
    createdAt: { gte: query.from, lt: query.to },
    ...(query.templateId ? { templateId: query.templateId } : {}),
    ...(locationIds ? { locationId: { in: locationIds } } : {}),
  };
}

/** Ids of reward redemptions in scope that have NOT been reversed, with what they cost. */
async function liveRedemptions(scope: ReturnType<typeof operationScope>) {
  const redemptions = await prisma.loyaltyOperation.findMany({
    where: { ...scope, kind: OperationKind.REWARD_REDEEMED },
    select: { id: true, redemptionValueMinor: true, locationId: true, templateId: true },
  });
  if (redemptions.length === 0) return [];

  const reversals = await prisma.loyaltyOperation.findMany({
    where: { reversalOfOperationId: { in: redemptions.map((r) => r.id) } },
    select: { reversalOfOperationId: true },
  });
  const reversed = new Set(reversals.map((r) => r.reversalOfOperationId));
  return redemptions.filter((r) => !reversed.has(r.id));
}

/**
 * Every headline figure for one business and one range.
 *
 * Deliberately one function rather than one per tile: a dashboard that issues eleven independent
 * queries can render eleven numbers taken at eleven different moments, and the first thing a
 * merchant does is add them up.
 */
export async function getBusinessMetrics(ctx: TenantContext, query: MetricsQuery): Promise<BusinessMetrics> {
  requirePermission(ctx, Permission.VIEW_DASHBOARD);
  assertRange(query);
  if (query.templateId) {
    const owned = await prisma.programTemplate.count({ where: { id: query.templateId, businessId: ctx.businessId } });
    // Tenant-scoped: another business's template id reports nothing rather than reporting theirs.
    if (owned === 0) throw new ValidationError("That program does not belong to this business");
  }
  const scope = operationScope(ctx, query);

  const [groups, visits, awards, redemptions, locations, templates] = await Promise.all([
    // One row per group, so "transactions" counts counter events rather than ledger rows.
    prisma.loyaltyOperation.groupBy({
      by: ["transactionGroupId"],
      where: scope,
      _max: { kind: true },
    }),
    prisma.loyaltyOperation.count({ where: { ...scope, countsAsVisit: true } }),
    prisma.loyaltyOperation.groupBy({
      by: ["unitType"],
      where: { ...scope, kind: { in: [...AWARD_KINDS] }, quantity: { gt: 0 } },
      _sum: { quantity: true },
    }),
    liveRedemptions(scope),
    prisma.location.findMany({ where: { businessId: ctx.businessId }, select: { id: true, name: true } }),
    prisma.programTemplate.findMany({
      where: { businessId: ctx.businessId, ...(query.templateId ? { id: query.templateId } : {}) },
      select: { id: true, name: true, cardType: true },
    }),
  ]);

  /*
   * A group is a reversal group when its rows are REVERSAL rows. `_max: { kind }` is enough to tell:
   * the ledger writes a group of one kind on the compensating side, and REVERSAL sorts last among
   * the enum values, so a mixed group could never be produced by `reverseOperationGroup` anyway.
   */
  const reversals = groups.filter((g) => g._max.kind === OperationKind.REVERSAL).length;

  const [newCustomers, repeatProfiles, cardsIssued] = await Promise.all([
    prisma.customerBusinessProfile.count({
      where: { businessId: ctx.businessId, firstSeenAt: { gte: query.from, lt: query.to } },
    }),
    // People who transacted in the range and existed before it. Distinct profiles, not rows.
    prisma.loyaltyOperation.groupBy({
      by: ["customerBusinessProfileId"],
      where: { ...scope, profile: { firstSeenAt: { lt: query.from } } },
    }),
    prisma.customerCard.count({
      where: {
        businessId: ctx.businessId,
        issuedAt: { gte: query.from, lt: query.to },
        ...(query.templateId ? { templateId: query.templateId } : {}),
      },
    }),
  ]);

  const [byLocationGroups, byTemplateGroups, cardsByTemplate] = await Promise.all([
    prisma.loyaltyOperation.groupBy({ by: ["locationId", "transactionGroupId"], where: scope }),
    prisma.loyaltyOperation.groupBy({ by: ["templateId", "transactionGroupId"], where: scope }),
    prisma.customerCard.groupBy({
      by: ["templateId"],
      where: {
        businessId: ctx.businessId,
        issuedAt: { gte: query.from, lt: query.to },
        ...(query.templateId ? { templateId: query.templateId } : {}),
      },
      _count: { _all: true },
    }),
  ]);

  const visitsByLocation = await prisma.loyaltyOperation.groupBy({
    by: ["locationId"],
    where: { ...scope, countsAsVisit: true },
    _count: { _all: true },
  });

  const countBy = <K extends string>(rows: { [P in K]: string }[], key: K): Map<string, number> => {
    const out = new Map<string, number>();
    for (const row of rows) out.set(row[key], (out.get(row[key]) ?? 0) + 1);
    return out;
  };

  const groupsPerLocation = countBy(byLocationGroups, "locationId");
  const groupsPerTemplate = countBy(byTemplateGroups, "templateId");
  const redemptionsPerLocation = countBy(redemptions, "locationId");
  const redemptionsPerTemplate = countBy(redemptions, "templateId");
  const visitsPerLocation = new Map(visitsByLocation.map((v) => [v.locationId, v._count._all]));
  const cardsPerTemplate = new Map(cardsByTemplate.map((c) => [c.templateId, c._count._all]));

  const awarded = (unit: UnitType) => awards.find((a) => a.unitType === unit)?._sum.quantity ?? 0;

  return {
    range: { from: query.from, to: query.to },
    transactions: groups.length - reversals,
    reversals,
    visits,
    newCustomers,
    repeatCustomers: repeatProfiles.length,
    cardsIssued,
    rewardsRedeemed: redemptions.length,
    rewardValueMinorRedeemed: redemptions.reduce((sum, r) => sum + (r.redemptionValueMinor ?? 0), 0),
    unitsAwarded: { stamps: awarded(UnitType.STAMP), points: awarded(UnitType.POINT) },
    byLocation: locations
      .map((l) => ({
        locationId: l.id,
        name: l.name,
        transactions: groupsPerLocation.get(l.id) ?? 0,
        visits: visitsPerLocation.get(l.id) ?? 0,
        rewardsRedeemed: redemptionsPerLocation.get(l.id) ?? 0,
      }))
      .filter((l) => l.transactions > 0 || l.visits > 0 || l.rewardsRedeemed > 0),
    byTemplate: templates
      .map((t) => ({
        templateId: t.id,
        name: t.name,
        cardType: t.cardType,
        cardsIssued: cardsPerTemplate.get(t.id) ?? 0,
        transactions: groupsPerTemplate.get(t.id) ?? 0,
        rewardsRedeemed: redemptionsPerTemplate.get(t.id) ?? 0,
      }))
      .filter((t) => t.cardsIssued > 0 || t.transactions > 0 || t.rewardsRedeemed > 0),
  };
}
