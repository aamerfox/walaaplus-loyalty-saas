import { WebhookDestinationState } from "@prisma/client";
import { NextResponse } from "next/server";
import { z } from "zod";
import { ValidationError } from "@/server/errors";
import { errorResponse, readJsonObject } from "@/server/http";
import {
  createDestination,
  queueTestDelivery,
  rotateSecret,
  setDestinationState,
} from "@/server/integrations/webhooks/destinations";
import { requireScannerContext } from "@/server/tenant/scanner-context";

/**
 * POST /api/staff/webhooks — the owner's webhook destinations.
 *
 * **Owner only**, enforced in the service. Not owner-or-manager, which is the bar everywhere else:
 * a destination is a standing instruction to send this business's activity to a third party, and a
 * manager who could create one could arrange for every redemption to be copied somewhere the owner
 * never looked.
 *
 * **This route sends no HTTP.** `test` writes an outbox row and returns; the worker makes the
 * request. A route handler that called out to a merchant's endpoint would be a till waiting on
 * somebody else's timeout, and `tests/unit/webhook-boundary.test.ts` asserts nothing under
 * `src/app/` imports the transport or the delivery runner.
 *
 * **There is no `reveal` action.** The signing secret is returned exactly once, by `create` and by
 * `rotate`, out of the value that generated it — never out of a column. An owner who loses it
 * rotates it.
 *
 * **And no action carries a URL back.** `create` echoes the host; the full address is encrypted and
 * no selection anywhere reads it out.
 */

const business = z.string().min(1).optional();
const destinationId = z.string().min(1).max(64);

const bodySchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("create"),
    businessId: business,
    name: z.string().trim().min(1).max(60),
    /**
     * Bounded here, and judged by `assertSafeWebhookUrl` in the service.
     *
     * The route caps the length so a megabyte of text never reaches the validator; the validator
     * decides everything else, because "is this address safe" is one rule and it lives in one place.
     */
    url: z.string().trim().min(1).max(2000),
  }),
  z.strictObject({
    action: z.literal("setState"),
    businessId: business,
    destinationId,
    // The three merchant-driven states, listed literally so a new enum value cannot arrive here by
    // accident.
    state: z.enum([
      WebhookDestinationState.ENABLED,
      WebhookDestinationState.DISABLED,
      WebhookDestinationState.REVOKED,
    ]),
  }),
  z.strictObject({ action: z.literal("rotate"), businessId: business, destinationId }),
  z.strictObject({ action: z.literal("test"), businessId: business, destinationId }),
]);

export async function POST(req: Request) {
  try {
    const parsed = bodySchema.safeParse(await readJsonObject(req));
    if (!parsed.success) throw new ValidationError("Invalid webhook request", parsed.error.issues);
    const input = parsed.data;

    const { ctx } = await requireScannerContext(input.businessId ?? null);

    switch (input.action) {
      case "create": {
        const created = await createDestination(ctx, { name: input.name, url: input.url });
        // The one response in this product that carries a secret, and it is the only time it exists
        // outside the caller's own memory.
        return NextResponse.json(created, { status: 201 });
      }
      case "setState":
        return NextResponse.json(await setDestinationState(ctx, input.destinationId, input.state), { status: 200 });
      case "rotate":
        return NextResponse.json(await rotateSecret(ctx, input.destinationId), { status: 200 });
      case "test":
        return NextResponse.json(await queueTestDelivery(ctx, input.destinationId), { status: 202 });
    }
  } catch (e) {
    return errorResponse(e);
  }
}
