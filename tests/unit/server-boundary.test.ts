import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Database access stays inside the server layer.
 *
 * `PHASE-1A-IMPLEMENTATION.md` §10 states this, comments in the page files repeat it, and every
 * prompt so far has honoured it. Nothing checked it. A rule that lives only in prose is a rule a
 * hurried change breaks silently — and this one is load-bearing: the services are where the tenant
 * filter, the permission check and the ledger's invariants live, so a Prisma call in a route or a
 * page is a call that has skipped all three.
 *
 * The audit that prompted this test confirmed the rule holds today by hand. This is the version
 * that keeps holding.
 */

const ROOT = path.resolve(import.meta.dirname, "../..");

/** Every `.ts`/`.tsx` file under a directory. */
function sourceFiles(dir: string): string[] {
  const full = path.join(ROOT, dir);
  const out: string[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current)) {
      const child = path.join(current, entry);
      if (statSync(child).isDirectory()) walk(child);
      else if (/\.tsx?$/.test(entry)) out.push(path.relative(ROOT, child).split(path.sep).join("/"));
    }
  };
  walk(full);
  return out;
}

/** Write operations. A read is a different question, answered separately below. */
const WRITE_CALL =
  /\b(?:prisma|tx|db)\s*\.\s*[a-zA-Z]+\s*\.\s*(create|createMany|createManyAndReturn|update|updateMany|upsert|delete|deleteMany)\s*\(/;
const RAW_WRITE = /\$executeRaw|\$executeRawUnsafe/;

describe("the server boundary", () => {
  const outsideServer = ["src/app", "src/components", "src/lib", "src/i18n"].flatMap(sourceFiles);

  it("finds files to check, so this test cannot pass by looking at nothing", () => {
    // Guards the guard: a broken path glob would make every assertion below vacuous.
    expect(outsideServer.length).toBeGreaterThan(20);
    expect(outsideServer).toContain("src/app/api/enroll/route.ts");
  });

  it("has no Prisma write outside src/server", () => {
    const offenders = outsideServer.filter((file) => {
      const source = readFileSync(path.join(ROOT, file), "utf8");
      return WRITE_CALL.test(source) || RAW_WRITE.test(source);
    });
    expect(
      offenders,
      "a write outside the server layer has skipped the tenant filter, the permission check and " +
        "the ledger's invariants, all of which live in the services",
    ).toEqual([]);
  });

  it("imports the Prisma client in exactly one place outside src/server, for a health probe", () => {
    /*
     * The one exception, named so it stays one. `/api/health` runs `SELECT 1` to prove the pool
     * can reach PostgreSQL; routing that through a service would add a layer whose only job is to
     * forward. If this list grows, the growth is the thing to argue about.
     */
    const importers = outsideServer.filter((file) =>
      /from "@\/server\/db"|from "\.\.\/.*server\/db"/.test(readFileSync(path.join(ROOT, file), "utf8")),
    );
    expect(importers).toEqual(["src/app/api/health/route.ts"]);

    const health = readFileSync(path.join(ROOT, "src/app/api/health/route.ts"), "utf8");
    expect(health).toContain("SELECT 1");
    expect(WRITE_CALL.test(health)).toBe(false);
  });

  it("uses no server actions, which would be another way in", () => {
    for (const file of outsideServer) {
      const source = readFileSync(path.join(ROOT, file), "utf8");
      expect(source.includes('"use server"'), `${file} declares a server action`).toBe(false);
    }
  });

  it("detects a write if one appears", () => {
    // The regex is the whole test; prove it matches the shapes it claims to.
    for (const sample of [
      'await prisma.customerCard.update({ where: { id } })',
      "await tx.loyaltyOperation.create({ data })",
      'await db.business.deleteMany({ where: {} })',
      "await prisma.$executeRaw`UPDATE ...`",
    ]) {
      expect(WRITE_CALL.test(sample) || RAW_WRITE.test(sample), sample).toBe(true);
    }
    // And does not fire on a read.
    expect(WRITE_CALL.test("await prisma.customerCard.findFirst({ where: { id } })")).toBe(false);
  });
});
