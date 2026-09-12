import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { Badge, EmptyState, PageHeader, Section, StatTile, Table, Td, Th } from "@/components/ui";
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
    <>
      <PageHeader
        title={t("historyTitle")}
        description={t("historySubtitle")}
        back={
          <Link
            href={`/${locale}/business/customers`}
            className="inline-flex items-center gap-1 text-sm font-semibold text-ink-muted underline-offset-4 hover:text-ink hover:underline"
          >
            {/* A logical-direction chevron: it points back, which in Arabic is the other way. */}
            <span aria-hidden="true" className="rtl:rotate-180">
              ←
            </span>
            {t("title")}
          </Link>
        }
      />

      {/* The balances are the headline of this page, so they are tiles rather than a line of text
          under the title — a cashier checking a disputed balance reads them from across a counter. */}
      <div className="grid gap-3 sm:grid-cols-3">
        <StatTile label={t("stamps")} value={balances.stampBalance} testId="detail-stamps" />
        <StatTile label={t("rewards")} value={balances.rewardBalance} testId="detail-rewards" tone="accent" />
        <StatTile label={t("stampsToNext")} value={balances.stampsToNextReward} hint={t("stampsToNextHint")} />
      </div>

      <Section title={t("historySection")}>
        {operations.items.length === 0 ? (
          <EmptyState testId="history-empty" title={t("historyEmptyTitle")} body={t("historyEmpty")} />
        ) : (
          <Table testId="operations-table">
            <thead>
              <tr>
                <Th>{t("when")}</Th>
                <Th>{t("kind")}</Th>
                <Th>{t("quantity")}</Th>
                <Th className="hidden sm:table-cell">{t("balanceAfter")}</Th>
                <Th className="hidden md:table-cell">{t("reason")}</Th>
              </tr>
            </thead>
            <tbody data-testid="operations-rows">
              {operations.items.map((op) => (
                <tr key={op.id} className="transition-colors hover:bg-surface-muted">
                  <Td className="whitespace-nowrap text-ink-muted">
                    <span dir="ltr">{op.createdAt.toISOString().slice(0, 16).replace("T", " ")}</span>
                  </Td>
                  <Td className="font-semibold">
                    {/* Only the kinds this phase can produce have labels; anything else — an
                        imported or future kind — shows its raw name rather than an empty cell. */}
                    {isLabelledKind(op.kind) ? kinds(op.kind) : op.kind}
                    {op.countsAsVisit && (
                      <Badge tone="accent" className="ms-2">
                        {t("countsAsVisit")}
                      </Badge>
                    )}
                  </Td>
                  <Td className={op.quantity < 0 ? "font-semibold text-danger-ink" : "font-semibold text-success-ink"}>
                    <span dir="ltr" className="tabular-nums">
                      {op.quantity > 0 ? `+${op.quantity}` : op.quantity} {op.unitType}
                    </span>
                  </Td>
                  <Td className="hidden text-ink-muted sm:table-cell">
                    <span dir="ltr" className="tabular-nums">
                      {op.balanceAfter}
                    </span>
                  </Td>
                  <Td className="hidden text-ink-muted md:table-cell">{op.reason ?? op.comment ?? "—"}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Section>
    </>
  );
}
