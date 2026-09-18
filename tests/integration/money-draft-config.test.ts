import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { migratorPrisma, resetDatabase } from "../setup/fixtures";

/**
 * Migration 22 — a money programme's DRAFT is configurable, and everything live stays frozen.
 *
 * **Every attempt in this file runs as the RESTRICTED RUNTIME ROLE** (`prisma` from `@/server/db`),
 * because that is the role the owner service will actually use. The first version of this check ran
 * as the MIGRATOR and therefore proved nothing: migration 21 classed `MonetaryRule` and
 * `MonetaryTier` as append-only, so the runtime role held SELECT/INSERT only and the draft editor
 * could not have written at all — while the migrator-based probe reported everything green.
 *
 * Fixtures are built by the OWNER, because a draft has to exist before the runtime role can be shown
 * failing or succeeding at changing it.
 *
 * ## What migration 22 changed, and what it did not
 *
 * | | migration 21 | migration 22 |
 * |---|---|---|
 * | INSERT on a DRAFT version | allowed | unchanged |
 * | INSERT on ACTIVE/RETIRED | refused | unchanged |
 * | UPDATE/DELETE on a **DRAFT** | refused — the defect | **allowed** |
 * | UPDATE/DELETE on ACTIVE/RETIRED | refused | unchanged, same message |
 *
 * The invariant migration 21 was protecting is that a LIVE rate never changes, because cards pin to
 * a version. A DRAFT has no cards pinned to it, so editing one changes nothing anybody agreed to.
 */

const FROZEN_TIER = /MonetaryTier is frozen; a tier change is a new program version/;
const FROZEN_RULE = /MonetaryRule is frozen; a rule change is a new program version/;
const NEVER_DELETED = /is retired, never deleted/;

interface Fixture {
  businessId: string;
  templateId: string;
  versionId: string;
  ruleId: string | null;
  tierId: string | null;
}

type Status = "DRAFT" | "ACTIVE" | "RETIRED";
type Kind = "CASHBACK" | "DISCOUNT" | "STAMP" | "POINTS";

/** Build a programme at a chosen lifecycle status, as the OWNER. */
async function fixture(
  status: Status,
  kind: Kind = "CASHBACK",
  opts: { withTiers?: boolean; ruleKind?: Kind; businessCurrency?: string } = {},
): Promise<Fixture> {
  const owner = migratorPrisma();
  const businessId = randomUUID();
  await owner.$executeRawUnsafe(
    `INSERT INTO "Business" (id,name,currency,"updatedAt") VALUES ($1,$2,$3,now())`,
    businessId,
    "Draft probe",
    opts.businessCurrency ?? "SYP",
  );
  const templateId = randomUUID();
  await owner.$executeRawUnsafe(
    `INSERT INTO "ProgramTemplate" (id,"businessId",name,status,"cardType","defaultLocale","createdAt","updatedAt")
     VALUES ($1,$2,'Probe','ACTIVE',$3::"CardType",'ar',now(),now())`,
    templateId,
    businessId,
    kind,
  );
  const versionId = randomUUID();
  await owner.$executeRawUnsafe(
    `INSERT INTO "ProgramVersion" (id,"templateId","versionNumber",status,mechanics,"createdAt")
     VALUES ($1,$2,1,'DRAFT',$3::jsonb,now())`,
    versionId,
    templateId,
    JSON.stringify({ kind, contractVersion: 1 }),
  );

  // A stamp or points version carries no money rule; activation refuses one that does.
  if (kind !== "CASHBACK" && kind !== "DISCOUNT") {
    return { businessId, templateId, versionId, ruleId: null, tierId: null };
  }

  const ruleId = randomUUID();
  await owner.$executeRawUnsafe(
    `INSERT INTO "MonetaryRule" (id,"programVersionId",kind,currency,"currencyExponent","createdAt")
     VALUES ($1,$2,$3::"MonetaryRuleKind",$4,$5,now())`,
    ruleId,
    versionId,
    opts.ruleKind ?? kind,
    opts.businessCurrency ?? "SYP",
    opts.businessCurrency === "JOD" ? 3 : 2,
  );

  let tierId: string | null = null;
  if (opts.withTiers !== false) {
    tierId = randomUUID();
    await owner.$executeRawUnsafe(
      `INSERT INTO "MonetaryTier" (id,"monetaryRuleId","tierIndex","minCumulativeSpendMinor","rateBasisPoints","createdAt")
       VALUES ($1,$2,0,0,500,now())`,
      tierId,
      ruleId,
    );
  }

  if (status !== "DRAFT") {
    await owner.$executeRawUnsafe(
      `UPDATE "ProgramVersion" SET status=$2::"ProgramVersionStatus","activatedAt"=now() WHERE id=$1`,
      versionId,
      status,
    );
  }
  return { businessId, templateId, versionId, ruleId, tierId };
}

