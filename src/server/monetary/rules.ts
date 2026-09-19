import { CardType, MonetaryRuleKind, Permission, Prisma, ProgramVersionStatus, TemplateStatus } from "@prisma/client";
import { z } from "zod";
import { AuditAction, recordAudit } from "../audit/audit";
import { CONTENDED_TX, prisma, type DbClient, type Tx } from "../db";
import { NotFoundError, ValidationError } from "../errors";
import { assertLocationsBelongToBusiness } from "../program/available-locations";
import { assertProgramSlotAvailable } from "../program/programs";
import { DIRECT_SOURCE_NAME, DIRECT_UTM_SOURCE } from "../program/sources";
import { opaqueToken } from "../security/tokens";
import { requirePermission, type TenantContext } from "../tenant/context";
import {
  MonetaryProgramKind,
  MONETARY_MECHANICS_CONTRACT_VERSION,
  parseMonetaryMechanics,
  type MonetaryMechanics,
  type MonetaryMechanicsInput,
} from "./mechanics";
import { assertRateBasisPoints, MAX_MINOR_AMOUNT, parseMinorAmount } from "./money";

/**
 * Configuring a cashback or discount program: the rate table, and nothing else.
 *
 * ## The one decision this module makes, and why it is not the caller's
 *
 * **The currency is the business's own, copied once, and never chosen per program.** It is read from
 * `Business.currency` inside the transaction, checked against `SupportedCurrency`, and written onto
 * the rule together with that currency's exponent. A caller cannot supply a currency, because there
 * is no conversion anywhere in this product: a balance earned in SYP is spendable in SYP at that
 * business and is not a quantity of anything else. Letting a program name its own currency would
 * create exactly one thing — a card whose balance is in a unit the till does not take.
 *
 * `Business.currency` has no foreign key and no `CHECK` (it is plain `text`, defaulted to `'SYP'`
 * at registration and never written again — see `docs/PHASE-4-MONEY-MATRIX.md` §1). So the check
 * happens here and again in the database's own rule trigger, which refuses an exponent that does not
 * match `SupportedCurrency`. A business whose currency this product does not have an exponent for
 * cannot configure a money program at all, and is told so by name rather than being given a guessed
 * two decimal places.
 *
 * ## Why the version is activated last
 *
 * The same order `createPointsProgram` uses, enforced by the same kind of trigger: `MonetaryRule`
 * and `MonetaryTier` may only be written while their `ProgramVersion` is `DRAFT`. Writing the rates
 * first and activating last is what makes the rate table immutable for every card that pins the
 * version — and the database refuses the alternative rather than trusting this file to remember.
 */

/** A tier as a merchant configures it: a threshold and the rate that applies at or above it. */
export const monetaryTierSchema = z.strictObject({
  /**
   * Cumulative qualified spend at or above which this tier applies, in minor units. The first tier
   * must be 0 — a card with no history has to have a rate, and inventing one is the ambiguity the
   * database refuses.
   */
  minCumulativeSpendMinor: z.union([z.bigint(), z.number(), z.string()]),
  /** 0..10000 = 0%..100%. */
  rateBasisPoints: z.number().int().min(0).max(10_000),
});
export type MonetaryTierInput = z.input<typeof monetaryTierSchema>;

/** A rate table is small on purpose: a merchant who needs more than this is describing a pricing engine. */
export const MAX_MONETARY_TIERS = 10;

export const createMonetaryProgramSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  kind: z.enum([MonetaryProgramKind.CASHBACK, MonetaryProgramKind.DISCOUNT]),
  mechanics: z.unknown(),
  tiers: z.array(monetaryTierSchema).max(MAX_MONETARY_TIERS),
  allowAdditionalProgram: z.boolean().optional(),
  activate: z.boolean().optional(),
});
export interface CreateMonetaryProgramInput {
  name: string;
  kind: MonetaryProgramKind;
  mechanics: MonetaryMechanicsInput;
  tiers: MonetaryTierInput[];
  allowAdditionalProgram?: boolean;
  /** Initial owner creation may intentionally leave the DRAFT table empty; later publish is guarded by SQL. */
  activate?: boolean;
}

