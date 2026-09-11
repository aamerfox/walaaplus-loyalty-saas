import { OperationSource } from "@prisma/client";
import { NextResponse } from "next/server";
import { ValidationError } from "@/server/errors";
import { errorResponse, readJsonObject } from "@/server/http";
import { reverseStampOperation } from "@/server/stamp/engine";
import { requireScannerContext } from "@/server/tenant/scanner-context";

/**
 * POST /api/scanner/reverse — undo a mistake.
 *
 * A correction is a compensating group, never an edit and never a delete: the original rows stay
 * in the ledger forever and new rows cancel them. The engine refuses to reverse a reversal, to
 * reverse the same group twice, or to un-earn a reward that has already been handed over — that
 * last case needs a human decision, and the error says so.
 *
 * A reason is required. A reversal without one is unauditable a month later.
 */
export async function POST(req: Request) {
  try {
    const body = await readJsonObject(req);
    const { ctx } = await requireScannerContext(typeof body.businessId === "string" ? body.businessId : null);

    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    if (reason === "") throw new ValidationError("A reversal requires a reason");

    return NextResponse.json(
      await reverseStampOperation(ctx, {
        transactionGroupId: String(body.transactionGroupId ?? ""),
        reason,
        idempotencyKey: String(body.idempotencyKey ?? ""),
        source: OperationSource.SCANNER,
      }),
    );
  } catch (e) {
    return errorResponse(e);
  }
}