beforeEach(resetDatabase);

// ─── The window migration 22 opened ───────────────────────────────────────────

describe("the runtime role can configure a DRAFT money programme", () => {
  it("edits a rate", async () => {
    const f = await fixture("DRAFT");
    await expect(
      prisma.$executeRawUnsafe(`UPDATE "MonetaryTier" SET "rateBasisPoints"=700 WHERE id=$1`, f.tierId),
    ).resolves.toBe(1);
  });

  it("removes a tier", async () => {
    const f = await fixture("DRAFT");
    await expect(prisma.$executeRawUnsafe(`DELETE FROM "MonetaryTier" WHERE id=$1`, f.tierId)).resolves.toBe(1);
  });

  it("edits a threshold", async () => {
    const f = await fixture("DRAFT");
    const owner = migratorPrisma();
    await owner.$executeRawUnsafe(
      `INSERT INTO "MonetaryTier" (id,"monetaryRuleId","tierIndex","minCumulativeSpendMinor","rateBasisPoints","createdAt")
       VALUES ($1,$2,1,100000,900,now())`,
      randomUUID(),
      f.ruleId,
    );
    // Rates and thresholds are what a draft editor legitimately changes.
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "MonetaryTier" SET "minCumulativeSpendMinor"=250000 WHERE "monetaryRuleId"=$1 AND "tierIndex"=1`,
        f.ruleId,
      ),
    ).resolves.toBe(1);
  });

  it("removes the whole rate table, tiers first — the order a discard uses", async () => {
    const f = await fixture("DRAFT");
    await expect(prisma.$executeRawUnsafe(`DELETE FROM "MonetaryTier" WHERE "monetaryRuleId"=$1`, f.ruleId)).resolves.toBe(1);
    await expect(prisma.$executeRawUnsafe(`DELETE FROM "MonetaryRule" WHERE id=$1`, f.ruleId)).resolves.toBe(1);
  });
});

describe("the currency is the business's, and no writer may change it", () => {
  /*
   * `docs/PHASE-4-MONEY-CONTRACT.md` §1.3: a programme is denominated in `Business.currency`,
   * because there is no conversion layer and no rate source anywhere in this product.
   *
   * **An earlier version of this very file asserted the opposite** — that a DRAFT rule's currency
   * could be edited — and migration 22 permitted it. That was a contract violation written as a
   * passing test: it would have let a merchant denominate a programme in USD while their business
   * trades in SYP, and supplying a matching exponent would have made it look valid all the way down.
   */
  it("refuses changing a DRAFT rule to another currency, even with a correct exponent", async () => {
    const f = await fixture("DRAFT"); // the business trades in SYP
    for (const [code, exponent] of [["USD", 2], ["JPY", 0], ["JOD", 3]] as const) {
      await expect(
        prisma.$executeRawUnsafe(
          `UPDATE "MonetaryRule" SET currency=$2,"currencyExponent"=$3 WHERE id=$1`,
          f.ruleId,
          code,
          exponent,
        ),
        `${code} must be refused even though ${exponent} is its real exponent`,
      ).rejects.toThrow(/the currency is the business's \(SYP\), not/);
    }

    // The stored unit is untouched by every one of those attempts.
    const rule = await prisma.monetaryRule.findUniqueOrThrow({ where: { id: f.ruleId! } });
    expect(rule.currency).toBe("SYP");
    expect(rule.currencyExponent).toBe(2);
  });

  it("refuses CREATING a rule in a currency that is not the business's", async () => {
    const f = await fixture("DRAFT");
    const owner = migratorPrisma();
    await owner.$executeRawUnsafe(`DELETE FROM "MonetaryTier" WHERE "monetaryRuleId"=$1`, f.ruleId);
    await owner.$executeRawUnsafe(`DELETE FROM "MonetaryRule" WHERE id=$1`, f.ruleId);

    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "MonetaryRule" (id,"programVersionId",kind,currency,"currencyExponent","createdAt")
         VALUES ($1,$2,'CASHBACK','USD',2,now())`,
        randomUUID(),
        f.versionId,
      ),
    ).rejects.toThrow(/the currency is the business's \(SYP\), not USD/);
  });

  it("still refuses an exponent that is wrong for the business's own currency", async () => {
    // Two separate rules: the currency must be the business's, AND the unit must be right for it.
    const f = await fixture("DRAFT");
    await expect(
      prisma.$executeRawUnsafe(`UPDATE "MonetaryRule" SET "currencyExponent"=3 WHERE id=$1`, f.ruleId),
    ).rejects.toThrow(/exponent for SYP is 2, not 3/);
  });

  it("accepts a rule in a business whose own currency is not SYP", async () => {
    // The rule is "match the business", not "always SYP".
    const f = await fixture("DRAFT", "CASHBACK", { businessCurrency: "JOD" });
    const rule = await prisma.monetaryRule.findUniqueOrThrow({ where: { id: f.ruleId! } });
    expect(rule.currency).toBe("JOD");
    expect(rule.currencyExponent).toBe(3);
  });
});

