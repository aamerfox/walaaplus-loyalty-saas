import { CardType, MonetaryRuleKind, Permission, ProgramVersionStatus, TemplateStatus } from "@prisma/client";
import { AuditAction, recordAudit } from "../audit/audit";
import { CONTENDED_TX, prisma, type Tx } from "../db";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import { requirePermission, type TenantContext } from "../tenant/context";
import { assertRateBasisPoints, parseMinorAmount } from "./money";
import { MAX_MONETARY_TIERS, normaliseTiers, type MonetaryTierInput } from "./rules";

/**
 * The owner-facing draft lifecycle for a CASHBACK or DISCOUNT program.
 *
 * `src/server/program/versions.ts` owns the same four verbs for STAMP and POINTS, and deliberately
 * refuses money types: a stamp draft's rules live in one `mechanics` JSON column, while a rate table
 * is rows in `MonetaryRule` and `MonetaryTier` with database triggers policing their lifecycle.
 * Sharing one function would mean a card-type branch inside every step.
 *
 * Two rules here are not this module's to relax, because the database enforces them either way
 * (migration 22) and this code would simply produce a worse error message than the trigger:
 *
 *  - **Currency and exponent are never inputs.** They come from the business, are copied onto the
 *    rule, and appear in no parameter of any function below. There is no conversion anywhere in this
 *    product, so a rule denominated in anything but the business's own currency has no meaning.
 *  - **A money version is retired, never deleted.** Discarding a draft is a DRAFT -> RETIRED
 *    transition. A retired draft can never be activated, so the row stays as evidence of what was
 *    considered without ever becoming something a customer was promised.
 */

/** A money program's draft, as the owner screens need it. */
export interface MoneyDraft {
  templateId: string;
  templateName: string;
  cardType: CardType;
  versionId: string;
  versionNumber: number;
  /** Display only. Never accepted from a form, a route, or any function in this module. */
  currency: string;
  /** Display only. The number of minor digits this product records for `currency`. */
  currencyExponent: number;
  kind: MonetaryRuleKind;
  tiers: { tierIndex: number; minCumulativeSpendMinor: bigint; rateBasisPoints: number }[];
}

/** The live version's rate table, for the screen that shows what a new draft would replace. */
export interface MoneyLive extends Omit<MoneyDraft, "versionId"> {
  versionId: string;
  activatedAt: Date | null;
}

const MONEY_CARD_TYPES: readonly CardType[] = [CardType.CASHBACK, CardType.DISCOUNT];

export function isMoneyCardType(cardType: CardType): boolean {
  return MONEY_CARD_TYPES.includes(cardType);
}

/**
 * Refuse a card type this flow cannot configure, before anything is read or written.
 *
 * A `ValidationError`, not a `NotFoundError`: the program exists and the owner is looking at it. The
 * mirror image of `assertDraftEditable` in `versions.ts`, which refuses money types from that flow.
 */
function assertMoneyProgram(cardType: CardType): void {
  if (!isMoneyCardType(cardType)) {
    throw new ValidationError(
      "This program is not a cashback or discount program. Stamp and points programs are edited from the program version screens.",
    );
  }
}

async function requireOwnMoneyTemplate(tx: Tx, ctx: TenantContext, templateId: string) {
  const template = await tx.programTemplate.findFirst({
    where: { id: templateId, businessId: ctx.businessId },
    select: { id: true, name: true, cardType: true, status: true },
  });
  if (!template) throw new NotFoundError("Program not found");
  assertMoneyProgram(template.cardType);
  return template;
}

/** The rule and tiers attached to one version, or null when the version carries none. */
async function readRateTable(tx: Tx, programVersionId: string) {
  const rule = await tx.monetaryRule.findFirst({
    where: { programVersionId },
    select: { id: true, kind: true, currency: true, currencyExponent: true },
  });
  if (!rule) return null;
  const tiers = await tx.monetaryTier.findMany({
    where: { monetaryRuleId: rule.id },
    orderBy: { tierIndex: "asc" },
    select: { tierIndex: true, minCumulativeSpendMinor: true, rateBasisPoints: true },
  });
  return { rule, tiers };
}

/**
 * Open a draft of the live rate table.
 *
 * The draft starts as an exact copy, including the currency and exponent, so "what changed" means
 * what the owner changed. Calling it twice returns the open draft rather than refusing — a second
 * draft is refused by the database anyway, and a merchant clicking the button again means "let me
 * edit the draft".
 */
