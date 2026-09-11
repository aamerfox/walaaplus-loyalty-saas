import { OperationSource } from "@prisma/client";
import { NextResponse } from "next/server";
import { errorResponse, readJsonObject } from "@/server/http";
import { redeemReward } from "@/server/stamp/engine";
import { requireScannerContext } from "@/server/tenant/scanner-context";

/**
 * POST /api/scanner/redeem — hand over one earned reward.
 *
 * Decrements the reward balance by exactly one and never touches stamps. A card with nothing
 * earned is refused with a conflict, which the scanner shows as "no reward available" rather than
 * as an error the cashier has to interpret.
 */
export async function POST(req: Request) {
  try {
    const body = await readJsonObject(req);
    const { ctx } = await requireScannerContext(typeof body.businessId === "string" ? body.businessId : null);

    return NextResponse.json(
      await redeemReward(ctx, {
        customerCardId: String(body.customerCardId ?? ""),
        idempotencyKey: String(body.idempotencyKey ?? ""),
        source: OperationSource.SCANNER,
        comment: typeof body.comment === "string" && body.comment.trim() !== "" ? body.comment.trim() : undefined,
      }),
    );
  } catch (e) {
    return errorResponse(e);
  }
}
