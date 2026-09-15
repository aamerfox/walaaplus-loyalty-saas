import { randomUUID } from "node:crypto";
import { OperationSource, PrismaClient, ProgramVersionStatus } from "@prisma/client";
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { earnCashback } from "@/server/monetary/engine";
import {
  createMonetaryShop,
  enrolMonetaryCustomer,
  migratorPrisma,
  resetDatabase,
  type MonetaryShopFixture,
} from "../setup/fixtures";
import { resolveTestDatabaseUrls } from "../setup/test-env";

/**
 * What the DATABASE refuses, proved by writing directly through the RESTRICTED RUNTIME ROLE.
 *
 * `prisma` from `@/server/db` is the same least-privileged role the web process and the worker use.
 * Every write below therefore bypasses the money engine entirely and asks the only question that
 * matters for a financial record: **if the service were wrong, or absent, or hostile, would the row
 * still be refused?**
 *
 * A test that went through `earnCashback` would prove the service is careful. These prove the
 * guarantee survives the service being replaced.
 */

let seq = 0;
const nextKey = () => `integ-${Date.now()}-${(seq += 1)}-padding`;

beforeEach(resetDatabase);

interface Ctx {
  fx: MonetaryShopFixture;
  cardId: string;
  profileId: string;
  templateId: string;
  programVersionId: string;
  ruleId: string;
  tierId: string;
}

async function setup(opts: Parameters<typeof createMonetaryShop>[0] = {}): Promise<Ctx> {
  const fx = await createMonetaryShop(opts);
  const e = await enrolMonetaryCustomer(fx);
  return {
    fx,
    cardId: e.customerCardId,
    profileId: e.customerBusinessProfileId,
    templateId: e.templateId,
    programVersionId: e.programVersionId,
    ruleId: fx.program.monetaryRuleId,
    tierId: fx.baseTierId,
  };
}

/** A row that is valid in every respect, so a test can change exactly one thing about it. */
function validEarning(c: Ctx, over: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    transactionGroupId: randomUUID(),
    businessId: c.fx.businessId,
    locationId: c.fx.locationId,
    customerBusinessProfileId: c.profileId,
    customerCardId: c.cardId,
    templateId: c.templateId,
    programVersionId: c.programVersionId,
    monetaryRuleId: c.ruleId,
    monetaryTierId: c.tierId,
    kind: "CASHBACK_EARNED" as const,
    currency: "SYP",
    currencyExponent: 2,
    grossAmountMinor: 100_000n,
    requestedRedemptionMinor: null,
    cashEffectMinor: 5_000n, // 5% of 100,000
    discountMinor: null,
    netCounterAmountMinor: 100_000n,
    rateBasisPoints: 500,
    cashBalanceAfterMinor: 5_000n,
    cardSequence: 1n,
    reversalOfId: null,
    reason: null,
    performedByUserId: c.fx.userId,
    ...over,
  };
}

const insert = (data: ReturnType<typeof validEarning>) => prisma.monetaryOperation.create({ data });

// ─── The control ──────────────────────────────────────────────────────────────

describe("the baseline row", () => {
  it("is accepted, so every refusal below is about the ONE thing that was changed", async () => {
    const c = await setup();
    await expect(insert(validEarning(c))).resolves.toBeDefined();
  });
});

// ─── Append-only ──────────────────────────────────────────────────────────────

