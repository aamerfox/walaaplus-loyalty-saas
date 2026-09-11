/**
 * Prompt 0.3 item 6 — final schema and index review.
 *
 * Every Phase 0 access path is listed here with the constraint or index it depends on, and each
 * one is checked against the ACTUAL migrated PostgreSQL catalog: name, uniqueness, column list in
 * order, and the predicate for partial indexes. A path that loses its index, or whose uniqueness
 * is quietly downgraded to an ordinary index, fails here rather than in production.
 *
 * Identity and integrity are enforced by UNIQUE constraints. An ordinary index is never accepted
 * as a substitute: `unique: true` below is asserted against `pg_index.indisunique`.
 */
import { describe, expect, it } from "vitest";
import { prisma } from "@/server/db";

interface CatalogIndex {
  table_name: string;
  index_name: string;
  is_unique: boolean;
  def: string;
  columns: string[];
}

interface Expectation {
  /** The access path in plain words — why this index exists. */
  path: string;
  table: string;
  index: string;
  unique: boolean;
  columns: string[];
  /** For partial indexes: what the WHERE clause must contain. */
  partial?: RegExp;
}

const EXPECTED: Expectation[] = [
  // ── Ledger read paths (highest-volume table) ──────────────────────────────
  {
    path: "tenant + date: a business's activity feed and reporting window",
    table: "LoyaltyOperation",
    index: "LoyaltyOperation_businessId_createdAt_idx",
    unique: false,
    columns: ["businessId", "createdAt"],
  },
  {
    path: "card + date: one card's history, and reconciliation of its projections",
    table: "LoyaltyOperation",
    index: "LoyaltyOperation_customerCardId_createdAt_idx",
    unique: false,
    columns: ["customerCardId", "createdAt"],
  },
  {
    path: "location + date: per-branch activity and staff reporting",
    table: "LoyaltyOperation",
    index: "LoyaltyOperation_locationId_createdAt_idx",
    unique: false,
    columns: ["locationId", "createdAt"],
  },
  {
    path: "customer-business-profile + date: one customer's history within one business",
    table: "LoyaltyOperation",
    index: "LoyaltyOperation_customerBusinessProfileId_createdAt_idx",
    unique: false,
    columns: ["customerBusinessProfileId", "createdAt"],
  },
  {
    path: "transaction-group lookup: reading and reversing a group",
    table: "LoyaltyOperation",
    index: "LoyaltyOperation_transactionGroupId_idx",
    unique: false,
    columns: ["transactionGroupId"],
  },
  {
    path: "reversal uniqueness: at most ONE compensating row per original operation",
    table: "LoyaltyOperation",
    index: "LoyaltyOperation_reversalOfOperationId_key",
    unique: true,
    columns: ["reversalOfOperationId"],
    partial: /reversalOfOperationId.*IS NOT NULL/i,
  },
  {
    path: "external event de-duplication: one ledger row per provider event",
    table: "LoyaltyOperation",
    index: "LoyaltyOperation_externalProvider_externalEventId_key",
    unique: true,
    columns: ["externalProvider", "externalEventId"],
  },

  // ── Idempotency ───────────────────────────────────────────────────────────
  {
    path: "idempotency lookup by business + key, and the reserve-before-execute race",
    table: "IdempotencyRecord",
    index: "IdempotencyRecord_businessId_key_key",
    unique: true,
    columns: ["businessId", "key"],
  },

  // ── Card identity ─────────────────────────────────────────────────────────
  {
    path: "global card token: QR scan",
    table: "CustomerCard",
    index: "CustomerCard_qrToken_key",
    unique: true,
    columns: ["qrToken"],
  },
  {
    path: "global card token: share link",
    table: "CustomerCard",
    index: "CustomerCard_shareToken_key",
    unique: true,
    columns: ["shareToken"],
  },
  {
    path: "global card token: serial number",
    table: "CustomerCard",
    index: "CustomerCard_serialNumber_key",
    unique: true,
    columns: ["serialNumber"],
  },
  {
    path: "one card per customer profile per template",
    table: "CustomerCard",
    index: "CustomerCard_customerBusinessProfileId_templateId_key",
    unique: true,
    columns: ["customerBusinessProfileId", "templateId"],
  },

  // ── Distribution links ────────────────────────────────────────────────────
  {
    path: "UTM public token: the value carried in a QR or URL, globally unique",
    table: "UtmSourceLink",
    index: "UtmSourceLink_publicToken_key",
    unique: true,
    columns: ["publicToken"],
  },
  {
    path: "UTM link name unique per template (utmSource deliberately is NOT unique)",
    table: "UtmSourceLink",
    index: "UtmSourceLink_templateId_name_key",
    unique: true,
    columns: ["templateId", "name"],
  },

  // ── Staff access resolution (runs on every request) ───────────────────────
  {
    path: "staff membership: one membership per user per business, resolved per request",
    table: "BusinessMembership",
    index: "BusinessMembership_businessId_userId_key",
    unique: true,
    columns: ["businessId", "userId"],
  },
  {
    path: "staff membership: a user's businesses",
    table: "BusinessMembership",
    index: "BusinessMembership_userId_idx",
    unique: false,
    columns: ["userId"],
  },
  {
    path: "staff-location assignment: one row per membership per location",
    table: "StaffLocation",
    index: "StaffLocation_pkey",
    unique: true,
    columns: ["membershipId", "locationId"],
  },
  {
    path: "staff-location assignment: who is assigned to a location",
    table: "StaffLocation",
    index: "StaffLocation_locationId_idx",
    unique: false,
    columns: ["locationId"],
  },

  // ── Audit ─────────────────────────────────────────────────────────────────
  {
    path: "audit log: a business's events by date",
    table: "AuditLog",
    index: "AuditLog_businessId_createdAt_idx",
    unique: false,
    columns: ["businessId", "createdAt"],
  },
  {
    path: "audit log: one actor's events by date",
    table: "AuditLog",
    index: "AuditLog_actorUserId_createdAt_idx",
    unique: false,
    columns: ["actorUserId", "createdAt"],
  },

  // ── Authentication rate limiting ──────────────────────────────────────────
  {
    path: "rate-limit window lookup, and the conflict target that makes the upsert atomic",
    table: "AuthRateLimit",
    index: "AuthRateLimit_scope_keyHash_key",
    unique: true,
    columns: ["scope", "keyHash"],
  },
  {
    path: "rate-limit expiry sweep: DELETE WHERE expiresAt < now() must not scan the table",
    table: "AuthRateLimit",
    index: "AuthRateLimit_expiresAt_idx",
    unique: false,
    columns: ["expiresAt"],
  },

  // ── Program integrity (partial uniques Prisma cannot express) ─────────────
  {
    path: "at most one ACTIVE version per program template",
    table: "ProgramVersion",
    index: "ProgramVersion_one_active_per_template",
    unique: true,
    columns: ["templateId"],
    partial: /status = 'ACTIVE'/i,
  },
  {
    path: "version numbering is stable per template",
    table: "ProgramVersion",
    index: "ProgramVersion_templateId_versionNumber_key",
    unique: true,
    columns: ["templateId", "versionNumber"],
  },
  {
    path: "at most one default location per business",
    table: "Location",
    index: "Location_one_default_per_business",
    unique: true,
    columns: ["businessId"],
    partial: /isDefault.*true/i,
  },

  // ── Customer identity ─────────────────────────────────────────────────────
  {
    path: "customer is a global phone identity",
    table: "Customer",
    index: "Customer_normalizedPhone_key",
    unique: true,
    columns: ["normalizedPhone"],
  },
  {
    path: "one profile per customer per business",
    table: "CustomerBusinessProfile",
    index: "CustomerBusinessProfile_businessId_customerId_key",
    unique: true,
    columns: ["businessId", "customerId"],
  },
  {
    path: "merchant sign-in by email",
    table: "User",
    index: "User_email_key",
    unique: true,
    columns: ["email"],
  },
];