// ─── The window that stayed shut ──────────────────────────────────────────────

describe("a live rate table is as frozen as it ever was", () => {
  for (const status of ["ACTIVE", "RETIRED"] as const) {
    it(`refuses every edit on a ${status} version, with migration 21's own messages`, async () => {
      const f = await fixture(status);
      await expect(
        prisma.$executeRawUnsafe(`UPDATE "MonetaryTier" SET "rateBasisPoints"=700 WHERE id=$1`, f.tierId),
      ).rejects.toThrow(FROZEN_TIER);
      await expect(prisma.$executeRawUnsafe(`DELETE FROM "MonetaryTier" WHERE id=$1`, f.tierId)).rejects.toThrow(FROZEN_TIER);
      await expect(
        prisma.$executeRawUnsafe(`UPDATE "MonetaryRule" SET currency='USD' WHERE id=$1`, f.ruleId),
      ).rejects.toThrow(FROZEN_RULE);
      await expect(prisma.$executeRawUnsafe(`DELETE FROM "MonetaryRule" WHERE id=$1`, f.ruleId)).rejects.toThrow(FROZEN_RULE);
    });

    it(`refuses ADDING a tier to a ${status} version`, async () => {
      const f = await fixture(status);
      await expect(
        prisma.$executeRawUnsafe(
          `INSERT INTO "MonetaryTier" (id,"monetaryRuleId","tierIndex","minCumulativeSpendMinor","rateBasisPoints","createdAt")
           VALUES ($1,$2,1,100000,900,now())`,
          randomUUID(),
          f.ruleId,
        ),
      ).rejects.toThrow(new RegExp(`tiers are configured on a DRAFT version, not a ${status} one`));
    });
  }
});