describe("a financial record is append-only, in TWO independent layers", () => {
  /*
   * The two layers are tested separately because they fail differently and for different reasons,
   * and a test that accepted either message would not notice if one of them disappeared.
   *
   *   PRIVILEGE  the runtime role simply has no UPDATE or DELETE on these tables, so the attempt
   *              never reaches the trigger. This is the layer that protects against a bug in this
   *              product's own code.
   *   TRIGGER    refuses the TABLE OWNER too - the role that runs migrations and holds every
   *              privilege. This is the layer that protects against a careless operator at a psql
   *              prompt, and it is the only one of the two that can explain itself.
   */
  it("gives the runtime role no UPDATE or DELETE privilege at all", async () => {
    const c = await setup();
    await insert(validEarning(c));
    await expect(prisma.$executeRawUnsafe(`UPDATE "MonetaryOperation" SET "cashEffectMinor" = 999999`)).rejects.toThrow(
      /permission denied for table MonetaryOperation/,
    );
    await expect(prisma.$executeRawUnsafe(`DELETE FROM "MonetaryOperation"`)).rejects.toThrow(
      /permission denied for table MonetaryOperation/,
    );
    expect(await prisma.monetaryOperation.count()).toBe(1);
  });

  /*
   * ## The grant state, observed directly rather than inferred from an error message
   *
   * The test above cannot be red-proved the way every other guarantee here is. Removing a GRANT and
   * re-running the suite does not work, because `scripts/db-roles.mjs` runs in the integration
   * globalSetup and REVOKEs and re-GRANTs on every invocation - so the privilege is restored before
   * the first test executes, and the suite stays green. The red proof reported exactly that, which
   * is how this gap was found.
   *
   * What replaces it is not a weaker check but a different KIND of check: `has_table_privilege` is a
   * direct observation of the catalog, so it cannot pass because some other layer happened to refuse
   * first. It is asserted from the OWNER connection, because asking the catalog a question is not
   * something the runtime role needs to be able to do.
   */
  it("holds exactly INSERT and SELECT on the money tables, and nothing else", async () => {
    const owner = migratorPrisma();
    const runtimeUser = new URL(resolveTestDatabaseUrls().runtime).username;

    for (const table of ["MonetaryOperation", "MonetaryRule", "MonetaryTier"]) {
      const [p] = await owner.$queryRawUnsafe<
        { s: boolean; i: boolean; u: boolean; d: boolean; t: boolean }[]
      >(
        `SELECT has_table_privilege($1, $2, 'SELECT') AS s,
                has_table_privilege($1, $2, 'INSERT') AS i,
                has_table_privilege($1, $2, 'UPDATE') AS u,
                has_table_privilege($1, $2, 'DELETE') AS d,
                has_table_privilege($1, $2, 'TRUNCATE') AS t`,
        runtimeUser,
        `public."${table}"`,
      );
      expect({ table, ...p }).toEqual({ table, s: true, i: true, u: false, d: false, t: false });
    }

    // Reference data is narrower still: read it, never write it.
    const [currency] = await owner.$queryRawUnsafe<
      { s: boolean; i: boolean; u: boolean; d: boolean; t: boolean }[]
    >(
      `SELECT has_table_privilege($1, $2, 'SELECT') AS s,
              has_table_privilege($1, $2, 'INSERT') AS i,
              has_table_privilege($1, $2, 'UPDATE') AS u,
              has_table_privilege($1, $2, 'DELETE') AS d,
              has_table_privilege($1, $2, 'TRUNCATE') AS t`,
      runtimeUser,
      `public."SupportedCurrency"`,
    );
    expect(currency).toEqual({ s: true, i: false, u: false, d: false, t: false });
  });

  it("refuses the TABLE OWNER an UPDATE or a DELETE, and says to use a reversal instead", async () => {
    const c = await setup();
    await insert(validEarning(c));
    const owner = migratorPrisma();
    await expect(owner.$executeRawUnsafe(`UPDATE "MonetaryOperation" SET "reason" = 'oops'`)).rejects.toThrow(
      /append-only; UPDATE is not permitted/,
    );
    await expect(owner.$executeRawUnsafe(`DELETE FROM "MonetaryOperation"`)).rejects.toThrow(
      /append-only; DELETE is not permitted/,
    );
    expect(await prisma.monetaryOperation.count()).toBe(1);
  });

  it("refuses a TRUNCATE even to the table OWNER, which no privilege grant would have stopped", async () => {
    await setup();
    await expect(migratorPrisma().$executeRawUnsafe(`TRUNCATE TABLE "MonetaryOperation"`)).rejects.toThrow(
      /append-only; TRUNCATE is not permitted/,
    );
  });
});

