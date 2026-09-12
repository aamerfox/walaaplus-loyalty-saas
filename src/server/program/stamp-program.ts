import { CardType, Permission, Prisma, ProgramVersionStatus, TemplateStatus } from "@prisma/client";
import { AuditAction, recordAudit } from "../audit/audit";
import { CONTENDED_TX, prisma, type Tx } from "../db";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import { opaqueToken } from "../security/tokens";
import { requirePermission, type TenantContext } from "../tenant/context";
import { parseStampMechanics, readStampMechanics, type StampMechanics, type StampMechanicsInput } from "./mechanics";

/**
 * Creating the one stamp program a Phase 1a pilot café runs.
 *
 * This is the only place a program is born, and it does four things that must all hold or none:
 * the template, its first immutable version, the reward that version pays out, and the `direct`
 * enrollment source customers arrive through. A template with no active version issues cards that
 * pin nothing; a version with no reward tier cannot record what was redeemed; a template with no
 * source has no way for anyone to enrol. So they are created together, in one transaction.
 *
 * Order matters and is forced by the database: `reward_tier_protect` refuses a tier once its
 * version leaves DRAFT, so the tier is written first and the version is activated last.
 */

/** The `direct` enrollment source every template gets (PRODUCT-SPEC §4 UtmSourceLink). */
export const DIRECT_SOURCE_NAME = "Direct";
export const DIRECT_UTM_SOURCE = "direct";

export interface CreateStampProgramInput {
  /** Merchant-facing program name, e.g. "بطاقة القهوة". */
  name: string;
  mechanics: StampMechanicsInput;
}

export interface StampProgramSummary {
  templateId: string;
  programVersionId: string;
  rewardTierId: string;
  /** The `direct` source's opaque public token. This is what a QR or link carries. */
  directSourceToken: string;
  directSourceId: string;
  mechanics: StampMechanics;
}

/**
 * The business's default location.
 *
 * Phase 1a runs one café at one counter: the program, its enrollment and its awards all attribute
 * to the `Main` location created at registration. Multi-location programs are Phase 1b, which is
 * why this resolves the default rather than taking a location from the caller.
 */
export async function getDefaultLocationId(db: Tx | typeof prisma, businessId: string): Promise<string> {
  const location = await db.location.findFirst({
    where: { businessId, isDefault: true, active: true },
    select: { id: true },
  });
  if (!location) throw new NotFoundError("This business has no active default location");
  return location.id;
}

/**
 * Create the business's stamp program: template, version 1, its reward tier, and the direct source.
 *
 * Requires EDIT_TEMPLATES, so an owner or manager may do it and a cashier may not.
 */
