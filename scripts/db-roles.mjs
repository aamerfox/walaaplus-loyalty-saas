#!/usr/bin/env node
/**
 * `npm run db:roles` — create/refresh the RESTRICTED RUNTIME ROLE and its grants.
 *
 * Two database roles exist per environment:
 *
 *   migrator / owner   owns every table, runs `prisma migrate deploy` and this script.
 *                      URL: MIGRATE_DATABASE_URL           (tests: TEST_MIGRATE_DATABASE_URL)
 *   runtime            used by web and worker. Can read and write application tables but can
 *                      NEVER update, delete or truncate the ledger, alter any table, or touch
 *                      triggers — it does not own anything in `public`.
 *                      URL: DATABASE_URL                   (tests: TEST_DATABASE_URL)
 *
 * The runtime role's NAME and PASSWORD are read from DATABASE_URL, so there is exactly one
 * place a credential lives. This script connects with MIGRATE_DATABASE_URL and:
 *   1. creates the role if missing; (re)applies LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
 *      NOINHERIT NOREPLICATION NOBYPASSRLS and the password from DATABASE_URL;
 *   2. grants CONNECT, USAGE on schema public (never CREATE), SELECT/INSERT/UPDATE/DELETE on all
 *      current tables and the same as DEFAULT PRIVILEGES for tables the migrator creates later;
 *   3. REVOKES everything on append-only tables and re-grants SELECT, INSERT only;
 *   3b. REVOKES everything on no-delete tables and re-grants SELECT, INSERT, UPDATE only;
 *   4. revokes everything on `_prisma_migrations` (bookkeeping belongs to the migrator);
 *   5. creates the `pgboss` schema owned by the runtime role, so the worker can manage its own
 *      queue tables without any privilege in `public`;
 *   6. verifies the result with has_table_privilege() and exits non-zero if anything is wrong.
 *
 * Idempotent: run it after EVERY `prisma migrate deploy` (new tables need grants). Prints role
 * and table names only — never the password, never the URLs.
 *
 * Any table added to APPEND_ONLY_TABLES or NO_DELETE_TABLES is protected the moment this script
 * runs; add a new protected table to the right list in the same commit as its migration.
 */
import { config as loadDotenv } from "dotenv";
import pg from "pg";
import { decideMembershipAction } from "./lib/db-role-membership.mjs";

loadDotenv({ quiet: true });

const APPEND_ONLY_TABLES = [
  "LoyaltyOperation",
  "ConsentRecord",
  "CampaignRevision",
  "CampaignApproval",
  "CampaignAudienceSnapshot",
  "CampaignAudienceMember",
  "ReferralAttribution",
  "PromotionRedemption",
];
/**
 * Tables whose rows may be updated but must never be removed.
 *
 * `CardShareLink` is the first of these, and it needed a third category rather than a place in the
 * list above. Revoking an invitation capability IS a state change, so the table cannot refuse UPDATE
 * the way the ledger and the consent history do — but an issued capability is a fact about what was
 * handed out, and a revocation that erased the row would leave nothing to audit.
 *
 * So the privilege here is SELECT, INSERT and UPDATE, and never DELETE or TRUNCATE. The narrower
 * rule — that an UPDATE may change `revokedAt` and nothing else, once, from NULL — is enforced by
 * trigger, because a grant cannot express it. Two layers, same as everywhere else: the role stops
 * the app, the trigger stops anyone with more rights than the app.
 */
const NO_DELETE_TABLES = ["CardShareLink", "Promotion"];

const MIGRATOR_ONLY_TABLES = ["_prisma_migrations"];
const WORKER_SCHEMA = "pgboss";

function fail(message) {
  process.stderr.write(`db-roles: ${message}\n`);
  process.exit(2);
}

function required(name) {
  const value = process.env[name];
  if (!value) fail(`${name} is not set. See .env.example.`);
  return value;
}

