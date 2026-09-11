import { NextResponse } from "next/server";
import { errorResponse, readJsonObject } from "@/server/http";
import { createCashier } from "@/server/staff/cashiers";
import { requireScannerContext } from "@/server/tenant/scanner-context";

/**
 * POST /api/staff/cashiers — create the till account.
 *
 * The whole of Phase 1a's staff management: one owner-only verb. The service checks the ROLE, not
 * a permission bit, so granting `EDIT_STAFF` to a manager does not open this. Role editing,
 * permission editing and location assignment are Phase 1b.
 *
 * The response carries the account's email and ids, never the password or its hash.
 */
export async function POST(req: Request) {
  try {
    const body = await readJsonObject(req);
    const { ctx } = await requireScannerContext(typeof body.businessId === "string" ? body.businessId : null);

    const created = await createCashier(ctx, {
      email: String(body.email ?? ""),
      password: String(body.password ?? ""),
      firstName: String(body.firstName ?? ""),
      lastName: typeof body.lastName === "string" && body.lastName.trim() !== "" ? body.lastName.trim() : undefined,
    });

    return NextResponse.json({ userId: created.userId, membershipId: created.membershipId, email: created.email }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
