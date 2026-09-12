"use client";

import { useState } from "react";
import { Globe, Menu, X } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useRouter, usePathname } from "@/i18n/routing";
import Sidebar from "./Sidebar";

/**
 * The top bar: who you are acting as, which language, and — on a phone — the way into the menu.
 *
 * What it deliberately no longer contains: a search box that searched nothing, a notification bell
 * with a permanent unread dot, and an avatar showing the initials "BO" for every user alive. Each
 * was a promise the product could not keep, and the bell's red dot was a promise it re-made on
 * every page load. Customer search exists and has its own screen; notifications arrive with push in
 * Phase 1.5.
 *
 * The business name comes from the server, from the membership resolved for this request — not from
 * the session token, which says who someone is and never what they may do.
 */
export default function Header({ businessName, userInitials }: { businessName: string; userInitials: string }) {
  const t = useTranslations("Navigation");
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);

  const toggleLanguage = () => router.replace(pathname, { locale: locale === "en" ? "ar" : "en" });

  return (
    <>
      <header className="sticky top-0 z-20 flex h-16 shrink-0 items-center gap-3 border-b border-border bg-surface/90 px-4 backdrop-blur-md sm:h-20 sm:px-6">
        <button
          type="button"
          onClick={() => setMenuOpen(true)}
          data-testid="open-menu"
          aria-label={t("openMenu")}
          className="rounded-xl p-2 text-ink-muted hover:bg-surface-muted lg:hidden"
        >
          <Menu className="size-6" aria-hidden="true" />
        </button>

        <div className="min-w-0 flex-1">
          <p className="truncate font-display text-base font-bold text-ink sm:text-lg" data-testid="current-business">
            {businessName}
          </p>
        </div>

        <button
          type="button"
          onClick={toggleLanguage}
          data-testid="toggle-locale"
          // The label names the destination language, not the current one: "AR" alone leaves the
          // user guessing whether it is a state or a switch.
          aria-label={locale === "en" ? t("switchToArabic") : t("switchToEnglish")}
          className="flex items-center gap-2 rounded-xl border border-border px-3 py-2 text-sm font-semibold text-ink-muted transition-colors hover:bg-surface-muted hover:text-ink"
        >
          <Globe className="size-4" aria-hidden="true" />
          <span aria-hidden="true">{locale === "en" ? "AR" : "EN"}</span>
        </button>

        <span
          aria-hidden="true"
          className="flex size-10 items-center justify-center rounded-full bg-navy-50 font-semibold text-navy-900 dark:bg-navy-800 dark:text-white"
        >
          {userInitials}
        </span>
      </header>

      {/* The phone menu: the same navigation, not a reduced one. */}
      {menuOpen ? (
        <div className="fixed inset-0 z-40 lg:hidden">
          <button
            type="button"
            aria-label={t("closeMenu")}
            onClick={() => setMenuOpen(false)}
            className="absolute inset-0 bg-navy-950/50"
          />
          <div className="absolute inset-y-0 start-0 flex w-72 max-w-[85vw] flex-col bg-surface shadow-xl">
            <div className="flex justify-end p-2">
              <button
                type="button"
                onClick={() => setMenuOpen(false)}
                data-testid="close-menu"
                aria-label={t("closeMenu")}
                className="rounded-xl p-2 text-ink-muted hover:bg-surface-muted"
              >
                <X className="size-6" aria-hidden="true" />
              </button>
            </div>
            <Sidebar onNavigate={() => setMenuOpen(false)} />
          </div>
        </div>
      ) : null}
    </>
  );
}
