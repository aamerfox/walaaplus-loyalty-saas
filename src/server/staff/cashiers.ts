import { MembershipRole, Prisma } from "@prisma/client";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { AuditAction, recordAudit } from "../audit/audit";
import { CONTENDED_TX, prisma } from "../db";
import { ConflictError, ForbiddenError, ValidationError } from "../errors";
import { getDefaultLocationId } from "../program/stamp-program";
import type { TenantContext } from "../tenant/context";

/**
 * Creating the one kind of staff account a Phase 1a pilot needs: a cashier at the counter.
 *
 * This is deliberately the narrowest possible slice of staff management. There is no role picker,
 * no permission editor, no location assignment and no way to touch an existing membership — all of
 * that is Phase 1b. What exists here is what a café owner needs on day one: make an account for
 * the person working the till.
 *
 * The new cashier gets ROLE DEFAULTS ONLY. `permissions` is left empty, so their access is exactly
 * `ROLE_DEFAULT_PERMISSIONS.CASHIER` — accruals, redemptions, and seeing the customer in front of
 * them — resolved from the database on every request. They are assigned to the business's Main
 * location and nowhere else, so `requireLocationAccess` refuses them anywhere they have not been
 * put, and an unassigned cashier would be refused everywhere rather than treated as unrestricted.
 */

const createCashierSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email()),
  // Same floor as owner registration: a till account is a full login to a business's data.
  password: z.string().min(10, "password must be at least 10 characters").max(200),
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().max(80).optional(),
  phone: z.string().trim().max(32).optional(),
});
export type CreateCashierInput = z.input<typeof createCashierSchema>;

export interface CashierSummary {
  userId: string;
  membershipId: string;
  email: string;
  locationId: string;
}

const BCRYPT_ROUNDS = 12;

/**
 * Create a cashier for this business.
 *
 * **Owner only.** Not "has EDIT_STAFF": creating a login that can move loyalty value is the
 * owner's decision, and Phase 1a gives managers no way to add staff at all. The check is on the
 * role, so it cannot be widened by granting a permission bit.
 */
export async function createCashier(ctx: TenantContext, input: CreateCashierInput): Promise<CashierSummary> {
  if (ctx.role !== MembershipRole.OWNER) {
    throw new ForbiddenError("Only the business owner may create a cashier");
  }
  const parsed = createCashierSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError("Invalid cashier details", parsed.error.issues);
  const data = parsed.data;

  // Hashed before the transaction opens: bcrypt takes ~200 ms and holding a database transaction
  // open for it would pin a connection for no reason.
  const passwordHash = await bcrypt.hash(data.password, BCRYPT_ROUNDS);

  try {
    return await prisma.$transaction(async (tx) => {
      const locationId = await getDefaultLocationId(tx, ctx.businessId);

      const user = await tx.user.create({
        data: {
          email: data.email,
          passwordHash,
          firstName: data.firstName,
          lastName: data.lastName ?? null,
          phone: data.phone ?? null,
        },
        select: { id: true, email: true },
      });

      const membership = await tx.businessMembership.create({
        data: {
          businessId: ctx.businessId,
          userId: user.id,
          role: MembershipRole.CASHIER,
          // Empty on purpose. Role defaults are the whole grant; anything extra is Phase 1b.
          permissions: [],
          locations: { create: [{ locationId }] },
        },
        select: { id: true },
      });

      await recordAudit(tx, {
        action: AuditAction.CASHIER_CREATED,
        entityType: "BusinessMembership",
        entityId: membership.id,
        businessId: ctx.businessId,
        actorUserId: ctx.userId,
        // The email identifies the account an owner just created and will need to support. The
        // password and its hash appear nowhere.
        metadata: { cashierUserId: user.id, email: user.email, role: MembershipRole.CASHIER, locationId },
      });

      return { userId: user.id, membershipId: membership.id, email: user.email, locationId };
    }, CONTENDED_TX);
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      // A global User already holds this email. Attaching it to this business would be a
      // reasonable Phase 1b feature ("invite an existing user"), but it must not happen as a
      // side effect of setting a password for someone else's account.
      throw new ConflictError("An account with this email already exists; inviting an existing user arrives in Phase 1b");
    }
    throw e;
  }
}
