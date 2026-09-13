import { CardType, Permission } from "@prisma/client";
import { getTranslations } from "next-intl/server";
import { notFound, redirect } from "next/navigation";
import { Link } from "@/i18n/routing";
import { buttonClass, EmptyState, Notice, PageHeader } from "@/components/ui";
import { getCurrentUserId } from "@/server/auth/session";
import { isAppError } from "@/server/errors";
import { getProgramDraft } from "@/server/program/versions";
import { resolveScannerContext } from "@/server/tenant/scanner-context";
import DraftEditor, { type DraftEditorProps, type TierDraft } from "./DraftEditor";

/**
 * The draft of a program's next version.
 *
 * Server-rendered from the SAVED draft, which is what makes the review panel trustworthy: it shows
 * the difference between the live version and what is actually stored, not between the live version
 * and whatever is currently typed into a form. A merchant who edits and does not save sees their
 * change in the fields and not in the review — which is the correct answer, because an unsaved
 * change is not what would be published.
 *
 * No draft, no page: if nobody has opened one, this is an empty state pointing back at the program,
 * rather than a form that would silently create a version.
 */
export default async function ProgramDraftPage({
  params,
}: {
  params: Promise<{ locale: string; templateId: string }>;
}) {
  const { locale, templateId } = await params;
  const userId = await getCurrentUserId();
  if (!userId) redirect(`/${locale}/auth/login`);

  const t = await getTranslations("Versions");
  const resolved = await resolveScannerContext(userId, null);
  if (resolved.kind !== "ready") notFound();
  const { ctx } = resolved.context;

  let draft: Awaited<ReturnType<typeof getProgramDraft>>;
  try {
    draft = await getProgramDraft(ctx, templateId);
  } catch (e) {
    // Another business's program, a missing one, or one this member may not read: one answer.
    if (isAppError(e)) notFound();
    throw e;
  }

  if (!draft) {
    return (
      <>
        <PageHeader
          title={t("title")}
          back={
            <Link
              href={`/business/programs/${templateId}`}
              className="inline-flex items-center gap-1 text-sm font-semibold text-ink-muted underline-offset-4 hover:text-ink hover:underline"
            >
              {/* A logical-direction chevron: it points back, which in Arabic is the other way. */}
              <span aria-hidden="true" className="rtl:rotate-180">
                &#8592;
              </span>
              {t("backToProgram")}
            </Link>
          }
        />
        <EmptyState
          testId="draft-none"
          title={t("noDraftTitle")}
          body={t("noDraftBody")}
          action={
            <Link href={`/business/programs/${templateId}`} className={buttonClass("primary")}>
              {t("backToProgram")}
            </Link>
          }
        />
      </>
    );
  }

  // `EDIT_TEMPLATES` decides whether the editor renders; the server decides again on every write.
  if (!ctx.permissions.has(Permission.EDIT_TEMPLATES)) {
    return (
      <>
        <PageHeader title={draft.name} description={t("subtitle", { number: draft.draftVersionNumber })} />
        <Notice tone="warn" testId="draft-forbidden">
          {t("forbidden")}
        </Notice>
      </>
    );
  }

  const m = draft.mechanics;
  const isPoints = draft.cardType === CardType.POINTS;
  const text = (value: number | undefined) => (value === undefined ? "" : String(value));

  const tiers: TierDraft[] = isPoints
    ? draft.tiers.map((tier) => ({
        name: tier.name,
        requiredPoints: String(tier.requiredPoints),
        rewardValueMinor: tier.rewardValueMinor === null ? "" : String(tier.rewardValueMinor),
      }))
    : [];

  const initial: DraftEditorProps["initial"] = {
    earnMode: m.earnMode,
    spendAmountPerBlockMinor: text(m.spendAmountPerBlockMinor),
    unitsPerBlock: text("kind" in m && m.kind === "POINTS" ? m.pointsPerBlock : m.stampsPerBlock),
    pointsPerVisit: text("kind" in m && m.kind === "POINTS" ? m.pointsPerVisit : undefined),
    dailyAwardLimit: text(m.dailyAwardLimit),
    welcomeUnits: text(m.kind === "POINTS" ? m.welcomePoints : m.welcomeStamps),
    requirePurchaseAmount: m.requirePurchaseAmount,
    countRewardRedemptionAsVisit: m.countRewardRedemptionAsVisit,
    maxPointsPerManualAward: text(m.kind === "POINTS" ? m.maxPointsPerManualAward : undefined),
    pointsLabel: m.kind === "POINTS" ? (m.pointsLabel ?? "") : "",
    stampsRequiredPerReward: m.kind === "STAMP" ? String(m.stampsRequiredPerReward) : "",
    rewardName: m.kind === "STAMP" ? m.rewardName : "",
    rewardDescription: m.kind === "STAMP" ? (m.rewardDescription ?? "") : "",
    rewardValueMinor: m.kind === "STAMP" ? text(m.rewardValueMinor) : "",
    availableLocations: [...(m.availableLocations ?? [])],
    tiers,
  };

  return (
    <>
      <PageHeader
        title={draft.name}
        description={t("subtitle", { number: draft.draftVersionNumber })}
        back={
          <Link
            href={`/business/programs/${templateId}`}
            className="inline-flex items-center gap-1 text-sm font-semibold text-ink-muted underline-offset-4 hover:text-ink hover:underline"
          >
            {/* A logical-direction chevron: it points back, which in Arabic is the other way. */}
            <span aria-hidden="true" className="rtl:rotate-180">
              &#8592;
            </span>
            {t("backToProgram")}
          </Link>
        }
      />

      <DraftEditor
        businessId={ctx.businessId}
        templateId={draft.templateId}
        cardType={draft.cardType}
        draftVersionNumber={draft.draftVersionNumber}
        liveVersionNumber={draft.liveVersionNumber}
        cardsOnLiveVersion={draft.cardsOnLiveVersion}
        locations={draft.locations}
        changes={draft.changes}
        initial={initial}
      />
    </>
  );
}
