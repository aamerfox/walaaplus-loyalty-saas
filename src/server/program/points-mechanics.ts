import { z } from "zod";
import { LedgerInvariantError, ValidationError } from "../errors";
import { availableLocationsSchema } from "./available-locations";

/**
 * The points-program mechanics contract.
 *
 * Written the same way as the stamp contract next door, for the same reason: `ProgramVersion.
 * mechanics` is a JSON column, and JSON columns rot. Nothing may read that column directly —
 * everything goes through `readPointsMechanics`, which parses it or refuses.
 *
 * ## Why a points card is not a stamp card with a bigger threshold
 *
 * A stamp card converts automatically: reach the threshold and a reward appears in
 * `rewardBalance`, waiting to be handed over. A points card does not convert at all. Points
 * accumulate, and the CUSTOMER chooses which configured reward to spend them on — which is why
 * tiers are rows (`RewardTier`) that the ledger can reference by id, not numbers in this JSON.
 * Redemption debits points and records the tier; there is no intermediate reward balance, and
 * nothing is ever "earned" without a person asking for it.
 *
 * ## Integers, everywhere, with no exceptions
 *
 * Every quantity here is `z.number().int()`, every money field is integer minor units, and the two
 * earning rules floor-divide. There is no path in this contract or its engine where a float can
 * enter a balance: a points program that pays 1.5 points per 1,000 SYP is configured as 3 points
 * per 2,000 SYP instead. Floating point in a loyalty balance is a slow leak that shows up as a
 * customer whose 100 points display as 99.99999999999999.
 */

/** How points are earned. Phase 1b ships these three and no others. */
export const PointsEarnMode = {
  /** Staff decide the quantity, bounded by `maxPointsPerManualAward` when set. */
  MANUAL: "MANUAL",
  /** A fixed number of points per visit. */
  PER_VISIT: "PER_VISIT",
  /** Whole blocks of spend, floor-rounded, no remainder carried (PRODUCT-SPEC §5.5). */
  SPEND_BLOCK: "SPEND_BLOCK",
} as const;
export type PointsEarnMode = (typeof PointsEarnMode)[keyof typeof PointsEarnMode];

/** Current contract version. Pinned versions keep the number they were written with. */
export const POINTS_MECHANICS_CONTRACT_VERSION = 1;

/** Bounds: generous for a real merchant, and still a refusal for nonsense. */
export const MAX_POINTS_PER_AWARD = 1_000_000;
const MAX_POINTS_PER_VISIT = 100_000;
const MAX_DAILY_AWARD_LIMIT = 1_000;
const MAX_WELCOME_POINTS = 1_000_000;
/** 2^31-1 minor units: the ledger's money columns are 32-bit. */
const MAX_MINOR_UNITS = 2_147_483_647;

const positiveInt = (max: number) => z.number().int().min(1).max(max);

export const pointsMechanicsSchema = z
  .strictObject({
    /** Discriminator. The stamp schema carries "STAMP", so neither engine can read the other's rows. */
    kind: z.literal("POINTS"),
    contractVersion: z.literal(POINTS_MECHANICS_CONTRACT_VERSION),

    /** Shown wherever a balance is displayed: "نقطة", "point", "star". Presentation only. */
    pointsLabel: z.string().trim().min(1).max(40).optional(),

    earnMode: z.enum([PointsEarnMode.MANUAL, PointsEarnMode.PER_VISIT, PointsEarnMode.SPEND_BLOCK]),

    /** PER_VISIT only: points granted by one visit award. */
    pointsPerVisit: positiveInt(MAX_POINTS_PER_VISIT).optional(),

    /** SPEND_BLOCK only: the spend that earns one block, in integer minor units. */
    spendAmountPerBlockMinor: positiveInt(MAX_MINOR_UNITS).optional(),
    /** SPEND_BLOCK only: points granted per whole block. */
    pointsPerBlock: positiveInt(MAX_POINTS_PER_VISIT).optional(),

    /**
     * Ceiling on one manual award. A points program hands out numbers a cashier types, and a
     * mistyped 50000 for 500 is both a real loss and an unpleasant conversation with a customer
     * whose balance is then corrected downwards.
     */
    maxPointsPerManualAward: positiveInt(MAX_POINTS_PER_AWARD).optional(),

    /** When true, an award must state the purchase amount even outside SPEND_BLOCK. */
    requirePurchaseAmount: z.boolean().default(false),

    /** Award OPERATIONS per card per business-timezone day. Absent = no limit. */
    dailyAwardLimit: positiveInt(MAX_DAILY_AWARD_LIMIT).optional(),

    /** Frozen per row by the Phase 0 visit policy; see src/server/ledger/visits.ts. */
    countRewardRedemptionAsVisit: z.boolean().default(false),

    /** Points granted once on enrollment. Absent = none. */
    welcomePoints: positiveInt(MAX_WELCOME_POINTS).optional(),

    /**
     * Counters this version may be operated at. Absent = the business's Main location only, which
     * is the Phase 1a rule and the default for anything that does not ask for more.
     */
    availableLocations: availableLocationsSchema.optional(),
  })
  .superRefine((m, ctx) => {
    const visitOnly = ["pointsPerVisit"] as const;
    const spendOnly = ["spendAmountPerBlockMinor", "pointsPerBlock"] as const;

    const required = m.earnMode === PointsEarnMode.PER_VISIT ? visitOnly : m.earnMode === PointsEarnMode.SPEND_BLOCK ? spendOnly : [];
    const forbidden = [...visitOnly, ...spendOnly].filter((f) => !(required as readonly string[]).includes(f));

    for (const field of required) {
      if (m[field] === undefined) {
        ctx.addIssue({ code: "custom", path: [field], message: `${field} is required when earnMode is ${m.earnMode}` });
      }
    }
    for (const field of forbidden) {
      if (m[field] !== undefined) {
        ctx.addIssue({ code: "custom", path: [field], message: `${field} is not valid when earnMode is ${m.earnMode}` });
      }
    }
  });

