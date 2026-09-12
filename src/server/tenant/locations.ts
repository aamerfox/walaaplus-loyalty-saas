import { Permission } from "@prisma/client";
import { prisma } from "../db";
import { requirePermission, type TenantContext } from "./context";

/**
 * The counters a business operates.
 *
 * Read-only, deliberately. The Phase 1b core has no service that creates, renames or deactivates a
 * location — registration creates the one `Main` location and nothing else has ever needed to
 * change it — so this module offers exactly what exists rather than a screen with buttons that
 * would have to reach past the service layer to work. The gap is recorded in the Prompt 2 evidence
 * as a missing contract rather than filled in by a UI prompt.
 *
 * `VIEW_LOCATIONS` gates it: an owner and a manager hold it, a cashier does not. A cashier does not
 * need a directory of counters — they need the one they are standing at, which the scanner resolves
 * for them from their own assignment.
 */

export interface BusinessLocation {
  id: string;
  name: string;
  /** The `Main` location created at registration. Exactly one per business. */
  isDefault: boolean;
  active: boolean;
  /** Staff assigned to this location. Counts only, never names, on a list screen. */
  assignedStaffCount: number;
  /** Programs whose ACTIVE version lists this location. Zero means "Main-only programs only". */
  programCount: number;
}

/**
 * Every location of the caller's business, default first.
 *
 * `programCount` is derived by reading each live version's `availableLocations`, because that list
 * lives inside the immutable mechanics rather than in a join table — the same reason a merchant
 * publishes a new version to open a branch instead of editing the old one.
 */
export async function listBusinessLocations(ctx: TenantContext): Promise<BusinessLocation[]> {
  requirePermission(ctx, Permission.VIEW_LOCATIONS);

  const [locations, versions] = await Promise.all([
    prisma.location.findMany({
      where: { businessId: ctx.businessId },
      select: { id: true, name: true, isDefault: true, active: true, _count: { select: { staff: true } } },
      orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
    }),
    prisma.programVersion.findMany({
      where: { status: "ACTIVE", template: { businessId: ctx.businessId, status: { in: ["ACTIVE", "PAUSED"] } } },
      select: { mechanics: true },
    }),
  ]);

  const programsPerLocation = new Map<string, number>();
  for (const version of versions) {
    const listed = (version.mechanics as { availableLocations?: unknown }).availableLocations;
    if (!Array.isArray(listed)) continue;
    for (const id of listed) {
      if (typeof id === "string") programsPerLocation.set(id, (programsPerLocation.get(id) ?? 0) + 1);
    }
  }

  return locations.map((l) => ({
    id: l.id,
    name: l.name,
    isDefault: l.isDefault,
    active: l.active,
    assignedStaffCount: l._count.staff,
    programCount: programsPerLocation.get(l.id) ?? 0,
  }));
}
