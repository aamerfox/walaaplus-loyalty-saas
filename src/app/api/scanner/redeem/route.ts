import { OperationSource } from "@prisma/client";
import { NextResponse } from "next/server";
import { z } from "zod";
import { ValidationError } from "@/server/errors";
import { errorResponse, readJsonObject } from "@/server/http";
import { redeemReward } from "@/server/stamp/engine";
import { requireScannerContext } from "@/server/tenant/scanner-context";

/**
 * POST /api/scanner/redeem — hand over one earned reward on a STAMP card.
 *
 * Decrements the reward balance by exactly one and never touches stamps. A card with nothing earned
 * is refused with a conflict, which the scanner shows as "no reward available" rather than as an
 * error the cashier has to interpret.
 *
 * A points card redeems a configured tier instead, which is a different shape — a price in points
 * and a tier to name — so it has its own endpoint (`/api/scanner/points`) rather than an optional
 * field here. Handing a points card to this route reaches the stamp engine's mechanics reader and is
 * refused there.
 *
 * `locationId` is meaningful only when the card's pinned version lists `availableLocations`; the
 * engine checks the program's list and this member's assignment inside the write transaction.
 */

const bodySchema = z.strictObject({
  businessId: z.string().min(1).optional(),
  customerCardId: z.string().min(1),
  idempotencyKey: z.string().min(8),
  locationId: z.string().min(1).optional(),
  comment: z.string().trim().max(500).optional(),
});

export async function POST(req: Request) {
  try {
    const parsed = bodySchema.safeParse(await readJsonObject(req, { allowLocation: true }));
    if (!parsed.success) throw new ValidationError("Invalid redemption", parsed.error.issues);
    const input = parsed.data;

    const { ctx } = await requireScannerContext(input.businessId ?? null);
    return NextResponse.json(
      await redeemReward(ctx, {
        customerCardId: input.customerCardId,
        idempotencyKey: input.idempotencyKey,
        source: OperationSource.SCANNER,
        locationId: input.locationId,
        comment: input.comment?.trim() || undefined,
      }),
    );
  } catch (e) {
    return errorResponse(e);
  }
}