describe("a rate table is frozen once its version goes live", () => {
  it("gives the runtime role no way to change a rate at all", async () => {
    const c = await setup();
    await expect(
      prisma.$executeRawUnsafe(`UPDATE "MonetaryRule" SET "currency" = 'USD' WHERE id = '${c.ruleId}'`),
    ).rejects.toThrow(/permission denied for table MonetaryRule/);
    await expect(
      prisma.$executeRawUnsafe(`UPDATE "MonetaryTier" SET "rateBasisPoints" = 1 WHERE id = '${c.tierId}'`),
    ).rejects.toThrow(/permission denied for table MonetaryTier/);
    await expect(prisma.$executeRawUnsafe(`DELETE FROM "MonetaryTier" WHERE id = '${c.tierId}'`)).rejects.toThrow(
      /permission denied for table MonetaryTier/,
    );
  });

  it("refuses the TABLE OWNER a change to a rule or a tier - the customer's deal is frozen", async () => {
    const c = await setup();
    const owner = migratorPrisma();
    await expect(
      owner.$executeRawUnsafe(`UPDATE "MonetaryRule" SET "currency" = 'USD' WHERE id = '${c.ruleId}'`),
    ).rejects.toThrow(/MonetaryRule is frozen; a rule change is a new program version/);
    await expect(
      owner.$executeRawUnsafe(`UPDATE "MonetaryTier" SET "rateBasisPoints" = 1 WHERE id = '${c.tierId}'`),
    ).rejects.toThrow(/MonetaryTier is frozen; a tier change is a new program version/);
    await expect(owner.$executeRawUnsafe(`DELETE FROM "MonetaryTier" WHERE id = '${c.tierId}'`)).rejects.toThrow(
      /MonetaryTier is frozen/,
    );
  });

  it("refuses to ADD a tier to a live version, which append-only alone would have allowed", async () => {
    const c = await setup();
    /*
     * The important one. Freezing UPDATE and DELETE is not enough: without the DRAFT check, a
     * business could add a new top rate - or a threshold that moves existing customers into a
     * worse band - and every card already pinned to that version would start earning at a rate its
     * holder never agreed to.
     */
    await expect(
      prisma.monetaryTier.create({
        data: { monetaryRuleId: c.ruleId, tierIndex: 1, minCumulativeSpendMinor: 1_000_000n, rateBasisPoints: 9_000 },
      }),
    ).rejects.toThrow(/tiers are configured on a DRAFT version, not a ACTIVE one/);
  });

  it("refuses to attach a rule to a version that is already live", async () => {
    const c = await setup();
    const other = await prisma.programVersion.findFirstOrThrow({ where: { id: c.programVersionId } });
    expect(other.status).toBe(ProgramVersionStatus.ACTIVE);
    await expect(
      prisma.monetaryRule.create({
        data: { programVersionId: other.id, kind: "CASHBACK", currency: "SYP", currencyExponent: 2 },
      }),
    ).rejects.toThrow(/a rule is configured on a DRAFT version|Unique constraint/);
  });
});

// ─── The unit ─────────────────────────────────────────────────────────────────

describe("the currency and its exponent are not the application's to invent", () => {
  it("refuses a rule whose exponent disagrees with SupportedCurrency", async () => {
    const c = await setup();
    const draft = await migratorPrisma().programVersion.create({
      data: { templateId: c.templateId, versionNumber: 99, status: ProgramVersionStatus.DRAFT },
      select: { id: true },
    });
    // SYP is exponent 2. Claiming 3 would make every amount in this program ten times too small.
    await expect(
      prisma.monetaryRule.create({ data: { programVersionId: draft.id, kind: "CASHBACK", currency: "SYP", currencyExponent: 3 } }),
    ).rejects.toThrow(/exponent for SYP is 2, not 3/);
  });

  it("refuses a currency this product has no exponent for", async () => {
    const c = await setup();
    const draft = await migratorPrisma().programVersion.create({
      data: { templateId: c.templateId, versionNumber: 98, status: ProgramVersionStatus.DRAFT },
      select: { id: true },
    });
    await expect(
      prisma.monetaryRule.create({ data: { programVersionId: draft.id, kind: "CASHBACK", currency: "XYZ", currencyExponent: 2 } }),
    ).rejects.toThrow(/not a supported currency|Foreign key/i);
  });

  it("gives the runtime role SELECT on SupportedCurrency and nothing else", async () => {
    // It must be able to read the unit...
    await expect(prisma.supportedCurrency.findUnique({ where: { code: "SYP" } })).resolves.toMatchObject({ exponent: 2 });

    // ...and must not be able to invent one. A currency with the wrong exponent would silently move
    // every amount recorded against it by a factor of ten.
    await expect(prisma.supportedCurrency.create({ data: { code: "ZZZ", exponent: 2 } })).rejects.toThrow(/permission denied/i);
    await expect(prisma.$executeRawUnsafe(`UPDATE "SupportedCurrency" SET "exponent" = 0`)).rejects.toThrow(/permission denied/i);
    await expect(prisma.$executeRawUnsafe(`DELETE FROM "SupportedCurrency"`)).rejects.toThrow(/permission denied/i);
  });

  it("refuses the TABLE OWNER a change to the currency table too", async () => {
    const owner = migratorPrisma();
    // Reference data is not the application's to change, and not the operator's either: an exponent
    // edited here would silently reinterpret every amount already recorded in that currency.
    await expect(owner.$executeRawUnsafe(`UPDATE "SupportedCurrency" SET "exponent" = 0`)).rejects.toThrow(
      /SupportedCurrency is reference data/,
    );
    await expect(owner.$executeRawUnsafe(`DELETE FROM "SupportedCurrency" WHERE code = 'SYP'`)).rejects.toThrow(
      /SupportedCurrency is reference data/,
    );
  });

  it("refuses an operation whose currency does not match its rule", async () => {
    const c = await setup();
    await expect(insert(validEarning(c, { currency: "USD" }))).rejects.toThrow(/currency must match the rule exactly/);
    await expect(insert(validEarning(c, { currencyExponent: 3 }))).rejects.toThrow(/currency must match the rule exactly/);
  });
});