export interface MonetaryProgramSummary {
  templateId: string;
  programVersionId: string;
  monetaryRuleId: string;
  tierIds: string[];
  currency: string;
  currencyExponent: number;
  mechanics: MonetaryMechanics;
}

/** A tier as the engine uses it: normalised, ordered, and in the unit the rule froze. */
export interface ResolvedTier {
  id: string;
  tierIndex: number;
  minCumulativeSpendMinor: bigint;
  rateBasisPoints: number;
}

/** A rule as the engine uses it, with its tiers ordered by threshold ascending. */
export interface ResolvedRule {
  id: string;
  kind: MonetaryRuleKind;
  programVersionId: string;
  currency: string;
  currencyExponent: number;
  tiers: ResolvedTier[];
}

/**
 * The business's currency and the exponent this product records for it.
 *
 * Refuses rather than defaults. A currency with no row in `SupportedCurrency` has no known number of
 * decimal places, and the failure mode of guessing is not a rejected request — it is a balance that
 * is silently a factor of ten wrong, discovered by a customer.
 */
export async function resolveBusinessCurrency(db: DbClient, businessId: string): Promise<{ currency: string; exponent: number }> {
  const business = await db.business.findUnique({ where: { id: businessId }, select: { currency: true } });
  if (!business) throw new NotFoundError("Business not found");
  const currency = business.currency.trim().toUpperCase();
  const supported = await db.supportedCurrency.findUnique({ where: { code: currency }, select: { exponent: true } });
  if (!supported) {
    throw new ValidationError(
      `This product does not record how many decimal places ${currency} uses, so it cannot run a money program in it. ` +
        "Add the currency and its exponent before configuring cashback or discounts.",
    );
  }
  return { currency, exponent: supported.exponent };
}

/**
 * Validate a rate table before any of it is written.
 *
 * The database checks each row as it arrives; this checks the SET, which is a different question and
 * produces a far better sentence. "tier 3 has no tier 2 below it" is what a trigger can say about
 * one row; "thresholds must start at zero and increase" is what a person configuring a program needs
 * to hear, before three of their four tiers have been inserted and rolled back.
 */
export function normaliseTiers(input: MonetaryTierInput[]): { minCumulativeSpendMinor: bigint; rateBasisPoints: number }[] {
  const tiers = input.map((t, i) => {
    assertRateBasisPoints(t.rateBasisPoints);
    return {
      minCumulativeSpendMinor: parseMinorAmount(t.minCumulativeSpendMinor, `tiers[${i}].minCumulativeSpendMinor`),
      rateBasisPoints: t.rateBasisPoints,
    };
  });

  tiers.sort((a, b) => (a.minCumulativeSpendMinor < b.minCumulativeSpendMinor ? -1 : a.minCumulativeSpendMinor > b.minCumulativeSpendMinor ? 1 : 0));

  if (tiers[0].minCumulativeSpendMinor !== 0n) {
    throw new ValidationError("The first tier must start at zero spend, so that a new card has a rate");
  }
  for (let i = 1; i < tiers.length; i += 1) {
    if (tiers[i].minCumulativeSpendMinor === tiers[i - 1].minCumulativeSpendMinor) {
      throw new ValidationError("Two tiers cannot share a threshold; which one applied would be ambiguous");
    }
  }
  if (tiers.some((t) => t.minCumulativeSpendMinor > MAX_MINOR_AMOUNT)) {
    throw new ValidationError("A tier threshold is larger than this product will record");
  }
  return tiers;
}

/**
 * Create a cashback or discount program: template, version 1, its rule, its tiers, its direct source.
 *
 * Requires `EDIT_TEMPLATES` — the same permission that configures every other program. A cashier can
 * apply a rate and cannot set one, which is the separation that matters here: the person at the
 * counter is the one with a customer in front of them.
 */
