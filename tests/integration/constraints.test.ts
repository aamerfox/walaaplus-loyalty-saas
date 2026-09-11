import { describe, expect, it } from "vitest";
import { prisma } from "@/server/db";

/**
 * Asserts the schema-level guarantees the product spec depends on are physically present in the
 * migrated database — including the ones Prisma cannot express and that live in raw SQL.
 */
describe("database constraints and indexes", () => {
  it("has every required UNIQUE index", async () => {
    const rows = await prisma.$queryRaw<{ indexname: string; indexdef: string }[]>`
      SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexdef ILIKE 'CREATE UNIQUE INDEX%'`;
    const names = new Set(rows.map((r) => r.indexname));
    for (const expected of [
      "User_email_key",
      "Customer_normalizedPhone_key",
      "BusinessMembership_businessId_userId_key",
      "CustomerBusinessProfile_businessId_customerId_key",
      "ProgramVersion_templateId_versionNumber_key",
      "UtmSourceLink_publicToken_key",
      "UtmSourceLink_templateId_name_key",
      "CustomerCard_serialNumber_key",
      "CustomerCard_qrToken_key",
      "CustomerCard_shareToken_key",
      "CustomerCard_customerBusinessProfileId_templateId_key",
      "IdempotencyRecord_businessId_key_key",
      "PushSubscription_endpoint_key",
      "LoyaltyOperation_externalProvider_externalEventId_key",
    ]) {
      expect(names, `missing unique index ${expected}`).toContain(expected);
    }
  });

  it("has the partial unique indexes Prisma cannot declare", async () => {
    const rows = await prisma.$queryRaw<{ indexname: string; indexdef: string }[]>`
      SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public'
        AND indexname IN ('ProgramVersion_one_active_per_template', 'Location_one_default_per_business')`;
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.indexdef).toMatch(/CREATE UNIQUE INDEX/);
      expect(r.indexdef).toMatch(/WHERE/);
    }
  });

  it("has the high-volume ledger indexes", async () => {
    const rows = await prisma.$queryRaw<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'LoyaltyOperation'`;
    const names = new Set(rows.map((r) => r.indexname));
    for (const expected of [
      "LoyaltyOperation_businessId_createdAt_idx",
      "LoyaltyOperation_customerCardId_createdAt_idx",
      "LoyaltyOperation_locationId_createdAt_idx",
      "LoyaltyOperation_customerBusinessProfileId_createdAt_idx",
      "LoyaltyOperation_transactionGroupId_idx",
    ]) {
      expect(names, `missing index ${expected}`).toContain(expected);
    }
  });

  it("has the protective triggers", async () => {
    const rows = await prisma.$queryRaw<{ tgname: string; relname: string }[]>`
      SELECT t.tgname, c.relname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
      WHERE NOT t.tgisinternal AND c.relname IN ('LoyaltyOperation', 'ProgramVersion')`;
    const pairs = new Set(rows.map((r) => `${r.relname}:${r.tgname}`));
    expect(pairs).toContain("LoyaltyOperation:loyalty_operation_append_only");
    expect(pairs).toContain("LoyaltyOperation:loyalty_operation_no_truncate");
    expect(pairs).toContain("ProgramVersion:program_version_protect");
  });

  it("LoyaltyOperation has no updatedAt and its core columns are NOT NULL", async () => {
    const cols = await prisma.$queryRaw<{ column_name: string; is_nullable: string }[]>`
      SELECT column_name, is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'LoyaltyOperation'`;
    const byName = new Map(cols.map((c) => [c.column_name, c.is_nullable]));
    expect(byName.has("updatedAt")).toBe(false);
    for (const required of [
      "transactionGroupId",
      "businessId",
      "locationId",
      "customerId",
      "customerBusinessProfileId",
      "customerCardId",
      "templateId",
      "programVersionId",
      "kind",
      "unitType",
      "quantity",
      "balanceAfter",
      "countsAsVisit",
      "source",
      "createdAt",
    ]) {
      expect(byName.get(required), `${required} should be NOT NULL`).toBe("NO");
    }
    // Actor may be null for ENROLLMENT/SYSTEM sources.
    expect(byName.get("performedByUserId")).toBe("YES");
  });

  it("Customer has no name columns (names live on CustomerBusinessProfile)", async () => {
    const cols = await prisma.$queryRaw<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'Customer'`;
    const names = cols.map((c) => c.column_name);
    expect(names).not.toContain("firstName");
    expect(names).not.toContain("lastName");
    const profileCols = await prisma.$queryRaw<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'CustomerBusinessProfile'`;
    expect(profileCols.map((c) => c.column_name)).toEqual(expect.arrayContaining(["firstName", "lastName"]));
  });
});
