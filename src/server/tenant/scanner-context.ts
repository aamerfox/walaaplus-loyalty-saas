import { prisma } from "../db";
import { ForbiddenError, UnauthorizedError } from "../errors";
import { requireUserId } from "../auth/session";
import { listUserBusinesses } from "./memberships";
import { requireBusinessMembership, type TenantContext } from "./context";

/**
 * Which business is a signed-in staff member acting for?
 *
 * A `User` is global and may hold memberships in several businesses (PRODUCT-SPEC §3) — that is
 * what later lets one person own two cafés and agency staff reach client businesses. So "the
 * current business" is not a property of the session; it has to be resolved and verified on every
 * request, which is what this does.
 *
 * A requested business is always checked against an ACTIVE membership, so a staff member cannot
 * reach another tenant by editing a query string. With no request, a single membership is used
 * directly — the pilot case — and several memberships mean the caller must choose.
 */
export interface ScannerContext {
  ctx: TenantContext;
  businessName: string;
}

export type ScannerResolution =
  | { kind: "ready"; context: ScannerContext }
  | { kind: "choose"; businesses: { id: string; name: string }[] }
  | { kind: "none" };

/**
 * Resolve the acting business for a staff screen.
 *
 * `requestedBusinessId` comes from the URL. It is never trusted: `requireBusinessMembership`
 * re-reads the membership from the database and throws if there is not an active one.
 */
export async function resolveScannerContext(userId: string, requestedBusinessId?: string | null): Promise<ScannerResolution> {
  if (requestedBusinessId) {
    const ctx = await requireBusinessMembership(prisma, userId, requestedBusinessId);
    const business = await prisma.business.findUniqueOrThrow({ where: { id: ctx.businessId }, select: { name: true } });
    return { kind: "ready", context: { ctx, businessName: business.name } };
  }

  const memberships = await listUserBusinesses(userId);
  if (memberships.length === 0) return { kind: "none" };
  if (memberships.length > 1) {
    return { kind: "choose", businesses: memberships.map((m) => ({ id: m.business.id, name: m.business.name })) };
  }

  const only = memberships[0].business;
  const ctx = await requireBusinessMembership(prisma, userId, only.id);
  return { kind: "ready", context: { ctx, businessName: only.name } };
}

/**
 * The same resolution for an API route, where there is no screen to render a chooser: a caller
 * that belongs to several businesses must name one, and a caller that belongs to none is refused.
 */
export async function requireScannerContext(requestedBusinessId?: string | null): Promise<ScannerContext> {
  const userId = await requireUserId();
  const resolved = await resolveScannerContext(userId, requestedBusinessId);
  if (resolved.kind === "ready") return resolved.context;
  if (resolved.kind === "choose") throw new ForbiddenError("This account belongs to several businesses; name the one to act for");
  throw new ForbiddenError("This account has no active business membership");
}

/** Guard for staff pages: the signed-in user id, or an Unauthorized that the page maps to a redirect. */
export async function requireStaffUserId(): Promise<string> {
  const userId = await requireUserId();
  if (!userId) throw new UnauthorizedError();
  return userId;
}
