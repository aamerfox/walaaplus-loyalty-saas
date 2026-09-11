/**
 * Integration-test helpers. These write directly through Prisma because template, customer and
 * card SERVICES do not exist until Phase 1a; tests for the Phase 0 engine need rows to exist.
 * Production code must never do this (docs/PRODUCT-SPEC.md §2.6).
 */
import { randomBytes, randomUUID } from "node:crypto";
import { CardType, ProgramVersionStatus, TemplateStatus, type Prisma } from "@prisma/client";
import { prisma } from "@/server/db";
import { registerBusinessOwner, type RegisterInput } from "@/server/registration/register";

const APP_TABLES = [
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

/**
 * Wipe every application table. The ledger blocks TRUNCATE by trigger, so the user trigger is
 * disabled for the duration — something only the table owner (the test role) can do, which is
 * exactly the point: application code cannot.
 */
export async function resetDatabase(): Promise<void> {
  const list = APP_TABLES.map((t) => `"${t}"`).join(", ");
  await prisma.$executeRawUnsafe(`ALTER TABLE "LoyaltyOperation" DISABLE TRIGGER USER`);
  try {
    await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
  } finally {
    await prisma.$executeRawUnsafe(`ALTER TABLE "LoyaltyOperation" ENABLE TRIGGER USER`);
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

/** Owner + business + ACTIVE stamp template/version + customer + profile + card, all in one business. */
export async function createBusinessWithCard(
  opts: { mechanics?: Prisma.InputJsonObject; cardType?: CardType } = {},
): Promise<CardFixture> {
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
          status: ProgramVersionStatus.ACTIVE,
          mechanics: opts.mechanics ?? { stampsRequiredPerReward: 10, countRewardRedemptionAsVisit: false },
          activatedAt: new Date(),
        },
      },
    },
    include: { versions: true },
  });
  const version = template.versions[0];

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
  };
}
