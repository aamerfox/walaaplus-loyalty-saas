import { NextResponse } from "next/server";
import { z } from "zod";
import { createKey, revokeKey, rotateKey } from "@/server/api/keys";
import { ValidationError } from "@/server/errors";
import { errorResponse, readJsonObject } from "@/server/http";
import { requireScannerContext } from "@/server/tenant/scanner-context";

/**
 * `POST /api/staff/api-keys` — the owner's public-API keys.
 *
 * **Owner only**, enforced in the service by `requireApiKeyOwner`, not here. That is the same
 * arrangement as webhook destinations and for the same reason: a key is standing, unattended read
 * access to this business's data, valid for ninety days, usable by anyone holding it. A manager who
 * could mint one could arrange for the event history to be read continuously without the owner ever
 * seeing a screen.
 *
 * **There is no `reveal` action, and there never will be.** The raw value is returned exactly once,
 * by `create` and by `rotate`, out of the value that generated it — never out of a column, because
 * the column holds a digest and there is no way back. An owner who loses a key rotates it.
 *
 * **There is no `delete` action either.** A key is revoked, and the row stays: it is the record that
 * this business held a credential between two dates. The database refuses a DELETE for the runtime
 * role and the table owner alike. Retention is registered as **D31** and is not guessed here.
 *
 * **This route is not `/api/v1`.** It is authenticated by the session cookie, like every other
 * staff route. A public API key cannot manage keys — which is what stops a leaked key extending its
 * own life.
 */

const business = z.string().min(1).optional();
const keyId = z.string().min(1).max(64);

const bodySchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("create"),
    businessId: business,
    // Bounded here so a megabyte of text never reaches a service; the service owns every other rule.
    name: z.string().trim().min(1).max(60),
  }),
  z.strictObject({ action: z.literal("rotate"), businessId: business, keyId, name: z.string().trim().min(1).max(60) }),
  z.strictObject({ action: z.literal("revoke"), businessId: business, keyId }),
]);

export async function POST(req: Request) {
  try {
    const parsed = bodySchema.safeParse(await readJsonObject(req));
    if (!parsed.success) throw new ValidationError("Invalid API key request", parsed.error.issues);
    const input = parsed.data;

    const { ctx } = await requireScannerContext(input.businessId ?? null);

    switch (input.action) {
      case "create":
        // One of the two responses in this product that carries a secret, and the only moment the
        // value exists outside the caller's own memory.
        return NextResponse.json(await createKey(ctx, { name: input.name }), { status: 201 });
      case "rotate":
        return NextResponse.json(await rotateKey(ctx, input.keyId, input.name), { status: 201 });
      case "revoke":
        return NextResponse.json(await revokeKey(ctx, input.keyId), { status: 200 });
    }
  } catch (e) {
    /*
     * The staff error mapper, which returns a domain error's own code and message.
     *
     * Right here and wrong for `/api/v1`: this answer goes to our own screen, read by somebody who
     * is authenticated as a person and is entitled to know that their key has expired rather than
     * being revoked. The public API gets a fixed sentence instead — `apiInternal` in
     * `src/server/api/request.ts`.
     *
     * A terminal-state key reaches this as the controlled `API_KEY_NOT_ACTIVE` conflict from
     * Prompt 1, never as a PostgreSQL message.
     */
    return errorResponse(e);
  }
}
