import { OperationSource } from "@prisma/client";
import { NextResponse } from "next/server";
import { z } from "zod";
import { ValidationError } from "@/server/errors";
import { errorResponse, readJsonObject } from "@/server/http";
import { reverseCounterOperation } from "@/server/program/counter";
import { requireScannerContext } from "@/server/tenant/scanner-context";

/**
 * POST /api/scanner/reverse — undo a mistake, on either kind of card.
 *
 * A correction is a compensating group, never an edit and never a delete: the original rows stay in
 * the ledger forever and new rows cancel them. The engine refuses to reverse a reversal, to reverse
 * the same group twice, or to un-earn value that has already been spent — that last case needs a
 * human decision, and the error says so.
 *
 * **Which engine owns the group is resolved on the server**, from the group itself, inside the
 * caller's tenant. A client that named the card type would be asserting a fact about rows it cannot
 * see, and a wrong assertion would reach the wrong mechanics reader and fail blaming the data.
 *
 * There is no `locationId`: a reversal is attributed to the location of the operation it corrects,
 * always, and supplying one is refused rather than ignored.
 *
 * A reason is required. A reversal without one is unauditable a month later.
 */

const bodySchema = z.strictObject({
  businessId: z.string().min(1).optional(),
  transactionGroupId: z.string().min(1),
  reason: z.string().trim().min(1).max(500),
  idempotencyKey: z.string().min(8),
});

export async function POST(req: Request) {
  try {
    const parsed = bodySchema.safeParse(await readJsonObject(req));
    if (!parsed.success) throw new ValidationError("Invalid reversal", parsed.error.issues);
    const input = parsed.data;

    const { ctx } = await requireScannerContext(input.businessId ?? null);
    return NextResponse.json(
      await reverseCounterOperation(ctx, {
        transactionGroupId: input.transactionGroupId,
        reason: input.reason,
        idempotencyKey: input.idempotencyKey,
        source: OperationSource.SCANNER,
      }),
    );
  } catch (e) {
    return errorResponse(e);
  }
}