function parsePostgresUrl(name, raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    // Almost always one cause: an unencoded character in the password. `openssl rand -base64 24`
    // yields a `/` about a third of the time, and in
    //   postgresql://walaaplus:ab/cd@db:5432/loyalty
    // the authority ends at that slash, so this is not a URL. Say so here rather than leaving
    // the operator with "is not a valid URL" and a password that looks perfectly fine.
    fail(
      `${name} is not a valid URL. A password containing / + % : @ or whitespace must be ` +
        "percent-encoded; generate database passwords with `openssl rand -hex 32` instead. " +
        "The value is not printed.",
    );
  }
  if (!/^postgres(ql)?:$/.test(url.protocol)) fail(`${name} must be a postgresql:// URL.`);
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (!database) fail(`${name} has no database name.`);
  if (!url.hostname) fail(`${name} has no host.`);
  let decodedPassword;
  try {
    decodedPassword = decodeURIComponent(url.password);
  } catch {
    fail(
      `${name} has a password containing an unencoded % sign. Percent-encode it, or generate ` +
        "database passwords with `openssl rand -hex 32`. The value is not printed.",
    );
  }
  if (!decodedPassword) fail(`${name} has no password.`);
  // node-postgres connection string: Prisma's `?schema=` parameter is not a libpq option.
  const forPg = new URL(raw);
  forPg.searchParams.delete("schema");
  return {
    user: decodeURIComponent(url.username),
    password: decodedPassword,
    database,
    connectionString: forPg.toString(),
  };
}

const migrator = parsePostgresUrl("MIGRATE_DATABASE_URL", required("MIGRATE_DATABASE_URL"));
const runtime = parsePostgresUrl("DATABASE_URL", required("DATABASE_URL"));

if (!/^[a-z_][a-z0-9_]{0,62}$/.test(runtime.user)) {
  fail(`runtime role name "${runtime.user}" must match ^[a-z_][a-z0-9_]{0,62}$ (lower-case identifier).`);
}
if (!runtime.password) fail("DATABASE_URL must carry a password for the runtime role.");
if (runtime.user === migrator.user) {
  fail(
    `DATABASE_URL and MIGRATE_DATABASE_URL use the same role "${runtime.user}". ` +
      "The runtime role must be a separate, restricted role.",
  );
}
if (runtime.database !== migrator.database) {
  fail(`DATABASE_URL database "${runtime.database}" differs from MIGRATE_DATABASE_URL database "${migrator.database}".`);
}

const client = new pg.Client({ connectionString: migrator.connectionString, application_name: "walaaplus-db-roles" });
const ident = (s) => client.escapeIdentifier(s);
const literal = (s) => client.escapeLiteral(s);

async function run(sql) {
  await client.query(sql);
}

async function tableExists(name) {
  const r = await client.query("SELECT to_regclass($1) IS NOT NULL AS present", [`public.${ident(name)}`]);
  return r.rows[0].present === true;
}

