/**
 * Integration-test helpers. These write directly through Prisma because template, customer and
 * card SERVICES do not exist until Phase 1a; tests for the Phase 0 engine need rows to exist.
 * Production code must never do this (docs/PRODUCT-SPEC.md §2.6).
 */
import { randomBytes, randomUUID } from "node:crypto";
import { CardType, MembershipRole, OperationSource, PrismaClient, ProgramVersionStatus, TemplateStatus, type Prisma } from "@prisma/client";
import { prisma } from "@/server/db";
import { resolveTestDatabaseUrls } from "./test-env";
import type { MemberActor, SystemActor } from "@/server/ledger/actor";
import { registerBusinessOwner, type RegisterInput } from "@/server/registration/register";
import { requireBusinessMembership, type TenantContext } from "@/server/tenant/context";
import { enrollCustomer, type EnrollCustomerInput } from "@/server/customers/enrollment";
import { reconcileCardBalances } from "@/server/ledger/reconciliation";
import type { StampMechanicsInput } from "@/server/program/mechanics";
import { createStampProgram, type StampProgramSummary } from "@/server/program/stamp-program";

const APP_TABLES = [
  "AuthRateLimit",
  "PushDelivery",
  "PushSubscription",
  "PushMessage",
  "LoyaltyOperation",
  "IdempotencyRecord",
  "AuditLog",
  "CustomerCard",
  "RewardTier",
  "UtmSourceLink",
  "ProgramVersion",
  "ProgramTemplate",
  "CustomerBusinessProfile",
  "Customer",
  "StaffLocation",
  "Location",
  "BusinessMembership",
  "Business",
  "User",
];

let migrator: PrismaClient | undefined;

/**
 * Prisma client connected as the MIGRATOR / table-owner role (TEST_MIGRATE_DATABASE_URL).
 * Only the harness uses it: to wipe tables between files and to prove, from the owner's side,
 * that the runtime role's bypass attempts changed nothing. `prisma` from "@/server/db" is the
 * restricted RUNTIME role — exactly what web and worker use.
 */
export function migratorPrisma(): PrismaClient {
  migrator ??= new PrismaClient({ datasourceUrl: resolveTestDatabaseUrls().owner, log: ["error"] });
  return migrator;
}

/**
 * Wipe every application table. The ledger blocks TRUNCATE by trigger, so the user trigger is
 * disabled for the duration — something only the table OWNER can do. The runtime role the
 * services use cannot (tests/integration/runtime-role.test.ts proves it).
 */
export async function resetDatabase(): Promise<void> {
  const db = migratorPrisma();
  const list = APP_TABLES.map((t) => `"${t}"`).join(", ");
  await db.$executeRawUnsafe(`ALTER TABLE "LoyaltyOperation" DISABLE TRIGGER USER`);
  try {
    await db.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
  } finally {
    await db.$executeRawUnsafe(`ALTER TABLE "LoyaltyOperation" ENABLE TRIGGER USER`);
  }
}

export function uniqueEmail(prefix = "user"): string {
  return `${prefix}-${randomUUID().slice(0, 8)}@example.test`;
}

export function uniquePhone(): string {
  // Syrian mobile shape, random subscriber number. E.164 normalisation itself is Phase 1a.
  return `+9639${randomBytes(4).readUInt32BE(0).toString().padStart(8, "0").slice(0, 8)}`;
}

export const TEST_PASSWORD = "correct-horse-battery-staple";

export async function registerTestOwner(overrides: Partial<RegisterInput> = {}) {
  return registerBusinessOwner({
    email: uniqueEmail("owner"),
    password: TEST_PASSWORD,
    firstName: "Test",
    lastName: "Owner",
    businessName: `Biz ${randomUUID().slice(0, 6)}`,
    ...overrides,
  });
}

export interface CardFixture {
  userId: string;
  businessId: string;
  locationId: string;
  templateId: string;
  programVersionId: string;
  customerId: string;
  profileId: string;
  cardId: string;
}

export interface RewardTierFixture {
  name: string;
  requiredPoints: number;
  rewardValueMinor?: number;
}

/**
 * Owner + business + ACTIVE stamp template/version + customer + profile + card, all in one business.
 * Reward tiers are created while the version is still DRAFT (the trigger forbids adding them later),
 * then the version is activated — the same order production services will follow.
 */
export async function createBusinessWithCard(
  opts: { mechanics?: Prisma.InputJsonObject; cardType?: CardType; rewardTiers?: RewardTierFixture[] } = {},
): Promise<CardFixture & { rewardTierIds: string[] }> {
  const reg = await registerTestOwner();

  const template = await prisma.programTemplate.create({
    data: {
      businessId: reg.businessId,
      name: "Fixture program",
      cardType: opts.cardType ?? CardType.STAMP,
      status: TemplateStatus.ACTIVE,
      versions: {
        create: {
          versionNumber: 1,
          status: ProgramVersionStatus.DRAFT,
          mechanics: opts.mechanics ?? { stampsRequiredPerReward: 10, countRewardRedemptionAsVisit: false },
          rewardTiers: {
            create: (opts.rewardTiers ?? []).map((t, i) => ({ ...t, sortOrder: i })),
          },
        },
      },
    },
    include: { versions: { include: { rewardTiers: true } } },
  });
  const draft = template.versions[0];
  const version = await prisma.programVersion.update({
    where: { id: draft.id },
    data: { status: ProgramVersionStatus.ACTIVE, activatedAt: new Date() },
  });
  const rewardTierIds = draft.rewardTiers.map((t) => t.id);

  const customer = await prisma.customer.create({ data: { normalizedPhone: uniquePhone() } });
  const profile = await prisma.customerBusinessProfile.create({
    data: { businessId: reg.businessId, customerId: customer.id, firstName: "Fixture", lastName: "Customer" },
  });
  const card = await prisma.customerCard.create({
    data: {
      businessId: reg.businessId,
      templateId: template.id,
      programVersionId: version.id,
      customerBusinessProfileId: profile.id,
      serialNumber: `SN-${randomUUID().slice(0, 12)}`,
      qrToken: randomBytes(16).toString("base64url"),
      shareToken: randomBytes(16).toString("base64url"),
      status: "ACTIVE",
    },
  });

  return {
    userId: reg.userId,
    businessId: reg.businessId,
    locationId: reg.locationId,
    templateId: template.id,
    programVersionId: version.id,
    customerId: customer.id,
    profileId: profile.id,
    cardId: card.id,
    rewardTierIds,
  };
}

