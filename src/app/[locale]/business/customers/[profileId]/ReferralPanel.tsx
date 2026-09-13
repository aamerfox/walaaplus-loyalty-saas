"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/routing";
import { Badge, Button, Notice, TextInput } from "@/components/ui";

/**
 * How this customer arrived, on their own record.
 *
 * ## What it says, and the two things it cannot
 *
 * It says that a member of staff saw a valid invitation when this card was issued. It does **not**
 * say who sent it: the referring customer is somebody else's record, this screen is not an
 * introduction service, and nothing behind it returns a referrer's name, card or link id.
 *
 * It also does not say anybody earned anything, because nobody did. No referral reward policy
 * exists (D15), so the panel states that in as many words rather than leaving a merchant to assume
 * a record like this must be worth something.
 *
 * ## Withdrawing
 *
 * Owner and manager only, enforced on the server. Two steps, because it is additive and permanent
 * in both directions: the original record stays, a withdrawal is written beside it, and the card
 * cannot be attributed again afterwards — re-attributing later would be retrospective attribution.
 * The confirmation says that rather than asking "are you sure".
 */

export interface CardAttribution {
  id: string;
  recordedAt: string;
  method: string;
  voided: boolean;
  voidedAt: string | null;
  voidReason: string | null;
  recordedByName: string | null;
}

export default function ReferralPanel({
  businessId,
  attribution,
  mayVoid,
}: {
  businessId: string;
  /** Null when this card was issued without an invitation, which is the ordinary case. */
  attribution: CardAttribution | null;
  mayVoid: boolean;
}) {
  const t = useTranslations("Referral");
  const tc = useTranslations("Common");
  const router = useRouter();

  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!attribution) {
    return (
      <p className="text-xs text-ink-muted" data-testid="referral-none">
        {t("none")}
      </p>
    );
  }

  async function withdraw() {
    if (busy || !attribution) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/staff/referrals", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "void",
          businessId,
          attributionId: attribution.id,
          reason: reason.trim() || undefined,
        }),
      });
      if (response.ok) {
        setConfirming(false);
        setReason("");
        router.refresh();
        return;
      }
      const data = (await response.json().catch(() => null)) as { error?: { code?: string } } | null;
      setError(data?.error?.code === "FORBIDDEN" ? t("voidForbidden") : t("error"));
    } catch {
      setError(t("error"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2 rounded-xl border border-border bg-surface-muted p-3" data-testid="referral-panel">
      <p className="text-xs font-semibold uppercase tracking-wide text-ink-muted">{t("title")}</p>

      {error ? (
        <Notice tone="danger" testId="referral-error">
          {error}
        </Notice>
      ) : null}

      <p className="text-sm text-ink">
        <Badge tone={attribution.voided ? "neutral" : "success"} testId="referral-state">
          {attribution.voided ? t("voided") : t("attributed")}
        </Badge>
      </p>

      <p className="text-xs text-ink-muted" data-testid="referral-detail">
        {t(`method.${attribution.method}`)} · {t("recordedOn")} <bdi>{attribution.recordedAt.slice(0, 10)}</bdi>
        {attribution.recordedByName ? (
          <>
            {" · "}
            {t("recordedBy")} {attribution.recordedByName}
          </>
        ) : null}
      </p>

      {attribution.voided && attribution.voidedAt ? (
        <p className="text-xs text-ink-muted" data-testid="referral-voided-detail">
          {t("voidedOn")} <bdi>{attribution.voidedAt.slice(0, 10)}</bdi>
          {attribution.voidReason ? ` · ${attribution.voidReason}` : ""}
        </p>
      ) : null}

      {/* Both stated every time, because both are what a merchant would otherwise assume. */}
      <p className="text-xs text-ink-muted" data-testid="referral-no-referrer">
        {t("noReferrer")}
      </p>
      <p className="text-xs text-ink-muted" data-testid="referral-no-reward">
        {t("noReward")}
      </p>

      {mayVoid && !attribution.voided ? (
        confirming ? (
          <div className="space-y-2 rounded-lg border border-border bg-surface p-3" data-testid="referral-void-confirm">
            <p className="text-sm text-ink">{t("voidConfirm")}</p>
            <label className="block text-sm">
              <span className="mb-1 block font-semibold text-ink">{t("voidReason")}</span>
              <TextInput
                value={reason}
                maxLength={280}
                data-testid="referral-void-reason"
                onChange={(e) => setReason(e.target.value)}
              />
              <span className="mt-1 block text-xs text-ink-muted">{t("voidReasonHint")}</span>
            </label>
            <div className="flex flex-wrap gap-2">
              <Button type="button" size="sm" variant="danger" disabled={busy} testId="referral-void-yes" onClick={() => void withdraw()}>
                {t("voidYes")}
              </Button>
              <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setConfirming(false)}>
                {tc("cancel")}
              </Button>
            </div>
          </div>
        ) : (
          <Button type="button" size="sm" variant="ghost" testId="referral-void" onClick={() => setConfirming(true)}>
            {t("void")}
          </Button>
        )
      ) : null}
    </div>
  );
}
