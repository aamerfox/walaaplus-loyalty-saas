"use client";

import { useState } from "react";
import { signOut } from "next-auth/react";
import { useLocale, useTranslations } from "next-intl";
import { LogOut } from "lucide-react";

/**
 * Sign out, for real.
 *
 * The button this replaced had no `onClick`. It looked exactly like this one, sat in the sidebar of
 * every merchant screen, and did nothing — so the only way to end a session on a shared till was to
 * clear cookies, and the person who pressed it walked away believing they were signed out.
 *
 * It lives on the navy rail, so its colours come from that surface rather than from the light
 * palette: white text at rest, a red wash on hover that still passes contrast against navy.
 *
 * `callbackUrl` is locale-aware so an Arabic user lands on the Arabic sign-in page rather than being
 * bounced through the default locale.
 */
export default function SignOutButton() {
  const t = useTranslations("Navigation");
  const locale = useLocale();
  const [busy, setBusy] = useState(false);

  return (
    <button
      type="button"
      disabled={busy}
      data-testid="sign-out"
      onClick={() => {
        setBusy(true);
        void signOut({ callbackUrl: `/${locale}/auth/login` });
      }}
      className="flex w-full items-center gap-3 rounded-xl px-4 py-3 text-sm font-semibold text-white/70 transition-colors hover:bg-white/10 hover:text-white disabled:opacity-60"
    >
      <LogOut className="size-5 shrink-0" aria-hidden="true" />
      <span>{busy ? t("signingOut") : t("logout")}</span>
    </button>
  );
}