// ─── Tenancy and pinning ──────────────────────────────────────────────────────

describe("an operation cannot be written across a tenant or a program boundary", () => {
  it("refuses a card belonging to another business", async () => {
    const c = await setup();
    const other = await setup();
    await expect(insert(validEarning(c, { businessId: other.fx.businessId }))).rejects.toThrow(
      /card belongs to a different business/,
    );
  });

  it("refuses a customer, template or version that is not the card's", async () => {
    const c = await setup();
    const other = await setup();
    await expect(insert(validEarning(c, { customerBusinessProfileId: other.profileId }))).rejects.toThrow(
      /card belongs to a different customer/,
    );
    await expect(insert(validEarning(c, { templateId: other.templateId }))).rejects.toThrow(
      /card belongs to a different program/,
    );
    await expect(
      insert(validEarning(c, { programVersionId: other.programVersionId, monetaryRuleId: other.ruleId, monetaryTierId: other.tierId })),
    ).rejects.toThrow(/card is pinned to a different program version/);
  });

  it("refuses a location belonging to another business", async () => {
    const c = await setup();
    const other = await setup();
    await expect(insert(validEarning(c, { locationId: other.fx.locationId }))).rejects.toThrow(
      /location belongs to a different business/,
    );
  });

  it("refuses a rule that belongs to a different version, and a tier from a different rule", async () => {
    const c = await setup();
    const other = await setup();
    await expect(insert(validEarning(c, { monetaryRuleId: other.ruleId }))).rejects.toThrow(
      /rule belongs to a different program version/,
    );
    await expect(insert(validEarning(c, { monetaryTierId: other.tierId }))).rejects.toThrow(
      /tier belongs to a different rule/,
    );
  });

  it("refuses a rate that is not the tier's rate — a forged rate", async () => {
    const c = await setup();
    // The rate is copied from the tier so the row survives the tier. Disagreeing with it is the
    // single easiest way to pay a customer a number nobody configured.
    await expect(insert(validEarning(c, { rateBasisPoints: 9_000, cashEffectMinor: 90_000n }))).rejects.toThrow(
      /rate does not match the tier/,
    );
  });
});

// ─── Arithmetic the database recomputes ───────────────────────────────────────