/** Verified owner context for the fixture business, resolved from the database like production. */
export async function ownerCtx(fx: { userId: string; businessId: string }): Promise<TenantContext> {
  return requireBusinessMembership(prisma, fx.userId, fx.businessId);
}

/** Member actor (scanner by default) for the fixture owner. */
export async function ownerActor(fx: { userId: string; businessId: string }, source: MemberActor["source"] = OperationSource.SCANNER): Promise<MemberActor> {
  return { kind: "member", ctx: await ownerCtx(fx), source };
}

/** Explicit system actor for the fixture business. */
export function systemActor(fx: { businessId: string }, source: SystemActor["source"] = OperationSource.SYSTEM, reason = "test fixture"): SystemActor {
  return { kind: "system", businessId: fx.businessId, source, reason };
}

/** Create a staff user with the given role and location assignments; returns a verified context. */
export async function createStaff(
  fx: { businessId: string },
  role: MembershipRole,
  locationIds: string[] = [],
): Promise<{ userId: string; membershipId: string; ctx: TenantContext }> {
  const user = await prisma.user.create({ data: { email: uniqueEmail(role.toLowerCase()), passwordHash: "x", firstName: role } });
  const m = await prisma.businessMembership.create({
    data: {
      businessId: fx.businessId,
      userId: user.id,
      role,
      locations: { create: locationIds.map((locationId) => ({ locationId })) },
    },
  });
  const ctx = await requireBusinessMembership(prisma, user.id, fx.businessId);
  return { userId: user.id, membershipId: m.id, ctx };
}

export async function createLocation(fx: { businessId: string }, name: string): Promise<string> {
  const l = await prisma.location.create({ data: { businessId: fx.businessId, name } });
  return l.id;
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 1a: a real stamp café
// ─────────────────────────────────────────────────────────────────────────────

/** Mechanics a pilot café would actually configure: buy 10, get 1 free. */
export const CAFE_MECHANICS: StampMechanicsInput = {
  kind: "STAMP",
  contractVersion: 1,
  stampsRequiredPerReward: 10,
  rewardName: "قهوة مجانية",
  earnMode: "MANUAL",
  countRewardRedemptionAsVisit: false,
};

export interface StampCafeFixture {
  userId: string;
  businessId: string;
  locationId: string;
  ctx: TenantContext;
  program: StampProgramSummary;
}

/**
 * Owner + business + live stamp program + direct enrollment source, through the REAL services.
 *
 * Deliberately not hand-written rows: a fixture that builds its own program can drift from what
 * `createStampProgram` produces, and then every test that uses it proves nothing about the code
 * that ships.
 */
export async function createStampCafe(
  opts: { mechanics?: Partial<StampMechanicsInput>; timezone?: string; name?: string } = {},
): Promise<StampCafeFixture> {
  const reg = await registerTestOwner();
  if (opts.timezone) {
    await prisma.business.update({ where: { id: reg.businessId }, data: { timezone: opts.timezone } });
  }
  const ctx = await requireBusinessMembership(prisma, reg.userId, reg.businessId);
  const program = await createStampProgram(ctx, {
    name: opts.name ?? "Café card",
    mechanics: { ...CAFE_MECHANICS, ...opts.mechanics } as StampMechanicsInput,
  });
  return { userId: reg.userId, businessId: reg.businessId, locationId: reg.locationId, ctx, program };
}

/** A cashier assigned to the café's Main location, with a verified context. */
export async function createCafeCashier(fx: StampCafeFixture) {
  return createStaff(fx, MembershipRole.CASHIER, [fx.locationId]);
}

/** A unique Syrian mobile number per call, so tests never collide on the global phone identity. */
export function uniqueSyrianPhone(): string {
  const subscriber = randomBytes(4).readUInt32BE(0).toString().padStart(8, "0").slice(0, 8);
  return `+9639${subscriber}`;
}

/** Enrol a customer through the real public path and return the result. */
export async function enrolCustomer(fx: StampCafeFixture, overrides: Partial<EnrollCustomerInput> = {}) {
  return enrollCustomer({
    sourceToken: fx.program.directSourceToken,
    phone: overrides.phone ?? uniqueSyrianPhone(),
    firstName: overrides.firstName ?? "زبون",
    ...overrides,
  });
}

/** Assert the ledger and the card projections still agree. Call it after every scenario. */
export async function expectReconciled(businessId: string): Promise<void> {
  const report = await reconcileCardBalances({ businessId });
  if (report.mismatches.length > 0) {
    throw new Error(`reconciliation drift: ${JSON.stringify(report.mismatches)}`);
  }
}
