import { MembershipRole, Prisma } from "@prisma/client";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { AuditAction, recordAudit } from "../audit/audit";
import { prisma } from "../db";
import { ConflictError, ValidationError } from "../errors";

const SUPPORTED_TIMEZONES = new Set(Intl.supportedValuesOf("timeZone"));
const BCRYPT_ROUNDS = 12;
export const DEFAULT_LOCATION_NAME = "Main";

export const registerInputSchema = z.object({
  // Normalise BEFORE validating so "  Foo@Bar.COM " is accepted and stored as "foo@bar.com".
  email: z.string().trim().toLowerCase().pipe(z.email()),
  password: z.string().min(10, "password must be at least 10 characters").max(200),
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().max(80).optional(),
  phone: z.string().trim().max(32).optional(),
  businessName: z.string().trim().min(2).max(120),
  locale: z.enum(["ar", "en"]).default("ar"),
  currency: z
    .string()
    .trim()
    .length(3)
    .transform((v) => v.toUpperCase())
    .default("SYP"),
  timezone: z
    .string()
    .trim()
    .default("Asia/Damascus")
    .refine((tz) => SUPPORTED_TIMEZONES.has(tz), "unknown IANA timezone"),
});
export type RegisterInput = z.input<typeof registerInputSchema>;

export interface RegistrationResult {
  userId: string;
  businessId: string;
  membershipId: string;
  locationId: string;
}

/**
 * Register a merchant. ONE transaction creates, or nothing is created:
 *   User → Business → OWNER BusinessMembership → default "Main" Location → audit rows.
 * (docs/PRODUCT-SPEC.md §3 "Registration")
 */
export async function registerBusinessOwner(
  rawInput: RegisterInput,
  opts: { ipAddress?: string | null } = {},
): Promise<RegistrationResult> {
  const parsed = registerInputSchema.safeParse(rawInput);
  if (!parsed.success) throw new ValidationError("Invalid registration data", parsed.error.issues);
  const input = parsed.data;

  const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);

  try {
    return await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email: input.email,
          passwordHash,
          firstName: input.firstName,
          lastName: input.lastName ?? null,
          phone: input.phone ?? null,
        },
        select: { id: true },
      });

      const business = await tx.business.create({
        data: {
          name: input.businessName,
          currency: input.currency,
          defaultLocale: input.locale,
          timezone: input.timezone,
        },
        select: { id: true },
      });

      const membership = await tx.businessMembership.create({
        data: { businessId: business.id, userId: user.id, role: MembershipRole.OWNER },
        select: { id: true },
      });

      const location = await tx.location.create({
        data: { businessId: business.id, name: DEFAULT_LOCATION_NAME, isDefault: true },
        select: { id: true },
      });

      const common = { businessId: business.id, actorUserId: user.id, ipAddress: opts.ipAddress };
      await recordAudit(tx, { ...common, action: AuditAction.USER_REGISTERED, entityType: "User", entityId: user.id });
      await recordAudit(tx, { ...common, action: AuditAction.BUSINESS_CREATED, entityType: "Business", entityId: business.id });
      await recordAudit(tx, {
        ...common,
        action: AuditAction.MEMBERSHIP_CREATED,
        entityType: "BusinessMembership",
        entityId: membership.id,
        metadata: { role: MembershipRole.OWNER },
      });
      await recordAudit(tx, {
        ...common,
        action: AuditAction.LOCATION_CREATED,
        entityType: "Location",
        entityId: location.id,
        metadata: { isDefault: true },
      });

      return {
        userId: user.id,
        businessId: business.id,
        membershipId: membership.id,
        locationId: location.id,
      };
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      throw new ConflictError("An account with this email already exists");
    }
    throw e;
  }
}