async function loadCatalog(): Promise<Map<string, CatalogIndex>> {
  const rows = await prisma.$queryRaw<CatalogIndex[]>`
    SELECT t.relname AS table_name,
           i.relname AS index_name,
           ix.indisunique AS is_unique,
           pg_get_indexdef(ix.indexrelid) AS def,
           array_agg(a.attname ORDER BY k.ord) AS columns
      FROM pg_index ix
      JOIN pg_class i ON i.oid = ix.indexrelid
      JOIN pg_class t ON t.oid = ix.indrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ord) ON true
      JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
     WHERE n.nspname = 'public'
     GROUP BY t.relname, i.relname, ix.indisunique, ix.indexrelid`;
  return new Map(rows.map((r) => [r.index_name, r]));
}

describe("Phase 0 schema and index review", () => {
  it.each(EXPECTED.map((e) => [e.index, e] as const))("%s", async (_name, expectation) => {
    const catalog = await loadCatalog();
    const found = catalog.get(expectation.index);
    expect(found, `missing index for access path: ${expectation.path}`).toBeDefined();
    expect(found!.table_name, expectation.path).toBe(expectation.table);
    expect(found!.columns, expectation.path).toEqual(expectation.columns);
    // Identity and integrity must be constraints, never ordinary indexes.
    expect(found!.is_unique, `${expectation.index} must ${expectation.unique ? "" : "NOT "}be UNIQUE`).toBe(expectation.unique);
    if (expectation.partial) {
      expect(found!.def, `${expectation.index} must be partial`).toMatch(/WHERE/i);
      expect(found!.def).toMatch(expectation.partial);
    } else {
      expect(found!.def, `${expectation.index} must not be partial`).not.toMatch(/WHERE/i);
    }
  });

  it("the ledger keeps no mutable timestamp and its identity columns are NOT NULL", async () => {
    const cols = await prisma.$queryRaw<{ column_name: string; is_nullable: string }[]>`
      SELECT column_name, is_nullable FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'LoyaltyOperation'`;
    const byName = new Map(cols.map((c) => [c.column_name, c.is_nullable]));
    expect(byName.has("updatedAt")).toBe(false);
    for (const c of ["transactionGroupId", "businessId", "locationId", "customerCardId", "countsAsVisit", "source", "createdAt"]) {
      expect(byName.get(c), `${c} must be NOT NULL`).toBe("NO");
    }
  });

  it("AuthRateLimit has the columns and types the atomic upsert relies on", async () => {
    const cols = await prisma.$queryRaw<{ column_name: string; data_type: string; is_nullable: string }[]>`
      SELECT column_name, data_type, is_nullable FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'AuthRateLimit' ORDER BY column_name`;
    const byName = new Map(cols.map((c) => [c.column_name, c]));
    expect([...byName.keys()]).toEqual(["attempts", "expiresAt", "id", "keyHash", "lastAttemptAt", "scope", "windowStart"]);
    expect(byName.get("attempts")!.data_type).toBe("integer");
    for (const c of ["expiresAt", "windowStart", "lastAttemptAt"]) {
      expect(byName.get(c)!.data_type).toBe("timestamp without time zone");
      expect(byName.get(c)!.is_nullable).toBe("NO");
    }
    expect(byName.get("keyHash")!.is_nullable).toBe("NO");
    expect(byName.get("scope")!.is_nullable).toBe("NO");
  });

  it("every table the application writes has a primary key", async () => {
    const rows = await prisma.$queryRaw<{ relname: string }[]>`
      SELECT c.relname FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname <> '_prisma_migrations'
        AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = c.oid AND i.indisprimary)`;
    expect(rows.map((r) => r.relname)).toEqual([]);
  });

  it("the protective triggers are all present and enabled", async () => {
    const rows = await prisma.$queryRaw<{ relname: string; tgname: string; tgenabled: string }[]>`
      SELECT c.relname, t.tgname, t.tgenabled::text AS tgenabled
        FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
       WHERE NOT t.tgisinternal ORDER BY c.relname, t.tgname`;
    const pairs = new Set(rows.map((r) => `${r.relname}:${r.tgname}`));
    for (const expected of [
      "LoyaltyOperation:loyalty_operation_append_only",
      "LoyaltyOperation:loyalty_operation_no_truncate",
      "ProgramVersion:program_version_protect",
      "RewardTier:reward_tier_protect",
      "ProgramTemplate:program_template_protect_card_type",
    ]) {
      expect(pairs, `missing trigger ${expected}`).toContain(expected);
    }
    // 'O' = enabled in origin/local mode. A disabled trigger ('D') is a silent hole.
    expect(rows.every((r) => r.tgenabled === "O")).toBe(true);
  });
});
