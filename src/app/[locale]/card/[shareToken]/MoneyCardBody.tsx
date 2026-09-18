import { getTranslations } from "next-intl/server";
import { qrSvg } from "@/server/qr";
import type { PublicMoneyCardView } from "@/server/customers/card-view";

/**
 * The customer's view of a cashback or discount card.
 *
 * The stamp card draws a paper card; this one has a single number on it, so the page is that number
 * and the sentence that makes it safe to read.
 *
 * **What this page must never imply.** A cashback balance is spendable against a future bill at this
 * business's counter, and nowhere else. It is not money the customer can withdraw, not a claim on the
 * business for cash, not a bank balance, and not a payment instrument. `balanceMeaning` says so in
 * both languages, next to the figure rather than in a footer, because this is the one screen a
 * customer reads on their own with nobody to ask.
 *
 * No action is offered, exactly as on the stamp card: earning, redeeming and reversing are staff
 * operations behind a session. The QR is the holder's own scanner token — the same one the stamp card
 * shows — and remains the only opaque value on the page besides the share token already in the URL.
 */
export default async function MoneyCardBody({ view }: { view: PublicMoneyCardView }) {
  const t = await getTranslations("MoneyCard");
  const qr = qrSvg(view.qrToken, { cellSize: 6, margin: 4 });

  return (
    <main className="min-h-screen bg-zinc-950 px-4 py-8 text-zinc-100">
      <div className="mx-auto w-full max-w-sm space-y-6">
        <header className="text-center">
          <h1 className="text-xl font-bold">{view.businessName}</h1>
          <p className="text-sm text-zinc-400">{view.programName}</p>
          {view.customerFirstName !== null && <p className="mt-2 text-sm text-zinc-300">{view.customerFirstName}</p>}
        </header>

        {!view.active && (
          <p
            role="status"
            data-testid="card-inactive"
            className="rounded-2xl bg-amber-500/10 px-4 py-3 text-center text-sm font-medium text-warn-ink"
          >
            {view.expired ? t("statusExpired") : t("statusPaused")}
          </p>
        )}

        <section className="rounded-3xl bg-zinc-900 p-6 text-center shadow-xl ring-1 ring-white/5">
          {view.cardType === "CASHBACK" ? (
            <>
              <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-400">{t("balanceTitle")}</h2>
              {/* The figure, and immediately under it what it is. Never separated. */}
              <p data-testid="card-balance" className="mt-2 text-4xl font-bold tabular-nums">
                {view.displayBalance} <span className="text-2xl font-medium text-zinc-400">{view.currency}</span>
              </p>
              <p className="mt-3 text-sm text-zinc-400">{t("balanceMeaning", { business: view.businessName })}</p>
            </>
          ) : (
            <>
              <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-400">{t("discountTitle")}</h2>
              <p data-testid="card-rate" className="mt-2 text-4xl font-bold tabular-nums">
                {formatRate(view.nextRateBasisPoints)}%
              </p>
              <p className="mt-3 text-sm text-zinc-400">{t("discountMeaning", { business: view.businessName })}</p>
            </>
          )}
        </section>

        {view.cardType === "CASHBACK" && (
          <section className="rounded-3xl bg-zinc-900 p-6 text-center shadow-xl ring-1 ring-white/5">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-400">{t("rateTitle")}</h2>
            <p data-testid="card-rate" className="mt-2 text-2xl font-bold tabular-nums">
              {formatRate(view.nextRateBasisPoints)}%
            </p>
            <p className="mt-2 text-sm text-zinc-400">{t("rateMeaning")}</p>
          </section>
        )}

        <section className="rounded-3xl bg-white p-6 text-center shadow-xl">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-zinc-500">{t("showThis")}</h2>
          <div className="mx-auto w-48" dangerouslySetInnerHTML={{ __html: qr }} />
          <p className="mt-3 font-mono text-xs text-zinc-500">{view.serialNumber}</p>
        </section>

        <p className="text-center text-xs text-zinc-500">{t("notAnAccount")}</p>
      </div>
    </main>
  );
}

/** Basis points as a percentage, by string. `750` is `7.5`. */
function formatRate(bp: number): string {
  const abs = Math.abs(bp).toString().padStart(3, "0");
  const whole = abs.slice(0, abs.length - 2);
  const fraction = abs.slice(abs.length - 2).replace(/0+$/, "");
  return `${whole}${fraction ? `.${fraction}` : ""}`;
}
