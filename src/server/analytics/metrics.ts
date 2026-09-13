import { CardType, Permission, Prisma } from "@prisma/client";
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
 * ## Where the counting happens (Phase 1b finding M-12, closed)
 *
 * It used to happen in Node. `groupBy(["transactionGroupId"])` returned one row per counter event in
 * the range and `.length` counted them; the per-location and per-template breakdowns returned one
 * row per (location, group) pair and counted them in a `Map`; `liveRedemptions` fetched every
 * redemption and every reversal of one and subtracted the sets. All of that is correct, and all of
 * it moves the whole range across the wire to count it. A café doing two hundred operations a day
 * was fine; the same query over a 400-day range at a busy branch is tens of thousands of rows
 * fetched to produce eleven integers.
 *
 * Every count is now a PostgreSQL aggregate, and every query in this file returns either **one row**
 * or **one row per location or per program**. `COUNT(DISTINCT "transactionGroupId")` is the whole
 * reason it is raw SQL: Prisma's `groupBy` cannot express a distinct count, so the choice was
 * between fetching the distinct values or writing the aggregate. The definitions in the table above
 * did not change, and the tests that pinned them were written before this and still pass.
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
function scopedLocationIds(ctx: TenantContext, query: MetricsQuery): string[] | undefined {
  if (ctx.locationIds === null) return query.locationId ? [query.locationId] : undefined;
  return query.locationId ? ctx.locationIds.filter((id) => id === query.locationId) : [...ctx.locationIds];
}


/**
 * The same scope as a SQL predicate, for the aggregates Prisma cannot express.
 *
 * Every value is a bound parameter — `Prisma.sql` interpolates placeholders, never text — so a
 * template id or a location id is data at every step. An EMPTY allowed-location list becomes
 * `IN (NULL)`, which matches nothing: a member restricted to no locations sees no numbers, which is
 * the same answer the Prisma path gives and the only safe reading of "assigned nowhere".
 */
function sqlScope(ctx: TenantContext, query: MetricsQuery): Prisma.Sql {
  const locationIds = scopedLocationIds(ctx, query);
  return Prisma.sql`
        o."businessId" = ${ctx.businessId}
    AND o."createdAt" >= ${query.from} AND o."createdAt" < ${query.to}
    ${query.templateId ? Prisma.sql`AND o."templateId" = ${query.templateId}` : Prisma.empty}
    ${
      locationIds
        ? Prisma.sql`AND o."locationId" IN (${locationIds.length > 0 ? Prisma.join(locationIds) : Prisma.sql`NULL`})`
        : Prisma.empty
    }`;
}

/** Postgres returns `bigint` for COUNT and SUM; the API speaks in numbers. */
function num(value: bigint | number | null): number {
  return value === null ? 0 : Number(value);
}

interface HeadlineRow {
  groups: bigint;
  reversalGroups: bigint;
  visits: bigint;
  stamps: bigint | null;
  points: bigint | null;
  redemptions: bigint;
  redemptionValue: bigint | null;
  repeatCustomers: bigint;
}

interface LocationRow {
  locationId: string;
  transactions: bigint;
  visits: bigint;
  redemptions: bigint;
}

interface TemplateRow {
  templateId: string;
  transactions: bigint;
  redemptions: bigint;
}

/**
 * "A redemption the merchant took back is not a reward given", as a SQL predicate.
 *
 * `NOT EXISTS` rather than a `LEFT JOIN … IS NULL` or a fetched id set: it stops at the first
 * matching reversal, uses `LoyaltyOperation_reversalOfOperationId_key`, and reads the same way as
 * the sentence it implements.
 */