describe("the database recomputes the money rather than trusting the row", () => {
  it("refuses cashback that is not the rate applied to the invoice, rounded half-up", async () => {
    const c = await setup();
    await expect(insert(validEarning(c, { cashEffectMinor: 5_001n, cashBalanceAfterMinor: 5_001n }))).rejects.toThrow(
      /is not 500 basis points of 100000 rounded half-up/,
    );
    // One unit LOW is refused just as firmly as one unit high.
    await expect(insert(validEarning(c, { cashEffectMinor: 4_999n, cashBalanceAfterMinor: 4_999n }))).rejects.toThrow(
      /rounded half-up/,
    );
  });

  it("refuses a discount that is not the rate applied to the invoice", async () => {
    const c = await setup({ kind: "DISCOUNT", tiers: [{ minCumulativeSpendMinor: 0, rateBasisPoints: 1_000 }] });
    const base = {
      kind: "DISCOUNT_APPLIED" as const,
      rateBasisPoints: 1_000,
      cashEffectMinor: 0n,
      cashBalanceAfterMinor: 0n,
      discountMinor: 10_000n,
      netCounterAmountMinor: 90_000n,
    };
    await expect(insert(validEarning(c, base))).resolves.toBeDefined();
    await expect(
      insert(validEarning(c, { ...base, cardSequence: 2n, discountMinor: 10_001n, netCounterAmountMinor: 89_999n })),
    ).rejects.toThrow(/discount 10001 is not 1000 basis points of 100000 rounded half-up/);
  });

  it("refuses a net that is not the invoice less what came off it", async () => {
    const c = await setup();
    await expect(insert(validEarning(c, { netCounterAmountMinor: 95_000n }))).rejects.toThrow(
      /earning cashback does not change the amount collected/,
    );
  });

  it("refuses a discount larger than the invoice", async () => {
    const c = await setup({ kind: "DISCOUNT", tiers: [{ minCumulativeSpendMinor: 0, rateBasisPoints: 1_000 }] });
    /*
     * Two layers again, and here the TRIGGER is the one that answers: a BEFORE trigger runs before
     * the row's CHECK constraints, so `MonetaryOperation_discount_within_gross` is a backstop that
     * the coherence rule shadows. The exact message is asserted rather than a generic "rejected",
     * because which rule fired is the thing worth knowing.
     */
    await expect(
      insert(
        validEarning(c, {
          kind: "DISCOUNT_APPLIED",
          rateBasisPoints: 1_000,
          cashEffectMinor: 0n,
          cashBalanceAfterMinor: 0n,
          grossAmountMinor: 100n,
          discountMinor: 200n,
          netCounterAmountMinor: 0n,
        }),
      ),
    ).rejects.toThrow(/the amount collected is the invoice less the discount/);
  });

  it("refuses an amount beyond the recorded ceiling, and any negative amount", async () => {
    const c = await setup();
    /*
     * These rows are COHERENT in every other respect - the net equals the gross and the cashback is
     * exactly 5% of it, recomputed - so every coherence rule passes and the CHECK constraints are
     * what refuse them. That is the point: this layer holds when the arithmetic is internally
     * consistent and the numbers are simply not ones this product will record.
     */
    await expect(
      insert(
        validEarning(c, {
          grossAmountMinor: 1_000_000_000_000_001n,
          netCounterAmountMinor: 1_000_000_000_000_001n,
          cashEffectMinor: 50_000_000_000_000n,
          cashBalanceAfterMinor: 50_000_000_000_000n,
        }),
      ),
    ).rejects.toThrow(/gross_bounded|check constraint/i);

    await expect(
      insert(validEarning(c, { grossAmountMinor: -1n, netCounterAmountMinor: -1n, cashEffectMinor: 0n, cashBalanceAfterMinor: 0n })),
    ).rejects.toThrow(/non_negative|check constraint/i);
  });
});

// ─── Per-kind coherence ───────────────────────────────────────────────────────

