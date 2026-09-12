import { z } from "zod";
import { LedgerInvariantError, ValidationError } from "../errors";
import { availableLocationsSchema } from "./available-locations";

/**
 * The stamp-program mechanics contract.
 *
 * `ProgramVersion.mechanics` is a JSON column, which is exactly the shape of data that rots: a
 * typo becomes a silently absent rule, and a rule added in a later phase becomes an
 * `any`-typed read three services deep. Nothing in this codebase may consume that column
 * directly — everything goes through `readStampMechanics`, which parses it or refuses.
 *
 * The schema is STRICT. An unknown key is an error, not a value to ignore. That is what keeps
 * Phase 1a honest: `pointsPerVisit`, `cashbackPercent`, `cardExpiryMode`, `birthdayStamps`,
 * `referral*` and every other deferred mechanic are rejected at the boundary rather than
 * half-implemented. When a later phase adds one, it adds it here, bumps `contractVersion`, and
 * the reader keeps working for versions already pinned to cards.
 */

/** How stamps are earned. Phase 1a ships these three and no others. */
export const StampEarnMode = {
  /** Staff decide the quantity. */
  MANUAL: "MANUAL",
  /** One stamp per visit, quantity fixed by the program. */
  PER_VISIT: "PER_VISIT",
  /** Whole blocks of spend, floor-rounded, no remainder carried (PRODUCT-SPEC §5.5). */
  SPEND_BLOCK: "SPEND_BLOCK",
} as const;
export type StampEarnMode = (typeof StampEarnMode)[keyof typeof StampEarnMode];

/** Current contract version. Pinned versions keep the number they were written with. */
export const STAMP_MECHANICS_CONTRACT_VERSION = 1;

/** Bounds chosen to be generous for a café and still refuse nonsense. */
const MAX_STAMPS_PER_REWARD = 1_000;
const MAX_DAILY_AWARD_LIMIT = 1_000;
const MAX_WELCOME_STAMPS = 1_000;
/** 2^31-1 minor units: the ledger's money columns are 32-bit (docs/evidence L-4). */
const MAX_MINOR_UNITS = 2_147_483_647;

const positiveInt = (max: number) => z.number().int().min(1).max(max);

export const stampMechanicsSchema = z
  .strictObject({
    /** Discriminator. A points program will add its own schema and its own literal. */
    kind: z.literal("STAMP"),
    contractVersion: z.literal(STAMP_MECHANICS_CONTRACT_VERSION),

    stampsRequiredPerReward: positiveInt(MAX_STAMPS_PER_REWARD),

    rewardName: z.string().trim().min(1).max(120),
    rewardDescription: z.string().trim().min(1).max(500).optional(),
    /** Merchant cost/value of one reward, integer minor units of the business currency. */
    rewardValueMinor: z.number().int().min(0).max(MAX_MINOR_UNITS).optional(),

    earnMode: z.enum([StampEarnMode.MANUAL, StampEarnMode.PER_VISIT, StampEarnMode.SPEND_BLOCK]),
    /** SPEND_BLOCK only: the spend that earns one block, in integer minor units. */
    spendAmountPerBlockMinor: positiveInt(MAX_MINOR_UNITS).optional(),
    /** SPEND_BLOCK only: stamps granted per whole block. */
    stampsPerBlock: positiveInt(MAX_STAMPS_PER_REWARD).optional(),

    /** When true, an award must state the purchase amount even outside SPEND_BLOCK. */
    requirePurchaseAmount: z.boolean().default(false),

    /** Award OPERATIONS per card per business-timezone day. Absent = no limit. */
    dailyAwardLimit: positiveInt(MAX_DAILY_AWARD_LIMIT).optional(),

    /** Frozen per row by the Phase 0 visit policy; see src/server/ledger/visits.ts. */
    countRewardRedemptionAsVisit: z.boolean().default(false),

    /** Stamps granted once on enrollment through the direct source. Absent = none. */
    welcomeStamps: positiveInt(MAX_WELCOME_STAMPS).optional(),

    /**
     * Counters this version may be operated at (Phase 1b). **Absent means the business's Main
     * location only**, which is what every Phase 1a version says and what every card pinned to one
     * keeps saying forever.
     *
     * Added as an OPTIONAL field rather than behind a contract-version bump, deliberately.
     * `contractVersion` is a `z.literal`, so raising it would make `readStampMechanics` refuse
     * every version already pinned to a live card — every existing café would stop being able to
     * award a stamp the moment this shipped. An absent optional field means exactly what its
     * absence meant before, which is the definition of a compatible change.
     */
    availableLocations: availableLocationsSchema.optional(),
  })
  .superRefine((m, ctx) => {
    const spendFields = ["spendAmountPerBlockMinor", "stampsPerBlock"] as const;
    if (m.earnMode === StampEarnMode.SPEND_BLOCK) {
      for (const field of spendFields) {
        if (m[field] === undefined) {
          ctx.addIssue({ code: "custom", path: [field], message: `${field} is required when earnMode is SPEND_BLOCK` });
        }
      }
    } else {
      for (const field of spendFields) {
        if (m[field] !== undefined) {
          ctx.addIssue({ code: "custom", path: [field], message: `${field} is only valid when earnMode is SPEND_BLOCK` });
        }
      }
    }
    // A welcome bonus that instantly completes a card is almost always a misconfiguration, and
    // it would hand out a free reward to anyone who enrols. Refuse it at the boundary.
    if (m.welcomeStamps !== undefined && m.welcomeStamps >= m.stampsRequiredPerReward) {
      ctx.addIssue({
        code: "custom",
        path: ["welcomeStamps"],
        message: "welcomeStamps must be fewer than stampsRequiredPerReward; a welcome bonus may not complete a card on its own",
      });
    }
  });

