/**
 * Remediation item 6 — the RESTRICTED RUNTIME ROLE.
 *
 * `prisma` from "@/server/db" is connected exactly as web and worker are: with TEST_DATABASE_URL,
 * the restricted role created by scripts/db-roles.mjs. This file proves, against real PostgreSQL:
 *
 *   - the connection really is a non-superuser role distinct from the migrator;
 *   - the legitimate path works (SELECT and INSERT on the ledger through the service);
 *   - every known bypass of the append-only ledger fails with a PRIVILEGE error, i.e. before any
 *     trigger runs: UPDATE, DELETE, TRUNCATE, ALTER TABLE, disabling or dropping the triggers,
 *     replacing or dropping the trigger function, dropping the index, session_replication_role,
 *     SET ROLE to the migrator, self-promotion, creating objects in `public`, touching
 *     `_prisma_migrations`;
 *   - afterwards the ledger row, the triggers and the function are untouched — verified from the
 *     OWNER side, so a "failure" that silently succeeded would be caught.
 */
import { OperationKind, OperationSource, UnitType } from "@prisma/client";
import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { appendOperationGroup } from "@/server/ledger/ledger";
import { createBusinessWithCard, migratorPrisma, ownerActor, resetDatabase, type CardFixture } from "../setup/fixtures";

/** PostgreSQL privilege errors (SQLSTATE 42501 and friends) as Prisma surfaces them. */
const DENIED = /permission denied|must be owner|must be superuser|must have admin option/i;

interface RoleRow {
  rolname: string;
  rolsuper: boolean;
  rolcreaterole: boolean;
  rolcreatedb: boolean;
  rolbypassrls: boolean;
  rolreplication: boolean;
}

async function currentRole(db: typeof prisma): Promise<RoleRow> {
  const rows = await db.$queryRaw<RoleRow[]>`
    SELECT rolname, rolsuper, rolcreaterole, rolcreatedb, rolbypassrls, rolreplication
    FROM pg_catalog.pg_roles WHERE rolname = current_user`;
  return rows[0];
}

interface Snapshot {
  rowCount: number;
  quantity: number;
  triggers: { tgname: string; tgenabled: string }[];
  functionSource: string;
  indexes: string[];
}

/** Everything a bypass could have damaged, read as the OWNER so nothing is hidden by privilege. */
async function snapshot(opId: string): Promise<Snapshot> {
  const owner = migratorPrisma();
  const row = await owner.loyaltyOperation.findUniqueOrThrow({ where: { id: opId } });
  const triggers = await owner.$queryRaw<{ tgname: string; tgenabled: string }[]>`
    SELECT t.tgname, t.tgenabled::text AS tgenabled
    FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
    WHERE c.relname = 'LoyaltyOperation' AND NOT t.tgisinternal ORDER BY t.tgname`;
  const fn = await owner.$queryRaw<{ prosrc: string }[]>`
    SELECT prosrc FROM pg_proc WHERE proname = 'walaaplus_reject_ledger_mutation'`;
  const idx = await owner.$queryRaw<{ indexname: string }[]>`
    SELECT indexname FROM pg_indexes WHERE tablename = 'LoyaltyOperation' ORDER BY indexname`;
  return {
    rowCount: await owner.loyaltyOperation.count(),
    quantity: row.quantity,
    triggers,
    functionSource: fn[0]?.prosrc ?? "",
    indexes: idx.map((i) => i.indexname),
  };
}

