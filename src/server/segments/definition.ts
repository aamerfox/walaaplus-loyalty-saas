import { CardType, type Prisma } from "@prisma/client";
import { z } from "zod";
import { ValidationError } from "../errors";

/**
 * What a segment is allowed to say.
 *
 * ## A definition, not a query
 *
 * A saved segment is a small, validated object. It is never a SQL fragment, never a Prisma
 * `where`, and never a list of customers copied out of the database. Every field and every
 * operator below is on an allowlist; anything else is refused, including a field that merely does
 * not exist yet. That is what makes it safe to store a merchant's own selection and re-evaluate it
 * months later against data that has moved on.
 *
 * The **contract version** is stored with each definition, for the same reason a program version
 * stores its `contractVersion`: a future shape can be added without rewriting what merchants have
 * already saved.
 *
 * ## The one semantic decision worth reading
 *
 * A segment selects **customers**, not cards. Most of the conditions, though, are facts about a
 * CARD — which program, which balance, which source. So "program is the coffee card AND stamps ≥ 5"
 * has two possible readings:
 *
 *  1. the customer has a coffee card, and the customer has *some* card with 5 stamps;
 *  2. the customer has a coffee card *with* 5 stamps on it.
 *
 * **This product means (2).** Every card-scoped condition in an `all` segment must be satisfied by
 * the SAME card. Reading (1) is the one a naive `AND` of subqueries produces, and it is the one
 * that quietly sends "5 stamps from a free coffee" to somebody whose five stamps are on a different
 * programme entirely. The `some: { AND: [...] }` below is that decision, in one line.
 *
 * `match: "any"` is the mirror: the customer has at least one card satisfying at least one of the
 * card conditions, or satisfies a profile condition directly.
 *
 * ## Scoped fields
 *
 * | Field | Scope | Proven by |
 * |---|---|---|
 * | `program` | card | `CustomerCard.templateId` |
 * | `cardType` | card | the card's template |
 * | `programVersion` | card | the version the card is PINNED to |
 * | `stampBalance`, `pointBalance`, `rewardBalance` | card | the ledger's projections on the card |
 * | `source` | card | `UtmSourceLink.name` — the display name, never the token |
 * | `servedAtLocation` | card | a ledger row written at that branch |
 * | `joinedAt` | profile | `CustomerBusinessProfile.firstSeenAt` |
 * | `lastActivityAt` | card | `CustomerCard.lastActivityAt` |
 *
 * **`servedAtLocation` means "has been served there", not "is allowed there".** A card's eligible
 * branches live inside its pinned mechanics JSON, which is not a queryable column and deliberately
 * so; what the system can actually prove is where value was written. A segment that claimed
 * eligibility would be guessing, so this one says what it means.
 */

export const SEGMENT_DEFINITION_VERSION = 1;

/** A segment may hold this many conditions. Enough for any real selection, small enough to read. */
export const MAX_CONDITIONS = 10;

const id = z.string().trim().min(1).max(64);
const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Dates are YYYY-MM-DD");

/** A numeric range. At least one end is required; both ends make it a band. */
const range = z
  .strictObject({
    min: z.number().int().min(0).max(1_000_000).optional(),
    max: z.number().int().min(0).max(1_000_000).optional(),
  })
  .refine((v) => v.min !== undefined || v.max !== undefined, { message: "A range needs a minimum, a maximum, or both" })
  .refine((v) => v.min === undefined || v.max === undefined || v.min <= v.max, {
    message: "A range's minimum must not exceed its maximum",
  });

const dateRange = z
  .strictObject({ after: localDate.optional(), before: localDate.optional() })
  .refine((v) => v.after !== undefined || v.before !== undefined, { message: "A date range needs one end or both" });

export const conditionSchema = z.discriminatedUnion("field", [
  z.strictObject({ field: z.literal("program"), templateId: id }),
  z.strictObject({ field: z.literal("cardType"), cardType: z.enum([CardType.STAMP, CardType.POINTS]) }),
  z.strictObject({ field: z.literal("programVersion"), templateId: id, versionNumber: z.number().int().min(1).max(10_000) }),
  z.strictObject({ field: z.literal("stampBalance"), range }),
  z.strictObject({ field: z.literal("pointBalance"), range }),
  z.strictObject({ field: z.literal("rewardBalance"), range }),
  z.strictObject({ field: z.literal("source"), name: z.string().trim().min(1).max(120) }),
  z.strictObject({ field: z.literal("servedAtLocation"), locationId: id }),
  z.strictObject({ field: z.literal("joinedAt"), dateRange }),
  z.strictObject({ field: z.literal("lastActivityAt"), dateRange }),
]);
export type SegmentCondition = z.infer<typeof conditionSchema>;

export const definitionSchema = z.strictObject({
  version: z.literal(SEGMENT_DEFINITION_VERSION),
  match: z.enum(["all", "any"]),
  conditions: z.array(conditionSchema).min(1).max(MAX_CONDITIONS),
});
export type SegmentDefinition = z.infer<typeof definitionSchema>;