async function main() {
  await client.connect();

  const who = await client.query("SELECT current_user AS usr, current_database() AS db");
  const owner = who.rows[0].usr;
  const database = who.rows[0].db;
  process.stdout.write(`db-roles: connected as migrator "${owner}" to database "${database}"\n`);

  for (const t of [...APPEND_ONLY_TABLES, ...NO_DELETE_TABLES]) {
    if (!(await tableExists(t))) fail(`table "${t}" does not exist. Run \`npm run db:migrate\` first.`);
  }

  /** Set when THIS run grants the migrator membership in the runtime role; revoked before COMMIT. */
  let grantedTemporaryMembership = false;
  /** Set when an administrator had already granted that membership; left untouched, reported. */
  let hadPreExistingMembership = false;

  await run("BEGIN");
  try {
    const role = ident(runtime.user);

    // 1. Role
    const exists = await client.query("SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = $1", [runtime.user]);
    if (exists.rowCount === 0) {
      await run(`CREATE ROLE ${role}`);
      process.stdout.write(`db-roles: created role "${runtime.user}"\n`);
    }
    await run(
      `ALTER ROLE ${role} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS ` +
        `PASSWORD ${literal(runtime.password)}`,
    );

    // 2. Connect + schema usage + table access. No CREATE anywhere in `public`.
    await run(`GRANT CONNECT ON DATABASE ${ident(database)} TO ${role}`);
    await run(`GRANT USAGE ON SCHEMA public TO ${role}`);
    await run(`REVOKE CREATE ON SCHEMA public FROM ${role}`);
    await run(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role}`);
    await run(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${role}`);
    // Tables the migrator creates in future migrations get the same grants automatically.
    // Append-only tables added later must ALSO be listed above so step 3 revokes on them.
    await run(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${role}`);
    await run(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${role}`);

    // 3. Append-only tables: read and append, nothing else.
    for (const t of APPEND_ONLY_TABLES) {
      await run(`REVOKE ALL PRIVILEGES ON TABLE public.${ident(t)} FROM ${role}`);
      await run(`GRANT SELECT, INSERT ON TABLE public.${ident(t)} TO ${role}`);
    }

    // 3b. No-delete tables: one more verb than the list above, and two fewer than the default.
    for (const t of NO_DELETE_TABLES) {
      await run(`REVOKE ALL PRIVILEGES ON TABLE public.${ident(t)} FROM ${role}`);
      await run(`GRANT SELECT, INSERT, UPDATE ON TABLE public.${ident(t)} TO ${role}`);
    }

    // 4. Migration bookkeeping is not the runtime's business.
    for (const t of MIGRATOR_ONLY_TABLES) {
      if (await tableExists(t)) await run(`REVOKE ALL PRIVILEGES ON TABLE public.${ident(t)} FROM ${role}`);
    }

    // 5. pg-boss schema, owned by the runtime role — including any objects a previous role created
    //    in it (e.g. an environment whose worker used to connect as the owner).
    //
    //    Creating or transferring an object owned by another role requires MEMBERSHIP in that role
    //    unless we are superuser. Membership is privilege: a migrator that stays a member of the
    //    runtime role can SET ROLE into it, and a runtime role that gains members widens its blast
    //    radius. So the grant here is strictly temporary — taken only when it is missing, and
    //    revoked again below. A membership an administrator established on purpose is DETECTED and
    //    left exactly as it was, with a notice, because removing it is not this script's decision.
    const me = await client.query("SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = current_user");
    const isSuperuser = me.rows[0].rolsuper === true;
    const preExisting = await client.query(
      `SELECT 1 FROM pg_catalog.pg_auth_members m
         JOIN pg_catalog.pg_roles target ON target.oid = m.roleid
         JOIN pg_catalog.pg_roles member ON member.oid = m.member
        WHERE target.rolname = $1 AND member.rolname = current_user`,
      [runtime.user],
    );
    hadPreExistingMembership = preExisting.rowCount > 0;
    const decision = decideMembershipAction({ isSuperuser, hadPreExistingMembership });
    if (decision.grant) {
      await run(`GRANT ${role} TO CURRENT_USER`);
      grantedTemporaryMembership = decision.revokeAfter;
    }
    await run(`CREATE SCHEMA IF NOT EXISTS ${ident(WORKER_SCHEMA)} AUTHORIZATION ${role}`);
    await run(`ALTER SCHEMA ${ident(WORKER_SCHEMA)} OWNER TO ${role}`);
    const foreign = await client.query(
      `SELECT c.relname, c.relkind::text AS relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relkind IN ('r', 'p', 'S', 'v', 'm') AND pg_get_userbyid(c.relowner) <> $2`,
      [WORKER_SCHEMA, runtime.user],
    );
    for (const { relname, relkind } of foreign.rows) {
      const kind = relkind === "S" ? "SEQUENCE" : relkind === "v" ? "VIEW" : relkind === "m" ? "MATERIALIZED VIEW" : "TABLE";
      await run(`ALTER ${kind} ${ident(WORKER_SCHEMA)}.${ident(relname)} OWNER TO ${role}`);
    }
    const foreignFns = await client.query(
      `SELECT p.oid::regprocedure::text AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = $1 AND pg_get_userbyid(p.proowner) <> $2`,
      [WORKER_SCHEMA, runtime.user],
    );
    for (const { signature } of foreignFns.rows) await run(`ALTER FUNCTION ${signature} OWNER TO ${role}`);
    const foreignTypes = await client.query(
      `SELECT t.typname FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
       WHERE n.nspname = $1 AND t.typtype IN ('e', 'c', 'd') AND t.typrelid = 0 AND pg_get_userbyid(t.typowner) <> $2`,
      [WORKER_SCHEMA, runtime.user],
    );
    for (const { typname } of foreignTypes.rows) await run(`ALTER TYPE ${ident(WORKER_SCHEMA)}.${ident(typname)} OWNER TO ${role}`);
    const handedOver = foreign.rowCount + foreignFns.rowCount + foreignTypes.rowCount;
    if (handedOver > 0) process.stdout.write(`db-roles: transferred ${handedOver} existing ${WORKER_SCHEMA} objects to "${runtime.user}"\n`);

    // 5b. Hand the temporary privilege straight back. The ownership changes above are catalog
    //     facts and survive; only the migrator's ability to act AS the runtime role goes away.
    if (grantedTemporaryMembership) {
      await run(`REVOKE ${role} FROM CURRENT_USER`);
      process.stdout.write(`db-roles: temporary membership in "${runtime.user}" granted for the ownership transfer and revoked again\n`);
    } else if (hadPreExistingMembership) {
      process.stdout.write(
        `db-roles: NOTICE migrator "${owner}" was ALREADY a member of "${runtime.user}" before this run. ` +
          "Left unchanged — an administrator established it deliberately. Revoke it manually if that is not intended: " +
          `REVOKE "${runtime.user}" FROM "${owner}";\n`,
      );
    }

    await run("COMMIT");
  } catch (err) {
    await run("ROLLBACK");
    throw err;
  }

  // 6. Verify. Anything wrong here is a hard failure.
  const problems = [];
  const attrs = await client.query(
    "SELECT rolsuper, rolcreaterole, rolcreatedb, rolbypassrls, rolreplication, rolcanlogin " +
      "FROM pg_catalog.pg_roles WHERE rolname = $1",
    [runtime.user],
  );
  const a = attrs.rows[0];
  if (!a) problems.push("role does not exist after creation");
  else {
    if (a.rolsuper) problems.push("role is SUPERUSER");
    if (a.rolcreaterole) problems.push("role has CREATEROLE");
    if (a.rolcreatedb) problems.push("role has CREATEDB");
    if (a.rolbypassrls) problems.push("role has BYPASSRLS");
    if (a.rolreplication) problems.push("role has REPLICATION");
    if (!a.rolcanlogin) problems.push("role cannot LOGIN");
  }
  for (const t of APPEND_ONLY_TABLES) {
    const p = await client.query(
      "SELECT has_table_privilege($1, $2, 'SELECT') AS s, has_table_privilege($1, $2, 'INSERT') AS i, " +
        "has_table_privilege($1, $2, 'UPDATE') AS u, has_table_privilege($1, $2, 'DELETE') AS d, " +
        "has_table_privilege($1, $2, 'TRUNCATE') AS t",
      [runtime.user, `public.${ident(t)}`],
    );
    const r = p.rows[0];
    if (!r.s || !r.i) problems.push(`${t}: SELECT/INSERT missing`);
    if (r.u || r.d || r.t) problems.push(`${t}: UPDATE/DELETE/TRUNCATE still granted`);
  }
  for (const t of NO_DELETE_TABLES) {
    const p = await client.query(
      "SELECT has_table_privilege($1, $2, 'SELECT') AS s, has_table_privilege($1, $2, 'INSERT') AS i, " +
        "has_table_privilege($1, $2, 'UPDATE') AS u, has_table_privilege($1, $2, 'DELETE') AS d, " +
        "has_table_privilege($1, $2, 'TRUNCATE') AS t",
      [runtime.user, `public.${ident(t)}`],
    );
    const r = p.rows[0];
    if (!r.s || !r.i || !r.u) problems.push(`${t}: SELECT/INSERT/UPDATE missing`);
    if (r.d || r.t) problems.push(`${t}: DELETE/TRUNCATE still granted`);
  }
  const schemaCreate = await client.query("SELECT has_schema_privilege($1, 'public', 'CREATE') AS c", [runtime.user]);
  if (schemaCreate.rows[0].c) problems.push("role can CREATE in schema public");

  // No role may be left able to act AS the runtime role because of this script. A membership that
  // existed before the run is reported, not silently accepted as ours.
  const members = await client.query(
    `SELECT member.rolname FROM pg_catalog.pg_auth_members m
       JOIN pg_catalog.pg_roles target ON target.oid = m.roleid
       JOIN pg_catalog.pg_roles member ON member.oid = m.member
      WHERE target.rolname = $1 ORDER BY 1`,
    [runtime.user],
  );
  const memberNames = members.rows.map((r) => r.rolname);
  if (grantedTemporaryMembership && memberNames.includes(owner)) {
    problems.push(`temporary membership of "${owner}" in "${runtime.user}" was not revoked`);
  }
  if (!grantedTemporaryMembership && !hadPreExistingMembership && memberNames.includes(owner)) {
    problems.push(`migrator "${owner}" is a member of "${runtime.user}" but this run did not grant it`);
  }

  const tables = await client.query(
    "SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'",
  );

  await client.end();

  if (problems.length > 0) {
    process.stderr.write(`db-roles: VERIFICATION FAILED\n  - ${problems.join("\n  - ")}\n`);
    process.exit(1);
  }
  process.stdout.write(
    `db-roles: OK role "${runtime.user}" — read/write on ${tables.rows[0].n} public tables, ` +
      `append-only on [${APPEND_ONLY_TABLES.join(", ")}], no-delete on [${NO_DELETE_TABLES.join(", ")}], ` +
      `no access to [${MIGRATOR_ONLY_TABLES.join(", ")}], ` +
      `owns schema "${WORKER_SCHEMA}", cannot CREATE in public, ` +
      `members: [${memberNames.join(", ") || "none"}]\n`,
  );
}

main().catch((err) => {
  // pg errors never contain the connection string; keep it that way.
  process.stderr.write(`db-roles: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
