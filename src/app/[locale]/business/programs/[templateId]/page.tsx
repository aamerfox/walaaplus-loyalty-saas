import { CardType, Permission } from "@prisma/client";
import { getTranslations } from "next-intl/server";
import { notFound, redirect } from "next/navigation";
import { Link } from "@/i18n/routing";
import { Badge, Card, DetailRow, Notice, PageHeader, Section, StatTile, Table, Td, Th } from "@/components/ui";
import { getBusinessMetrics } from "@/server/analytics/metrics";
import { getCurrentUserId } from "@/server/auth/session";
import { isAppError } from "@/server/errors";
import { getProgramDetail, type ProgramDetail } from "@/server/program/program-detail";
import { listSourceLinks } from "@/server/program/source-links";
import { listProgramVersions } from "@/server/program/versions";
import { resolveScannerContext } from "@/server/tenant/scanner-context";
import ProgramLifecycle from "./ProgramLifecycle";
import SourceManager from "./SourceManager";

/**
 * One loyalty program, in full.
 *
 * Two reads, both tenant-scoped and both already existing: `getProgramDetail` for the configuration
 * pinned to the live version, and `getBusinessMetrics` — the same function the dashboard uses —
 * narrowed to this template for the activity. Nothing on this page is computed twice or here.
 *
 * The live configuration is READ-ONLY, and that is a property of the domain rather than a gap in
 * this screen: a program version's mechanics and its reward tiers are frozen by database triggers
 * once the version activates, so that a card sold under one set of rules keeps them.
 *
 * What Prompt 3 adds is the way FORWARD from that. A merchant who needs different rules opens a
 * draft of the next version, reviews exactly what differs, and publishes it — and the version
 * history below makes the consequence legible: each past version is listed with the number of cards
 * still pinned to it, still running on its rules. "Existing cards keep their version" stops being a
 * sentence in a document and becomes a number on a screen.
 */
