"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";

/**
 * PWA installation for one card.
 *
 * Scope is the point. A customer holding cards from three cafés needs three home-screen icons, so
 * each card registers the service worker under ITS OWN path (PRODUCT-SPEC §6.2). One root-scoped
 * worker would give the browser a single registration, a single push subscription and one shared
 * cache for every card — which is why the script lives at `/sw.js` but is always registered with
 * this card's path as the scope.
 *
 * What this component does NOT do, deliberately: it caches no card data, claims no offline
 * support, requests no notification permission, and reports no installation. Offline card state,
 * web push and install telemetry are Phase 1.5. The `beforeinstallprompt` handler here only
 * surfaces the browser's own prompt on Android; iOS Safari has no such event, so the instructions
 * below are the only path there and are shown to everyone.
 */

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export default function CardPwa({ locale, shareToken }: { locale: string; shareToken: string }) {
  const t = useTranslations("Card");
  const [installEvent, setInstallEvent] = useState<BeforeInstallPromptEvent | null>(null);

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    /*
     * The trailing slash matters. Service-worker scope is matched as a STRING PREFIX, not by path
     * segment, so a scope of `/en/card/ABC` would also control `/en/card/ABCDEF`. Today no token
     * can prefix another because every share token is exactly 32 characters — but that is an
     * invariant of the token generator holding up a security property two files away, which is
     * not a load a constant should carry. With the slash the property is true of any token.
     */
    const scope = `/${locale}/card/${shareToken}/`;
    // Registration failures are not worth interrupting a customer over: the card is a normal page
    // and works without a worker. Installability is the only thing lost.
    void navigator.serviceWorker.register("/sw.js", { scope }).catch(() => undefined);
  }, [locale, shareToken]);

  useEffect(() => {
    const onPrompt = (event: Event) => {
      event.preventDefault(); // keep the browser's own banner from firing; we place the button
      setInstallEvent(event as BeforeInstallPromptEvent);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    return () => window.removeEventListener("beforeinstallprompt", onPrompt);
  }, []);

  return (
    <section data-testid="card-install" className="rounded-3xl bg-zinc-900 p-5 text-center ring-1 ring-white/5">
      <h2 className="text-sm font-semibold text-zinc-200">{t("installTitle")}</h2>

      {installEvent !== null && (
        <button
          type="button"
          onClick={() => {
            void installEvent.prompt();
            setInstallEvent(null);
          }}
          className="mt-3 w-full rounded-xl bg-navy-900 py-3 font-bold text-white transition-colors hover:bg-navy-800"
        >
          {t("installButton")}
        </button>
      )}

      {/*
        Both sets of instructions, always. Sniffing the user agent to pick one gets it wrong on
        in-app browsers, which is where a lot of Syrian traffic actually arrives from.
      */}
      <ul className="mt-3 space-y-1 text-start text-xs leading-relaxed text-zinc-400">
        <li>{t("installAndroid")}</li>
        <li>{t("installIos")}</li>
      </ul>
    </section>
  );
}
