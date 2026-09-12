import { NextResponse } from "next/server";
import { z } from "zod";
import { ValidationError, isAppError } from "@/server/errors";
import { errorResponse, readJsonObject } from "@/server/http";
import { StampEarnMode, STAMP_MECHANICS_CONTRACT_VERSION } from "@/server/program/mechanics";
import { publicEnrollmentUrl } from "@/server/program/enrollment-url";
import { createStampProgram, getStampProgramOverview } from "@/server/program/stamp-program";
import { qrSvg } from "@/server/qr";
import { requireScannerContext } from "@/server/tenant/scanner-context";

/**
 * POST /api/staff/program — create the business's one stamp card.
 *
 * The missing rung in the ladder. Registration made a business, a Main location and an OWNER; the
 * stamp engine could serve customers; and nothing in between let a merchant actually create the
 * card, so no enrolment link existed and no customer could join. This route is that step and
 * nothing more.
 *
 * It adds NO domain logic. `createStampProgram` already creates the template, the immutable
 * version, the reward tier and the direct enrolment source in one transaction, takes a row lock so
 * two simultaneous clicks cannot both pass the "already has a program" check, and refuses a second
 * program with a 409. This handler validates five fields, fills in the settings Phase 1a does not
 * offer, and calls it.
 *
 * **Only five fields are accepted**, and the schema is strict, so a body carrying `earnMode`,
 * `spendAmountPerBlockMinor`, `dailyAwardLimit` or anything else is refused rather than quietly
 * honoured. The rest of the mechanics are fixed below: a pilot café stamps by hand, and shipping a
 * form that can choose an earn mode would be shipping Phase 1b's screen early.
 *
 * Authorization is the service's, twice over: `requireScannerContext` re-reads an ACTIVE
 * membership from the database for the business named, and `createStampProgram` requires
 * EDIT_TEMPLATES — which an OWNER and a MANAGER hold and a CASHIER does not.
 */

const createSchema = z.strictObject({
  /** Present only when the caller belongs to several businesses; verified, never trusted. */
  businessId: z.string().min(1).optional(),
  name: z.string().trim().min(1).max(120),
  stampsRequiredPerReward: z.coerce.number().int().min(1).max(100),
  rewardName: z.string().trim().min(1).max(120),
  rewardDescription: z.string().trim().max(500).optional(),
  welcomeStamps: z.coerce.number().int().min(0).max(50).optional(),
});

interface ProgramResponse {
  /** What the owner prints or shares. */
  enrollmentUrl: string;
  /**
   * The same URL as an inline SVG QR, rendered HERE rather than in the browser.
   *
   * The alternative was to let the page re-render from the server after creation and pick the QR
   * up then, which works but leaves the owner looking at a link with no QR for as long as the
   * refresh takes. Rendering it in the response makes the screen deterministic, and keeps the
   * rule that this token never reaches a third-party image service.
   */
  enrollmentQrSvg: string;
  programName: string;
  stampsRequiredPerReward: number;
  rewardName: string;
  /** True when this request created the program; false when one already existed. */
  created: boolean;
}

export async function POST(req: Request) {
  try {
    const body = await readJsonObject(req);
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) throw new ValidationError("Invalid program details", parsed.error.issues);
    const input = parsed.data;

    const { ctx } = await requireScannerContext(input.businessId ?? null);

    const summary = await createStampProgram(ctx, {
      name: input.name,
      mechanics: {
        kind: "STAMP",
        contractVersion: STAMP_MECHANICS_CONTRACT_VERSION,
        stampsRequiredPerReward: input.stampsRequiredPerReward,
        rewardName: input.rewardName,
        // An empty description is absence, not an empty string: the contract refuses "".
        rewardDescription: input.rewardDescription?.trim() ? input.rewardDescription.trim() : undefined,
        // 0 means "no welcome bonus" to a person filling in a form, and `undefined` to the
        // contract, which takes a positive integer or nothing.
        welcomeStamps: input.welcomeStamps && input.welcomeStamps > 0 ? input.welcomeStamps : undefined,
        // Fixed for Phase 1a. Not accepted from the caller, and not offered by any screen.
        earnMode: StampEarnMode.MANUAL,
        requirePurchaseAmount: false,
        countRewardRedemptionAsVisit: false,
      },
    });

    return NextResponse.json(
      {
        enrollmentUrl: publicEnrollmentUrl(summary.directSourceToken),
        enrollmentQrSvg: qrSvg(publicEnrollmentUrl(summary.directSourceToken), { cellSize: 5, margin: 4 }),
        programName: input.name.trim(),
        stampsRequiredPerReward: summary.mechanics.stampsRequiredPerReward,
        rewardName: summary.mechanics.rewardName,
        created: true,
      } satisfies ProgramResponse,
      { status: 201 },
    );
  } catch (e) {
    // A second submission — the double-click, the retried request, the two owners at once — is a
    // CONFLICT from the service, and answering it with an error would strand the owner on a
    // screen with no link. The program that already exists IS the right answer, so it is
    // returned, with `created: false` so the screen can say which happened.
    if (isAppError(e) && e.status === 409) {
      try {
        const { ctx } = await requireScannerContext(null);
        const existing = await getStampProgramOverview(ctx);
        if (existing?.directSourceToken) {
          return NextResponse.json(
            {
              enrollmentUrl: publicEnrollmentUrl(existing.directSourceToken),
              enrollmentQrSvg: qrSvg(publicEnrollmentUrl(existing.directSourceToken), { cellSize: 5, margin: 4 }),
              programName: existing.templateName,
              stampsRequiredPerReward: existing.mechanics.stampsRequiredPerReward,
              rewardName: existing.mechanics.rewardName,
              created: false,
            } satisfies ProgramResponse,
            { status: 200 },
          );
        }
      } catch {
        // Fall through to the original 409 rather than inventing a different failure.
      }
    }
    return errorResponse(e);
  }
}
