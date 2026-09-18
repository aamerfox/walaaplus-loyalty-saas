import { NextResponse } from "next/server";
import { z } from "zod";
import { errorResponse, readJsonObject } from "@/server/http";
import { ValidationError } from "@/server/errors";
import {
  createMoneyDraft,
  discardMoneyDraft,
  getMoneyProgramConfig,
  publishMoneyDraft,
  updateMoneyDraftRateTable,
} from "@/server/monetary/draft";
import { MAX_MONETARY_TIERS } from "@/server/monetary/rules";
import { requireScannerContext } from "@/server/tenant/scanner-context";

/**
 * POST /api/staff/money-version — the rate-table draft lifecycle for a cashback or discount program.
 *
 * The money counterpart of `/api/staff/program-version`, which handles stamp and points and refuses
 * money types. Two endpoints rather than one because the payloads share nothing: a stamp draft edits
 * a `mechanics` object, this edits an ordered table of thresholds and rates.
 *
 * **There is no `currency` field and no `currencyExponent` field in any schema below, and that is
 * deliberate.** A programme is denominated in the business's own currency; this product has no
 * conversion layer and no rate source, so a currency arriving from a form would be either redundant
 * or wrong. Adding one here would also be futile: the monetary rule guard installed by migration 22
 * re-derives the business currency and refuses any rule that disagrees, and the exponent must match
 * the reference row for that currency. The route does not offer a field the database exists to
 * reject.
 *
 * `discard` does not delete anything. A money version is retired — see `discardMoneyDraft`.
 */

const templateId = z.string().min(1).max(64);
const business = z.string().min(1).optional();

/**
 * One row of the rate table.
 *
 * `minCumulativeSpendMinor` is integer MINOR units of the business's currency, never a decimal: a
 * float here would silently move a threshold by a fraction of a unit. `rateBasisPoints` is 0..10000
 * — dimensionless, so no currency is involved in a rate.
 */
const tierSchema = z.strictObject({
  minCumulativeSpendMinor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  rateBasisPoints: z.number().int().min(0).max(10_000),
});

const bodySchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("read"), businessId: business, templateId }),
  z.strictObject({ action: z.literal("createDraft"), businessId: business, templateId }),
  z.strictObject({
    action: z.literal("updateRateTable"),
    businessId: business,
    templateId,
    tiers: z.array(tierSchema).min(1).max(MAX_MONETARY_TIERS),
  }),
  z.strictObject({ action: z.literal("discardDraft"), businessId: business, templateId }),
  z.strictObject({
    action: z.literal("publish"),
    businessId: business,
    templateId,
    expectedVersionNumber: z.number().int().min(1).max(1_000_000),
  }),
]);

/**
 * `bigint` does not survive `JSON.stringify`, and a money amount must not be rounded on its way to a
 * screen. Amounts leave as decimal STRINGS of minor units; the client formats them with the exponent.
 */
function serialiseTable<T extends { tiers: { minCumulativeSpendMinor: bigint }[] } | null>(table: T) {
  if (!table) return null;
  return {
    ...table,
    tiers: table.tiers.map((t) => ({ ...t, minCumulativeSpendMinor: t.minCumulativeSpendMinor.toString() })),
  };
}

export async function POST(req: Request) {
  try {
    const parsed = bodySchema.safeParse(await readJsonObject(req));
    if (!parsed.success) throw new ValidationError("Invalid request");
    const input = parsed.data;

    const { ctx } = await requireScannerContext(input.businessId ?? null);

    switch (input.action) {
      case "read": {
        const config = await getMoneyProgramConfig(ctx, input.templateId);
        return NextResponse.json(
          { live: serialiseTable(config.live), draft: serialiseTable(config.draft) },
          { status: 200 },
        );
      }
      case "createDraft": {
        const draft = await createMoneyDraft(ctx, input.templateId);
        return NextResponse.json(serialiseTable(draft), { status: 201 });
      }
      case "updateRateTable": {
        const draft = await updateMoneyDraftRateTable(ctx, input.templateId, input.tiers);
        return NextResponse.json(serialiseTable(draft), { status: 200 });
      }
      case "discardDraft":
        await discardMoneyDraft(ctx, input.templateId);
        return NextResponse.json({ ok: true, disposition: "RETIRED" }, { status: 200 });
      case "publish":
        return NextResponse.json(
          await publishMoneyDraft(ctx, input.templateId, input.expectedVersionNumber),
          { status: 200 },
        );
    }
  } catch (e) {
    return errorResponse(e);
  }
}
