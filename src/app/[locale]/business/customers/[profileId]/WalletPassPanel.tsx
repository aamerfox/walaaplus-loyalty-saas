"use client";

import { useCallback, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Badge, Button, Notice } from "@/components/ui";

/**
 * What a card's wallet pass would contain, and the one control that acts on it.
 *
 * ## What a member of staff may see here
 *
 * Whether the card has a live invitation link, when it was issued, how many have been issued over
 * its life — and the two payloads with **the capability removed**. The link itself is never shown.
 * It belongs to the customer, in their wallet, and a screen that displayed it would be a screen
 * somebody screenshots into a support chat.
 *
 * The panel says so in as many words, because a redacted value with no explanation reads as a bug.
 *
 * ## Loaded on demand
 *
 * A customer holding three cards would otherwise mean three payload builds on every page load, for
 * a panel most visits never open. Fetching when it is opened keeps the customer record fast and
 * keeps the wallet code off the critical path of the screen staff actually use.
 *
 * ## Revoking
 *
 * Two steps, because it is not reversible in the way a merchant might assume: the link in the
 * customer's wallet stops working, and getting a new one means issuing the pass again. The
 * confirmation says that rather than asking "are you sure".
 */

interface ShareLinkStatus {
  live: boolean;
  issuedAt: string | null;
  issuedFor: string | null;
  everIssued: number;
}

interface Preview {
  link: ShareLinkStatus;
  signed: false;
  apple: unknown;
  google: unknown;
}

export default function WalletPassPanel({ businessId, customerCardId }: { businessId: string; customerCardId: string }) {
  const t = useTranslations("Wallet");
  const tc = useTranslations("Common");
  const locale = useLocale();

  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const post = useCallback(
    async (payload: Record<string, unknown>): Promise<unknown | null> => {
      setBusy(true);
      setError(null);
      try {
        const response = await fetch("/api/staff/wallet", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ businessId, customerCardId, ...payload }),
        });
        const data: unknown = await response.json().catch(() => null);
        if (response.ok) return data;
        const code = (data as { error?: { code?: string } } | null)?.error?.code;
        setError(code === "VALIDATION_ERROR" ? t("notStampCard") : code === "FORBIDDEN" ? tc("genericError") : t("error"));
        return null;
      } catch {
        setError(t("error"));
        return null;
      } finally {
        setBusy(false);
      }
    },
    [businessId, customerCardId, t, tc],
  );

  const load = useCallback(async () => {
    const data = await post({ action: "preview", locale: locale === "ar" ? "ar" : "en" });
    if (data) setPreview(data as Preview);
  }, [post, locale]);

  if (!open) {
    return (
      <Button
        type="button"
        size="sm"
        variant="secondary"
        testId="wallet-open"
        onClick={() => {
          setOpen(true);
          void load();
        }}
      >
        {t("title")}
      </Button>
    );
  }

  return (
    <section className="space-y-3 rounded-xl border border-border bg-surface-muted p-4" data-testid="wallet-panel">
      <div>
        <p className="font-display font-bold text-ink">{t("title")}</p>
        <p className="text-xs text-ink-muted">{t("subtitle")}</p>
      </div>

      {error ? (
        <Notice tone="danger" testId="wallet-error">
          {error}
        </Notice>
      ) : null}

      {message ? (
        <Notice tone="success" testId="wallet-message">
          {message}
        </Notice>
      ) : null}

      {busy && !preview ? <p className="text-sm text-ink-muted">{t("subtitle")}</p> : null}

      {preview ? (
        <>
          {/* Nothing in this build can sign a pass, and the screen says it rather than implying it. */}
          <Notice tone="warn" testId="wallet-not-signed">
            {t("notSigned")}
          </Notice>

          <p className="text-sm text-ink" data-testid="wallet-link-status">
            <Badge tone={preview.link.live ? "success" : "neutral"}>
              {preview.link.live ? t("linkLive") : t("linkNone")}
            </Badge>
          </p>
          <p className="text-xs text-ink-muted">
            {t("linkEverIssued", { count: preview.link.everIssued })}
            {preview.link.issuedAt ? (
              <>
                {" · "}
                {t("linkIssued")} <bdi>{preview.link.issuedAt.slice(0, 10)}</bdi>
              </>
            ) : null}
          </p>
          <Notice tone="info" testId="wallet-token-hidden">
            {t("tokenHidden")}
          </Notice>

          <div className="space-y-2">
            <p className="text-sm font-semibold text-ink">{t("applePass")}</p>
            <p className="text-xs text-ink-muted">{t("appleNote")}</p>
            <pre
              className="max-h-64 overflow-auto rounded-lg bg-surface p-3 text-xs text-ink-muted"
              data-testid="wallet-apple-payload"
              dir="ltr"
            >
              {JSON.stringify(preview.apple, null, 2)}
            </pre>
          </div>

          <div className="space-y-2">
            <p className="text-sm font-semibold text-ink">{t("googlePass")}</p>
            <p className="text-xs text-ink-muted">{t("googleNote")}</p>
            <pre
              className="max-h-64 overflow-auto rounded-lg bg-surface p-3 text-xs text-ink-muted"
              data-testid="wallet-google-payload"
              dir="ltr"
            >
              {JSON.stringify(preview.google, null, 2)}
            </pre>
          </div>

          <Notice tone="info" testId="wallet-barcode-note">
            {t("barcodeNote")}
          </Notice>
          {/*
           * The honest caveat about an already-saved pass. Nothing here pushes an update to a
           * wallet, and claiming otherwise would be a promise a customer discovers is false.
           */}
          <Notice tone="info" testId="wallet-reinstall-note">
            {t("reinstallNote")}
          </Notice>
          <Notice tone="warn" testId="wallet-device-gate">
            {t("deviceGate")}
          </Notice>

          {preview.link.live ? (
            confirming ? (
              <div className="space-y-2 rounded-lg border border-border bg-surface p-3" data-testid="wallet-revoke-confirm">
                <p className="text-sm text-ink">{t("revokeConfirm")}</p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="danger"
                    disabled={busy}
                    testId="wallet-revoke-yes"
                    onClick={() =>
                      void post({ action: "revoke" }).then((data) => {
                        if (!data) return;
                        setConfirming(false);
                        setMessage((data as { revoked: boolean }).revoked ? t("revoked") : t("revokeNothing"));
                        void load();
                      })
                    }
                  >
                    {t("revokeYes")}
                  </Button>
                  <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setConfirming(false)}>
                    {tc("cancel")}
                  </Button>
                </div>
              </div>
            ) : (
              <Button type="button" size="sm" variant="danger" testId="wallet-revoke" onClick={() => setConfirming(true)}>
                {t("revoke")}
              </Button>
            )
          ) : null}
        </>
      ) : null}
    </section>
  );
}