describe("configuration cannot be moved around the freeze", () => {
  it("refuses re-pointing a rule at a different version", async () => {
    /*
     * Re-pointing would carry a draft's configuration into a live programme, or move a live rule out
     * of reach of the check above — and across tenants, because a version belongs to a template
     * which belongs to a business.
     */
    const mine = await fixture("DRAFT");
    const other = await fixture("DRAFT");
    await expect(
      prisma.$executeRawUnsafe(`UPDATE "MonetaryRule" SET "programVersionId"=$2 WHERE id=$1`, mine.ruleId, other.versionId),
    ).rejects.toThrow(/a rule cannot be moved to a different program version/);
  });

  it("refuses re-pointing a tier at a different rule", async () => {
    const mine = await fixture("DRAFT");
    const other = await fixture("DRAFT");
    await expect(
      prisma.$executeRawUnsafe(`UPDATE "MonetaryTier" SET "monetaryRuleId"=$2 WHERE id=$1`, mine.tierId, other.ruleId),
    ).rejects.toThrow(/a tier cannot be moved to a different rule/);
  });

  it("keeps every ordering rule on an edit, not only on an insert", async () => {
    const f = await fixture("DRAFT");
    // Tier 0 must still start at zero after being edited.
    await expect(
      prisma.$executeRawUnsafe(`UPDATE "MonetaryTier" SET "minCumulativeSpendMinor"=5000 WHERE id=$1`, f.tierId),
    ).rejects.toThrow(/the first tier starts at zero spend/);
  });
});

// ─── Everything else the money tables promise ─────────────────────────────────

describe("the other money tables are unchanged by migration 22", () => {
  it("keeps MonetaryOperation strictly append-only for the runtime role", async () => {
    await expect(prisma.$executeRawUnsafe(`UPDATE "MonetaryOperation" SET "reason"='x'`)).rejects.toThrow(
      /permission denied for table MonetaryOperation/,
    );
    await expect(prisma.$executeRawUnsafe(`DELETE FROM "MonetaryOperation"`)).rejects.toThrow(
      /permission denied for table MonetaryOperation/,
    );
  });

  it("keeps SupportedCurrency read-only for the runtime role", async () => {
    await expect(
      prisma.$executeRawUnsafe(`INSERT INTO "SupportedCurrency" (code,exponent) VALUES ('ZZZ',2)`),
    ).rejects.toThrow(/permission denied for table SupportedCurrency/);
  });

  it("refuses TRUNCATE on every money table, for the runtime role AND the owner", async () => {
    for (const t of ["MonetaryRule", "MonetaryTier", "MonetaryOperation", "SupportedCurrency"]) {
      await expect(prisma.$executeRawUnsafe(`TRUNCATE "${t}"`)).rejects.toThrow(/permission denied/i);
    }
    /*
     * Migration 21 gave only MonetaryOperation a trigger; the other three were protected by the
     * absence of a privilege, which stops the runtime role and not the table owner.
     *
     * CASCADE on purpose. A plain TRUNCATE of these tables stops earlier, at "cannot truncate a
     * table referenced in a foreign key constraint" — so a test without CASCADE would pass on the
     * FK and never reach the trigger it claims to be testing. CASCADE is also the form somebody
     * clearing a table by hand would actually reach for.
     */
    const owner = migratorPrisma();
    for (const t of ["MonetaryRule", "MonetaryTier", "SupportedCurrency"]) {
      await expect(owner.$executeRawUnsafe(`TRUNCATE "${t}" CASCADE`)).rejects.toThrow(/TRUNCATE is not permitted/);
    }
  });

  it("holds exactly the privileges the draft editor needs and nothing more", async () => {
    const owner = migratorPrisma();
    const runtimeUser = new URL(process.env.DATABASE_URL ?? "").username;
    for (const table of ["MonetaryRule", "MonetaryTier"]) {
      const [p] = await owner.$queryRawUnsafe<{ s: boolean; i: boolean; u: boolean; d: boolean; t: boolean }[]>(
        `SELECT has_table_privilege($1,$2,'SELECT') AS s, has_table_privilege($1,$2,'INSERT') AS i,
                has_table_privilege($1,$2,'UPDATE') AS u, has_table_privilege($1,$2,'DELETE') AS d,
                has_table_privilege($1,$2,'TRUNCATE') AS t`,
        runtimeUser,
        `public."${table}"`,
      );
      expect({ table, ...p }).toEqual({ table, s: true, i: true, u: true, d: true, t: false });
    }
  });
});

