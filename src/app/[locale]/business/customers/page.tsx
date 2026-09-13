import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";
import Link from "next/link";
import { buttonClass, EmptyState, PageHeader, Table, Td, Th, TextInput, Toolbar } from "@/components/ui";
import { getCurrentUserId } from "@/server/auth/session";
import { listCustomers } from "@/server/customers/lookup";
import { resolveScannerContext } from "@/server/tenant/scanner-context";

/**
 * The owner's customer list.
 *
 * Everything comes from `listCustomers`, which filters by the resolved business and refuses a
 * cashier outright — their `VIEW_CUSTOMERS` covers the person at the counter, not the directory. The
 * page does not query Prisma itself, so the tenant filter cannot be forgotten here.
 *
 * Search accepts a name or a phone number; the service normalises a phone before matching, so a
 * customer found by `0944…` and by `+963 944…` is the same row. It is a plain `GET` form, so a
 * search is shareable, the back button works, and nothing depends on JavaScript.
 *
 * The table is the shared `Table` primitive — one density, one border treatment, `text-start` in
 * every cell so Arabic reads from the right without a second stylesheet.
 */
export default async function CustomersPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ q?: string; cursor?: string; b?: string }>;
}) {
  const { locale } = await params;
  const { q, cursor, b } = await searchParams;

  const userId = await getCurrentUserId();
  if (!userId) redirect(`/${locale}/auth/login`);

  const t = await getTranslations("Customers");
  const tc = await getTranslations("Common");
  const resolved = await resolveScannerContext(userId, b ?? null);
  if (resolved.kind !== "ready") {
    return <EmptyState testId="customers-no-business" title={t("title")} body={t("empty")} />;
  }

  const page = await listCustomers(resolved.context.ctx, { search: q, cursor, limit: 25 });
  const queryFor = (next?: string) => {
    const sp = new URLSearchParams();
    if (q) sp.set("q", q);
    if (next) sp.set("cursor", next);
    if (b) sp.set("b", b);
    const s = sp.toString();
    return s ? `?${s}` : "";
  };

  return (
    <>
      <PageHeader title={t("title")} description={t("subtitle")} />

      <form method="get">
        <Toolbar>
          {b !== undefined && <input type="hidden" name="b" value={b} />}
          <TextInput
            name="q"
            defaultValue={q ?? ""}
            placeholder={t("searchPlaceholder")}
            aria-label={tc("search")}
            data-testid="customers-search"
            className="max-w-sm"
          />
          <button type="submit" className={buttonClass("primary")}>
            {tc("search")}
          </button>
        </Toolbar>
      </form>

      <p className="text-xs text-ink-muted" data-testid="customers-legend">
        {t("balancesLegend")}
      </p>

      {page.items.length === 0 ? (
        <EmptyState testId="customers-empty" title={t("emptyTitle")} body={t("empty")} />
      ) : (
        <Table testId="customers-table">
          <thead>
            <tr>
              <Th>{t("name")}</Th>
              <Th>{t("phone")}</Th>
              <Th className="hidden sm:table-cell">{t("programs")}</Th>
              <Th>{t("stamps")}</Th>
              <Th>{t("points")}</Th>
              <Th>{t("rewards")}</Th>
              <Th className="hidden sm:table-cell">{t("joined")}</Th>
              <Th className="text-end">{tc("actions")}</Th>
            </tr>
          </thead>
          <tbody data-testid="customers-rows">
            {page.items.map((item) => (
              <tr key={item.customerBusinessProfileId} className="transition-colors hover:bg-surface-muted">
                <Td className="font-semibold">{[item.firstName, item.lastName].filter(Boolean).join(" ") || "—"}</Td>
                <Td className="text-ink-muted">
                  {/* A phone number is Latin digits in both locales; `dir="ltr"` keeps the + at the front. */}
                  <span dir="ltr">{item.phone}</span>
                </Td>
                <Td className="hidden tabular-nums text-ink-muted sm:table-cell">{item.cardCount}</Td>
                <Td className="tabular-nums">{item.stampBalance}</Td>
                <Td className="tabular-nums">{item.pointBalance}</Td>
                <Td className="tabular-nums font-semibold text-success-ink">{item.rewardBalance}</Td>
                <Td className="hidden tabular-nums text-ink-muted sm:table-cell">
                  {item.firstSeenAt.toISOString().slice(0, 10)}
                </Td>
                <Td className="text-end">
                  {/* The customer, not one of their cards: a person with two programs is one record. */}
                  <Link
                    href={`/${locale}/business/customers/${item.customerBusinessProfileId}`}
                    className="font-semibold text-accent-ink underline-offset-4 hover:underline"
                  >
                    {t("view")}
                  </Link>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      {page.nextCursor !== null && (
        <Link href={`/${locale}/business/customers${queryFor(page.nextCursor)}`} className={buttonClass("secondary")}>
          {t("loadMore")}
        </Link>
      )}
    </>
  );
}