describe("each kind of operation means one thing and cannot be made to mean another", () => {
  it("refuses cashback earned under a discount rule, and a discount under a cashback rule", async () => {
    const cashback = await setup();
    await expect(
      insert(
        validEarning(cashback, {
          kind: "DISCOUNT_APPLIED",
          discountMinor: 5_000n,
          cashEffectMinor: 0n,
          cashBalanceAfterMinor: 0n,
          netCounterAmountMinor: 95_000n,
        }),
      ),
    ).rejects.toThrow(/a discount needs a discount rule/);

    const discount = await setup({ kind: "DISCOUNT", tiers: [{ minCumulativeSpendMinor: 0, rateBasisPoints: 500 }] });
    await expect(insert(validEarning(discount))).rejects.toThrow(/earning cashback needs a cashback rule/);
  });

  it("refuses an earning that claims no tier, or that carries a redemption or a discount", async () => {
    const c = await setup();
    await expect(insert(validEarning(c, { monetaryTierId: null, rateBasisPoints: null }))).rejects.toThrow(
      /a cashback award names the tier that produced it/,
    );
    await expect(insert(validEarning(c, { requestedRedemptionMinor: 1n }))).rejects.toThrow(
      /an earning row carries no redemption or discount/,
    );
  });

  it("refuses a redemption that adds to a balance, or takes more than was asked for", async () => {
    const c = await setup();
    await insert(validEarning(c)); // 5,000 on the card

    const redemption = {
      kind: "CASHBACK_REDEEMED" as const,
      monetaryTierId: null,
      rateBasisPoints: null,
      cardSequence: 2n,
      requestedRedemptionMinor: 1_000n,
      cashEffectMinor: -1_000n,
      netCounterAmountMinor: 99_000n,
      cashBalanceAfterMinor: 4_000n,
    };
    await expect(insert(validEarning(c, redemption))).resolves.toBeDefined();

    await expect(
      insert(validEarning(c, { ...redemption, cardSequence: 3n, cashEffectMinor: 1_000n, netCounterAmountMinor: 101_000n, cashBalanceAfterMinor: 5_000n })),
    ).rejects.toThrow(/redeeming cashback does not add to a balance|net_within_gross|check constraint/i);

    await expect(
      insert(validEarning(c, { ...redemption, cardSequence: 3n, cashEffectMinor: -2_000n, netCounterAmountMinor: 98_000n, cashBalanceAfterMinor: 2_000n })),
    ).rejects.toThrow(/more was redeemed than was asked for/);
  });

  it("refuses a discount that moves the cashback balance", async () => {
    const c = await setup({ kind: "DISCOUNT", tiers: [{ minCumulativeSpendMinor: 0, rateBasisPoints: 1_000 }] });
    await expect(
      insert(
        validEarning(c, {
          kind: "DISCOUNT_APPLIED",
          rateBasisPoints: 1_000,
          discountMinor: 10_000n,
          netCounterAmountMinor: 90_000n,
          cashEffectMinor: 500n,
          cashBalanceAfterMinor: 500n,
        }),
      ),
    ).rejects.toThrow(/a discount does not change the cashback balance/);
  });

  it("refuses a reversal with no target, no reason, or an invoice of its own", async () => {
    const c = await setup();
    const original = await insert(validEarning(c));

    const rev = {
      kind: "REVERSAL" as const,
      monetaryTierId: null,
      rateBasisPoints: null,
      cardSequence: 2n,
      grossAmountMinor: 0n,
      netCounterAmountMinor: 0n,
      cashEffectMinor: -5_000n,
      cashBalanceAfterMinor: 0n,
      reversalOfId: original.id,
      reason: "wrong customer",
    };

    await expect(insert(validEarning(c, { ...rev, reversalOfId: null }))).rejects.toThrow(/a reversal names what it reverses/);
    await expect(insert(validEarning(c, { ...rev, reason: "   " }))).rejects.toThrow(/a reversal records why/);
    await expect(
      insert(validEarning(c, { ...rev, grossAmountMinor: 100n, netCounterAmountMinor: 100n })),
    ).rejects.toThrow(/a reversal carries no invoice of its own/);
    // An amount somebody chose, rather than the exact inverse.
    await expect(insert(validEarning(c, { ...rev, cashEffectMinor: -1n, cashBalanceAfterMinor: 4_999n }))).rejects.toThrow(
      /a reversal undoes exactly what was done/,
    );

    await expect(insert(validEarning(c, rev))).resolves.toBeDefined();
  });

  it("refuses a second reversal of the same row, and a reversal of a reversal", async () => {
    /*
     * A DISCOUNT program, deliberately. A discount moves no money, so its reversal and the attempted
     * SECOND reversal both have a cash effect of zero and leave the balance at zero - which means
     * the "undoes exactly what was done" rule and the non-negative balance rule both PASS, and the
     * partial unique index on `reversalOfId` is genuinely the thing that refuses.
     *
     * Reversing a cashback award twice cannot reach that index: the second attempt is stopped by the
     * balance rules first, so a test built that way would pass without the index existing at all.
     */
    const c = await setup({ kind: "DISCOUNT", tiers: [{ minCumulativeSpendMinor: 0, rateBasisPoints: 1_000 }] });
    const original = await insert(
      validEarning(c, {
        kind: "DISCOUNT_APPLIED",
        rateBasisPoints: 1_000,
        discountMinor: 10_000n,
        netCounterAmountMinor: 90_000n,
        cashEffectMinor: 0n,
        cashBalanceAfterMinor: 0n,
      }),
    );

    const rev = {
      kind: "REVERSAL" as const,
      monetaryTierId: null,
      rateBasisPoints: null,
      grossAmountMinor: 0n,
      netCounterAmountMinor: 0n,
      cashEffectMinor: 0n,
      cashBalanceAfterMinor: 0n,
      reason: "mistake",
    };
    const first = await insert(validEarning(c, { ...rev, cardSequence: 2n, reversalOfId: original.id }));

    await expect(insert(validEarning(c, { ...rev, cardSequence: 3n, reversalOfId: original.id }))).rejects.toThrow(
      /Unique constraint|reversalOfId/i,
    );

    await expect(insert(validEarning(c, { ...rev, cardSequence: 3n, reversalOfId: first.id }))).rejects.toThrow(
      /a reversal cannot itself be reversed/,
    );
  });
});