describe("restricted runtime database role", () => {
  let fx: CardFixture;
  let opId: string;
  let before: Snapshot;
  let runtimeRoleName: string;

  beforeAll(async () => {
    await resetDatabase();
    fx = await createBusinessWithCard();
    const r = await appendOperationGroup({
      actor: await ownerActor(fx, OperationSource.DASHBOARD),
      customerCardId: fx.cardId,
      locationId: fx.locationId,
      operations: [{ kind: OperationKind.MANUAL_AWARD, unitType: UnitType.STAMP, quantity: 1 }],
    });
    opId = r.operations[0].id;
    before = await snapshot(opId);
    runtimeRoleName = (await currentRole(prisma)).rolname;
  });

  describe("identity", () => {
    it("the services connect as a non-superuser role with no elevated attributes", async () => {
      const role = await currentRole(prisma);
      expect(role.rolsuper).toBe(false);
      expect(role.rolcreaterole).toBe(false);
      expect(role.rolcreatedb).toBe(false);
      expect(role.rolbypassrls).toBe(false);
      expect(role.rolreplication).toBe(false);
    });

    it("the runtime role is not the migrator role, and owns nothing in schema public", async () => {
      const migrator = await currentRole(migratorPrisma());
      expect(runtimeRoleName).not.toBe(migrator.rolname);
      const owned = await prisma.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND pg_get_userbyid(c.relowner) = current_user`;
      expect(owned[0].n).toBe(0);
    });

    it("no role is left able to act AS the runtime role after setup (0.3 item 5)", async () => {
      // scripts/db-roles.mjs may borrow membership in this role to transfer ownership of the
      // pgboss schema. Membership is privilege — a member can SET ROLE into it — so the script
      // hands it straight back. Nothing may remain a member of the runtime role after setup.
      const rows = await prisma.$queryRaw<{ rolname: string }[]>`
        SELECT member.rolname FROM pg_catalog.pg_auth_members m
          JOIN pg_catalog.pg_roles target ON target.oid = m.roleid
          JOIN pg_catalog.pg_roles member ON member.oid = m.member
         WHERE target.rolname = current_user ORDER BY 1`;
      expect(rows.map((r) => r.rolname)).toEqual([]);

      const migrator = await currentRole(migratorPrisma());
      const asMigrator = await migratorPrisma().$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_catalog.pg_auth_members m
          JOIN pg_catalog.pg_roles target ON target.oid = m.roleid
          JOIN pg_catalog.pg_roles member ON member.oid = m.member
         WHERE member.rolname = ${migrator.rolname}`;
      expect(asMigrator[0].n).toBe(0);
    });

    it("the runtime role owns the worker schema but still cannot create in public", async () => {
      const rows = await prisma.$queryRaw<{ owner: string }[]>`
        SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname = 'pgboss'`;
      expect(rows[0]?.owner).toBe(runtimeRoleName);
      const created = await prisma.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'pgboss' AND pg_get_userbyid(c.relowner) <> current_user`;
      expect(created[0].n).toBe(0);
    });

    it("has exactly SELECT and INSERT on the ledger, and no CREATE in public", async () => {
      const p = await prisma.$queryRaw<{ s: boolean; i: boolean; u: boolean; d: boolean; t: boolean; c: boolean }[]>`
        SELECT has_table_privilege('"LoyaltyOperation"', 'SELECT')   AS s,
               has_table_privilege('"LoyaltyOperation"', 'INSERT')   AS i,
               has_table_privilege('"LoyaltyOperation"', 'UPDATE')   AS u,
               has_table_privilege('"LoyaltyOperation"', 'DELETE')   AS d,
               has_table_privilege('"LoyaltyOperation"', 'TRUNCATE') AS t,
               has_schema_privilege('public', 'CREATE')              AS c`;
      expect(p[0]).toEqual({ s: true, i: true, u: false, d: false, t: false, c: false });
    });

    it.each([
      `"ConsentRecord"`,
      `"CampaignRevision"`,
      `"CampaignApproval"`,
      `"CampaignAudienceSnapshot"`,
      `"CampaignAudienceMember"`,
    ])(
      "has exactly SELECT and INSERT on %s, the other append-only histories",
      async (table) => {
        /*
         * Consent history and campaign revisions are append-only for the same reason the ledger is:
         * what they record is WHAT HAPPENED, and an edit to that is indistinguishable from a lie.
         * The triggers already refuse a mutation, but a trigger is defeated by whoever may ALTER the
         * table, so the runtime role must not hold the privilege in the first place. Any table added
         * to APPEND_ONLY_TABLES in scripts/db-roles.mjs belongs in this list.
         */
        const p = await prisma.$queryRaw<{ s: boolean; i: boolean; u: boolean; d: boolean; t: boolean }[]>`
          SELECT has_table_privilege(${table}::text, 'SELECT')   AS s,
                 has_table_privilege(${table}::text, 'INSERT')   AS i,
                 has_table_privilege(${table}::text, 'UPDATE')   AS u,
                 has_table_privilege(${table}::text, 'DELETE')   AS d,
                 has_table_privilege(${table}::text, 'TRUNCATE') AS t`;
        expect(p[0]).toEqual({ s: true, i: true, u: false, d: false, t: false });
      },
    );
  });

  describe("the legitimate path works as the runtime role", () => {
    it("reads the ledger and appended a row through the service", async () => {
      expect(await prisma.loyaltyOperation.count()).toBe(1);
      const row = await prisma.loyaltyOperation.findUniqueOrThrow({ where: { id: opId } });
      expect(row.quantity).toBe(1);
    });

    it("can still write ordinary application tables (projection update path)", async () => {
      const card = await prisma.customerCard.findUniqueOrThrow({ where: { id: fx.cardId } });
      expect(card.stampBalance).toBe(1);
      await prisma.customerCard.update({ where: { id: fx.cardId }, data: { status: "ACTIVE" } });
    });
  });

  describe("every bypass fails on privilege, before any trigger runs", () => {
    const attempts: [string, string][] = [
      ["UPDATE ledger row", `UPDATE "LoyaltyOperation" SET quantity = 5`],
      ["DELETE ledger rows", `DELETE FROM "LoyaltyOperation"`],
      ["TRUNCATE ledger", `TRUNCATE "LoyaltyOperation"`],
      ["TRUNCATE ledger CASCADE", `TRUNCATE "LoyaltyOperation" CASCADE`],
      ["disable user triggers", `ALTER TABLE "LoyaltyOperation" DISABLE TRIGGER USER`],
      ["disable all triggers", `ALTER TABLE "LoyaltyOperation" DISABLE TRIGGER ALL`],
      ["disable the append-only trigger by name", `ALTER TABLE "LoyaltyOperation" DISABLE TRIGGER loyalty_operation_append_only`],
      ["disable the no-truncate trigger by name", `ALTER TABLE "LoyaltyOperation" DISABLE TRIGGER loyalty_operation_no_truncate`],
      ["drop the append-only trigger", `DROP TRIGGER loyalty_operation_append_only ON "LoyaltyOperation"`],
      ["drop the no-truncate trigger", `DROP TRIGGER loyalty_operation_no_truncate ON "LoyaltyOperation"`],
      ["drop a ledger column", `ALTER TABLE "LoyaltyOperation" DROP COLUMN "comment"`],
      ["rename the ledger table", `ALTER TABLE "LoyaltyOperation" RENAME TO "LoyaltyOperationOld"`],
      ["change ledger ownership", `ALTER TABLE "LoyaltyOperation" OWNER TO CURRENT_USER`],
      ["drop the ledger table", `DROP TABLE "LoyaltyOperation" CASCADE`],
      [
        "replace the trigger function with a no-op",
        `CREATE OR REPLACE FUNCTION walaaplus_reject_ledger_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$`,
      ],
      ["drop the trigger function", `DROP FUNCTION walaaplus_reject_ledger_mutation() CASCADE`],
      ["drop the one-reversal-per-operation index", `DROP INDEX "LoyaltyOperation_reversalOfOperationId_key"`],
      ["disable the RewardTier freeze", `ALTER TABLE "RewardTier" DISABLE TRIGGER reward_tier_protect`],
      ["disable the ProgramVersion freeze", `ALTER TABLE "ProgramVersion" DISABLE TRIGGER program_version_protect`],
      ["disable the cardType lock", `ALTER TABLE "ProgramTemplate" DISABLE TRIGGER program_template_protect_card_type`],
      ["bypass triggers via session_replication_role", `SET session_replication_role = 'replica'`],
      ["bypass triggers via LOCAL session_replication_role", `SET LOCAL session_replication_role = 'replica'`],
      ["create a table in public", `CREATE TABLE public."Rogue" (id int)`],
      ["create a function in public", `CREATE FUNCTION public.rogue() RETURNS int LANGUAGE sql AS 'SELECT 1'`],
      ["UPDATE a consent record", `UPDATE "ConsentRecord" SET reason = 'edited'`],
      ["DELETE consent records", `DELETE FROM "ConsentRecord"`],
      ["TRUNCATE consent history", `TRUNCATE "ConsentRecord"`],
      ["disable the consent append-only trigger", `ALTER TABLE "ConsentRecord" DISABLE TRIGGER USER`],
      ["UPDATE a campaign revision", `UPDATE "CampaignRevision" SET body = 'edited'`],
      ["DELETE campaign revisions", `DELETE FROM "CampaignRevision"`],
      ["TRUNCATE campaign revisions", `TRUNCATE "CampaignRevision"`],
      ["disable the revision append-only trigger", `ALTER TABLE "CampaignRevision" DISABLE TRIGGER USER`],
      ["UPDATE an approval", `UPDATE "CampaignApproval" SET note = 'edited'`],
      ["DELETE approvals", `DELETE FROM "CampaignApproval"`],
      ["TRUNCATE approvals", `TRUNCATE "CampaignApproval"`],
      ["disable the approval append-only trigger", `ALTER TABLE "CampaignApproval" DISABLE TRIGGER USER`],
      ["UPDATE an audience snapshot", `UPDATE "CampaignAudienceSnapshot" SET "eligibleCount" = 9999`],
      ["DELETE audience snapshots", `DELETE FROM "CampaignAudienceSnapshot"`],
      ["UPDATE an audience member", `UPDATE "CampaignAudienceMember" SET "consentState" = 'GRANTED'`],
      ["DELETE audience members", `DELETE FROM "CampaignAudienceMember"`],
      ["TRUNCATE audience members", `TRUNCATE "CampaignAudienceMember"`],
      ["delete migration history", `DELETE FROM "_prisma_migrations"`],
      ["read migration history", `SELECT count(*) FROM "_prisma_migrations"`],
    ];

    it.each(attempts)("%s", async (_label, sql) => {
      await expect(prisma.$executeRawUnsafe(sql)).rejects.toThrow(DENIED);
    });

    it("cannot SET ROLE to the migrator", async () => {
      const migrator = await currentRole(migratorPrisma());
      await expect(prisma.$executeRawUnsafe(`SET ROLE "${migrator.rolname}"`)).rejects.toThrow(DENIED);
    });

    it("cannot promote itself", async () => {
      await expect(prisma.$executeRawUnsafe(`ALTER ROLE "${runtimeRoleName}" SUPERUSER`)).rejects.toThrow(DENIED);
      await expect(prisma.$executeRawUnsafe(`ALTER ROLE "${runtimeRoleName}" CREATEROLE`)).rejects.toThrow(DENIED);
      await expect(prisma.$executeRawUnsafe(`ALTER ROLE "${runtimeRoleName}" BYPASSRLS`)).rejects.toThrow(DENIED);
    });

    it("cannot grant itself the missing privileges", async () => {
      // PostgreSQL turns a GRANT by a non-owner into a WARNING ("no privileges were granted") rather
      // than an error, so the statement may resolve. What matters is that nothing was granted.
      await prisma.$executeRawUnsafe(`GRANT UPDATE, DELETE, TRUNCATE ON "LoyaltyOperation" TO "${runtimeRoleName}"`).catch(() => undefined);
      const p = await prisma.$queryRaw<{ u: boolean; d: boolean; t: boolean }[]>`
        SELECT has_table_privilege('"LoyaltyOperation"', 'UPDATE') AS u,
               has_table_privilege('"LoyaltyOperation"', 'DELETE') AS d,
               has_table_privilege('"LoyaltyOperation"', 'TRUNCATE') AS t`;
      expect(p[0]).toEqual({ u: false, d: false, t: false });
      await expect(prisma.$executeRawUnsafe(`UPDATE "LoyaltyOperation" SET quantity = 7`)).rejects.toThrow(DENIED);
    });

    it("nothing changed: row, triggers, function and indexes are identical from the owner's side", async () => {
      const after = await snapshot(opId);
      expect(after).toEqual(before);
      expect(after.rowCount).toBe(1);
      expect(after.quantity).toBe(1);
      expect(after.triggers.map((t) => t.tgname)).toEqual(["loyalty_operation_append_only", "loyalty_operation_no_truncate"]);
      // 'O' = enabled (fires in origin and local modes); 'D' would mean disabled.
      expect(after.triggers.every((t) => t.tgenabled === "O")).toBe(true);
      expect(after.functionSource).toMatch(/append-only/);
      expect(after.indexes).toContain("LoyaltyOperation_reversalOfOperationId_key");
    });
  });
});
