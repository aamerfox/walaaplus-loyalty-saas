import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import { getEnrollmentSourceView } from "@/server/customers/enrollment";
import { isAppError } from "@/server/errors";
import JoinForm from "./JoinForm";

/**
 * Public enrollment page — the first thing a customer of a café ever sees.
 *
 * No session, no merchant login, and no redirect to one (PRODUCT-SPEC §6.1). The opaque token in
 * the URL is the only input; the business, program and offer are all derived from it server-side.
 *
 * What renders here is deliberately the minimum needed to decide to join: the business name, the
 * program name, the offer and any welcome bonus. No ids, no tokens beyond the one already in the
 * URL, no staff, no customers, no configuration. A dead or foreign link renders the same 404 as a
 * link that never existed, so a stale QR cannot be used to probe a business.
 */
export default async function JoinPage({ params }: { params: Promise<{ locale: string; token: string }> }) {
  const { token } = await params;

  let view;
  try {
    view = await getEnrollmentSourceView(token);
  } catch (e) {
    // NotFound, an inactive link, an archived program: all the same answer.
    if (isAppError(e)) notFound();
    throw e;
  }

  const t = await getTranslations("Join");

  return (
    <main className="min-h-screen bg-gradient-to-b from-indigo-50 to-white px-4 py-10 dark:from-zinc-950 dark:to-zinc-900">
      <div className="mx-auto w-full max-w-md">
        <header className="mb-8 text-center">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-indigo-600 text-2xl font-bold text-white shadow-lg">
            {view.businessName.slice(0, 1)}
          </div>
          <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-50">{t("title")}</h1>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            {t("subtitle", { business: view.businessName, program: view.templateName })}
          </p>
        </header>

        <section className="mb-6 rounded-2xl border border-indigo-100 bg-white p-5 text-center shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
          <p className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
            {t("rewardLine", { required: view.stampsRequiredPerReward, reward: view.rewardName })}
          </p>
          {view.rewardDescription !== null && (
            <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">{view.rewardDescription}</p>
          )}
          {view.welcomeStamps > 0 && (
            <p className="mt-3 rounded-xl bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400">
              {t("welcomeLine", { count: view.welcomeStamps })}
            </p>
          )}
        </section>

        <JoinForm sourceToken={token} />

        <p className="mt-6 text-center text-xs text-zinc-400">{t("privacyNote")}</p>
      </div>
    </main>
  );
}
