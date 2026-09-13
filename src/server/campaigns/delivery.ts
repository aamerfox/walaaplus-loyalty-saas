import { CampaignState } from "@prisma/client";

/**
 * The delivery boundary — which is to say, the wall.
 *
 * ## Why this file exists at all
 *
 * A campaign can now be approved, and an approval has a snapshot behind it with a count of people
 * who may be contacted. That is one small step from somebody writing a loop, and the honest way to
 * handle "one small step" is to put the step somewhere visible and make it refuse.
 *
 * So this is the ONLY thing in the codebase shaped like a delivery port. It has one implementation,
 * `disabledDelivery`, and that implementation throws before it reads anything. Not after resolving
 * recipients and deciding not to contact them — **before**, so that even a bug in the guard cannot
 * cause a customer's contact details to be loaded in the name of sending them something.
 *
 * ## What is NOT here, and must not arrive without its own prompt
 *
 * No provider client. No credentials, no configuration keys, no environment variables. No queue, no
 * worker, no job, no scheduler, no retry policy, no timer. No `fetch`, no HTTP client, no socket.
 * `tests/integration/campaign-approval.test.ts` reads this directory and asserts their absence by
 * pattern, so adding one breaks a test rather than passing review quietly.
 *
 * ## The rule a future delivery phase inherits
 *
 * **An approval is not permission to contact anybody.** A snapshot records who could be contacted
 * *at the moment of a decision*; consent moves afterwards, and a customer who withdrew yesterday
 * must not receive a message today because a snapshot taken last week still lists them. Whatever
 * builds delivery re-reads current consent per recipient at dispatch time and treats the snapshot
 * as the *ceiling* of an audience, never as its authority. `readinessOf` says so in a field, and
 * the integration suite proves the withdrawal case.
 */

/** Everything that stands between an approved campaign and a message, as data. */
export interface DeliveryReadiness {
  /** The campaign's own state. */
  state: CampaignState;
  /** The revision an approval currently covers, or null. */
  approvedRevisionNumber: number | null;
  /** How many people the snapshot behind that approval recorded as contactable. */
  approvedAudienceSize: number | null;
  /**
   * Always `false` in this build, and the field exists so a future phase has to set it rather than
   * discover that nobody ever wrote the check.
   */
  deliverable: false;
  /** Why not, in the order a merchant would hit them. Never empty. */
  blockers: DeliveryBlocker[];
  /**
   * A standing instruction to whatever builds delivery, carried in the contract rather than only in
   * a comment, because a comment is not returned by an API.
   */
  consentMustBeRecheckedAtDispatch: true;
}

export type DeliveryBlocker =
  /** The campaign has no standing approval for its current revision. */
  | "NOT_APPROVED"
  /** An approval exists but was taken back. */
  | "WITHDRAWN"
  /** The campaign is archived. */
  | "ARCHIVED"
  /** Approved, with a snapshot that recorded nobody who may be contacted. */
  | "EMPTY_AUDIENCE"
  /**
   * The one that never clears in this build. It is listed last so a merchant reading the screen
   * sees their own blockers first and this one as the standing fact underneath them.
   */
  | "NO_DELIVERY_CHANNEL_EXISTS";

/** Thrown by the only delivery implementation that exists. Never caught anywhere: nothing retries. */
export class DeliveryDisabledError extends Error {
  readonly code = "DELIVERY_DISABLED";
  constructor() {
    super(
      "Delivery is not implemented. This build has no provider, queue, worker or scheduler, and an " +
        "approval is not permission to contact anybody.",
    );
    this.name = "DeliveryDisabledError";
  }
}

/**
 * The port a future delivery phase would implement.
 *
 * Deliberately narrow: it takes a snapshot id and nothing else. There is no variant that takes a
 * recipient, a phone number or a rendered message, because a port shaped like that is a port
 * somebody can call with data they assembled themselves.
 */
export interface CampaignDeliveryPort {
  dispatchApprovedSnapshot(snapshotId: string): Promise<never>;
}

/**
 * The only implementation. It refuses on the first line.
 *
 * Note the shape: `snapshotId` is accepted and never used. That is the point — the function cannot
 * reach a recipient because it never looks one up, and a reviewer can confirm that by reading four
 * lines rather than by tracing a call graph.
 */
export const disabledDelivery: CampaignDeliveryPort = {
  async dispatchApprovedSnapshot(): Promise<never> {
    throw new DeliveryDisabledError();
  },
};

/** Pure. Turns a campaign's approval state into the reasons it still cannot be delivered. */
export function readinessOf(campaign: {
  state: CampaignState;
  approvedRevisionNumber: number | null;
  approvedAudienceSize: number | null;
}): DeliveryReadiness {
  const blockers: DeliveryBlocker[] = [];

  if (campaign.state === CampaignState.ARCHIVED) blockers.push("ARCHIVED");
  else if (campaign.state === CampaignState.WITHDRAWN) blockers.push("WITHDRAWN");
  else if (campaign.state !== CampaignState.APPROVED || campaign.approvedRevisionNumber === null) {
    blockers.push("NOT_APPROVED");
  } else if (campaign.approvedAudienceSize === 0) blockers.push("EMPTY_AUDIENCE");

  // Always, and last. Everything above can be fixed by a merchant this afternoon; this one is the
  // state of the product.
  blockers.push("NO_DELIVERY_CHANNEL_EXISTS");

  return {
    state: campaign.state,
    approvedRevisionNumber: campaign.approvedRevisionNumber,
    approvedAudienceSize: campaign.approvedAudienceSize,
    deliverable: false,
    blockers,
    consentMustBeRecheckedAtDispatch: true,
  };
}