export async function createMonetaryProgram(ctx: TenantContext, input: CreateMonetaryProgramInput): Promise<MonetaryProgramSummary> {
  requirePermission(ctx, Permission.EDIT_TEMPLATES);
  const parsed = createMonetaryProgramSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError("Invalid money program", parsed.error.issues);

  const mechanics = parseMonetaryMechanics(parsed.data.mechanics);
  if (mechanics.kind !== parsed.data.kind) {
    throw new ValidationError("The program kind and its mechanics must agree");
  }
  const rawTiers = parsed.data.tiers as MonetaryTierInput[];
  const shouldActivate = input.activate !== false;
  const tiers = rawTiers.length === 0 && !shouldActivate ? [] : normaliseTiers(rawTiers);
  const name = parsed.data.name;

  return prisma.$transaction(async (tx) => {
    // Serialise program creation for this business, exactly as the stamp and points paths do.
    await tx.$executeRaw`SELECT id FROM "Business" WHERE id = ${ctx.businessId} FOR UPDATE`;
    await assertProgramSlotAvailable(tx, ctx.businessId, { name, allowAdditional: input.allowAdditionalProgram === true });

    const { currency, exponent } = await resolveBusinessCurrency(tx, ctx.businessId);

    if (mechanics.availableLocations) {
      await assertLocationsBelongToBusiness(tx, ctx.businessId, mechanics.availableLocations);
    }

    const template = await tx.programTemplate.create({
      data: {
        businessId: ctx.businessId,
        name,
        cardType: mechanics.kind === MonetaryProgramKind.CASHBACK ? CardType.CASHBACK : CardType.DISCOUNT,
        status: TemplateStatus.ACTIVE,
        defaultLocale: "ar",
      },
      select: { id: true },
    });

    const version = await tx.programVersion.create({
      data: {
        templateId: template.id,
        versionNumber: 1,
        status: ProgramVersionStatus.DRAFT,
        mechanics: mechanics as unknown as Prisma.InputJsonObject,
      },
      select: { id: true },
    });

    const rule = await tx.monetaryRule.create({
      data: {
        programVersionId: version.id,
        kind: mechanics.kind === MonetaryProgramKind.CASHBACK ? MonetaryRuleKind.CASHBACK : MonetaryRuleKind.DISCOUNT,
        currency,
        currencyExponent: exponent,
      },
      select: { id: true },
    });

    const tierIds: string[] = [];
    for (const [index, tier] of tiers.entries()) {
      const row = await tx.monetaryTier.create({
        data: {
          monetaryRuleId: rule.id,
          tierIndex: index,
          minCumulativeSpendMinor: tier.minCumulativeSpendMinor,
          rateBasisPoints: tier.rateBasisPoints,
        },
        select: { id: true },
      });
      tierIds.push(row.id);
    }

    // Initial owner creation deliberately leaves the complete row set in DRAFT. Existing fixtures
    // and service callers retain the historical complete-create behaviour unless activate=false.
    if (shouldActivate) {
      await tx.programVersion.update({
        where: { id: version.id },
        data: { status: ProgramVersionStatus.ACTIVE, activatedAt: new Date() },
      });
    }

    /*
     * Every template gets its `direct` source, so every card carries attribution. The token stays
     * server-side (owner decision B7): nothing publishes it and no public route accepts it.
     *
     * `welcomeUnitQuantity` is NULL and always will be for a money program. A welcome balance here
     * would be the business paying real money to anyone who enrols, with no invoice and no member of
     * staff involved — see the note in `monetary/mechanics.ts`.
     */
    const directSource = await tx.utmSourceLink.create({
      data: {
        templateId: template.id,
        name: DIRECT_SOURCE_NAME,
        publicToken: opaqueToken(),
        utmSource: DIRECT_UTM_SOURCE,
        welcomeUnitQuantity: null,
        active: true,
      },
      select: { id: true },
    });

    /*
     * The source row is audited the same way `createPointsProgram` audits its own, so a money
     * program's paper trail is not thinner than a points program's for the same act. **The token is
     * a capability and is never written here** - an audit row is read by more people and kept far
     * longer than the request that created it.
     */
    await recordAudit(tx, {
      businessId: ctx.businessId,
      actorUserId: ctx.userId,
      action: AuditAction.ENROLLMENT_SOURCE_CREATED,
      entityType: "UtmSourceLink",
      entityId: directSource.id,
      metadata: { templateId: template.id, utmSource: DIRECT_UTM_SOURCE, welcomeUnits: 0 },
    });

    await recordAudit(tx, {
      businessId: ctx.businessId,
      actorUserId: ctx.userId,
      action: AuditAction.MONETARY_RULE_CONFIGURED,
      entityType: "MonetaryRule",
      entityId: rule.id,
      /*
       * The rate table IS written here, in full. An audit row that said only "a rule was configured"
       * would be useless for the one question this log will actually be asked: what rate was a
       * customer promised, and who set it. The values are not secrets — the customer is told them at
       * the counter — and they are already immutable in `MonetaryTier`; this records WHO and WHEN.
       */
      metadata: {
        templateId: template.id,
        programVersionId: version.id,
        kind: mechanics.kind,
        currency,
        currencyExponent: exponent,
        contractVersion: MONETARY_MECHANICS_CONTRACT_VERSION,
        tiers: tiers.map((t, i) => ({
          tierIndex: i,
          // Serialised as a string: a threshold can exceed 2^53 and JSON has no bigint.
          minCumulativeSpendMinor: t.minCumulativeSpendMinor.toString(),
          rateBasisPoints: t.rateBasisPoints,
        })),
      },
    });

    return {
      templateId: template.id,
      programVersionId: version.id,
      monetaryRuleId: rule.id,
      tierIds,
      currency,
      currencyExponent: exponent,
      mechanics,
    };
  }, CONTENDED_TX);
}

