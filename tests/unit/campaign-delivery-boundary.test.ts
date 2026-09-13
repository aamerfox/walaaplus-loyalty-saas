import { CampaignState } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { DeliveryDisabledError, disabledDelivery, readinessOf } from "@/server/campaigns/delivery";

/**
 * The wall, tested as a wall.
 *
 * `src/server/campaigns/delivery.ts` is the only thing in this codebase shaped like a delivery port.
 * It exists so that the step from "an approved campaign with a count of contactable people" to
 * "somebody writes a loop" has to pass through a named place that refuses — rather than being a
 * thing nobody thought about until it appeared in a pull request.
 *
 * Two properties matter here, and they are different:
 *
 *  1. it throws; and
 *  2. it throws **before reading anything**, so that a bug in a future guard cannot cause a
 *     customer's contact details to be loaded in the name of sending them a message.
 *
 * The second is the one worth a test that looks paranoid. It is enforced by spying on the database
 * module: the port must not touch it at all.
 */

describe("the delivery port refuses, and refuses early", () => {
  it("throws a deliberate domain error rather than returning anything", async () => {
    await expect(disabledDelivery.dispatchApprovedSnapshot("snapshot-1")).rejects.toBeInstanceOf(DeliveryDisabledError);
    await expect(disabledDelivery.dispatchApprovedSnapshot("snapshot-1")).rejects.toThrow(/no provider, queue, worker or scheduler/);
  });

  it("says in its own message that an approval is not permission to contact anybody", async () => {
    // The sentence is part of the contract, not decoration: it is what a developer reading a stack
    // trace six months from now is told about why this refused.
    await expect(disabledDelivery.dispatchApprovedSnapshot("x")).rejects.toThrow(
      /approval is not permission to contact anybody/,
    );
  });

  it("resolves no recipient on the way to refusing", async () => {
    /*
     * If the port ever grows a "load the snapshot, check something, then throw" shape, this fails.
     * The database module is imported by every service; the port must import nothing from it, so a
     * dynamic import of the module here should show no query of any kind afterwards.
     */
    const db = await import("@/server/db");
    const spies = [
      vi.spyOn(db.prisma.campaignAudienceMember, "findMany"),
      vi.spyOn(db.prisma.campaignAudienceSnapshot, "findFirst"),
      vi.spyOn(db.prisma.customerBusinessProfile, "findMany"),
      vi.spyOn(db.prisma.customer, "findFirst"),
    ];

    await expect(disabledDelivery.dispatchApprovedSnapshot("snapshot-1")).rejects.toThrow(DeliveryDisabledError);

    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    for (const spy of spies) spy.mockRestore();
  });
});

describe("readiness is a list of reasons, and never a yes", () => {
  const base = { approvedRevisionNumber: null, approvedAudienceSize: null };

  it("is not deliverable in any state this build can reach", () => {
    for (const state of Object.values(CampaignState)) {
      const readiness = readinessOf({ ...base, state });
      expect(readiness.deliverable, `${state} must not be deliverable`).toBe(false);
      // The reason that never clears is present whatever else is wrong, and it is last: a merchant
      // reads their own blockers first and the state of the product underneath them.
      expect(readiness.blockers.at(-1)).toBe("NO_DELIVERY_CHANNEL_EXISTS");
    }
  });

  it("carries the instruction a future delivery phase inherits", () => {
    // In the contract rather than only in a comment, because a comment is not returned by an API.
    expect(readinessOf({ ...base, state: CampaignState.DRAFT }).consentMustBeRecheckedAtDispatch).toBe(true);
  });

  it("names the merchant's own blocker first", () => {
    expect(readinessOf({ ...base, state: CampaignState.DRAFT }).blockers[0]).toBe("NOT_APPROVED");
    expect(readinessOf({ ...base, state: CampaignState.IN_REVIEW }).blockers[0]).toBe("NOT_APPROVED");
    expect(readinessOf({ ...base, state: CampaignState.WITHDRAWN }).blockers[0]).toBe("WITHDRAWN");
    expect(readinessOf({ ...base, state: CampaignState.ARCHIVED }).blockers[0]).toBe("ARCHIVED");
  });

  it("treats an approved campaign with nobody in its snapshot as blocked on that", () => {
    const readiness = readinessOf({ state: CampaignState.APPROVED, approvedRevisionNumber: 3, approvedAudienceSize: 0 });
    expect(readiness.blockers).toEqual(["EMPTY_AUDIENCE", "NO_DELIVERY_CHANNEL_EXISTS"]);
  });

  it("leaves a fully approved campaign blocked on exactly one thing: the product", () => {
    const readiness = readinessOf({ state: CampaignState.APPROVED, approvedRevisionNumber: 3, approvedAudienceSize: 41 });
    expect(readiness.blockers).toEqual(["NO_DELIVERY_CHANNEL_EXISTS"]);
    expect(readiness.deliverable).toBe(false);
  });

  it("counts a campaign marked APPROVED with no approved revision as not approved", () => {
    // Defensive: the two are written in one transaction, so they cannot disagree. If they ever do,
    // the honest reading is "not approved" rather than "approved, audience unknown".
    expect(readinessOf({ state: CampaignState.APPROVED, approvedRevisionNumber: null, approvedAudienceSize: null }).blockers).toEqual(
      ["NOT_APPROVED", "NO_DELIVERY_CHANNEL_EXISTS"],
    );
  });
});