export default async function ProgramDetailPage({
  params,
}: {
  params: Promise<{ locale: string; templateId: string }>;
}) {
  const { locale, templateId } = await params;
  const userId = await getCurrentUserId();
  if (!userId) redirect(`/${locale}/auth/login`);

  const t = await getTranslations("Programs");
  const resolved = await resolveScannerContext(userId, null);
  if (resolved.kind !== "ready") notFound();

  const { ctx } = resolved.context;

  let program: ProgramDetail;
  try {
    program = await getProgramDetail(ctx, templateId);
  } catch (e) {
    // A template from another business, a missing one, and one this member may not read all end
    // here: the 404 is the answer, and it is the same answer for all three.
    if (isAppError(e)) notFound();
    throw e;
  }

  const now = new Date();
  const metrics = await getBusinessMetrics(ctx, { from: new Date(now.getTime() - 30 * 86_400_000), to: now, templateId }).catch(
    // A manager without VIEW_DASHBOARD may still read a program. The configuration is the point of
    // this page; the activity panel is an extra, and it is simply absent for them.
    () => null,
  );

  /*
   * Named sources are INTERNAL attribution records (B7). This list shows where a program's cards
   * came from; it shows no token, and there is no public link behind any row, because none exists.
   * Creating and deactivating them is a server contract that this screen does not yet expose.
   */
  const sources = await listSourceLinks(ctx, templateId).catch(() => []);

  // The version history, and whether a draft is already open. Tenant-scoped like everything else.
  const history = await listProgramVersions(ctx, templateId);
  const mayEdit = ctx.permissions.has(Permission.EDIT_TEMPLATES);
  const dates = new Intl.DateTimeFormat(locale === "ar" ? "ar-SY-u-nu-latn" : "en-GB", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });

  const numbers = new Intl.NumberFormat(locale === "ar" ? "ar-SY-u-nu-latn" : "en");
  const money = (minor: number | null) =>
    minor === null ? t("notSet") : numbers.format(minor);

  const earn =
    program.earnRule.mode === "MANUAL"
      ? t("earn.manual")
      : program.earnRule.mode === "PER_VISIT"
        ? t("earn.perVisit", { units: program.earnRule.unitsPerAward })
        : t("earn.spendBlock", {
            amount: numbers.format(program.earnRule.spendAmountPerBlockMinor),
            units: program.earnRule.unitsPerBlock,
          });

  return (
    <>
      <PageHeader
        title={program.name}
        description={t(`cardType.${program.cardType}`)}
        actions={
          <>
            {mayEdit ? (
              <ProgramLifecycle
                businessId={ctx.businessId}
                templateId={templateId}
                status={program.status}
                hasDraft={history.draftVersionNumber !== null}
              />
            ) : null}
            <Link href="/business/programs" className="rounded-xl border border-border px-4 py-2 font-semibold text-ink-muted hover:bg-surface-muted">
              {t("backToList")}
            </Link>
          </>
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={program.status === "ACTIVE" ? "success" : "warn"}>{t(`statuses.${program.status}`)}</Badge>
        <Badge tone="brand">{t("versionNumber", { number: program.versionNumber })}</Badge>
        {history.draftVersionNumber !== null ? (
          <Badge tone="accent">{t("draftOpen", { number: history.draftVersionNumber })}</Badge>
        ) : null}
      </div>

      {program.status === "PAUSED" ? (
        <Notice tone="warn" testId="program-paused">
          {t("pausedNote")}
        </Notice>
      ) : null}

      <Card>
        <h2 className="font-display text-lg font-bold text-ink">{t("howItWorks")}</h2>
        <dl className="mt-2" data-testid="program-rules">
          <DetailRow label={t("earnRule")}>{earn}</DetailRow>
          <DetailRow label={t("dailyLimit")}>
            {program.dailyAwardLimit === null ? t("noLimit") : t("awardsPerDay", { count: program.dailyAwardLimit })}
          </DetailRow>
          <DetailRow label={t("purchaseAmount")}>
            {program.requirePurchaseAmount ? t("required") : t("optional")}
          </DetailRow>
          <DetailRow label={t("welcomeBonus")}>
            {program.welcomeUnits === 0
              ? t("none")
              : program.cardType === CardType.POINTS
                ? t("welcomePoints", { count: program.welcomeUnits })
                : t("welcomeStamps", { count: program.welcomeUnits })}
          </DetailRow>
          <DetailRow label={t("locations")}>
            {program.availableLocations === null
              ? t("mainOnly")
              : // `Intl.ListFormat` so an Arabic list reads with an Arabic comma and conjunction
                // rather than an English one pasted between translated names.
                new Intl.ListFormat(locale === "ar" ? "ar" : "en", { style: "long", type: "conjunction" }).format(
                  program.availableLocations.map((l) => l.name),
                )}
          </DetailRow>
        </dl>
      </Card>

      <Card>
        <h2 className="font-display text-lg font-bold text-ink">
          {program.cardType === CardType.POINTS ? t("rewardTiers") : t("theReward")}
        </h2>

        {program.cardType === CardType.STAMP && program.stampReward ? (
          <dl className="mt-2">
            <DetailRow label={t("rewardName")}>{program.stampReward.rewardName}</DetailRow>
            <DetailRow label={t("stampsRequired")}>
              {t("stampsPerReward", { count: program.stampReward.stampsRequiredPerReward })}
            </DetailRow>
            <DetailRow label={t("rewardValue")}>{money(program.stampReward.rewardValueMinor)}</DetailRow>
          </dl>
        ) : (
          <ul className="mt-3 divide-y divide-border" data-testid="tier-list">
            {program.tiers.map((tier) => (
              <li key={tier.id} className="flex flex-wrap items-baseline justify-between gap-2 py-3">
                <div className="min-w-0">
                  <p className="font-semibold text-ink">{tier.name}</p>
                  {tier.description ? <p className="text-sm text-ink-muted">{tier.description}</p> : null}
                </div>
                <div className="flex items-center gap-3 text-sm tabular-nums text-ink-muted">
                  <span className="font-semibold text-ink">{t("costPoints", { count: tier.requiredPoints })}</span>
                  {tier.rewardValueMinor !== null ? <span>{t("valueMinor", { amount: numbers.format(tier.rewardValueMinor) })}</span> : null}
                  {tier.usageLimit !== null ? <Badge tone="neutral">{t("usageLimit", { count: tier.usageLimit })}</Badge> : null}
                </div>
              </li>
            ))}
          </ul>
        )}

        <Notice tone="info" testId="program-immutable">
          {t("immutableNoteWithDraft")}
        </Notice>
      </Card>

      {metrics ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4" data-testid="program-metrics">
          <StatTile label={t("metricCards")} value={numbers.format(program.cardCount)} hint={t("metricCardsHint")} />
          <StatTile label={t("metricTransactions")} value={numbers.format(metrics.transactions)} hint={t("metricWindow")} />
          <StatTile label={t("metricRewards")} value={numbers.format(metrics.rewardsRedeemed)} hint={t("metricWindow")} />
          <StatTile
            label={program.cardType === CardType.POINTS ? t("metricPoints") : t("metricStamps")}
            value={numbers.format(
              program.cardType === CardType.POINTS ? metrics.unitsAwarded.points : metrics.unitsAwarded.stamps,
            )}
            hint={t("metricWindow")}
          />
        </div>
      ) : null}

      <Section title={t("versionHistory")} description={t("versionHistoryHelp")} testId="version-history">
        <Table testId="version-table">
          <thead>
            <tr>
              <Th>{t("version")}</Th>
              <Th>{t("versionStatus")}</Th>
              <Th>{t("versionLive")}</Th>
              <Th>{t("versionRetired")}</Th>
              <Th className="text-end">{t("versionCards")}</Th>
            </tr>
          </thead>
          <tbody>
            {history.versions.map((version) => (
              <tr key={version.versionNumber}>
                <Td className="font-semibold">{t("versionNumber", { number: version.versionNumber })}</Td>
                <Td>
                  <Badge
                    tone={version.status === "ACTIVE" ? "success" : version.status === "DRAFT" ? "accent" : "neutral"}
                  >
                    {t(`versionStatuses.${version.status}`)}
                  </Badge>
                </Td>
                <Td>{version.activatedAt ? dates.format(version.activatedAt) : t("notSet")}</Td>
                {/*
                 * Three different states, and they are not the same sentence. A live or draft
                 * version has not been retired, which is a dash. A retired one with no timestamp
                 * was retired before the column existed, which reads "not recorded" — not
                 * backfilled and not borrowed from its successor, because a fabricated date in
                 * front of a merchant is worse than an honest blank.
                 */}
                <Td>
                  {version.retiredAt
                    ? dates.format(version.retiredAt)
                    : version.status === "RETIRED"
                      ? t("notRecorded")
                      : "—"}
                </Td>
                <Td className="text-end tabular-nums">{numbers.format(version.cardCount)}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
        <Notice tone="info" testId="version-pinning">
          {t("versionPinningNote")}
        </Notice>
      </Section>

      <Section title={t("sources")} description={t("sourcesHelp")}>
        <Card>
          <SourceManager
            businessId={ctx.businessId}
            templateId={templateId}
            mayEdit={mayEdit}
            sources={sources.map((source) => ({
              id: source.id,
              name: source.name,
              utmSource: source.utmSource,
              utmMedium: source.utmMedium,
              utmCampaign: source.utmCampaign,
              active: source.active,
              isDirect: source.isDirect,
              cardCount: source.cardCount,
            }))}
          />
        </Card>
      </Section>

      <Notice tone="info" testId="program-counter-note">
        {t("counterOnly")}
      </Notice>
    </>
  );
}