export async function createMoneyDraft(ctx: TenantContext, templateId: string): Promise<MoneyDraft> {
  requirePermission(ctx, Permission.EDIT_TEMPLATES);

  return prisma.$transaction(async (tx) => {
    const template = await requireOwnMoneyTemplate(tx, ctx, templateId);
    if (template.status === TemplateStatus.ARCHIVED) {
      throw new ConflictError("This program is archived and cannot take a new version");
    }
    // Serialise every lifecycle verb for this program on one row, exactly as the stamp flow does, so
    // two managers cannot open two drafts or open one while another is publishing.
    await tx.$executeRaw`SELECT id FROM "ProgramTemplate" WHERE id = ${template.id} FOR UPDATE`;

    const open = await tx.programVersion.findFirst({
      where: { templateId: template.id, status: ProgramVersionStatus.DRAFT },
      select: { id: true, versionNumber: true },
    });
    if (open) {
      const table = await readRateTable(tx, open.id);
      if (!table) throw new ConflictError("This program's open draft has no rate table");
      return toDraft(template, open, table);
    }

    const live = await tx.programVersion.findFirst({
      where: { templateId: template.id, status: ProgramVersionStatus.ACTIVE },
      select: { id: true, versionNumber: true, mechanics: true },
    });
    if (!live) throw new ConflictError("This program has no live version to copy");
    const liveTable = await readRateTable(tx, live.id);
    if (!liveTable) throw new ConflictError("This program's live version has no rate table");

    const highest = await tx.programVersion.findFirst({
      where: { templateId: template.id },
      orderBy: { versionNumber: "desc" },
      select: { versionNumber: true },
    });
    const versionNumber = (highest?.versionNumber ?? 0) + 1;

    const draft = await tx.programVersion.create({
      data: {
        templateId: template.id,
        versionNumber,
        status: ProgramVersionStatus.DRAFT,
        mechanics: live.mechanics ?? {},
      },
      select: { id: true, versionNumber: true },
    });

    /*
     * Currency and exponent are copied from the live rule, not chosen. They are the business's, and
     * the database re-derives and re-checks them on this very INSERT: a value that disagreed with
     * `Business.currency` would be refused here rather than stored.
     */
    const rule = await tx.monetaryRule.create({
      data: {
        programVersionId: draft.id,
        kind: liveTable.rule.kind,
        currency: liveTable.rule.currency,
        currencyExponent: liveTable.rule.currencyExponent,
      },
      select: { id: true, kind: true, currency: true, currencyExponent: true },
    });
    for (const tier of liveTable.tiers) {
      await tx.monetaryTier.create({
        data: {
          monetaryRuleId: rule.id,
          tierIndex: tier.tierIndex,
          minCumulativeSpendMinor: tier.minCumulativeSpendMinor,
          rateBasisPoints: tier.rateBasisPoints,
        },
      });
    }

    await recordAudit(tx, {
      businessId: ctx.businessId,
      actorUserId: ctx.userId,
      action: AuditAction.PROGRAM_DRAFT_CREATED,
      entityType: "ProgramVersion",
      entityId: draft.id,
      metadata: { templateId: template.id, versionNumber: draft.versionNumber, copiedFrom: live.versionNumber },
    });

    return toDraft(template, draft, { rule, tiers: liveTable.tiers });
  }, CONTENDED_TX);
}

/**
 * Replace the draft's rate table.
 *
 * The whole table is sent and the whole table is rewritten, rather than patching one tier: a rate
 * table is only meaningful as an ordered set, and a partial edit invites a state where tier 2 has
 * been moved below tier 1. `normaliseTiers` is the same function the create path uses, so a draft
 * cannot be edited into a shape the create path would have refused.
 *
 * **`tiers` is the only input.** There is no parameter for currency or exponent here or anywhere
 * else in this module.
 */
