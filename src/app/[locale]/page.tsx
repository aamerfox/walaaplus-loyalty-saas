import { getTranslations } from "next-intl/server";
import { CreditCard, MapPin, ScanLine } from "lucide-react";
import { Link } from "@/i18n/routing";
import { Wordmark } from "@/components/brand/Wordmark";
import { buttonClass, Card } from "@/components/ui";

/**
 * The public landing page.
 *
 * ## What was wrong with it
 *
 * It was the clearest evidence for the owner's verdict. A navy-to-crimson gradient headline, black
 * pill buttons, three feature tiles in blue, fuchsia and green, and a grey skeleton pretending to be
 * a dashboard: a page from a different product with a Zademi logo on it.
 *
 * Two things beyond the colours were wrong, and both are fixed here:
 *
 *  - **Every string was an inline `locale === 'ar' ? … : …` ternary**, which is the one thing this
 *    project's i18n rule forbids — Arabic written inside a component is Arabic nobody can review,
 *    and it is why the page read as an English page with Arabic pasted in.
 *  - **It advertised Apple Wallet, Google Pay, white-label agencies and push automations.** None of
 *    them exists. They are scheduled — 1.5, 3b, 4 — and a landing page is not the place to promise
 *    a merchant something the counter cannot do. The three cards now describe what Zademi does
 *    today, which is also a stronger page: stamp and points cards, a counter that works on a phone,
 *    and several branches.
 *
 * Rendered on the server: it has no state, and a marketing page that ships a client bundle to say
 * three sentences is paying for nothing.
 */
export default async function LandingPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const t = await getTranslations("Landing");

  const features = [
    { icon: CreditCard, title: t("featureCardsTitle"), body: t("featureCardsBody") },
    { icon: ScanLine, title: t("featureCounterTitle"), body: t("featureCounterBody") },
    { icon: MapPin, title: t("featureLocationsTitle"), body: t("featureLocationsBody") },
  ];

  return (
    <div className="min-h-screen bg-app">
      <nav className="sticky top-0 z-50 border-b border-border bg-surface/90 backdrop-blur-md">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-4 px-4 sm:h-20 sm:px-6">
          <Link href="/" aria-label="Zademi" className="inline-flex">
            <Wordmark height={28} className="h-7 w-auto" />
          </Link>

          <div className="hidden flex-1 items-center justify-center gap-8 text-sm font-semibold text-ink-muted md:flex">
            <Link href="/pricing" className="transition-colors hover:text-ink">
              {t("navPricing")}
            </Link>
          </div>

          <div className="ms-auto flex items-center gap-2 md:ms-0">
            {/* Below `sm` the bar holds the mark, one action and the language. Three controls and a
                logo do not fit a 390px phone without the primary action wrapping onto two lines. */}
            <div className="hidden sm:block">
              <Link href="/auth/login" className={buttonClass("ghost", "sm")}>
                {t("navLogin")}
              </Link>
            </div>
            <Link href="/auth/register" className={buttonClass("primary", "sm")}>
              {t("ctaStart")}
            </Link>
            {/* A language switch, not a flag: the label is the destination language. */}
            <Link
              href="/"
              locale={locale === "ar" ? "en" : "ar"}
              aria-label={locale === "ar" ? t("switchToEnglish") : t("switchToArabic")}
              className="flex size-9 items-center justify-center rounded-xl border border-border text-sm font-bold text-ink-muted transition-colors hover:bg-surface-muted hover:text-ink"
            >
              <span aria-hidden="true">{locale === "ar" ? "EN" : "ع"}</span>
            </Link>
          </div>
        </div>
      </nav>

      {/*
       * The hero is navy, because navy is the brand's structural colour and this is the first
       * surface anyone sees. The accent is one turquoise wash, not a gradient across two hues.
       */}
      <header className="relative overflow-hidden bg-navy-900 text-white">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -top-40 end-[-10%] size-[34rem] rounded-full bg-turquoise-500/20 blur-3xl"
        />
        <div className="relative mx-auto max-w-4xl px-4 py-20 text-center sm:px-6 sm:py-28">
          <p className="mb-6 inline-flex items-center gap-2 rounded-full border border-white/20 px-4 py-1.5 text-xs font-bold uppercase tracking-widest text-turquoise-200">
            <span aria-hidden="true" className="size-1.5 rounded-full bg-mint-500" />
            {t("badge")}
          </p>

          <h1 className="font-display text-4xl font-extrabold leading-[1.15] tracking-tight sm:text-6xl">
            {t("heroTitle")}
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-lg leading-relaxed text-white/75">{t("heroSubtitle")}</p>

          <div className="mt-10 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Link href="/auth/register" className={buttonClass("accent", "lg")}>
              {t("ctaStart")}
            </Link>
            <Link
              href="/pricing"
              className="inline-flex h-12 items-center justify-center rounded-xl border border-white/25 px-6 font-bold text-white transition-colors hover:bg-white/10"
            >
              {t("ctaPricing")}
            </Link>
          </div>

        </div>
      </header>

      <section id="features" className="mx-auto max-w-6xl px-4 py-16 sm:px-6 sm:py-24">
        <div className="grid gap-5 md:grid-cols-3">
          {features.map(({ icon: Icon, title, body }) => (
            <Card key={title} className="space-y-3">
              <span className="inline-flex size-12 items-center justify-center rounded-2xl bg-turquoise-50 text-turquoise-700 dark:bg-navy-800 dark:text-turquoise-200">
                <Icon className="size-6" aria-hidden="true" />
              </span>
              <h2 className="font-display text-lg font-bold text-ink">{title}</h2>
              <p className="leading-relaxed text-ink-muted">{body}</p>
            </Card>
          ))}
        </div>
      </section>

      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-6xl flex-col items-center gap-3 px-4 py-10 text-sm text-ink-muted sm:flex-row sm:justify-between sm:px-6">
          <Wordmark height={22} className="h-[22px] w-auto" />
          <p>{t("footer")}</p>
        </div>
      </footer>
    </div>
  );
}
