"use client";

import { useTranslations } from "next-intl";
import { Link } from "@/i18n/routing";

/**
 * The owner's loyalty card, once it exists.
 *
 * This panel used to publish the card's public enrolment link and a QR to print for the counter.
 * Owner decision **B7, option 3** withdrew public self-service enrolment, so there is no link to
 * publish: a public form that issued a card to a number that had never enrolled, and nothing to a
 * number that had, told whoever submitted a number which case they hit — and only proof that the
 * submitter owns the number closes that, which Phase 1a has no channel to obtain.
 *
 * What replaces it is a sentence telling the owner where enrolment now happens, and a way to get
 * there. Deleting the QR without saying where it went would leave an owner hunting for a feature
 * that used to be on this screen.
 */
export default function ProgramSummary({
  locale,
  programName,
  stampsRequiredPerReward,
  rewardName,
  welcomeStamps,
  justCreated,
}: {
  locale: string;
  programName: string;
  stampsRequiredPerReward: number;
  rewardName: string;
  welcomeStamps: number;
  justCreated: boolean;
}) {
  const t = useTranslations("Program");

  return (
    <div className="space-y-6">
      {justCreated && (
        <p
          data-testid="program-created"
          className="rounded-2xl border border-mint-500 bg-success-bg p-4 text-sm font-medium text-success-ink dark:border-mint-500/20 dark:bg-mint-500/10 dark:text-success-ink"
        >
          {t("created")}
        </p>
      )}

      <section className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">{programName}</h2>
        <p className="mt-1 text-sm text-zinc-500" data-testid="program-summary">
          {t("summary", { stamps: stampsRequiredPerReward, reward: rewardName })}
          {welcomeStamps > 0 ? ` · ${t("welcomeSummary", { count: welcomeStamps })}` : ""}
        </p>
      </section>

      <section
        data-testid="enrollment-guidance"
        className="rounded-2xl border border-navy-200 bg-navy-50 p-6 dark:border-navy-200/20 dark:bg-navy-800/10"
      >
        <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">{t("howToEnrollTitle")}</h2>
        <p className="mt-2 text-sm text-zinc-700 dark:text-zinc-300">{t("howToEnrollBody")}</p>
        <p className="mt-2 text-xs text-zinc-500">{t("howToEnrollWhy")}</p>
        <div className="mt-4 flex flex-wrap gap-3">
          <Link
            href="/scanner"
            locale={locale}
            data-testid="next-scanner"
            className="rounded-xl bg-navy-900 px-5 py-3 font-bold text-white shadow-sm transition-colors hover:bg-navy-800"
          >
            {t("nextScanner")}
          </Link>
          <Link
            href="/business/team"
            locale={locale}
            data-testid="next-cashier"
            className="rounded-xl border border-zinc-300 px-5 py-3 font-medium text-zinc-800 transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"
          >
            {t("nextCashier")}
          </Link>
        </div>
      </section>
    </div>
  );
}