/** Parsed, trusted mechanics. Every consumer takes this type, never the raw JSON. */
export type PointsMechanics = z.infer<typeof pointsMechanicsSchema>;
/** What a caller supplies: defaults not yet applied. */
export type PointsMechanicsInput = z.input<typeof pointsMechanicsSchema>;

/** Validate mechanics supplied by a merchant. Use at the boundary where a program is created. */
export function parsePointsMechanics(input: unknown): PointsMechanics {
  const parsed = pointsMechanicsSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError("Invalid points program mechanics", parsed.error.issues);
  return parsed.data;
}

/**
 * Read mechanics ALREADY STORED on a ProgramVersion.
 *
 * A failure is not bad input, it is a corrupt or foreign row — a stamp version handed to the points
 * engine, most likely. That is an invariant violation (422) and it must stop the operation rather
 * than fall back to a default, because guessing an earn rule hands out the wrong number of points.
 */
export function readPointsMechanics(mechanics: unknown, context: { programVersionId?: string } = {}): PointsMechanics {
  const parsed = pointsMechanicsSchema.safeParse(mechanics);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((i) => i.path.join(".") || "(root)"))].sort().join(", ");
    throw new LedgerInvariantError(
      `Program version ${context.programVersionId ?? "(unknown)"} does not hold valid points mechanics: ${fields}`,
    );
  }
  return parsed.data;
}

/** True when this version is a points program this engine understands. Never throws. */
export function isPointsMechanics(mechanics: unknown): boolean {
  return pointsMechanicsSchema.safeParse(mechanics).success;
}

/**
 * Points earned by a purchase: whole blocks only, floor-rounded, remainder discarded
 * (PRODUCT-SPEC §5.5). 25,000 minor units at 10,000 per block earns 2 blocks; the 5,000 remainder
 * does NOT carry to the next purchase, and no fraction of a point is ever created.
 */
export function pointsForPurchase(mechanics: PointsMechanics, purchaseAmountMinor: number): number {
  if (mechanics.earnMode !== PointsEarnMode.SPEND_BLOCK) {
    throw new ValidationError("Purchase earning requires a SPEND_BLOCK program");
  }
  if (!Number.isInteger(purchaseAmountMinor) || purchaseAmountMinor < 0) {
    throw new ValidationError("purchaseAmountMinor must be a non-negative integer of minor units");
  }
  const blocks = Math.floor(purchaseAmountMinor / mechanics.spendAmountPerBlockMinor!);
  return blocks * mechanics.pointsPerBlock!;
}

/** Points one visit award grants. Only meaningful for a PER_VISIT program. */
export function pointsForVisit(mechanics: PointsMechanics): number {
  if (mechanics.earnMode !== PointsEarnMode.PER_VISIT) {
    throw new ValidationError("Visit earning requires a PER_VISIT program");
  }
  return mechanics.pointsPerVisit!;
}
