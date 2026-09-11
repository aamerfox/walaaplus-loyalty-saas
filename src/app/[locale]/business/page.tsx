import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";
import { getCurrentUserId } from "@/server/auth/session";
import { listUserBusinesses } from "@/server/tenant/memberships";

/**
 * Phase 0 shell page: lists the businesses the signed-in user belongs to, resolved from the
 * database on this request. It exists to exercise the auth → membership path end to end.
 * Real dashboard metrics arrive in Phase 1b, backed by the ledger.
 */
export default async function BusinessHome({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const userId = await getCurrentUserId();
  if (!userId) redirect(`/${locale}/auth/login`);

  const t = await getTranslations("BusinessHome");
  const memberships = await listUserBusinesses(userId);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-zinc-900 dark:text-zinc-100">{t("title")}</h1>
        <p className="mt-1 text-zinc-500 dark:text-zinc-400">{t("subtitle")}</p>
      </div>

      {memberships.length === 0 ? (
        <p className="rounded-2xl border border-zinc-200 bg-white p-6 text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900">
          {t("empty")}
        </p>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {memberships.map((m) => (
            <li
              key={m.id}
              className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900"
            >
              <div className="text-lg font-bold text-zinc-900 dark:text-zinc-100">{m.business.name}</div>
              <div className="mt-2 flex items-center gap-2 text-sm text-zinc-500">
                <span className="rounded-full bg-indigo-50 px-2 py-0.5 text-xs font-bold text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-400">
                  {t(`role.${m.role}`)}
                </span>
                <span>{m.business.currency}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