// ─── The chain ────────────────────────────────────────────────────────────────

describe("the balance chain cannot be forged or reordered", () => {
  it("refuses a sequence that does not follow the row before it", async () => {
    const c = await setup();
    await expect(insert(validEarning(c, { cardSequence: 2n }))).rejects.toThrow(/sequence 2 does not follow 0/);
    await insert(validEarning(c));
    await expect(insert(validEarning(c, { cardSequence: 1n }))).rejects.toThrow(/Unique constraint|sequence/i);
    await expect(insert(validEarning(c, { cardSequence: 5n, cashBalanceAfterMinor: 10_000n }))).rejects.toThrow(
      /sequence 5 does not follow 1/,
    );
  });

  it("refuses a balance that does not follow its predecessor plus this row's effect", async () => {
    const c = await setup();
    await insert(validEarning(c)); // balance 5,000
    await expect(insert(validEarning(c, { cardSequence: 2n, cashBalanceAfterMinor: 5_000n }))).rejects.toThrow(
      /balance 5000 does not follow 5000 with effect 5000/,
    );
    // A balance invented out of nothing is refused the same way.
    await expect(insert(validEarning(c, { cardSequence: 2n, cashBalanceAfterMinor: 999_999n }))).rejects.toThrow(
      /does not follow/,
    );
  });

  it("refuses a redemption that would overdraw the balance", async () => {
    const c = await setup();
    await insert(validEarning(c)); // 5,000
    await expect(
      insert(
        validEarning(c, {
          kind: "CASHBACK_REDEEMED",
          monetaryTierId: null,
          rateBasisPoints: null,
          cardSequence: 2n,
          requestedRedemptionMinor: 6_000n,
          cashEffectMinor: -6_000n,
          netCounterAmountMinor: 94_000n,
          cashBalanceAfterMinor: -1_000n,
        }),
      ),
    ).rejects.toThrow(/balance_non_negative|check constraint|overdraw/i);
  });

  it("lets exactly one of two OVERLAPPING writers take a sequence number", async () => {
    const c = await setup();

    /*
     * ## Why this test is built the hard way, and the two ways it first passed for the wrong reason
     *
     * The guarantee is the unique index on `("customerCardId", "cardSequence")`. Proving it needs
     * two writers whose transactions are **open at the same time**: both triggers then read only
     * COMMITTED rows, both find `prev_seq = 0`, both compute sequence 1, and both pass every
     * coherence rule. Nothing but the index can separate them - which is exactly the situation a
     * future writer that forgets to take the card lock would create.
     *
     * **Attempt 1** was `Promise.allSettled([insert(row), insert(row)])`. Two bare `create` calls are
     * two autocommit transactions and they do not overlap: the first commits before the second's
     * trigger runs, the trigger sees `prev_seq = 1`, demands sequence 2, and refuses the duplicate on
     * its own. The index was never consulted, and the test passed with it dropped.
     *
     * **Attempt 2** used two interactive transactions with A holding open for a fixed 750 ms. That
     * still passed with the index dropped, and the reason is worth recording: a freshly constructed
     * `PrismaClient` connects LAZILY, so B spent longer starting its engine than A spent waiting.
     * A committed first and B was refused by the trigger again - "sequence 1 does not follow 1".
     *
     * **This version** removes both timing assumptions: each client is WARMED with a trivial query
     * so no connection handshake happens inside the race, and A holds its transaction open until B
     * has SETTLED rather than for a guessed duration. That is deterministic in both worlds - with the
     * index B blocks and A releases it on the deadline; without it B finishes in milliseconds and A
     * notices immediately.
     */
    const runtimeUrl = resolveTestDatabaseUrls().runtime;
    const a = new PrismaClient({ datasourceUrl: runtimeUrl, log: [] });
    const b = new PrismaClient({ datasourceUrl: runtimeUrl, log: [] });

    try {
      // Connect and start both query engines BEFORE the race, so neither pays that cost inside it.
      await a.$queryRaw`SELECT 1`;
      await b.$queryRaw`SELECT 1`;

      let signalAInserted!: () => void;
      const aHasInserted = new Promise<void>((resolve) => {
        signalAInserted = resolve;
      });
      let bSettled = false;

      const txA = a.$transaction(
        async (tx) => {
          await tx.monetaryOperation.create({ data: validEarning(c) });
          signalAInserted();
          // Hold open until B has settled, or until a deadline if B is blocked on the index.
          const deadline = Date.now() + 3_000;
          while (!bSettled && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
        },
        { timeout: 30_000, maxWait: 20_000 },
      );

      const txB = (async () => {
        await aHasInserted;
        return b.$transaction(
          async (tx) => {
            // With the index: blocks on A's uncommitted entry, then fails when A commits.
            // Without it: succeeds, and the card ends up with two rows both at sequence 1.
            await tx.monetaryOperation.create({ data: validEarning(c) });
          },
          { timeout: 30_000, maxWait: 20_000 },
        );
      })().finally(() => {
        bSettled = true;
      });

      const outcomes = await Promise.allSettled([txA, txB]);
      expect(outcomes.filter((r) => r.status === "fulfilled")).toHaveLength(1);

      // And the loser lost to the INDEX, not to the sequence rule - which is what would have
      // refused it had the two transactions merely run one after the other.
      const loser = outcomes.find((r) => r.status === "rejected") as PromiseRejectedResult;
      expect(String(loser.reason)).toMatch(/Unique constraint|cardSequence/i);
      expect(String(loser.reason)).not.toMatch(/does not follow/);
    } finally {
      await a.$disconnect();
      await b.$disconnect();
    }

    // The direct observation, not an inference from which promise rejected: one row, one sequence.
    const rows = await prisma.monetaryOperation.findMany({
      where: { customerCardId: c.cardId },
      select: { cardSequence: true },
    });
    expect(rows).toHaveLength(1);
    expect(new Set(rows.map((r) => r.cardSequence)).size).toBe(1);
  });

  it("keeps the chain intact when the real engine runs alongside a direct write", async () => {
    const c = await setup();
    await insert(validEarning(c));

    // The engine reads the chain head it did not write, and continues from it.
    const r = await earnCashback(c.fx.ctx, {
      customerCardId: c.cardId,
      grossAmountMinor: 100_000n,
      idempotencyKey: nextKey(),
      source: OperationSource.SCANNER,
    });
    expect(r.cashBalanceAfterMinor).toBe("10000");

    const rows = await prisma.monetaryOperation.findMany({ where: { customerCardId: c.cardId }, orderBy: { cardSequence: "asc" } });
    expect(rows.map((x) => x.cardSequence)).toEqual([1n, 2n]);
  });
});

// ─── Referential integrity ────────────────────────────────────────────────────

describe("nothing an operation names can be deleted out from under it", () => {
  it("refuses to delete a rule or a tier an operation depends on", async () => {
    const c = await setup();
    await insert(validEarning(c));
    const owner = migratorPrisma();
    await expect(owner.$executeRawUnsafe(`DELETE FROM "MonetaryRule" WHERE id = '${c.ruleId}'`)).rejects.toThrow(
      /frozen|violates foreign key/i,
    );
    await expect(owner.$executeRawUnsafe(`DELETE FROM "MonetaryTier" WHERE id = '${c.tierId}'`)).rejects.toThrow(
      /frozen|violates foreign key/i,
    );
  });

  it("refuses a rule, tier, card or location that does not exist at all", async () => {
    const c = await setup();
    await expect(insert(validEarning(c, { monetaryRuleId: randomUUID() }))).rejects.toThrow(/does not exist|Foreign key/i);
    await expect(insert(validEarning(c, { customerCardId: randomUUID() }))).rejects.toThrow(/does not exist|Foreign key/i);
    await expect(insert(validEarning(c, { locationId: randomUUID() }))).rejects.toThrow(
      /different business|Foreign key/i,
    );
  });
});
