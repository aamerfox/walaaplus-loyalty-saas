import { getTranslations } from "next-intl/server";
import { notFound, redirect } from "next/navigation";
import { PageHeader } from "@/components/ui";
import { getCurrentUserId } from "@/server/auth/session";
import { readMoneyCard } from "@/server/monetary/counter";
import { resolveScannerContext } from "@/server/tenant/scanner-context";
import MoneyCounter, { type CounterCard } from "./MoneyCounter";

/**
 * The counter screen for a cashback or discount card.
 *
 * Its own route rather than a panel inside the stamp/points scanner. Those two share a shape — a
 * balance of countable things and a reward ladder — and a money card shares neither: it holds
 * currency, its rate depends on prior spend, and the answer it produces is an amount to collect.
 * Folding it into `ScannerClient` would mean a third branch through every control on that screen.
 *
 * The card is addressed by id in the query string because staff arrive here from a lookup that has
 * already resolved one. `readMoneyCard` re-checks the tenant regardless, and answers "not found"
 * identically for another business's card and for a stamp card.
 */
export default async function MoneyCounterPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ card?: string; b?: string }>;
}) {
  const { locale } = await params;
  const { card: cardId, b } = await searchParams;

  const userId = await getCurrentUserId();
  if (!userId) redirect(`/${locale}/scanner/login`);
  if (!cardId) notFound();

  const t = await getTranslations("MoneyCounter");
  const resolved = await resolveScannerContext(userId, b ?? null);
  if (resolved.kind !== "ready") notFound();

  let view: Awaited<ReturnType<typeof readMoneyCard>>;
  try {
    view = await readMoneyCard(resolved.context.ctx, cardId);
  } catch {
    notFound();
  }

  const card: CounterCard = {
    customerCardId: view.customerCardId,
    customerName: view.customerName,
    templateName: view.templateName,
    cardType: view.cardType,
    versionNumber: view.versionNumber,
    currency: view.currency,
    currencyExponent: view.currencyExponent,
    cashBalanceMinor: view.cashBalanceMinor,
    qualifiedSpendMinor: view.qualifiedSpendMinor,
    nextRateBasisPoints: view.nextRateBasisPoints,
    recent: view.recent.map((row) => ({ ...row, at: row.at.toISOString() })),
  };

  return (
    <main className="mx-auto w-full max-w-2xl p-4 sm:p-6">
      <PageHeader title={t("title")} description={t("subtitle")} />
      <MoneyCounter businessId={b ?? null} card={card} />
    </main>
  );
}