export async function createStampProgram(ctx: TenantContext, input: CreateStampProgramInput): Promise<StampProgramSummary> {
  requirePermission(ctx, Permission.EDIT_TEMPLATES);
  const mechanics = parseStampMechanics(input.mechanics);
  const name = input.name.trim();
  if (name.length === 0 || name.length > 120) {
    throw new ValidationError("Program name must be between 1 and 120 characters");
  }

  return prisma.$transaction(async (tx) => {
    // Serialise program creation for this business. Two owners clicking at once would otherwise
    // both pass the "already has a program" check below and create two live programs.
    await tx.$executeRaw`SELECT id FROM "Business" WHERE id = ${ctx.businessId} FOR UPDATE`;

    // Phase 1a pilot rule: exactly one live program per business. Phase 1b lifts this, which is
    // why it is enforced here and not as a database constraint that would have to be dropped.
    const live = await tx.programTemplate.count({
      where: { businessId: ctx.businessId, status: { in: [TemplateStatus.ACTIVE, TemplateStatus.PAUSED] } },
    });
    if (live > 0) throw new ConflictError("This business already has a loyalty program; Phase 1a supports one");

    // Also the location the program will operate at. Resolved inside the transaction so a program
    // can never be created for a business whose default location was just deactivated.
    const locationId = await getDefaultLocationId(tx, ctx.businessId);

    const template = await tx.programTemplate.create({
      data: {
        businessId: ctx.businessId,
        name,
        cardType: CardType.STAMP,
        status: TemplateStatus.ACTIVE,
        defaultLocale: "ar",
      },
      select: { id: true },
    });

    // DRAFT first: the reward tier cannot be attached to a version that has already been activated.
    const version = await tx.programVersion.create({
      data: {
        templateId: template.id,
        versionNumber: 1,
        status: ProgramVersionStatus.DRAFT,
        mechanics: mechanics as unknown as Prisma.InputJsonObject,
      },
      select: { id: true },
    });

    // One tier: the single reward a stamp card pays out. `requiredPoints` carries the stamp
    // threshold so the tier is self-describing next to a points program's tiers. It is created
    // from the parsed mechanics, so the two can never disagree.
    const tier = await tx.rewardTier.create({
      data: {
        programVersionId: version.id,
        name: mechanics.rewardName,
        description: mechanics.rewardDescription ?? null,
        requiredPoints: mechanics.stampsRequiredPerReward,
        rewardValueMinor: mechanics.rewardValueMinor ?? null,
        sortOrder: 0,
      },
      select: { id: true },
    });

    // Freeze it. From here the mechanics and the tier are immutable, enforced by triggers.
    await tx.programVersion.update({
      where: { id: version.id },
      data: { status: ProgramVersionStatus.ACTIVE, activatedAt: new Date() },
    });

    // The way in. Its token is opaque and carries nothing about the business or the program.
    const directSource = await tx.utmSourceLink.create({
      data: {
        templateId: template.id,
        name: DIRECT_SOURCE_NAME,
        publicToken: opaqueToken(),
        utmSource: DIRECT_UTM_SOURCE,
        welcomeUnitQuantity: mechanics.welcomeStamps ?? null,
        active: true,
      },
      select: { id: true, publicToken: true },
    });

    const common = { businessId: ctx.businessId, actorUserId: ctx.userId };
    await recordAudit(tx, {
      ...common,
      action: AuditAction.PROGRAM_CREATED,
      entityType: "ProgramTemplate",
      entityId: template.id,
      // Mechanics are recorded so a later dispute can show what the rules were when the program
      // was created, without reading a version row that may since have been retired.
      metadata: { programVersionId: version.id, rewardTierId: tier.id, locationId, mechanics: mechanics as unknown as Prisma.InputJsonObject },
    });
    await recordAudit(tx, {
      ...common,
      action: AuditAction.ENROLLMENT_SOURCE_CREATED,
      entityType: "UtmSourceLink",
      entityId: directSource.id,
      // The token itself is a capability: anyone holding it can open the enrollment page. It is
      // never written to the audit log.
      metadata: { templateId: template.id, utmSource: DIRECT_UTM_SOURCE, welcomeStamps: mechanics.welcomeStamps ?? 0 },
    });

    return {
      templateId: template.id,
      programVersionId: version.id,
      rewardTierId: tier.id,
      directSourceToken: directSource.publicToken,
      directSourceId: directSource.id,
      mechanics,
    };
  }, CONTENDED_TX);
}

export interface ActiveStampProgram {
  templateId: string;
  templateName: string;
  programVersionId: string;
  rewardTierId: string;
  mechanics: StampMechanics;
}

/**
 * The business's live stamp program, or null. Tenant-scoped: a template id from another business
 * is simply not found.
 */
export async function getActiveStampProgram(ctx: TenantContext): Promise<ActiveStampProgram | null> {
  requirePermission(ctx, Permission.VIEW_TEMPLATES);
  const template = await prisma.programTemplate.findFirst({
    where: { businessId: ctx.businessId, cardType: CardType.STAMP, status: TemplateStatus.ACTIVE },
    select: {
      id: true,
      name: true,
      versions: {
        where: { status: ProgramVersionStatus.ACTIVE },
        select: { id: true, mechanics: true, rewardTiers: { select: { id: true }, orderBy: { sortOrder: "asc" }, take: 1 } },
        take: 1,
      },
    },
  });
  const version = template?.versions[0];
  if (!template || !version) return null;

  return {
    templateId: template.id,
    templateName: template.name,
    programVersionId: version.id,
    rewardTierId: version.rewardTiers[0]?.id ?? "",
    mechanics: readStampMechanics(version.mechanics, { programVersionId: version.id }),
  };
}

export interface StampProgramOverview extends ActiveStampProgram {
  /**
   * The `direct` source's opaque public token: the thing a QR and a link carry, and the only
   * value on this object that is a capability. Null only if the source was deactivated, which
   * Phase 1a offers no way to do.
   */
  directSourceToken: string | null;
}

/**
 * Everything the owner's program screen needs, in one tenant-scoped read.
 *
 * Separate from `getActiveStampProgram` because it returns a CAPABILITY. The token in it is
 * enough to enrol customers into this business, so the lookup is filtered by `businessId` on the
 * template — a template id from another tenant finds nothing rather than finding a token — and it
 * inherits VIEW_TEMPLATES, which a CASHIER does not hold.
 */
export async function getStampProgramOverview(ctx: TenantContext): Promise<StampProgramOverview | null> {
  const program = await getActiveStampProgram(ctx);
  if (!program) return null;

  const source = await prisma.utmSourceLink.findFirst({
    where: {
      templateId: program.templateId,
      utmSource: DIRECT_UTM_SOURCE,
      active: true,
      // Belt and braces: the template was already resolved under this tenant, and the join is
      // repeated here so a future refactor of the line above cannot widen this one.
      template: { businessId: ctx.businessId },
    },
    select: { publicToken: true },
  });

  return { ...program, directSourceToken: source?.publicToken ?? null };
}