/** Parse a definition supplied by a merchant. Throws with the field issues, never a stack trace. */
export function parseDefinition(input: unknown): SegmentDefinition {
  const parsed = definitionSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError("Invalid segment", parsed.error.issues);
  return parsed.data;
}

/**
 * Read a definition ALREADY STORED on a segment.
 *
 * A failure here is a corrupt row rather than bad input — nothing writes this column except the
 * service above — so it is reported as such and the segment is shown as unreadable instead of being
 * silently evaluated as "everybody", which is the one wrong answer that could send a campaign to a
 * whole customer base.
 */
export function readDefinition(stored: unknown): SegmentDefinition | null {
  const parsed = definitionSchema.safeParse(stored);
  return parsed.success ? parsed.data : null;
}

/** Which side of the join a condition belongs to. */
function isProfileScoped(condition: SegmentCondition): boolean {
  return condition.field === "joinedAt";
}

/**
 * `YYYY-MM-DD` to the UTC instants bounding it. Inclusive at both ends.
 *
 * Returns Dates, and the type says so without a cast — the first version added a day in
 * milliseconds and handed Prisma a NUMBER where a Date belongs, which an `as` had hidden. The test
 * that compares the produced `where` is what caught it.
 *
 * Deliberately UTC rather than the business timezone. A segment is a standing rule with no clock
 * attached, evaluated at any hour by anyone; a boundary that moved with the reader's business day
 * would make "joined before 1 March" mean two different sets on two screens. The dashboard's date
 * RANGES are the opposite case and use the business day, because they describe a trading period.
 * The difference is documented in the segment screen's own copy.
 */
function dateBounds(dates: { after?: string; before?: string }): { gte?: Date; lt?: Date } {
  const midnight = (date: string) => new Date(`${date}T00:00:00.000Z`);
  const nextMidnight = (date: string) => new Date(midnight(date).getTime() + 86_400_000);
  return {
    ...(dates.after ? { gte: midnight(dates.after) } : {}),
    // Exclusive at the next midnight, so "before 7 March" includes the whole of the 7th.
    ...(dates.before ? { lt: nextMidnight(dates.before) } : {}),
  };
}

function numeric(r: { min?: number; max?: number }) {
  return { ...(r.min !== undefined ? { gte: r.min } : {}), ...(r.max !== undefined ? { lte: r.max } : {}) };
}

function cardWhere(condition: SegmentCondition, businessId: string): Prisma.CustomerCardWhereInput {
  switch (condition.field) {
    case "program":
      return { templateId: condition.templateId };
    case "cardType":
      // Through the template, which is where `cardType` lives and where it is locked at activation.
      return { template: { cardType: condition.cardType } };
    case "programVersion":
      return { templateId: condition.templateId, programVersion: { versionNumber: condition.versionNumber } };
    case "stampBalance":
      return { stampBalance: numeric(condition.range) };
    case "pointBalance":
      return { pointBalance: numeric(condition.range) };
    case "rewardBalance":
      return { rewardBalance: numeric(condition.range) };
    case "source":
      // By display NAME, tenant-scoped through the template. No token is read, matched or returned.
      return { utmSourceLink: { name: condition.name, template: { businessId } } };
    case "servedAtLocation":
      // "Served there", which is a ledger fact. Eligibility lives in immutable mechanics JSON and
      // is not a queryable column; a segment that claimed it would be guessing.
      return { operations: { some: { locationId: condition.locationId, businessId } } };
    case "lastActivityAt": {
      const bounds = dateBounds(condition.dateRange);
      return { lastActivityAt: bounds };
    }
    case "joinedAt":
      // Handled on the profile side; never reached.
      return {};
  }
}

function profileWhere(condition: SegmentCondition): Prisma.CustomerBusinessProfileWhereInput {
  if (condition.field !== "joinedAt") return {};
  return { firstSeenAt: dateBounds(condition.dateRange) };
}

/**
 * Turn a validated definition into the tenant-scoped `where` that selects the customers it means.
 *
 * `businessId` is applied at the top AND inside every nested card clause, so a condition naming
 * another business's program, source or branch selects nothing rather than reaching across the
 * tenant boundary. That is belt and braces on purpose: the service also verifies that every id in a
 * definition belongs to the caller before it is saved, and neither check is load-bearing alone.
 */
export function toProfileWhere(definition: SegmentDefinition, businessId: string): Prisma.CustomerBusinessProfileWhereInput {
  const cardConditions = definition.conditions.filter((c) => !isProfileScoped(c)).map((c) => cardWhere(c, businessId));
  const profileConditions = definition.conditions.filter(isProfileScoped).map(profileWhere);

  if (definition.match === "all") {
    return {
      businessId,
      ...(profileConditions.length > 0 ? { AND: profileConditions } : {}),
      // ONE card satisfying every card condition — see the note at the top of this file.
      ...(cardConditions.length > 0 ? { cards: { some: { businessId, AND: cardConditions } } } : {}),
    };
  }

  const alternatives: Prisma.CustomerBusinessProfileWhereInput[] = [
    ...profileConditions,
    ...(cardConditions.length > 0 ? [{ cards: { some: { businessId, OR: cardConditions } } }] : []),
  ];
  return { businessId, OR: alternatives };
}
