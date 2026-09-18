import { getTranslations } from "next-intl/server";
import { notFound, redirect } from "next/navigation";
import { PageHeader } from "@/components/ui";
import { getCurrentUserId } from "@/server/auth/session";
import { getMoneyProgramConfig, type MoneyDraft, type MoneyLive } from "@/server/monetary/draft";
import { resolveScannerContext } from "@/server/tenant/scanner-context";
import RateTableEditor, { type RateTable } from "./RateTableEditor";

/**
 * The rate table of a cashback or discount programme.
 *
 * Its own screen rather than a panel on the programme page, because a rate table is the thing a
 * merchant comes here to change and the thing a customer is promised. The stamp and points
 * equivalent lives under `/draft`; this one is separate because the two edit different shapes —
 * a `mechanics` object there, an ordered table of thresholds and rates here.
 *
 * `getMoneyProgramConfig` refuses a stamp or points programme, so reaching this URL with the wrong
 * template id produces a not-found rather than an empty editor that could never save.
 */
export default async function MoneyRatesPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; templateId: string }>;
  searchParams: Promise<{ b?: string }>;
}) {
  const { locale, templateId } = await params;
  const { b } = await searchParams;

  const userId = await getCurrentUserId();
  if (!userId) redirect(`/${locale}/auth/login`);

  const t = await getTranslations("MoneyRates");
  const resolved = await resolveScannerContext(userId, b ?? null);
  if (resolved.kind !== "ready") notFound();
  const { ctx } = resolved.context;

  let config: Awaited<ReturnType<typeof getMoneyProgramConfig>>;
  try {
    config = await getMoneyProgramConfig(ctx, templateId);
  } catch {
    // A stamp programme, another tenant's programme, or no programme: all the same answer here.
    notFound();
  }

  const name = config.draft?.templateName ?? config.live?.templateName ?? "";

  return (
    <main className="mx-auto w-full max-w-3xl p-4 sm:p-6">
      <PageHeader title={t("title", { name })} description={t("subtitle")} />
      <RateTableEditor
        businessId={b ?? null}
        templateId={templateId}
        live={toWire(config.live)}
        draft={toWire(config.draft)}
      />
    </main>
  );
}

/**
 * `bigint` cannot cross into a client component, and a money amount must not be rounded on the way.
 * Minor units travel as decimal strings; the editor inserts the decimal point using the exponent.
 */
function toWire(table: MoneyDraft | MoneyLive | null): RateTable | null {
  if (!table) return null;
  return {
    versionNumber: table.versionNumber,
    currency: table.currency,
    currencyExponent: table.currencyExponent,
    kind: table.kind as RateTable["kind"],
    tiers: table.tiers.map((tier) => ({
      tierIndex: tier.tierIndex,
      minCumulativeSpendMinor: tier.minCumulativeSpendMinor.toString(),
      rateBasisPoints: tier.rateBasisPoints,
    })),
  };
}
