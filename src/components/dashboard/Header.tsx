"use client";

import { useState } from "react";
import { Globe, Menu, X } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useRouter, usePathname } from "@/i18n/routing";
import { Wordmark } from "@/components/brand/Wordmark";
import BusinessContext from "./BusinessContext";
import Sidebar from "./Sidebar";

/**
 * The top bar: the way into the menu, which account you are acting for, and the language.
 *
 * ## What it is NOT
 *
 * It is not where the product is named — the navy rail beside it carries the wordmark, and on a
 * phone the drawer does. It used to print the tenant's name here at heading size next to a
 * standalone symbol, which made a shop called TrueBiznes look like the platform and turned the logo
 * into a fragment of itself. Both are gone.
 *
 * It also no longer contains a search box that searched nothing, a notification bell with a
 * permanent unread dot, or an avatar reading "BO" for every user alive. Each was a promise the
 * product could not keep.
 *
 * ## The phone drawer
 *
 * The same navy navigation, opened from the leading edge — `start-0`, so it slides from the right in
 * Arabic without a second layout being written for it — with the full wordmark at its head. Brand
 * recognition at phone width comes from the real lockup, not from a symbol standing in for one.
 */
export default function Header({ businesses }: { businesses: { id: string; name: string }[] }) {
  const t = useTranslations("Navigation");
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);

  const toggleLanguage = () => router.replace(pathname, { locale: locale === "en" ? "ar" : "en" });

  return (
    <>
      <header className="sticky top-0 z-20 flex h-16 shrink-0 items-center gap-3 border-b border-border bg-surface/95 px-4 backdrop-blur-md sm:px-6 lg:h-[72px]">
        <button
          type="button"
          onClick={() => setMenuOpen(true)}
          data-testid="open-menu"
          aria-label={t("openMenu")}
          aria-expanded={menuOpen}
          className="-ms-2 rounded-xl p-2.5 text-ink-muted transition-colors hover:bg-surface-muted hover:text-ink lg:hidden"
        >
          <Menu className="size-6" aria-hidden="true" />
        </button>

        <div className="flex-1" />

        <BusinessContext businesses={businesses} />

        <button
          type="button"
          onClick={toggleLanguage}
          data-testid="toggle-locale"
          // The label names the destination language, not the current one: "AR" alone leaves the
          // user guessing whether it is a state or a switch.
          aria-label={locale === "en" ? t("switchToArabic") : t("switchToEnglish")}
          className="flex h-10 items-center gap-2 rounded-xl border border-border px-3 text-sm font-semibold text-ink-muted transition-colors hover:bg-surface-muted hover:text-ink"
        >
          <Globe className="size-4" aria-hidden="true" />
          <span aria-hidden="true">{locale === "en" ? "AR" : "EN"}</span>
        </button>
      </header>

      {menuOpen ? (
        <div className="fixed inset-0 z-40 lg:hidden">
          <button
            type="button"
            aria-label={t("closeMenu")}
            onClick={() => setMenuOpen(false)}
            className="absolute inset-0 bg-navy-950/60"
          />
          <div className="absolute inset-y-0 start-0 flex w-72 max-w-[85vw] flex-col bg-navy-900 shadow-2xl">
            <div className="flex items-center justify-between px-5 pt-5">
              <Wordmark tone="white" height={26} className="h-[26px] w-auto" />
              <button
                type="button"
                onClick={() => setMenuOpen(false)}
                data-testid="close-menu"
                aria-label={t("closeMenu")}
                className="rounded-xl p-2 text-white/70 transition-colors hover:bg-white/10 hover:text-white"
              >
                <X className="size-6" aria-hidden="true" />
              </button>
            </div>
            {/* The rail itself, minus its own header: one navigation, not a phone-shaped copy. */}
            <div className="flex-1 overflow-hidden [&>aside>div:first-child]:hidden">
              <Sidebar onNavigate={() => setMenuOpen(false)} />
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
