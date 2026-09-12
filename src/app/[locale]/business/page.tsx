import { Permission } from "@prisma/client";
import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";
import { Link } from "@/i18n/routing";
import { Badge, buttonClass, Card, EmptyState, Notice, PageHeader, Section, StatGroup, StatTile } from "@/components/ui";
import { getBusinessMetrics } from "@/server/analytics/metrics";
import { getCurrentUserId } from "@/server/auth/session";
import { listBusinessPrograms } from "@/server/program/programs";
import { resolveScannerContext } from "@/server/tenant/scanner-context";

/**
 * The merchant dashboard.
 *
 * **Every number is derived from the ledger** by `getBusinessMetrics`, which is the one place their
 * definitions live (`docs/PHASE-1B-IMPLEMENTATION.md` §7). Nothing is counted in the browser,
 * nothing is cached, nothing is estimated.
 *
 * ## Grouped by what a merchant is asking
 *
 * The first version put eight identical tiles in one grid, which is a field of numbers rather than a
 * dashboard — the reader has to work out for themselves which figures belong together. They are now
 * three questions in the order a merchant asks them: **who came**, **what happened at the counter**,
 * **what it paid out**. Same data, same source, a screen that can be read at a glance.
 */
const WINDOW_DAYS = 30;

export default async function BusinessHome({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ b?: string }>;
}) {
  const { locale } = await params;
  const { b } = await searchParams;
  const userId = await getCurrentUserId();
  if (!userId) redirect(`/${locale}/auth/login`);

  const t = await getTranslations("Dashboard");
  const resolved = await resolveScannerContext(userId, b ?? null);

  if (resolved.kind !== "ready") {
    return (
      <EmptyState
        testId="dashboard-no-business"
        title={t("noBusinessTitle")}
        body={resolved.kind === "choose" ? t("chooseBusiness") : t("noBusinessBody")}
      />
    );
  }

  const { ctx } = resolved.context;

  // A cashier has no dashboard: the metric service refuses them, and a screen that rendered the
  // shell and then an error boundary would look like a fault rather than a boundary.
  if (!ctx.permissions.has(Permission.VIEW_DASHBOARD)) {
    return (
      <>
        <PageHeader title={t("title")} description={t("subtitle")} />
        <Notice tone="warn" testId="dashboard-forbidden">
          {t("forbidden")}
        </Notice>
      </>
    );
  }

  const now = new Date();
  const from = new Date(now.getTime() - WINDOW_DAYS * 86_400_000);
  const [metrics, programs] = await Promise.all([getBusinessMetrics(ctx, { from, to: now }), listBusinessPrograms(ctx)]);

  const numbers = new Intl.NumberFormat(locale === "ar" ? "ar-SY-u-nu-latn" : "en");

  if (programs.length === 0) {
    return (
      <>
        <PageHeader title={t("title")} description={t("subtitle")} />
        <EmptyState
          testId="dashboard-empty"
          title={t("emptyTitle")}
          body={t("emptyBody")}
          action={
            <Link href="/business/programs/new" className={buttonClass("primary", "lg")}>
              {t("emptyAction")}
            </Link>
          }
        />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title={t("title")}
        description={t("window", { days: WINDOW_DAYS })}
        actions={
          <Link href="/scanner" className={buttonClass("accent")}>
            {t("openScanner")}
          </Link>
        }
      />

      <StatGroup title={t("groupCustomers")} testId="dashboard-stats">
        <StatTile label={t("cardsIssued")} value={numbers.format(metrics.cardsIssued)} hint={t("cardsIssuedHint")} />
        <StatTile label={t("newCustomers")} value={numbers.format(metrics.newCustomers)} hint={t("newCustomersHint")} />
        <StatTile
          label={t("repeatCustomers")}
          value={numbers.format(metrics.repeatCustomers)}
          hint={t("repeatCustomersHint")}
          tone="accent"
        />
        <StatTile label={t("visits")} value={numbers.format(metrics.visits)} hint={t("visitsHint")} />
      </StatGroup>

      <StatGroup title={t("groupCounter")}>
        <StatTile label={t("transactions")} value={numbers.format(metrics.transactions)} hint={t("transactionsHint")} />
        <StatTile label={t("stampsAwarded")} value={numbers.format(metrics.unitsAwarded.stamps)} hint={t("stampsAwardedHint")} />
        <StatTile label={t("pointsAwarded")} value={numbers.format(metrics.unitsAwarded.points)} hint={t("pointsAwardedHint")} />
        <StatTile label={t("reversals")} value={numbers.format(metrics.reversals)} hint={t("reversalsHint")} />
      </StatGroup>

      <StatGroup title={t("groupRewards")} columns={2}>
        <StatTile
          label={t("rewardsRedeemed")}
          value={numbers.format(metrics.rewardsRedeemed)}
          hint={t("rewardsRedeemedHint")}
          tone="accent"
        />
        <StatTile
          label={t("rewardCost")}
          value={numbers.format(metrics.rewardValueMinorRedeemed)}
          hint={t("rewardCostHint")}
        />
      </StatGroup>

      {metrics.byTemplate.length > 0 ? (
        <Section
          title={t("byProgram")}
          actions={
            <Link href="/business/programs" className={buttonClass("secondary", "sm")}>
              {t("allPrograms")}
            </Link>
          }
        >
          <Card padded={false}>
            <ul className="divide-y divide-border" data-testid="dashboard-by-program">
              {metrics.byTemplate.map((row) => (
                <li key={row.templateId} className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
                  <div className="flex min-w-0 items-center gap-3">
                    <Link
                      href={`/business/programs/${row.templateId}`}
                      className="truncate font-semibold text-ink underline-offset-4 hover:underline"
                    >
                      {row.name}
                    </Link>
                    <Badge tone={row.cardType === "POINTS" ? "accent" : "brand"}>{t(`cardType.${row.cardType}`)}</Badge>
                  </div>
                  <div className="flex items-center gap-4 text-sm tabular-nums text-ink-muted">
                    <span>{t("programCards", { count: row.cardsIssued })}</span>
                    <span>{t("programTransactions", { count: row.transactions })}</span>
                  </div>
                </li>
              ))}
            </ul>
          </Card>
        </Section>
      ) : null}

      {metrics.byLocation.length > 1 ? (
        <Section title={t("byLocation")}>
          <Card padded={false}>
            <ul className="divide-y divide-border" data-testid="dashboard-by-location">
              {metrics.byLocation.map((row) => (
                <li key={row.locationId} className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
                  <span className="truncate font-semibold text-ink">{row.name}</span>
                  <div className="flex items-center gap-4 text-sm tabular-nums text-ink-muted">
                    <span>{t("programTransactions", { count: row.transactions })}</span>
                    <span>{t("locationRewards", { count: row.rewardsRedeemed })}</span>
                  </div>
                </li>
              ))}
            </ul>
          </Card>
        </Section>
      ) : null}

      <p className="text-xs leading-relaxed text-ink-faint" data-testid="metrics-provenance">
        {t("provenance")}
      </p>
    </>
  );
}
