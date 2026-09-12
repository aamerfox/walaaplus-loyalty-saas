import { Permission } from "@prisma/client";
import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";
import { Link } from "@/i18n/routing";
import { Badge, Card, EmptyState, Notice, PageHeader, StatTile } from "@/components/ui";
import { getBusinessMetrics } from "@/server/analytics/metrics";
import { getCurrentUserId } from "@/server/auth/session";
import { listBusinessPrograms } from "@/server/program/programs";
import { resolveScannerContext } from "@/server/tenant/scanner-context";

/**
 * The merchant dashboard.
 *
 * **Every number on this page is derived from the ledger** by `getBusinessMetrics`, which is the one
 * place their definitions live (`docs/PHASE-1B-IMPLEMENTATION.md` §7). Nothing is counted in the
 * browser, nothing is cached, and nothing is estimated — a dashboard that invents a figure is worse
 * than one that shows none, because the merchant cannot tell which is which.
 *
 * The window is the last 30 days, stated on the screen rather than implied. A figure without a
 * period is not a figure.
 */
const WINDOW_DAYS = 30;

export default async function BusinessHome({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const userId = await getCurrentUserId();
  if (!userId) redirect(`/${locale}/auth/login`);

  const t = await getTranslations("Dashboard");
  const resolved = await resolveScannerContext(userId, null);

  if (resolved.kind !== "ready") {
    return (
      <EmptyState
        testId="dashboard-no-business"
        title={t("noBusinessTitle")}
        body={resolved.kind === "choose" ? t("chooseBusiness") : t("noBusinessBody")}
      />
    );
  }

  const { ctx, businessName } = resolved.context;

  // A cashier has no dashboard: the metric service refuses them, and a screen that rendered the
  // shell and then an error boundary would look like a fault rather than a boundary.
  if (!ctx.permissions.has(Permission.VIEW_DASHBOARD)) {
    return (
      <>
        <PageHeader title={t("title")} subtitle={businessName} />
        <Notice tone="warn" testId="dashboard-forbidden">
          {t("forbidden")}
        </Notice>
      </>
    );
  }

  const now = new Date();
  const from = new Date(now.getTime() - WINDOW_DAYS * 86_400_000);
  const [metrics, programs] = await Promise.all([
    getBusinessMetrics(ctx, { from, to: now }),
    listBusinessPrograms(ctx),
  ]);

  const numbers = new Intl.NumberFormat(locale === "ar" ? "ar-SY-u-nu-latn" : "en");

  return (
    <>
      <PageHeader title={t("title")} subtitle={t("window", { days: WINDOW_DAYS })} />

      {programs.length === 0 ? (
        <EmptyState
          testId="dashboard-empty"
          title={t("emptyTitle")}
          body={t("emptyBody")}
          action={
            <Link
              href="/business/programs"
              className="rounded-xl bg-navy-900 px-5 py-3 font-bold text-white transition-colors hover:bg-navy-800"
            >
              {t("emptyAction")}
            </Link>
          }
        />
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4" data-testid="dashboard-stats">
            <StatTile label={t("cardsIssued")} value={numbers.format(metrics.cardsIssued)} hint={t("cardsIssuedHint")} />
            <StatTile label={t("transactions")} value={numbers.format(metrics.transactions)} hint={t("transactionsHint")} />
            <StatTile label={t("rewardsRedeemed")} value={numbers.format(metrics.rewardsRedeemed)} hint={t("rewardsRedeemedHint")} />
            <StatTile label={t("visits")} value={numbers.format(metrics.visits)} hint={t("visitsHint")} />
          </div>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatTile label={t("newCustomers")} value={numbers.format(metrics.newCustomers)} hint={t("newCustomersHint")} />
            <StatTile label={t("repeatCustomers")} value={numbers.format(metrics.repeatCustomers)} hint={t("repeatCustomersHint")} />
            <StatTile label={t("stampsAwarded")} value={numbers.format(metrics.unitsAwarded.stamps)} hint={t("stampsAwardedHint")} />
            <StatTile label={t("pointsAwarded")} value={numbers.format(metrics.unitsAwarded.points)} hint={t("pointsAwardedHint")} />
          </div>

          {metrics.byTemplate.length > 0 ? (
            <Card>
              <h2 className="font-display text-lg font-bold text-ink">{t("byProgram")}</h2>
              <ul className="mt-3 divide-y divide-border" data-testid="dashboard-by-program">
                {metrics.byTemplate.map((row) => (
                  <li key={row.templateId} className="flex flex-wrap items-center justify-between gap-2 py-3">
                    <Link
                      href={`/business/programs/${row.templateId}`}
                      className="font-semibold text-accent-ink underline-offset-4 hover:underline"
                    >
                      {row.name}
                    </Link>
                    <span className="flex items-center gap-3 text-sm text-ink-muted">
                      <Badge tone="brand">{t(`cardType.${row.cardType}`)}</Badge>
                      <span className="tabular-nums">{t("programCards", { count: row.cardsIssued })}</span>
                      <span className="tabular-nums">{t("programTransactions", { count: row.transactions })}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}

          {metrics.byLocation.length > 1 ? (
            <Card>
              <h2 className="font-display text-lg font-bold text-ink">{t("byLocation")}</h2>
              <ul className="mt-3 divide-y divide-border" data-testid="dashboard-by-location">
                {metrics.byLocation.map((row) => (
                  <li key={row.locationId} className="flex flex-wrap items-center justify-between gap-2 py-3">
                    <span className="font-semibold text-ink">{row.name}</span>
                    <span className="flex items-center gap-3 text-sm tabular-nums text-ink-muted">
                      <span>{t("programTransactions", { count: row.transactions })}</span>
                      <span>{t("locationRewards", { count: row.rewardsRedeemed })}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}

          <p className="text-xs text-ink-faint" data-testid="metrics-provenance">
            {t("provenance")}
          </p>
        </>
      )}
    </>
  );
}
