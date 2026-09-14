"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/routing";
import { Badge, Button, Notice, TextInput } from "@/components/ui";

/**
 * What this card has been recorded as owed, and the one control that acts on it.
 *
 * ## The sentence this panel exists to say
 *
 * **Nothing here was discounted, charged or paid.** These rows record that a customer was owed
 * something a person then handed over. A merchant reading a list headed "offers" would otherwise
 * reasonably assume a till applied them, and no till does.
 *
 * ## Withdrawing
 *
 * Owner and manager only, enforced on the server. Two steps, because it is additive and permanent in
 * the record — and because of the one consequence a merchant would not guess: **withdrawing frees
 * the customer to use the offer again.** A void here means the redemption did not happen, which is
 * the opposite of a referral attribution, where voiding does not free a slot. The confirmation says
 * so rather than asking "are you sure".
 */

export interface RedemptionRow {
  id: string;
  promotionName: string;
  benefitDescription: string;
  recordedAt: string;
  voided: boolean;
  voidedAt: string | null;
  voidReason: string | null;
  recordedByName: string | null;
}

export default function RedemptionsPanel({
  businessId,
  redemptions,
  mayVoid,
}: {
  businessId: string;
  redemptions: RedemptionRow[];
  mayVoid: boolean;
}) {
  const t = useTranslations("Customers");
  const tc = useTranslations("Common");
  const router = useRouter();

  const [confirming, setConfirming] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (redemptions.length === 0) {
    return (
      <p className="text-xs text-ink-muted" data-testid="redemptions-none">
        {t("redemptionsNone")}
      </p>
    );
  }

  async function withdraw(redemptionId: string) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/staff/promotions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "voidRedemption",
          businessId,
          redemptionId,
          reason: reason.trim() || undefined,
        }),
      });
      if (response.ok) {
        setConfirming(null);
        setReason("");
        router.refresh();
        return;
      }
      setError(t("voidError"));
    } catch {
      setError(t("voidError"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2 rounded-xl border border-border bg-surface-muted p-3" data-testid="redemptions-panel">
      <p className="text-xs font-semibold uppercase tracking-wide text-ink-muted">{t("redemptionsTitle")}</p>

      {error ? (
        <Notice tone="danger" testId="redemptions-error">
          {error}
        </Notice>
      ) : null}

      <ul className="space-y-2">
        {redemptions.map((row) => (
          <li key={row.id} className="space-y-1" data-testid="redemption-row">
            <p className="text-sm text-ink">
              <Badge tone={row.voided ? "neutral" : "success"}>
                {row.voided ? t("redemptionVoided") : row.promotionName}
              </Badge>{" "}
              <span className="text-ink-muted">{row.benefitDescription}</span>
            </p>
            <p className="text-xs text-ink-muted">
              {t("redemptionOn")} <bdi>{row.recordedAt.slice(0, 10)}</bdi>
              {row.recordedByName ? ` · ${t("redemptionBy")} ${row.recordedByName}` : ""}
              {row.voided && row.voidedAt ? ` · ${t("redemptionVoided")} ` : ""}
              {row.voided && row.voidedAt ? <bdi>{row.voidedAt.slice(0, 10)}</bdi> : null}
              {row.voidReason ? ` · ${row.voidReason}` : ""}
            </p>

            {mayVoid && !row.voided ? (
              confirming === row.id ? (
                <div className="space-y-2 rounded-lg border border-border bg-surface p-3" data-testid="redemption-void-confirm">
                  <p className="text-sm text-ink">{t("voidConfirm")}</p>
                  <label className="block text-sm">
                    <span className="mb-1 block font-semibold text-ink">{t("voidReason")}</span>
                    <TextInput
                      value={reason}
                      maxLength={280}
                      data-testid="redemption-void-reason"
                      onChange={(e) => setReason(e.target.value)}
                    />
                    <span className="mt-1 block text-xs text-ink-muted">{t("voidReasonHint")}</span>
                  </label>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="danger"
                      disabled={busy}
                      testId="redemption-void-yes"
                      onClick={() => void withdraw(row.id)}
                    >
                      {t("voidYes")}
                    </Button>
                    <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setConfirming(null)}>
                      {tc("cancel")}
                    </Button>
                  </div>
                </div>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  testId={`redemption-void-${row.id}`}
                  onClick={() => setConfirming(row.id)}
                >
                  {t("voidRedemption")}
                </Button>
              )
            ) : null}
          </li>
        ))}
      </ul>

      {/* The standing fact, under the list rather than only in a doc. */}
      <p className="text-xs text-ink-muted" data-testid="redemptions-no-money">
        {t("redemptionNoMoney")}
      </p>
    </div>
  );
}
