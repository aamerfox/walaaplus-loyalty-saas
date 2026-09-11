import { getTranslations } from "next-intl/server";
import { notFound, redirect } from "next/navigation";
import { getCurrentUserId } from "@/server/auth/session";
import { listCardOperations } from "@/server/customers/lookup";
import { getCardBalances } from "@/server/stamp/engine";
import { isAppError } from "@/server/errors";
import { resolveScannerContext } from "@/server/tenant/scanner-context";

/**
 * One customer's card and its immutable history.
 *
 * The history is the ledger, rendered: every award, conversion, reward earned, redemption and
 * reversal, with the balance each row left behind. There is no edit and no delete on this page,
 * because there is none in the system — a mistake is corrected by a reversal from the scanner,
 * which appears here as its own row alongside the original.
 *
 * Both services are tenant-scoped, so a card id from another business is a 404 rather than an
 * empty page, and a cashier sees only operations from the location they are assigned to.
 */
/** Operation kinds Phase 1a can produce, and therefore the ones with translated labels. */
const LABELLED_KINDS = [
  "MANUAL_AWARD",
  "VISIT_AWARD",
  "PURCHASE_AWARD",
  "STAMP_CONVERTED",
  "REWARD_EARNED",
  "REWARD_REDEEMED",
  "WELCOME_BONUS",
  "REVERSAL",
] as const;
type LabelledKind = (typeof LABELLED_KINDS)[number];

function isLabelledKind(kind: string): kind is LabelledKind {
  return (LABELLED_KINDS as readonly string[]).includes(kind);
}

export default async function CustomerDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; cardId: string }>;
  searchParams: Promise<{ b?: string }>;
}) {
  const { locale, cardId } = await params;
  const { b } = await searchParams;

  const userId = await getCurrentUserId();
  if (!userId) redirect(`/${locale}/auth/login`);

  const t = await getTranslations("Customers");
  const kinds = await getTranslations("OperationKinds");
  const resolved = await resolveScannerContext(userId, b ?? null);
  if (resolved.kind !== "ready") notFound();

  let balances;
  let operations;
  try {
    balances = await getCardBalances(resolved.context.ctx, cardId);
    operations = await listCardOperations(resolved.context.ctx, cardId, { limit: 50 });
  } catch (e) {
    if (isAppError(e)) notFound();
    throw e;
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-zinc-900 dark:text-zinc-100">{t("historyTitle")}</h1>
          <p className="mt-1 text-sm text-zinc-500">
            {t("stamps")}: <span data-testid="detail-stamps">{balances.stampBalance}</span> · {t("rewards")}:{" "}
            <span data-testid="detail-rewards">{balances.rewardBalance}</span>
          </p>
        </div>
      </header>

      {operations.items.length === 0 ? (
        <p className="rounded-2xl border border-zinc-200 bg-white p-6 text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900">
          {t("historyEmpty")}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
          <table className="w-full text-start text-sm">
            <thead className="border-b border-zinc-200 text-xs uppercase tracking-wide text-zinc-500 dark:border-zinc-800">
              <tr>
                <th className="px-4 py-3 text-start">{t("when")}</th>
                <th className="px-4 py-3 text-start">{t("kind")}</th>
                <th className="px-4 py-3 text-start">{t("quantity")}</th>
                <th className="px-4 py-3 text-start">{t("balanceAfter")}</th>
                <th className="px-4 py-3 text-start">{t("reason")}</th>
              </tr>
            </thead>
            <tbody data-testid="operations-rows">
              {operations.items.map((op) => (
                <tr key={op.id} className="border-b border-zinc-100 last:border-0 dark:border-zinc-800/60">
                  <td className="whitespace-nowrap px-4 py-3 text-zinc-500" dir="ltr">
                    {op.createdAt.toISOString().slice(0, 16).replace("T", " ")}
                  </td>
                  <td className="px-4 py-3 font-medium text-zinc-900 dark:text-zinc-100">
                    {/* Only the kinds this phase can produce have labels; anything else — an
                        imported or future kind — shows its raw name rather than an empty cell. */}
                    {isLabelledKind(op.kind) ? kinds(op.kind) : op.kind}
                    {op.countsAsVisit && (
                      <span className="ms-2 rounded-full bg-indigo-50 px-2 py-0.5 text-xs text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-400">
                        {t("countsAsVisit")}
                      </span>
                    )}
                  </td>
                  <td
                    className={`px-4 py-3 font-mono ${op.quantity < 0 ? "text-rose-600 dark:text-rose-400" : "text-emerald-600 dark:text-emerald-400"}`}
                    dir="ltr"
                  >
                    {op.quantity > 0 ? `+${op.quantity}` : op.quantity} {op.unitType}
                  </td>
                  <td className="px-4 py-3 font-mono text-zinc-700 dark:text-zinc-300" dir="ltr">
                    {op.balanceAfter}
                  </td>
                  <td className="px-4 py-3 text-zinc-500">{op.reason ?? op.comment ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