const NOT_REVERSED = Prisma.sql`
  NOT EXISTS (SELECT 1 FROM "LoyaltyOperation" r WHERE r."reversalOfOperationId" = o."id")`;

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
  if (query.locationId) {
    const owned = await prisma.location.count({ where: { id: query.locationId, businessId: ctx.businessId } });
    if (owned === 0) throw new ValidationError("That location does not belong to this business");
  }
  const where = sqlScope(ctx, query);

  /*
   * Four queries, and each one returns a bounded result: one row, or one row per location, or one
   * row per program. Issued in parallel because they are independent reads of the same range —
   * and inside one range, so eleven tiles cannot be taken at eleven different moments.
   */
  const [headline, byLocationRows, byTemplateRows, cardsIssued, cardsByTemplate, locations, templates] = await Promise.all([
    prisma.$queryRaw<HeadlineRow[]>`
      SELECT
        -- The ::text cast is for the parameterised lists only. A string LITERAL coerces to the
        -- enum type; a bound parameter arrives as text, and PostgreSQL compares neither for you.
        COUNT(DISTINCT o."transactionGroupId")                                              AS "groups",
        COUNT(DISTINCT o."transactionGroupId") FILTER (WHERE o."kind" = 'REVERSAL')         AS "reversalGroups",
        COUNT(*) FILTER (WHERE o."countsAsVisit")                                           AS "visits",
        SUM(o."quantity") FILTER (WHERE o."unitType" = 'STAMP' AND o."quantity" > 0
                                    AND o."kind"::text IN (${Prisma.join([...AWARD_KINDS])})) AS "stamps",
        SUM(o."quantity") FILTER (WHERE o."unitType" = 'POINT' AND o."quantity" > 0
                                    AND o."kind"::text IN (${Prisma.join([...AWARD_KINDS])})) AS "points",
        COUNT(*)               FILTER (WHERE o."kind" = 'REWARD_REDEEMED' AND ${NOT_REVERSED}) AS "redemptions",
        COALESCE(SUM(o."redemptionValueMinor")
                 FILTER (WHERE o."kind" = 'REWARD_REDEEMED' AND ${NOT_REVERSED}), 0)        AS "redemptionValue",
        COUNT(DISTINCT o."customerBusinessProfileId") FILTER (
          WHERE EXISTS (
            SELECT 1 FROM "CustomerBusinessProfile" p
             WHERE p."id" = o."customerBusinessProfileId" AND p."firstSeenAt" < ${query.from}))  AS "repeatCustomers"
        FROM "LoyaltyOperation" o
       WHERE ${where}`,

    prisma.$queryRaw<LocationRow[]>`
      SELECT o."locationId"                                                                  AS "locationId",
             COUNT(DISTINCT o."transactionGroupId")
               FILTER (WHERE o."kind" <> 'REVERSAL')                                         AS "transactions",
             COUNT(*) FILTER (WHERE o."countsAsVisit")                                       AS "visits",
             COUNT(*) FILTER (WHERE o."kind" = 'REWARD_REDEEMED' AND ${NOT_REVERSED})        AS "redemptions"
        FROM "LoyaltyOperation" o
       WHERE ${where}
       GROUP BY o."locationId"`,

    prisma.$queryRaw<TemplateRow[]>`
      SELECT o."templateId"                                                                  AS "templateId",
             COUNT(DISTINCT o."transactionGroupId")
               FILTER (WHERE o."kind" <> 'REVERSAL')                                         AS "transactions",
             COUNT(*) FILTER (WHERE o."kind" = 'REWARD_REDEEMED' AND ${NOT_REVERSED})        AS "redemptions"
        FROM "LoyaltyOperation" o
       WHERE ${where}
       GROUP BY o."templateId"`,

    // Cards and profiles are not ledger rows, so they are ordinary counts on their own indexes.
    prisma.customerCard.count({
      where: {
        businessId: ctx.businessId,
        issuedAt: { gte: query.from, lt: query.to },
        ...(query.templateId ? { templateId: query.templateId } : {}),
      },
    }),
    prisma.customerCard.groupBy({
      by: ["templateId"],
      where: {
        businessId: ctx.businessId,
        issuedAt: { gte: query.from, lt: query.to },
        ...(query.templateId ? { templateId: query.templateId } : {}),
      },
      _count: { _all: true },
    }),
    prisma.location.findMany({ where: { businessId: ctx.businessId }, select: { id: true, name: true } }),
    prisma.programTemplate.findMany({
      where: { businessId: ctx.businessId, ...(query.templateId ? { id: query.templateId } : {}) },
      select: { id: true, name: true, cardType: true },
    }),
  ]);

  const newCustomers = await prisma.customerBusinessProfile.count({
    where: { businessId: ctx.businessId, firstSeenAt: { gte: query.from, lt: query.to } },
  });

  // An empty range produces no row from an aggregate with GROUP BY, and one all-zero row from one
  // without. Both are handled rather than assumed.
  const h = headline[0];
  const groups = num(h?.groups ?? 0);
  const reversals = num(h?.reversalGroups ?? 0);

  const locationNames = new Map(locations.map((l) => [l.id, l.name]));
  const cardsPerTemplate = new Map(cardsByTemplate.map((c) => [c.templateId, c._count._all]));

  return {
    range: { from: query.from, to: query.to },
    transactions: groups - reversals,
    reversals,
    visits: num(h?.visits ?? 0),
    newCustomers,
    repeatCustomers: num(h?.repeatCustomers ?? 0),
    cardsIssued,
    rewardsRedeemed: num(h?.redemptions ?? 0),
    rewardValueMinorRedeemed: num(h?.redemptionValue ?? 0),
    unitsAwarded: { stamps: num(h?.stamps ?? 0), points: num(h?.points ?? 0) },
    /*
     * Driven by the aggregate rows, not by the location list: a counter with nothing in the range
     * produces no row and therefore no line, which is what the previous `.filter(...)` achieved by
     * building every line and throwing the empty ones away. A location the aggregate names but the
     * business no longer lists cannot occur — `locationId` is a foreign key — so a missing name is
     * an invariant break rather than a case to paper over, and it is left visible as an empty name.
     */
    byLocation: byLocationRows.map((row) => ({
      locationId: row.locationId,
      name: locationNames.get(row.locationId) ?? "",
      transactions: num(row.transactions),
      visits: num(row.visits),
      rewardsRedeemed: num(row.redemptions),
    })),
    byTemplate: templates
      .map((t) => {
        const row = byTemplateRows.find((r) => r.templateId === t.id);
        return {
          templateId: t.id,
          name: t.name,
          cardType: t.cardType,
          cardsIssued: cardsPerTemplate.get(t.id) ?? 0,
          transactions: num(row?.transactions ?? 0),
          rewardsRedeemed: num(row?.redemptions ?? 0),
        };
      })
      // A program with no cards and no activity in the range is not a line on a dashboard.
      .filter((t) => t.cardsIssued > 0 || t.transactions > 0 || t.rewardsRedeemed > 0),
  };
}