/**
 * Load the rule pinned to a program version, with its tiers ordered by threshold.
 *
 * Takes the version id the CARD is pinned to, never a template's current live version. That is the
 * whole pinning rule, and the database enforces the same thing from the other side: the operation's
 * `programVersionId` must equal the card's, and the rule's must equal the operation's.
 */
export async function loadRuleForVersion(db: DbClient, programVersionId: string): Promise<ResolvedRule> {
  const rule = await db.monetaryRule.findUnique({
    where: { programVersionId },
    select: {
      id: true,
      kind: true,
      programVersionId: true,
      currency: true,
      currencyExponent: true,
      tiers: {
        select: { id: true, tierIndex: true, minCumulativeSpendMinor: true, rateBasisPoints: true },
        orderBy: { minCumulativeSpendMinor: "asc" },
      },
    },
  });
  if (!rule) throw new NotFoundError("This program version has no money rule");
  if (rule.tiers.length === 0) {
    // Cannot happen through `createMonetaryProgram`, and is a refusal rather than a default if it
    // ever does: a rule with no tiers has no rate, and zero is not a safe guess in either direction.
    throw new ValidationError("This program version's money rule has no rates configured");
  }
  return rule;
}

/**
 * The tier that applies at a given cumulative qualified spend: the highest threshold at or below it.
 *
 * Total, by construction — tier 0 starts at zero and the database refuses a rule whose first tier
 * does not, so every non-negative spend selects a tier and there is no default branch to get wrong.
 */
export function selectTier(tiers: readonly ResolvedTier[], cumulativeSpendMinor: bigint): ResolvedTier {
  let chosen: ResolvedTier | undefined;
  for (const tier of tiers) {
    if (tier.minCumulativeSpendMinor <= cumulativeSpendMinor) chosen = tier;
    else break; // ordered ascending: nothing further can qualify
  }
  if (!chosen) {
    throw new ValidationError("No rate applies at this level of spend; the program's first tier must start at zero");
  }
  return chosen;
}

/** Narrow type for the transaction-scoped helpers above, so they compose inside one transaction. */
export type MonetaryTx = Tx;
