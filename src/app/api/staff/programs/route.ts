import { NextResponse } from "next/server";
import { z } from "zod";
import { ValidationError } from "@/server/errors";
import { errorResponse, readJsonObject } from "@/server/http";
import { createPointsProgram, MAX_REWARD_TIERS } from "@/server/program/programs";
import { createStampProgram } from "@/server/program/stamp-program";
import { createMonetaryProgram, MAX_MONETARY_TIERS } from "@/server/monetary/rules";
import { MonetaryProgramKind } from "@/server/monetary/mechanics";
import { requireScannerContext } from "@/server/tenant/scanner-context";

/**
 * POST /api/staff/programs — create an ADDITIONAL loyalty program.
 *
 * Separate from `/api/staff/program` (singular), which is the Phase 1a bootstrap: that endpoint
 * creates a business's first program and answers a repeated submission with the program that already
 * exists, because the screen behind it has no program picker and a double-click must not produce two
 * cards for one customer. That contract is unchanged and still tested.
 *
 * This endpoint is the deliberate opposite: the caller has a program list in front of them and is
 * asking for another one. It passes `allowAdditionalProgram`, so the domain's name rule and the
 * twenty-program ceiling are the only limits. A repeated submission of the SAME name conflicts,
 * which is what protects this screen's double-click.
 *
 * Everything about the tenant is resolved from the session. The body names a program, never a
 * business, a source, a token or a balance, and the schema is strict: anything else is refused.
 */

const tierSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(500).optional(),
  requiredPoints: z.number().int().min(1).max(1_000_000),
  rewardValueMinor: z.number().int().min(0).max(2_147_483_647).optional(),
  usageLimit: z.number().int().min(1).max(1_000).optional(),
  sortOrder: z.number().int().min(0).max(1_000).optional(),
});

/**
 * The mechanics a merchant may type, per kind.
 *
 * Mirrors the domain contracts rather than restating them loosely: the services parse these again
 * with `parsePointsMechanics` / `parseStampMechanics`, which are the authority. What this schema
 * adds is a strict boundary — a request carrying `cashbackPercent`, `availableLocations` for a
 * location the caller does not own, or a stray `kind` is refused before any service runs.
 */
const pointsBody = z.strictObject({
  cardType: z.literal("POINTS"),
  name: z.string().trim().min(1).max(120),
  pointsLabel: z.string().trim().min(1).max(40).optional(),
  earnMode: z.enum(["MANUAL", "PER_VISIT", "SPEND_BLOCK"]),
  pointsPerVisit: z.number().int().min(1).max(100_000).optional(),
  spendAmountPerBlockMinor: z.number().int().min(1).max(2_147_483_647).optional(),
  pointsPerBlock: z.number().int().min(1).max(100_000).optional(),
  maxPointsPerManualAward: z.number().int().min(1).max(1_000_000).optional(),
  requirePurchaseAmount: z.boolean().optional(),
  dailyAwardLimit: z.number().int().min(1).max(1_000).optional(),
  welcomePoints: z.number().int().min(1).max(1_000_000).optional(),
  availableLocations: z.array(z.string().min(1).max(64)).min(1).max(50).optional(),
  tiers: z.array(tierSchema).min(1).max(MAX_REWARD_TIERS),
});

const stampBody = z.strictObject({
  cardType: z.literal("STAMP"),
  name: z.string().trim().min(1).max(120),
  stampsRequiredPerReward: z.number().int().min(1).max(1_000),
  rewardName: z.string().trim().min(1).max(120),
  rewardDescription: z.string().trim().min(1).max(500).optional(),
  rewardValueMinor: z.number().int().min(0).max(2_147_483_647).optional(),
  earnMode: z.enum(["MANUAL", "PER_VISIT", "SPEND_BLOCK"]),
  spendAmountPerBlockMinor: z.number().int().min(1).max(2_147_483_647).optional(),
  stampsPerBlock: z.number().int().min(1).max(1_000).optional(),
  requirePurchaseAmount: z.boolean().optional(),
  dailyAwardLimit: z.number().int().min(1).max(1_000).optional(),
  welcomeStamps: z.number().int().min(1).max(1_000).optional(),
  availableLocations: z.array(z.string().min(1).max(64)).min(1).max(50).optional(),
});

const moneyTierSchema = z.strictObject({
  minCumulativeSpendMinor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  rateBasisPoints: z.number().int().min(0).max(10_000),
});

const moneyBody = z.union([
  z.strictObject({ cardType: z.literal("CASHBACK"), name: z.string().trim().min(1).max(120), availableLocations: z.array(z.string().min(1).max(64)).min(1).max(50), tiers: z.array(moneyTierSchema).max(MAX_MONETARY_TIERS) }),
  z.strictObject({ cardType: z.literal("DISCOUNT"), name: z.string().trim().min(1).max(120), availableLocations: z.array(z.string().min(1).max(64)).min(1).max(50), tiers: z.array(moneyTierSchema).max(MAX_MONETARY_TIERS) }),
]);
const bodySchema = z.union([pointsBody, stampBody, moneyBody]);

export async function POST(req: Request) {
  try {
    const parsed = bodySchema.safeParse(await readJsonObject(req));
    if (!parsed.success) throw new ValidationError("Invalid program", parsed.error.issues);
    const input = parsed.data;

    const { ctx } = await requireScannerContext(null);

    if (input.cardType === "CASHBACK" || input.cardType === "DISCOUNT") {
      const kind = input.cardType === "CASHBACK" ? MonetaryProgramKind.CASHBACK : MonetaryProgramKind.DISCOUNT;
      const created = await createMonetaryProgram(ctx, {
        name: input.name,
        kind,
        mechanics: { kind, contractVersion: 1, availableLocations: input.availableLocations },
        tiers: input.tiers,
        allowAdditionalProgram: true,
        activate: false,
      });
      return NextResponse.json(
        { templateId: created.templateId, programVersionId: created.programVersionId, tierCount: created.tierIds.length, lifecycle: "DRAFT_REQUIRES_EXPLICIT_PUBLISH" },
        { status: 201 },
      );
    }

    if (input.cardType === "POINTS") {
      // `cardType` is the discriminator this route dispatches on, not a mechanic. Leaving it in the
      // rest object would hand `parsePointsMechanics` an unknown key, and its strict schema would
      // refuse the whole program - correctly, and confusingly.
      const { name, tiers, ...rest } = input;
      const mechanics = { ...rest, cardType: undefined, kind: "POINTS" as const, contractVersion: 1 as const };
      delete (mechanics as { cardType?: unknown }).cardType;
      const created = await createPointsProgram(ctx, {
        name,
        tiers,
        allowAdditionalProgram: true,
        mechanics,
      });
      return NextResponse.json(
        { templateId: created.templateId, programVersionId: created.programVersionId, tierCount: created.tierIds.length },
        { status: 201 },
      );
    }

    const { name, ...stampRest } = input;
    const stampMechanics = { ...stampRest, kind: "STAMP" as const, contractVersion: 1 as const };
    delete (stampMechanics as { cardType?: unknown }).cardType;
    const created = await createStampProgram(ctx, { name, allowAdditionalProgram: true, mechanics: stampMechanics });
    // No `directSourceToken` in the response. It is a capability, and B7 keeps it on the server.
    return NextResponse.json({ templateId: created.templateId, programVersionId: created.programVersionId }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