/** Parsed, trusted mechanics. Every consumer takes this type, never the raw JSON. */
export type StampMechanics = z.infer<typeof stampMechanicsSchema>;
/** What a caller supplies: defaults not yet applied. */
export type StampMechanicsInput = z.input<typeof stampMechanicsSchema>;

/**
 * Validate mechanics supplied by a merchant. Throws ValidationError with the field issues.
 * Use this at the boundary where a program is created — never on data already stored.
 */
export function parseStampMechanics(input: unknown): StampMechanics {
  const parsed = stampMechanicsSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError("Invalid stamp program mechanics", parsed.error.issues);
  return parsed.data;
}

/**
 * Read mechanics that are ALREADY STORED on a ProgramVersion.
 *
 * A failure here is not bad user input, it is a corrupt or foreign row — a points version handed
 * to the stamp engine, or a version written before this contract existed. That is an invariant
 * violation (422), and it must stop the operation rather than fall back to a default: guessing a
 * threshold would silently hand out the wrong number of rewards.
 */
export function readStampMechanics(mechanics: unknown, context: { programVersionId?: string } = {}): StampMechanics {
  const parsed = stampMechanicsSchema.safeParse(mechanics);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((i) => i.path.join(".") || "(root)"))].sort().join(", ");
    throw new LedgerInvariantError(
      `Program version ${context.programVersionId ?? "(unknown)"} does not hold valid stamp mechanics: ${fields}`,
    );
  }
  return parsed.data;
}

/** True when this version is a stamp program this engine understands. Never throws. */
export function isStampMechanics(mechanics: unknown): boolean {
  return stampMechanicsSchema.safeParse(mechanics).success;
}

/**
 * Stamps earned by a purchase: whole blocks only, floor-rounded, remainder discarded
 * (PRODUCT-SPEC §5.5). 25,000 minor units at 10,000 per block earns 2 blocks; the 5,000
 * remainder does NOT carry over to the next purchase. Merchants expect this.
 */
export function stampsForPurchase(mechanics: StampMechanics, purchaseAmountMinor: number): number {
  if (mechanics.earnMode !== StampEarnMode.SPEND_BLOCK) {
    throw new ValidationError("Purchase earning requires a SPEND_BLOCK program");
  }
  if (!Number.isInteger(purchaseAmountMinor) || purchaseAmountMinor < 0) {
    throw new ValidationError("purchaseAmountMinor must be a non-negative integer of minor units");
  }
  const blocks = Math.floor(purchaseAmountMinor / mechanics.spendAmountPerBlockMinor!);
  return blocks * mechanics.stampsPerBlock!;
}

/**
 * Split a stamp award into the rows a threshold crossing needs (PRODUCT-SPEC §5.3).
 *
 * Conversion is immediate, the remainder carries forward, and one large award may complete
 * several rewards at once.
 */
export interface StampConversion {
  /** Stamps consumed by conversion; 0 when no reward completed. */
  stampsConverted: number;
  /** Rewards completed by this award. */
  rewardsEarned: number;
  /** Stamps left on the card afterwards. */
  remainingStamps: number;
}

export function planStampConversion(mechanics: StampMechanics, currentStamps: number, awardedStamps: number): StampConversion {
  const total = currentStamps + awardedStamps;
  const rewardsEarned = Math.floor(total / mechanics.stampsRequiredPerReward);
  const stampsConverted = rewardsEarned * mechanics.stampsRequiredPerReward;
  return { stampsConverted, rewardsEarned, remainingStamps: total - stampsConverted };
}
