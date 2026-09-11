-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "MembershipRole" AS ENUM ('OWNER', 'MANAGER', 'CASHIER');

-- CreateEnum
CREATE TYPE "Permission" AS ENUM ('VIEW_DASHBOARD', 'VIEW_TEMPLATES', 'EDIT_TEMPLATES', 'VIEW_CUSTOMERS', 'EDIT_CUSTOMERS', 'VIEW_OPERATIONS', 'MAKE_ACCRUALS', 'MAKE_REDEMPTIONS', 'VIEW_LOCATIONS', 'EDIT_LOCATIONS', 'VIEW_STAFF', 'EDIT_STAFF', 'VIEW_PUSHES', 'EDIT_PUSHES', 'VIEW_SEGMENTS', 'EDIT_SEGMENTS', 'VIEW_INTEGRATIONS', 'EDIT_INTEGRATIONS', 'VIEW_BILLING', 'EDIT_BILLING', 'VIEW_AGENCY', 'EDIT_AGENCY');

-- CreateEnum
CREATE TYPE "TemplateStatus" AS ENUM ('DRAFT', 'ACTIVE', 'PAUSED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "ProgramVersionStatus" AS ENUM ('DRAFT', 'ACTIVE', 'RETIRED');

-- CreateEnum
CREATE TYPE "CardType" AS ENUM ('STAMP', 'POINTS');

-- CreateEnum
CREATE TYPE "CardStatus" AS ENUM ('ISSUED', 'ACTIVE', 'PAUSED', 'EXPIRED', 'DELETED');

-- CreateEnum
CREATE TYPE "DeviceChannel" AS ENUM ('UNKNOWN', 'PWA', 'APPLE_WALLET', 'GOOGLE_WALLET');

-- CreateEnum
CREATE TYPE "OperationKind" AS ENUM ('CARD_ISSUED', 'WELCOME_BONUS', 'BIRTHDAY_BONUS', 'MANUAL_AWARD', 'VISIT_AWARD', 'PURCHASE_AWARD', 'STAMP_CONVERTED', 'REWARD_EARNED', 'REWARD_REDEEMED', 'BALANCE_REDEEMED', 'BALANCE_EXPIRED', 'IMPORT_ADJUSTMENT', 'REVERSAL', 'REFERRAL_BONUS', 'PROMOTION_REDEEMED', 'INTEGRATION_AWARD', 'INTEGRATION_REVERSAL');

-- CreateEnum
CREATE TYPE "UnitType" AS ENUM ('STAMP', 'POINT', 'REWARD', 'CASH', 'VISIT');

-- CreateEnum
CREATE TYPE "OperationSource" AS ENUM ('SCANNER', 'DASHBOARD', 'ENROLLMENT', 'AUTOMATION', 'IMPORT', 'API', 'SYSTEM');

-- CreateEnum
CREATE TYPE "PushMessageKind" AS ENUM ('MANUAL', 'TRANSACTIONAL', 'AUTOMATION');

-- CreateEnum
CREATE TYPE "PushMessageStatus" AS ENUM ('DRAFT', 'SCHEDULED', 'SENDING', 'SENT', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PushDeliveryStatus" AS ENUM ('PENDING', 'SENT', 'FAILED', 'EXPIRED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "firstName" TEXT,
    "lastName" TEXT,
    "phone" TEXT,
    "platformRole" TEXT NOT NULL DEFAULT 'USER',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Business" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT,
    "name" TEXT NOT NULL,
    "legalName" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'SYP',
    "defaultLocale" TEXT NOT NULL DEFAULT 'ar',
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Damascus',
    "logoUrl" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Business_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BusinessMembership" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "MembershipRole" NOT NULL,
    "permissions" "Permission"[] DEFAULT ARRAY[]::"Permission"[],
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BusinessMembership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StaffLocation" (
    "membershipId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StaffLocation_pkey" PRIMARY KEY ("membershipId","locationId")
);

-- CreateTable
CREATE TABLE "Location" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT,
    "latitude" DECIMAL(9,6),
    "longitude" DECIMAL(9,6),
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Location_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Customer" (
    "id" TEXT NOT NULL,
    "normalizedPhone" TEXT NOT NULL,
    "email" TEXT,
    "birthDate" DATE,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerBusinessProfile" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "firstName" TEXT,
    "lastName" TEXT,
    "marketingConsent" BOOLEAN NOT NULL DEFAULT false,
    "privacyConsentAt" TIMESTAMP(3),
    "consentTextVersion" TEXT,
    "customFields" JSONB,
    "utmSource" TEXT,
    "utmMedium" TEXT,
    "utmCampaign" TEXT,
    "referrerCustomerCardId" TEXT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerBusinessProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProgramTemplate" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "TemplateStatus" NOT NULL DEFAULT 'DRAFT',
    "cardType" "CardType" NOT NULL,
    "defaultLocale" TEXT NOT NULL DEFAULT 'ar',
    "livePresentation" JSONB NOT NULL DEFAULT '{}',
    "liveLegal" JSONB NOT NULL DEFAULT '{}',
    "liveIssuer" JSONB NOT NULL DEFAULT '{}',
    "livePlatform" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProgramTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProgramVersion" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "status" "ProgramVersionStatus" NOT NULL DEFAULT 'DRAFT',
    "mechanics" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activatedAt" TIMESTAMP(3),

    CONSTRAINT "ProgramVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RewardTier" (
    "id" TEXT NOT NULL,
    "programVersionId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "requiredPoints" INTEGER NOT NULL,
    "rewardValueMinor" INTEGER,
    "usageLimit" INTEGER,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RewardTier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UtmSourceLink" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "publicToken" TEXT NOT NULL,
    "utmSource" TEXT NOT NULL,
    "utmMedium" TEXT,
    "utmCampaign" TEXT,
    "welcomeUnitQuantity" INTEGER,
    "welcomeBonusExpiresAfterDays" INTEGER,
    "enrollmentTitle" TEXT,
    "enrollmentImageUrl" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UtmSourceLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerCard" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "programVersionId" TEXT NOT NULL,
    "customerBusinessProfileId" TEXT NOT NULL,
    "serialNumber" TEXT NOT NULL,
    "qrToken" TEXT NOT NULL,
    "shareToken" TEXT NOT NULL,
    "status" "CardStatus" NOT NULL DEFAULT 'ISSUED',
    "deviceChannel" "DeviceChannel" NOT NULL DEFAULT 'UNKNOWN',
    "stampBalance" INTEGER NOT NULL DEFAULT 0,
    "pointBalance" INTEGER NOT NULL DEFAULT 0,
    "rewardBalance" INTEGER NOT NULL DEFAULT 0,
    "cashBalanceMinor" INTEGER NOT NULL DEFAULT 0,
    "visitBalance" INTEGER NOT NULL DEFAULT 0,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "firstOpenedAt" TIMESTAMP(3),
    "lastOpenedAt" TIMESTAMP(3),
    "pwaDetectedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "lastActivityAt" TIMESTAMP(3),
    "utmSourceLinkId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerCard_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoyaltyOperation" (
    "id" TEXT NOT NULL,
    "transactionGroupId" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "customerBusinessProfileId" TEXT NOT NULL,
    "customerCardId" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "programVersionId" TEXT NOT NULL,
    "performedByUserId" TEXT,
    "rewardTierId" TEXT,
    "kind" "OperationKind" NOT NULL,
    "unitType" "UnitType" NOT NULL,
    "quantity" INTEGER NOT NULL,
    "purchaseAmountMinor" INTEGER,
    "monetaryDeltaMinor" INTEGER,
    "redemptionValueMinor" INTEGER,
    "balanceAfter" INTEGER NOT NULL,
    "countsAsVisit" BOOLEAN NOT NULL,
    "source" "OperationSource" NOT NULL,
    "comment" TEXT,
    "reason" TEXT,
    "reversalOfOperationId" TEXT,
    "externalProvider" TEXT,
    "externalEventId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoyaltyOperation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IdempotencyRecord" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "transactionGroupId" TEXT,
    "response" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IdempotencyRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "businessId" TEXT,
    "actorUserId" TEXT,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT,
    "metadata" JSONB,
    "ipAddress" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PushSubscription" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "customerCardId" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "userAgent" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PushSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PushMessage" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "templateId" TEXT,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "targetUrl" TEXT,
    "kind" "PushMessageKind" NOT NULL,
    "status" "PushMessageStatus" NOT NULL DEFAULT 'DRAFT',
    "scheduledAt" TIMESTAMP(3),
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PushMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PushDelivery" (
    "id" TEXT NOT NULL,
    "pushMessageId" TEXT NOT NULL,
    "pushSubscriptionId" TEXT NOT NULL,
    "customerCardId" TEXT NOT NULL,
    "status" "PushDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "providerStatusCode" INTEGER,
    "failureReason" TEXT,
    "sentAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PushDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "BusinessMembership_userId_idx" ON "BusinessMembership"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "BusinessMembership_businessId_userId_key" ON "BusinessMembership"("businessId", "userId");

-- CreateIndex
CREATE INDEX "StaffLocation_locationId_idx" ON "StaffLocation"("locationId");

-- CreateIndex
CREATE INDEX "Location_businessId_idx" ON "Location"("businessId");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_normalizedPhone_key" ON "Customer"("normalizedPhone");

-- CreateIndex
CREATE INDEX "CustomerBusinessProfile_businessId_lastSeenAt_idx" ON "CustomerBusinessProfile"("businessId", "lastSeenAt");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerBusinessProfile_businessId_customerId_key" ON "CustomerBusinessProfile"("businessId", "customerId");

-- CreateIndex
CREATE INDEX "ProgramTemplate_businessId_status_idx" ON "ProgramTemplate"("businessId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ProgramVersion_templateId_versionNumber_key" ON "ProgramVersion"("templateId", "versionNumber");

-- CreateIndex
CREATE INDEX "RewardTier_programVersionId_idx" ON "RewardTier"("programVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "UtmSourceLink_publicToken_key" ON "UtmSourceLink"("publicToken");

-- CreateIndex
CREATE UNIQUE INDEX "UtmSourceLink_templateId_utmSource_key" ON "UtmSourceLink"("templateId", "utmSource");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerCard_serialNumber_key" ON "CustomerCard"("serialNumber");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerCard_qrToken_key" ON "CustomerCard"("qrToken");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerCard_shareToken_key" ON "CustomerCard"("shareToken");

-- CreateIndex
CREATE INDEX "CustomerCard_businessId_status_idx" ON "CustomerCard"("businessId", "status");

-- CreateIndex
CREATE INDEX "CustomerCard_templateId_idx" ON "CustomerCard"("templateId");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerCard_customerBusinessProfileId_templateId_key" ON "CustomerCard"("customerBusinessProfileId", "templateId");

-- CreateIndex
CREATE INDEX "LoyaltyOperation_businessId_createdAt_idx" ON "LoyaltyOperation"("businessId", "createdAt");

-- CreateIndex
CREATE INDEX "LoyaltyOperation_customerCardId_createdAt_idx" ON "LoyaltyOperation"("customerCardId", "createdAt");

-- CreateIndex
CREATE INDEX "LoyaltyOperation_locationId_createdAt_idx" ON "LoyaltyOperation"("locationId", "createdAt");

-- CreateIndex
CREATE INDEX "LoyaltyOperation_customerBusinessProfileId_createdAt_idx" ON "LoyaltyOperation"("customerBusinessProfileId", "createdAt");

-- CreateIndex
CREATE INDEX "LoyaltyOperation_transactionGroupId_idx" ON "LoyaltyOperation"("transactionGroupId");

-- CreateIndex
CREATE UNIQUE INDEX "LoyaltyOperation_externalProvider_externalEventId_key" ON "LoyaltyOperation"("externalProvider", "externalEventId");

-- CreateIndex
CREATE INDEX "IdempotencyRecord_createdAt_idx" ON "IdempotencyRecord"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "IdempotencyRecord_businessId_key_key" ON "IdempotencyRecord"("businessId", "key");

-- CreateIndex
CREATE INDEX "AuditLog_businessId_createdAt_idx" ON "AuditLog"("businessId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_actorUserId_createdAt_idx" ON "AuditLog"("actorUserId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PushSubscription_endpoint_key" ON "PushSubscription"("endpoint");

-- CreateIndex
CREATE INDEX "PushSubscription_customerCardId_idx" ON "PushSubscription"("customerCardId");

-- CreateIndex
CREATE INDEX "PushMessage_businessId_createdAt_idx" ON "PushMessage"("businessId", "createdAt");

-- CreateIndex
CREATE INDEX "PushDelivery_pushMessageId_status_idx" ON "PushDelivery"("pushMessageId", "status");

-- AddForeignKey
ALTER TABLE "BusinessMembership" ADD CONSTRAINT "BusinessMembership_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BusinessMembership" ADD CONSTRAINT "BusinessMembership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffLocation" ADD CONSTRAINT "StaffLocation_membershipId_fkey" FOREIGN KEY ("membershipId") REFERENCES "BusinessMembership"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffLocation" ADD CONSTRAINT "StaffLocation_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Location" ADD CONSTRAINT "Location_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerBusinessProfile" ADD CONSTRAINT "CustomerBusinessProfile_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerBusinessProfile" ADD CONSTRAINT "CustomerBusinessProfile_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProgramTemplate" ADD CONSTRAINT "ProgramTemplate_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProgramVersion" ADD CONSTRAINT "ProgramVersion_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "ProgramTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RewardTier" ADD CONSTRAINT "RewardTier_programVersionId_fkey" FOREIGN KEY ("programVersionId") REFERENCES "ProgramVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UtmSourceLink" ADD CONSTRAINT "UtmSourceLink_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "ProgramTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerCard" ADD CONSTRAINT "CustomerCard_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerCard" ADD CONSTRAINT "CustomerCard_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "ProgramTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerCard" ADD CONSTRAINT "CustomerCard_programVersionId_fkey" FOREIGN KEY ("programVersionId") REFERENCES "ProgramVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerCard" ADD CONSTRAINT "CustomerCard_customerBusinessProfileId_fkey" FOREIGN KEY ("customerBusinessProfileId") REFERENCES "CustomerBusinessProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerCard" ADD CONSTRAINT "CustomerCard_utmSourceLinkId_fkey" FOREIGN KEY ("utmSourceLinkId") REFERENCES "UtmSourceLink"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoyaltyOperation" ADD CONSTRAINT "LoyaltyOperation_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoyaltyOperation" ADD CONSTRAINT "LoyaltyOperation_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoyaltyOperation" ADD CONSTRAINT "LoyaltyOperation_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoyaltyOperation" ADD CONSTRAINT "LoyaltyOperation_customerBusinessProfileId_fkey" FOREIGN KEY ("customerBusinessProfileId") REFERENCES "CustomerBusinessProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoyaltyOperation" ADD CONSTRAINT "LoyaltyOperation_customerCardId_fkey" FOREIGN KEY ("customerCardId") REFERENCES "CustomerCard"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoyaltyOperation" ADD CONSTRAINT "LoyaltyOperation_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "ProgramTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoyaltyOperation" ADD CONSTRAINT "LoyaltyOperation_programVersionId_fkey" FOREIGN KEY ("programVersionId") REFERENCES "ProgramVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoyaltyOperation" ADD CONSTRAINT "LoyaltyOperation_performedByUserId_fkey" FOREIGN KEY ("performedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoyaltyOperation" ADD CONSTRAINT "LoyaltyOperation_rewardTierId_fkey" FOREIGN KEY ("rewardTierId") REFERENCES "RewardTier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoyaltyOperation" ADD CONSTRAINT "LoyaltyOperation_reversalOfOperationId_fkey" FOREIGN KEY ("reversalOfOperationId") REFERENCES "LoyaltyOperation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IdempotencyRecord" ADD CONSTRAINT "IdempotencyRecord_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PushSubscription" ADD CONSTRAINT "PushSubscription_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PushSubscription" ADD CONSTRAINT "PushSubscription_customerCardId_fkey" FOREIGN KEY ("customerCardId") REFERENCES "CustomerCard"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PushMessage" ADD CONSTRAINT "PushMessage_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PushMessage" ADD CONSTRAINT "PushMessage_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "ProgramTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PushMessage" ADD CONSTRAINT "PushMessage_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PushDelivery" ADD CONSTRAINT "PushDelivery_pushMessageId_fkey" FOREIGN KEY ("pushMessageId") REFERENCES "PushMessage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PushDelivery" ADD CONSTRAINT "PushDelivery_pushSubscriptionId_fkey" FOREIGN KEY ("pushSubscriptionId") REFERENCES "PushSubscription"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PushDelivery" ADD CONSTRAINT "PushDelivery_customerCardId_fkey" FOREIGN KEY ("customerCardId") REFERENCES "CustomerCard"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ═══════════════════════════════════════════════════════════════════════════
-- WalaaPlus hand-written constraints. Prisma's schema language cannot express these,
-- so they live here and integration tests assert each one exists. See docs/PRODUCT-SPEC.md.
-- ═══════════════════════════════════════════════════════════════════════════

-- 1. Exactly one ACTIVE ProgramVersion per template. There is deliberately no
--    activeVersionId pointer on ProgramTemplate (two sources of truth would drift).
CREATE UNIQUE INDEX "ProgramVersion_one_active_per_template"
  ON "ProgramVersion" ("templateId")
  WHERE status = 'ACTIVE';

-- 2. Exactly one default ("Main") Location per business.
CREATE UNIQUE INDEX "Location_one_default_per_business"
  ON "Location" ("businessId")
  WHERE "isDefault" = true;

-- 3. LoyaltyOperation is APPEND-ONLY. UPDATE, DELETE and TRUNCATE are rejected at the
--    database level regardless of application code. Corrections are compensating rows.
CREATE OR REPLACE FUNCTION walaaplus_reject_ledger_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'LoyaltyOperation is append-only; % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation',
          HINT = 'Write a compensating reversal operation instead of mutating history.';
END
$$;

CREATE TRIGGER loyalty_operation_append_only
  BEFORE UPDATE OR DELETE ON "LoyaltyOperation"
  FOR EACH ROW EXECUTE FUNCTION walaaplus_reject_ledger_mutation();

CREATE TRIGGER loyalty_operation_no_truncate
  BEFORE TRUNCATE ON "LoyaltyOperation"
  FOR EACH STATEMENT EXECUTE FUNCTION walaaplus_reject_ledger_mutation();

-- 4. ProgramVersion mechanics are frozen once the version leaves DRAFT, and status only
--    moves forward (DRAFT -> ACTIVE -> RETIRED). Non-DRAFT versions cannot be deleted:
--    issued cards pin them forever.
CREATE OR REPLACE FUNCTION walaaplus_protect_program_version() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'DRAFT' THEN
      RAISE EXCEPTION 'ProgramVersion % is %; only DRAFT versions may be deleted', OLD.id, OLD.status
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.status <> 'DRAFT' AND (
       NEW.mechanics IS DISTINCT FROM OLD.mechanics
    OR NEW."templateId" <> OLD."templateId"
    OR NEW."versionNumber" <> OLD."versionNumber"
  ) THEN
    RAISE EXCEPTION 'ProgramVersion % is %; mechanics are immutable after activation', OLD.id, OLD.status
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF (OLD.status = 'ACTIVE' AND NEW.status = 'DRAFT')
     OR (OLD.status = 'RETIRED' AND NEW.status <> 'RETIRED') THEN
    RAISE EXCEPTION 'ProgramVersion % status cannot move from % to %', OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER program_version_protect
  BEFORE UPDATE OR DELETE ON "ProgramVersion"
  FOR EACH ROW EXECUTE FUNCTION walaaplus_protect_program_version();