// ─── A money version is retired, never deleted ────────────────────────────────

describe("a money program version can never be deleted", () => {
  it("refuses while its rule is still attached", async () => {
    const f = await fixture("DRAFT");
    await expect(prisma.$executeRawUnsafe(`DELETE FROM "ProgramVersion" WHERE id=$1`, f.versionId)).rejects.toThrow(
      NEVER_DELETED,
    );
  });

  it("refuses AFTER its tiers and rule have been legitimately removed", async () => {
    /*
     * **The case that matters.** Until this guard existed the foreign key from `MonetaryRule` was the
     * only thing protecting the version — and migration 22 is what made removing that rule
     * legitimate, so the accident that protected it is gone. Reproduced through the runtime role
     * before the guard was written: the delete was ALLOWED.
     */
    const f = await fixture("DRAFT");
    await prisma.$executeRawUnsafe(`DELETE FROM "MonetaryTier" WHERE "monetaryRuleId"=$1`, f.ruleId);
    await prisma.$executeRawUnsafe(`DELETE FROM "MonetaryRule" WHERE id=$1`, f.ruleId);

    await expect(prisma.$executeRawUnsafe(`DELETE FROM "ProgramVersion" WHERE id=$1`, f.versionId)).rejects.toThrow(
      NEVER_DELETED,
    );
    expect(
      await prisma.programVersion.count({ where: { id: f.versionId } }),
      "the version must still exist after the refusal",
    ).toBe(1);
  });

  it("is discarded by RETIRING it, and a retired draft can never be activated", async () => {
    const f = await fixture("DRAFT");
    await expect(
      prisma.$executeRawUnsafe(`UPDATE "ProgramVersion" SET status='RETIRED',"retiredAt"=now() WHERE id=$1`, f.versionId),
    ).resolves.toBe(1);

    // `walaaplus_protect_program_version` from migration 1 already refuses RETIRED -> anything.
    await expect(
      prisma.$executeRawUnsafe(`UPDATE "ProgramVersion" SET status='ACTIVE',"activatedAt"=now() WHERE id=$1`, f.versionId),
    ).rejects.toThrow(/status cannot move from RETIRED/);
  });

  for (const kind of ["STAMP", "POINTS"] as const) {
    it(`still deletes a ${kind} draft exactly as before — positive control`, async () => {
      /*
       * The guard is narrowed to the two money card types and the blanket privilege was NOT revoked,
       * because revoking it would break this flow. If this ever goes red, the guard has been widened
       * past money and an unrelated feature is broken.
       */
      const f = await fixture("DRAFT", kind);
      await expect(prisma.$executeRawUnsafe(`DELETE FROM "ProgramVersion" WHERE id=$1`, f.versionId)).resolves.toBe(1);
    });
  }
});

// ─── A money version cannot go live half-configured ───────────────────────────

