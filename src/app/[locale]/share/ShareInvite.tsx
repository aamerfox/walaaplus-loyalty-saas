"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import qrcode from "qrcode-generator";

/**
 * The invitation page's whole behaviour, in the browser.
 *
 * ## Why this is a client component at all
 *
 * The capability is in the URL **fragment**, and a fragment is never sent to a server. That is the
 * design, not a limitation: the token appears in no access log, no proxy log, no `Referer` header
 * and no error report, on this server or on any server the visitor navigates to afterwards. The
 * cost is that the page cannot be rendered on the server, because the server does not know which
 * link was opened. Worth it.
 *
 * So: read `location.hash`, post it to `/api/share/resolve` in a body, render what comes back.
 *
 * ## What never appears here
 *
 * No customer name, no phone, no card number, no serial, no balance, no programme, no card link,
 * no scanner QR. The QR on this page encodes **this page's own URL** — the thing a visitor is meant
 * to hand to a friend — and the only value that reaches the DOM besides it is the business name.
 *
 * ## What it does not promise
 *
 * Nothing about rewards. No referral policy exists — who would earn what, when, and within what
 * limits is an open decision (D15) — so the copy says "invite your friends" and "share the link",
 * which is what actually happens. A wallet pass is the one surface a customer cannot re-read a
 * correction on, and the page it opens should not be the place a promise is invented either.
 *
 * ## Failure is one shape
 *
 * Unknown, revoked, malformed, missing: the same generic notice. It confirms no card, no customer
 * and no business, because the difference between "never existed" and "was revoked" is the only
 * thing worth probing for and a visitor has no use for it.
 */

/** Rendered as the QR and copied by the copy button: the page's own address, fragment included. */
function currentUrl(): string {
  return typeof window === "undefined" ? "" : window.location.href;
}

type State =
  | { kind: "loading" }
  | { kind: "ok"; businessName: string; url: string }
  /** Unknown, revoked, malformed or absent. Deliberately not distinguished. */
  | { kind: "unavailable" };

/**
 * Share targets that work with a plain URL — no SDK, no script, no app id, no account.
 *
 * Every one of these is a link a browser follows. None of them loads third-party JavaScript onto
 * this page, which is what a "share SDK" would mean and what would turn an invitation page into a
 * tracking surface.
 *
 * **Messenger is absent**, and that is the honest answer rather than an oversight: its web share
 * dialog requires a registered Facebook app id, which is an external account this phase may not
 * add, and a bare `fb-messenger://` deep link does nothing at all on a device without the app. The
 * native share button reaches Messenger on any phone where it is installed, which is the same
 * outcome without the broken button. Recorded in the capability map.
 */
const TARGETS = [
  { id: "whatsapp", href: (u: string, t: string) => `https://wa.me/?text=${encodeURIComponent(`${t} ${u}`)}` },
  {
    id: "telegram",
    href: (u: string, t: string) => `https://t.me/share/url?url=${encodeURIComponent(u)}&text=${encodeURIComponent(t)}`,
  },
  { id: "facebook", href: (u: string) => `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(u)}` },
  {
    id: "x",
    href: (u: string, t: string) => `https://twitter.com/intent/tweet?url=${encodeURIComponent(u)}&text=${encodeURIComponent(t)}`,
  },
  {
    id: "reddit",
    href: (u: string, t: string) => `https://www.reddit.com/submit?url=${encodeURIComponent(u)}&title=${encodeURIComponent(t)}`,
  },
  { id: "bluesky", href: (u: string, t: string) => `https://bsky.app/intent/compose?text=${encodeURIComponent(`${t} ${u}`)}` },
  { id: "threads", href: (u: string, t: string) => `https://www.threads.net/intent/post?text=${encodeURIComponent(`${t} ${u}`)}` },
  {
    id: "email",
    href: (u: string, t: string) => `mailto:?subject=${encodeURIComponent(t)}&body=${encodeURIComponent(`${t}\n\n${u}`)}`,
  },
] as const;