export async function updateMoneyDraftRateTable(
  ctx: TenantContext,
  templateId: string,
  tiers: MonetaryTierInput[],
): Promise<MoneyDraft> {
  requirePermission(ctx, Permission.EDIT_TEMPLATES);

  if (tiers.length === 0) throw new ValidationError("A rate table needs at least one tier");
  if (tiers.length > MAX_MONETARY_TIERS) {
    throw new ValidationError(`A rate table cannot have more than ${MAX_MONETARY_TIERS} tiers`);
  }
  const normalised = normaliseTiers(tiers);
  for (const tier of normalised) {
    assertRateBasisPoints(tier.rateBasisPoints);
    parseMinorAmount(tier.minCumulativeSpendMinor, "minCumulativeSpendMinor");
  }

  return prisma.$transaction(async (tx) => {
    const template = await requireOwnMoneyTemplate(tx, ctx, templateId);
    await tx.$executeRaw`SELECT id FROM "ProgramTemplate" WHERE id = ${template.id} FOR UPDATE`;

    const draft = await tx.programVersion.findFirst({
      where: { templateId: template.id, status: ProgramVersionStatus.DRAFT },
      select: { id: true, versionNumber: true },
    });
    if (!draft) throw new NotFoundError("This program has no open draft");

    const table = await readRateTable(tx, draft.id);
    if (!table) throw new ConflictError("This program's open draft has no rate table");

    /*
     * Delete then insert, in two statements rather than one data-modifying CTE. Both arms of a CTE
     * run against a single snapshot, so the tier guard's lookup through `MonetaryRule` would see a
     * row the same statement had already removed. That is a property of the CTE, not of the guard.
     */
    await tx.monetaryTier.deleteMany({ where: { monetaryRuleId: table.rule.id } });
    for (const [index, tier] of normalised.entries()) {
      await tx.monetaryTier.create({
        data: {
          monetaryRuleId: table.rule.id,
          tierIndex: index,
          minCumulativeSpendMinor: tier.minCumulativeSpendMinor,
          rateBasisPoints: tier.rateBasisPoints,
        },
      });
    }

    await recordAudit(tx, {
      businessId: ctx.businessId,
      actorUserId: ctx.userId,
      action: AuditAction.MONETARY_RULE_CONFIGURED,
      entityType: "MonetaryRule",
      entityId: table.rule.id,
      metadata: {
        templateId: template.id,
        versionNumber: draft.versionNumber,
        status: ProgramVersionStatus.DRAFT,
        currency: table.rule.currency,
        tiers: normalised.map((t, i) => ({
          tierIndex: i,
          minCumulativeSpendMinor: t.minCumulativeSpendMinor.toString(),
          rateBasisPoints: t.rateBasisPoints,
        })),
      },
    });

    return toDraft(template, draft, {
      rule: table.rule,
      tiers: normalised.map((t, i) => ({ tierIndex: i, ...t })),
    });
  }, CONTENDED_TX);
}

/**
 * Discard a draft by RETIRING it. Nothing is deleted.
 *
 * The stamp flow deletes its draft row, and that is right for a stamp draft. It is wrong here, and
 * `walaaplus_protect_money_program_version` refuses the DELETE outright — a money version is a record
 * of what a customer could have been promised, and the retired row is the evidence that it was
 * considered and dropped. A retired version can never be activated, so this is terminal.
 */
export async function discardMoneyDraft(ctx: TenantContext, templateId: string): Promise<void> {
  requirePermission(ctx, Permission.EDIT_TEMPLATES);

  await prisma.$transaction(async (tx) => {
    const template = await requireOwnMoneyTemplate(tx, ctx, templateId);
    await tx.$executeRaw`SELECT id FROM "ProgramTemplate" WHERE id = ${template.id} FOR UPDATE`;

    const draft = await tx.programVersion.findFirst({
      where: { templateId: template.id, status: ProgramVersionStatus.DRAFT },
      select: { id: true, versionNumber: true },
    });
    if (!draft) throw new NotFoundError("This program has no open draft");

    await tx.programVersion.update({
      where: { id: draft.id },
      data: { status: ProgramVersionStatus.RETIRED, retiredAt: new Date() },
    });

    await recordAudit(tx, {
      businessId: ctx.businessId,
      actorUserId: ctx.userId,
      action: AuditAction.PROGRAM_DRAFT_DISCARDED,
      entityType: "ProgramVersion",
      entityId: draft.id,
      metadata: { templateId: template.id, versionNumber: draft.versionNumber, disposition: "RETIRED" },
    });
  }, CONTENDED_TX);
}

export interface MoneyPublishResult {
  publishedVersionNumber: number;
  retiredVersionNumber: number;
}

/**
 * Publish the draft: it becomes live, and the version it replaces is retired.
 *
 * Cards already issued stay pinned to the version they were issued on, so this changes what NEW
 * operations are rated at and changes nothing a customer has already been promised.
 *
 * `expectedVersionNumber` is the draft the owner was looking at. If somebody else published in the
 * meantime, this refuses rather than publishing a table the caller never saw.
 */
