import type { Metadata, Viewport } from "next";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import { getPublicCardView } from "@/server/customers/card-view";
import { isAppError } from "@/server/errors";
import { qrSvg } from "@/server/qr";
import CardPwa from "./CardPwa";

/**
 * The customer's card. Public, opened by whoever holds the link.
 *
 * This page is the product for the customer, and it is also the most exposed surface in it, so
 * what it does NOT do matters as much as what it shows:
 *
 *  - it never redirects to a merchant login (PRODUCT-SPEC §6.3);
 *  - it renders no internal identifier of any kind — the only opaque values on the page are this
 *    card's own page token, already in the URL, and its own scanner token, which is the QR the
 *    holder is meant to show;
 *  - it offers no action. Awards, redemptions and reversals are staff operations behind a session.
 *
 * `getPublicCardView` is keyed on the PAGE token, not the scanner token, so a cashier who has
 * scanned a QR still cannot open the customer's card page from it.
 */

export async function generateMetadata({ params }: { params: Promise<{ shareToken: string }> }): Promise<Metadata> {
  const { shareToken } = await params;
  try {
    const view = await getPublicCardView(shareToken);
    return {
      title: `${view.businessName} — ${view.programName}`,
      // Per-card manifest: a customer holding three cards needs three home-screen icons, which
      // means three manifests with three ids (PRODUCT-SPEC §6.2).
      manifest: `./${shareToken}/manifest.webmanifest`,
      // A loyalty card is not content to index, and its URL is a capability.
      robots: { index: false, follow: false },
    };
  } catch {
    return { title: "—", robots: { index: false, follow: false } };
  }
}

/**
 * The installed card's theme colour: the tint an installed PWA paints its status bar and task
 * switcher entry with. It belongs in `viewport`, not `metadata` - Next reads it from here, warns
 * about it there, and a value it warns about is a value it does not apply. Same indigo as the
 * manifest's `theme_color`; the two disagreeing is visible on an installed card.
 */
export const viewport: Viewport = {
  themeColor: "#4f46e5",
};

export default async function CardPage({ params }: { params: Promise<{ locale: string; shareToken: string }> }) {
  const { locale, shareToken } = await params;

  let view;
  try {
    view = await getPublicCardView(shareToken);
  } catch (e) {
    if (isAppError(e)) notFound();
    throw e;
  }

  const t = await getTranslations("Card");
  const qr = qrSvg(view.qrToken, { cellSize: 6, margin: 4 });
  const filled = view.stampBalance % view.stampsRequiredPerReward;
  const cells = Array.from({ length: view.stampsRequiredPerReward }, (_, i) => i < filled);

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
            className="rounded-2xl bg-amber-500/10 px-4 py-3 text-center text-sm font-medium text-amber-300"
          >
            {view.expired ? t("statusExpired") : t("statusPaused")}
          </p>
        )}

        <section className="rounded-3xl bg-zinc-900 p-6 shadow-xl ring-1 ring-white/5">
          <div className="mb-4 flex items-baseline justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-400">{t("stampsTitle")}</h2>
            <span data-testid="card-progress" className="text-sm font-bold text-zinc-200">
              {t("progress", { current: filled, required: view.stampsRequiredPerReward })}
            </span>
          </div>

          {/* One cell per stamp the program requires: a paper card, drawn. */}
          <ul className="grid grid-cols-5 gap-2" aria-label={t("stampsTitle")}>
            {cells.map((isFilled, index) => (
              <li
                key={index}
                data-filled={isFilled}
                className={
                  isFilled
                    ? "flex aspect-square items-center justify-center rounded-full bg-indigo-500 text-white shadow-inner"
                    : "flex aspect-square items-center justify-center rounded-full border-2 border-dashed border-zinc-700 text-zinc-700"
                }
              >
                <span aria-hidden="true" className="text-lg font-bold">
                  {isFilled ? "★" : ""}
                </span>
              </li>
            ))}
          </ul>

          <p className="mt-4 text-center text-sm text-zinc-400">
            {view.rewardBalance > 0
              ? view.rewardBalance === 1
                ? t("rewardReady")
                : t("rewardReadyCount", { count: view.rewardBalance })
              : t("toNextReward", { count: view.stampsToNextReward })}
          </p>

          {view.rewardBalance > 0 && (
            <p
              data-testid="card-reward-ready"
              className="mt-3 rounded-xl bg-emerald-500/10 px-3 py-2 text-center text-sm font-bold text-emerald-300"
            >
              {view.rewardName}
            </p>
          )}
        </section>

        <section className="rounded-3xl bg-white p-6 text-center shadow-xl">
          <p className="mb-3 text-sm font-medium text-zinc-600">{t("showQr")}</p>
          {/* Inline SVG: no third party ever sees this token, and no network request is needed. */}
          <div
            data-testid="card-qr"
            className="mx-auto w-full max-w-[220px] [&>svg]:h-auto [&>svg]:w-full"
            dangerouslySetInnerHTML={{ __html: qr }}
          />
          <p className="mt-3 font-mono text-xs tracking-wider text-zinc-500">
            {t("serial")}: {view.serialNumber}
          </p>
        </section>

        <CardPwa locale={locale} shareToken={shareToken} />

        <p className="pb-6 text-center text-xs text-zinc-500">{t("poweredBy", { business: view.businessName })}</p>
      </div>
    </main>
  );
}
