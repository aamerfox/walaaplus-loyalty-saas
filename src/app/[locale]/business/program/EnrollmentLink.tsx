"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/routing";

/**
 * The thing the owner actually came for: the link customers open, and the QR they scan.
 *
 * The QR is rendered on the SERVER as inline SVG and passed in as markup. That is deliberate and
 * it is the same rule the customer card follows: this token is a capability, and a QR fetched
 * from an image service would hand it to that service on every render.
 *
 * `dangerouslySetInnerHTML` is reaching for a loaded gun, so: the markup comes from `qrSvg` on
 * the server, which builds SVG from a fixed template around a matrix of light and dark modules.
 * No caller-supplied string reaches the output — the URL goes in as data to be encoded, not as
 * text to be printed.
 */
export default function EnrollmentLink({
  locale,
  enrollmentUrl,
  qrSvgMarkup,
  programName,
  stampsRequiredPerReward,
  rewardName,
  welcomeStamps,
  justCreated,
}: {
  locale: string;
  enrollmentUrl: string;
  qrSvgMarkup: string;
  programName: string;
  stampsRequiredPerReward: number;
  rewardName: string;
  welcomeStamps: number;
  justCreated: boolean;
}) {
  const t = useTranslations("Program");
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(enrollmentUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2500);
    } catch {
      // Clipboard access is refused in plenty of ordinary situations: an insecure origin, a
      // browser that wants a fresher user gesture, a locked-down device. The URL is on screen in
      // a selectable field, so the fallback is to select it and let the person copy it
      // themselves — which is better than a dialog telling them something failed.
      const field = document.getElementById("enrollment-url") as HTMLInputElement | null;
      field?.select();
    }
  }

  return (
    <div className="space-y-6">
      {justCreated && (
        <p
          data-testid="program-created"
          className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm font-medium text-emerald-800 dark:border-emerald-500/20 dark:bg-emerald-500/10 dark:text-emerald-300"
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

        <div className="mt-6 grid gap-6 sm:grid-cols-[auto_1fr] sm:items-start">
          <div
            data-testid="enrollment-qr"
            className="mx-auto w-fit rounded-2xl bg-white p-3 ring-1 ring-zinc-200 dark:ring-zinc-700"
            dangerouslySetInnerHTML={{ __html: qrSvgMarkup }}
          />

          <div className="space-y-3">
            <label htmlFor="enrollment-url" className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">
              {t("linkLabel")}
            </label>
            <input
              id="enrollment-url"
              data-testid="enrollment-url"
              readOnly
              dir="ltr"
              value={enrollmentUrl}
              onFocus={(e) => e.currentTarget.select()}
              className="w-full rounded-xl border border-zinc-300 bg-zinc-50 px-4 py-3 font-mono text-sm text-zinc-900 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
            />
            <button
              type="button"
              onClick={copy}
              data-testid="copy-link"
              className="rounded-xl bg-indigo-600 px-5 py-3 font-bold text-white shadow-sm transition-colors hover:bg-indigo-700"
            >
              {copied ? t("copied") : t("copy")}
            </button>
            <p className="text-xs text-zinc-400">{t("linkHelp")}</p>
          </div>
        </div>
      </section>

      <section className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">{t("nextTitle")}</h2>
        <p className="mt-1 text-sm text-zinc-500">{t("nextHelp")}</p>
        <div className="mt-4 flex flex-wrap gap-3">
          <Link
            href="/business/team"
            locale={locale}
            data-testid="next-cashier"
            className="rounded-xl border border-zinc-300 px-5 py-3 font-medium text-zinc-800 transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"
          >
            {t("nextCashier")}
          </Link>
          <Link
            href="/scanner"
            locale={locale}
            data-testid="next-scanner"
            className="rounded-xl border border-zinc-300 px-5 py-3 font-medium text-zinc-800 transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"
          >
            {t("nextScanner")}
          </Link>
        </div>
      </section>
    </div>
  );
}