describe("activating a money version is a database guarantee, not a service promise", () => {
  const activate = (id: string) =>
    prisma.$executeRawUnsafe(`UPDATE "ProgramVersion" SET status='ACTIVE',"activatedAt"=now() WHERE id=$1`, id);

  it("accepts a complete rate table", async () => {
    const f = await fixture("DRAFT");
    await expect(activate(f.versionId)).resolves.toBe(1);
  });

  it("refuses a money version with no rule at all", async () => {
    const f = await fixture("DRAFT");
    await prisma.$executeRawUnsafe(`DELETE FROM "MonetaryTier" WHERE "monetaryRuleId"=$1`, f.ruleId);
    await prisma.$executeRawUnsafe(`DELETE FROM "MonetaryRule" WHERE id=$1`, f.ruleId);
    await expect(activate(f.versionId)).rejects.toThrow(/needs exactly one monetary rule to be activated, found 0/);
  });

  it("refuses a money version with a rule but no rates", async () => {
    const f = await fixture("DRAFT", "CASHBACK", { withTiers: false });
    await expect(activate(f.versionId)).rejects.toThrow(/needs at least one rate to be activated/);
  });

  it("refuses a rule whose kind does not match the card type", async () => {
    const f = await fixture("DRAFT", "DISCOUNT", { ruleKind: "CASHBACK" });
    await expect(activate(f.versionId)).rejects.toThrow(/a DISCOUNT version carries a CASHBACK rule/);
  });

  it("refuses a rate table whose first tier does not start at zero", async () => {
    /*
     * Built by the OWNER with the trigger disabled, because the per-row guard would refuse it on the
     * way in. That is the point: this check is about the SET being complete at the moment of
     * activation, which no per-row guard can see.
     */
    const f = await fixture("DRAFT");
    const owner = migratorPrisma();
    await owner.$executeRawUnsafe(`ALTER TABLE "MonetaryTier" DISABLE TRIGGER USER`);
    try {
      await owner.$executeRawUnsafe(`UPDATE "MonetaryTier" SET "minCumulativeSpendMinor"=5000 WHERE id=$1`, f.tierId);
    } finally {
      await owner.$executeRawUnsafe(`ALTER TABLE "MonetaryTier" ENABLE TRIGGER USER`);
    }
    await expect(activate(f.versionId)).rejects.toThrow(/first rate must start at zero spend/);
  });

  it("refuses a rate table with a gap in its tier indexes", async () => {
    const f = await fixture("DRAFT");
    const owner = migratorPrisma();
    await owner.$executeRawUnsafe(`ALTER TABLE "MonetaryTier" DISABLE TRIGGER USER`);
    try {
      await owner.$executeRawUnsafe(
        `INSERT INTO "MonetaryTier" (id,"monetaryRuleId","tierIndex","minCumulativeSpendMinor","rateBasisPoints","createdAt")
         VALUES ($1,$2,5,100000,900,now())`,
        randomUUID(),
        f.ruleId,
      );
    } finally {
      await owner.$executeRawUnsafe(`ALTER TABLE "MonetaryTier" ENABLE TRIGGER USER`);
    }
    await expect(activate(f.versionId)).rejects.toThrow(/the rate table has a gap/);
  });

  it("refuses thresholds that do not increase with the tier", async () => {
    /*
     * Tiers 0, 1, 2 at thresholds 0, 1000, 500. Contiguous indexes, tier 0 at zero, and every
     * threshold DISTINCT — so this gets past the unique index on (rule, threshold), past the
     * first-tier check and past the gap check, and is refused by the ordering rule alone.
     *
     * An earlier version of this test used two tiers both at threshold 0, which the unique index
     * refused before the trigger was ever consulted.
     */
    const f = await fixture("DRAFT");
    const owner = migratorPrisma();
    await owner.$executeRawUnsafe(`ALTER TABLE "MonetaryTier" DISABLE TRIGGER USER`);
    try {
      for (const [index, threshold] of [[1, 1000], [2, 500]] as const) {
        await owner.$executeRawUnsafe(
          `INSERT INTO "MonetaryTier" (id,"monetaryRuleId","tierIndex","minCumulativeSpendMinor","rateBasisPoints","createdAt")
           VALUES ($1,$2,$3,$4,900,now())`,
          randomUUID(),
          f.ruleId,
          index,
          threshold,
        );
      }
    } finally {
      await owner.$executeRawUnsafe(`ALTER TABLE "MonetaryTier" ENABLE TRIGGER USER`);
    }
    await expect(activate(f.versionId)).rejects.toThrow(/thresholds must increase with the tier/);
  });

  it("refuses a stamp or points version that carries a money rule", async () => {
    const f = await fixture("DRAFT", "STAMP");
    const owner = migratorPrisma();
    await owner.$executeRawUnsafe(
      `INSERT INTO "MonetaryRule" (id,"programVersionId",kind,currency,"currencyExponent","createdAt")
       VALUES ($1,$2,'CASHBACK','SYP',2,now())`,
      randomUUID(),
      f.versionId,
    );
    await expect(activate(f.versionId)).rejects.toThrow(/a STAMP version cannot carry a monetary rule/);
  });
});