export async function publishMoneyDraft(
  ctx: TenantContext,
  templateId: string,
  expectedVersionNumber: number,
): Promise<MoneyPublishResult> {
  requirePermission(ctx, Permission.EDIT_TEMPLATES);

  return prisma.$transaction(async (tx) => {
    const template = await requireOwnMoneyTemplate(tx, ctx, templateId);
    if (template.status === TemplateStatus.ARCHIVED) {
      throw new ConflictError("This program is archived and cannot publish a new version");
    }
    await tx.$executeRaw`SELECT id FROM "ProgramTemplate" WHERE id = ${template.id} FOR UPDATE`;

    const draft = await tx.programVersion.findFirst({
      where: { templateId: template.id, status: ProgramVersionStatus.DRAFT },
      select: { id: true, versionNumber: true },
    });
    if (!draft) throw new NotFoundError("This program has no open draft");
    if (draft.versionNumber !== expectedVersionNumber) {
      throw new ConflictError(
        `This program's open draft is version ${draft.versionNumber}, not ${expectedVersionNumber}. Reload and check the rates before publishing.`,
      );
    }

    const live = await tx.programVersion.findFirst({
      where: { templateId: template.id, status: ProgramVersionStatus.ACTIVE },
      select: { id: true, versionNumber: true },
    });
    if (!live) throw new ConflictError("This program has no live version to replace");

    const now = new Date();
    // Retire first: the partial unique index permits exactly one ACTIVE row per template, so the
    // other order would collide with itself.
    await tx.programVersion.update({
      where: { id: live.id },
      data: { status: ProgramVersionStatus.RETIRED, retiredAt: now },
    });
    /*
     * `walaaplus_validate_money_version_activation` runs on this UPDATE and refuses an incomplete
     * rate table: no rule, no tiers, a tier 0 that does not start at zero, non-contiguous indexes,
     * thresholds that do not increase, or a rate outside 0..10000. Publish completeness is therefore
     * a database guarantee, not a promise this function makes.
     */
    await tx.programVersion.update({
      where: { id: draft.id },
      data: { status: ProgramVersionStatus.ACTIVE, activatedAt: now },
    });

    await recordAudit(tx, {
      businessId: ctx.businessId,
      actorUserId: ctx.userId,
      action: AuditAction.PROGRAM_VERSION_PUBLISHED,
      entityType: "ProgramVersion",
      entityId: draft.id,
      metadata: {
        templateId: template.id,
        versionNumber: draft.versionNumber,
        replacedVersionNumber: live.versionNumber,
        cardType: template.cardType,
      },
    });

    return { publishedVersionNumber: draft.versionNumber, retiredVersionNumber: live.versionNumber };
  }, CONTENDED_TX);
}

/** The live rate table and the open draft, if any — everything the owner screen renders. */
export interface MoneyProgramConfig {
  live: MoneyLive | null;
  draft: MoneyDraft | null;
}

export async function getMoneyProgramConfig(ctx: TenantContext, templateId: string): Promise<MoneyProgramConfig> {
  requirePermission(ctx, Permission.VIEW_TEMPLATES);

  return prisma.$transaction(async (tx) => {
    const template = await requireOwnMoneyTemplate(tx, ctx, templateId);

    const [liveVersion, draftVersion] = await Promise.all([
      tx.programVersion.findFirst({
        where: { templateId: template.id, status: ProgramVersionStatus.ACTIVE },
        select: { id: true, versionNumber: true, activatedAt: true },
      }),
      tx.programVersion.findFirst({
        where: { templateId: template.id, status: ProgramVersionStatus.DRAFT },
        select: { id: true, versionNumber: true },
      }),
    ]);

    const liveTable = liveVersion ? await readRateTable(tx, liveVersion.id) : null;
    const draftTable = draftVersion ? await readRateTable(tx, draftVersion.id) : null;

    return {
      live:
        liveVersion && liveTable
          ? { ...toDraft(template, liveVersion, liveTable), activatedAt: liveVersion.activatedAt }
          : null,
      draft: draftVersion && draftTable ? toDraft(template, draftVersion, draftTable) : null,
    };
  });
}

function toDraft(
  template: { id: string; name: string; cardType: CardType },
  version: { id: string; versionNumber: number },
  table: {
    rule: { kind: MonetaryRuleKind; currency: string; currencyExponent: number };
    tiers: { tierIndex: number; minCumulativeSpendMinor: bigint; rateBasisPoints: number }[];
  },
): MoneyDraft {
  return {
    templateId: template.id,
    templateName: template.name,
    cardType: template.cardType,
    versionId: version.id,
    versionNumber: version.versionNumber,
    currency: table.rule.currency,
    currencyExponent: table.rule.currencyExponent,
    kind: table.rule.kind,
    tiers: table.tiers.map((t) => ({
      tierIndex: t.tierIndex,
      minCumulativeSpendMinor: t.minCumulativeSpendMinor,
      rateBasisPoints: t.rateBasisPoints,
    })),
  };
}
