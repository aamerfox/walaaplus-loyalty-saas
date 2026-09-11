import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";
import Link from "next/link";
import { getCurrentUserId } from "@/server/auth/session";
import { listCustomers } from "@/server/customers/lookup";
import { resolveScannerContext } from "@/server/tenant/scanner-context";

/**
 * The owner's customer list.
 *
 * Everything on this page comes from `listCustomers`, which filters by the resolved business and
 * refuses a cashier outright — their `VIEW_CUSTOMERS` covers the person at the counter, not the
 * directory. The page does not query Prisma itself, so the tenant filter cannot be forgotten here.
 *
 * Search accepts a name or a phone number; the service normalises a phone before matching, so a
 * customer found by `0944…` and by `+963 944…` is the same row.
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
    return <p className="text-zinc-500">{t("empty")}</p>;
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
    <div className="space-y-6">
      <header>
        <h1 className="text-3xl font-bold tracking-tight text-zinc-900 dark:text-zinc-100">{t("title")}</h1>
        <p className="mt-1 text-zinc-500 dark:text-zinc-400">{t("subtitle")}</p>
      </header>

      {/* A plain GET form: the query lives in the URL, so a search is shareable and back works. */}
      <form method="get" className="flex gap-2">
        {b !== undefined && <input type="hidden" name="b" value={b} />}
        <input
          name="q"
          defaultValue={q ?? ""}
          placeholder={t("searchPlaceholder")}
          aria-label={tc("search")}
          data-testid="customers-search"
          className="w-full max-w-sm rounded-xl border border-zinc-300 px-4 py-2 text-zinc-900 outline-none focus:border-indigo-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
        />
        <button type="submit" className="rounded-xl bg-indigo-600 px-5 py-2 font-semibold text-white">
          {tc("search")}
        </button>
      </form>

      {page.items.length === 0 ? (
        <p data-testid="customers-empty" className="rounded-2xl border border-zinc-200 bg-white p-6 text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900">
          {t("empty")}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
          <table className="w-full text-start text-sm">
            <thead className="border-b border-zinc-200 text-xs uppercase tracking-wide text-zinc-500 dark:border-zinc-800">
              <tr>
                <th className="px-4 py-3 text-start">{t("name")}</th>
                <th className="px-4 py-3 text-start">{t("phone")}</th>
                <th className="px-4 py-3 text-start">{t("stamps")}</th>
                <th className="px-4 py-3 text-start">{t("rewards")}</th>
                <th className="px-4 py-3 text-start">{t("joined")}</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody data-testid="customers-rows">
              {page.items.map((item) => (
                <tr key={item.customerBusinessProfileId} className="border-b border-zinc-100 last:border-0 dark:border-zinc-800/60">
                  <td className="px-4 py-3 font-medium text-zinc-900 dark:text-zinc-100">
                    {[item.firstName, item.lastName].filter(Boolean).join(" ") || "—"}
                  </td>
                  <td className="px-4 py-3 text-zinc-500" dir="ltr">
                    {item.phone}
                  </td>
                  <td className="px-4 py-3 text-zinc-700 dark:text-zinc-300">{item.stampBalance}</td>
                  <td className="px-4 py-3 text-emerald-600 dark:text-emerald-400">{item.rewardBalance}</td>
                  <td className="px-4 py-3 text-zinc-500">{item.firstSeenAt.toISOString().slice(0, 10)}</td>
                  <td className="px-4 py-3 text-end">
                    {item.customerCardId !== null && (
                      <Link
                        href={`/${locale}/business/customers/${item.customerCardId}`}
                        className="font-semibold text-indigo-600 hover:underline dark:text-indigo-400"
                      >
                        {t("view")}
                      </Link>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {page.nextCursor !== null && (
        <Link href={`/${locale}/business/customers${queryFor(page.nextCursor)}`} className="inline-block font-semibold text-indigo-600">
          {t("loadMore")}
        </Link>
      )}
    </div>
  );
}