export default function ShareInvite() {
  const t = useTranslations("Share");
  const [state, setState] = useState<State>({ kind: "loading" });
  const [copied, setCopied] = useState(false);
  const [nativeShare, setNativeShare] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;

    /*
     * Everything happens in here rather than in the effect body, and not only to satisfy the lint
     * rule: this component's entire first render is a guess, because the server cannot know which
     * link was opened. Doing the detection and the fetch in one asynchronous pass keeps the number
     * of states the page can be in to three.
     */
    void (async () => {
      // `navigator.share` exists on phones and on some desktop browsers. Detected rather than
      // assumed, so the button is absent where it would do nothing instead of being a dead control.
      const canShare = typeof navigator !== "undefined" && typeof navigator.share === "function";

      const token = window.location.hash.replace(/^#/, "");
      if (!token) {
        if (!cancelled) {
          setNativeShare(canShare);
          setState({ kind: "unavailable" });
        }
        return;
      }

      try {
        const response = await fetch("/api/share/resolve", {
          method: "POST",
          headers: { "content-type": "application/json" },
          // In the body. Never in the path, never in a query string.
          body: JSON.stringify({ token }),
          cache: "no-store",
        });
        const data = (await response.json().catch(() => null)) as { ok?: boolean; businessName?: string } | null;
        if (cancelled) return;
        setNativeShare(canShare);
        if (data?.ok && typeof data.businessName === "string") {
          setState({ kind: "ok", businessName: data.businessName, url: currentUrl() });
        } else {
          setState({ kind: "unavailable" });
        }
      } catch {
        // A network failure reads the same as an invalid link. Retrying is the visitor's call.
        if (!cancelled) {
          setNativeShare(canShare);
          setState({ kind: "unavailable" });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => () => (copyTimer.current ? clearTimeout(copyTimer.current) : undefined), []);

  const url = state.kind === "ok" ? state.url : "";
  /** The business name and the link. Never a customer name, a balance, or anything else. */
  const message = state.kind === "ok" ? t("shareText", { business: state.businessName }) : "";

  const qrSvg = useMemo(() => {
    if (!url) return null;
    // Same settings as `src/server/qr.ts`, which explains the choice: error correction M and a
    // four-module quiet zone, drawn inline so no QR service ever sees this URL.
    const qr = qrcode(0, "M");
    qr.addData(url);
    qr.make();
    return qr.createSvgTag({ cellSize: 6, margin: 4 });
  }, [url]);

  const onCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 2_500);
    } catch {
      // Clipboard access can be refused (an insecure context, a permission prompt declined). The
      // link is on screen and selectable, so this is a missing convenience, not a dead end.
      setCopied(false);
    }
  }, [url]);

  const onNativeShare = useCallback(async () => {
    try {
      await navigator.share({ title: message, text: message, url });
    } catch {
      // Includes the visitor simply dismissing the sheet, which is not an error worth reporting.
    }
  }, [message, url]);

  if (state.kind === "loading") {
    return (
      <p className="text-center text-sm text-zinc-400" role="status" data-testid="share-loading">
        {t("loading")}
      </p>
    );
  }

  if (state.kind === "unavailable") {
    return (
      <section
        className="rounded-3xl bg-zinc-900 p-6 text-center ring-1 ring-white/5"
        role="status"
        data-testid="share-unavailable"
      >
        <h2 className="text-lg font-bold text-zinc-100">{t("unavailableTitle")}</h2>
        <p className="mt-2 text-sm text-zinc-400">{t("unavailableBody")}</p>
      </section>
    );
  }

  return (
    <div className="space-y-6" data-testid="share-invite">
      <header className="text-center">
        <h1 className="font-display text-2xl font-bold text-zinc-100" data-testid="share-heading">
          {t("title")}
        </h1>
        <p className="mt-1 text-sm text-zinc-400" data-testid="share-business">
          {t("subtitle", { business: state.businessName })}
        </p>
      </header>

      <section className="rounded-3xl bg-white p-5 shadow-xl" aria-label={t("qrLabel")}>
        {/*
         * The QR encodes THIS page's URL — the thing a visitor hands to a friend. It is not the
         * card's scanner QR, which stays on the card page where its holder shows it at a counter.
         */}
        <div
          className="mx-auto flex max-w-[280px] items-center justify-center [&>svg]:h-auto [&>svg]:w-full"
          data-testid="share-qr"
          role="img"
          aria-label={t("qrLabel")}
          dangerouslySetInnerHTML={{ __html: qrSvg ?? "" }}
        />
      </section>

      <div className="space-y-3">
        {nativeShare ? (
          <button
            type="button"
            onClick={() => void onNativeShare()}
            data-testid="share-native"
            className="h-12 w-full rounded-xl bg-turquoise-500 px-5 text-base font-bold text-navy-950 transition hover:bg-turquoise-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-turquoise-400"
          >
            {t("shareButton")}
          </button>
        ) : null}

        <button
          type="button"
          onClick={() => void onCopy()}
          data-testid="share-copy"
          className="h-12 w-full rounded-xl border border-white/15 px-5 text-base font-semibold text-zinc-100 transition hover:bg-white/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-turquoise-400"
        >
          {copied ? t("copied") : t("copyButton")}
        </button>

        {/* Announced to a screen reader without stealing focus from the button just pressed. */}
        <p className="sr-only" role="status" aria-live="polite" data-testid="share-copy-status">
          {copied ? t("copied") : ""}
        </p>

        {/* Visible and selectable, so the link is usable even where the clipboard is refused. */}
        <p
          className="break-all rounded-xl bg-black/30 px-3 py-2 text-center text-xs text-zinc-400"
          data-testid="share-url"
          dir="ltr"
        >
          {url}
        </p>
      </div>

      <section aria-labelledby="share-targets-heading" className="space-y-3">
        <h2 id="share-targets-heading" className="text-center text-sm font-semibold text-zinc-400">
          {t("targetsTitle")}
        </h2>
        <ul className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {TARGETS.map((target) => (
            <li key={target.id}>
              <a
                href={target.href(url, message)}
                target="_blank"
                rel="noopener noreferrer"
                data-testid={`share-to-${target.id}`}
                className="flex h-11 items-center justify-center rounded-xl border border-white/15 px-3 text-sm font-semibold text-zinc-100 transition hover:bg-white/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-turquoise-400"
              >
                {t(`target.${target.id}`)}
              </a>
            </li>
          ))}
        </ul>
      </section>

      {/*
       * What a newcomer needs to know, and the boundary this page does not cross: opening this link
       * joins nobody to anything. Cards are issued at the counter (owner decision B7 option 3).
       */}
      <p className="text-center text-sm text-zinc-400" data-testid="share-how-to-join">
        {t("howToJoin", { business: state.businessName })}
      </p>
    </div>
  );
}
