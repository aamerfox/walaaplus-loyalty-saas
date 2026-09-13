import { NextResponse } from "next/server";
import { z } from "zod";
import { ValidationError } from "@/server/errors";
import { errorResponse, readJsonObject } from "@/server/http";
import { revokeShareLink } from "@/server/share/share-links";
import { requireScannerContext } from "@/server/tenant/scanner-context";
import { previewWalletPass } from "@/server/wallet/wallet-pass";

/**
 * POST /api/staff/wallet — look at what a wallet pass would contain, and revoke its invitation link.
 *
 * **Two actions, and there is deliberately no third.** There is no `issue`: issuing a pass means
 * signing it, signing needs an Apple Pass Type certificate and a Google service-account key, and
 * this build has neither. A route that returned an unsigned payload carrying a live capability
 * would be a token-disclosure surface built for no consumer, so it does not exist.
 * `issueWalletPassPayloads` is the function a future signing step calls; it is tested and unrouted.
 *
 * **`preview` mints nothing.** A preview that minted would retire the link already sitting in the
 * customer's wallet every time a member of staff looked at their card.
 *
 * **`preview` returns no capability.** Every invitation URL in the payloads comes back with the
 * token replaced by a placeholder, applied over the whole serialised payload rather than to one
 * known field, so a field added later is redacted too rather than being the one that was forgotten.
 * The capability belongs to the customer, in their wallet, and an owner screen has no use for it.
 */

const bodySchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("preview"),
    businessId: z.string().min(1).optional(),
    customerCardId: z.string().min(1).max(64),
    locale: z.enum(["en", "ar"]),
  }),
  z.strictObject({
    action: z.literal("revoke"),
    businessId: z.string().min(1).optional(),
    customerCardId: z.string().min(1).max(64),
  }),
]);

export async function POST(req: Request) {
  try {
    const parsed = bodySchema.safeParse(await readJsonObject(req));
    if (!parsed.success) throw new ValidationError("Invalid wallet request", parsed.error.issues);
    const input = parsed.data;

    const { ctx } = await requireScannerContext(input.businessId ?? null);

    switch (input.action) {
      case "preview":
        return NextResponse.json(await previewWalletPass(ctx, input.customerCardId, input.locale), { status: 200 });
      case "revoke":
        return NextResponse.json({ revoked: await revokeShareLink(ctx, input.customerCardId) }, { status: 200 });
    }
  } catch (e) {
    return errorResponse(e);
  }
}
