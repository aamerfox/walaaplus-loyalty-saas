"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/routing";
import { Badge, Button, Notice, SelectInput } from "@/components/ui";

/** The five states a campaign can be in. Mirrors `CampaignState`; the server is the authority. */
export type CampaignStateName = "DRAFT" | "IN_REVIEW" | "APPROVED" | "WITHDRAWN" | "ARCHIVED";

/**
 * What a merchant can do to a campaign besides rewrite it or decide about it.
 *
 * Choose an audience, send it for review or pull it back, archive or restore it — and ask how many
 * people it would reach right now. **There is no send control here, and no disabled one**: a
 * greyed-out "Send" would be a promise the product has not made.
 *
 * Approving and withdrawing are deliberately NOT here. They live in `ApprovalPanel`, because they
 * write append-only history and they need a confirmation step that the ordinary controls do not.
 *
 * Two things this component does not decide: whether a transition is allowed, and who may make one.
 * It renders the buttons that make sense for the state it was given, and the server refuses
 * anything else — `MERCHANT_TRANSITIONS` in `src/server/campaigns/campaigns.ts` is the real table.
 */
export default function CampaignControls({
  businessId,
  campaignId,
  state,
  segmentId,
  segments,
  canPreview,
}: {
  businessId: string;
  campaignId: string;
  state: CampaignStateName;
  segmentId: string | null;
  segments: { id: string; name: string }[];
  /** False when this member is branch-scoped: a per-viewer audience number would mislead. */
  canPreview: boolean;
}) {
  const t = useTranslations("Campaigns");
  const tc = useTranslations("Common");
  const router = useRouter();

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [audience, setAudience] = useState<{ matched: number; marketingEligible: number; notEligible: number } | null>(null);

  async function post(payload: Record<string, unknown>): Promise<{ ok: boolean; data?: unknown; code?: string }> {
    if (busy) return { ok: false };
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/staff/campaigns", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ businessId, campaignId, ...payload }),
      });
      const data = (await response.json().catch(() => null)) as { error?: { code?: string } } | null;
      if (response.ok) return { ok: true, data };
      setError(
        data?.error?.code === "FORBIDDEN"
          ? t("errorForbidden")
          : data?.error?.code === "CONFLICT"
            ? t("errorApproveStale")
            : data?.error?.code === "VALIDATION_ERROR"
              ? t("errorNoAudience")
              : tc("genericError"),
      );
      return { ok: false, code: data?.error?.code };
    } catch {
      setError(tc("genericError"));
      return { ok: false };
    } finally {
      setBusy(false);
    }
  }

  function move(next: CampaignStateName) {
    void post({ action: "setState", state: next }).then((r) => {
      if (r.ok) router.refresh();
    });
  }

  // An approved campaign is frozen for these controls on purpose: the audience it was approved
  // against is part of the decision, so changing it means withdrawing first.
  const frozen = state === "APPROVED";
  const archived = state === "ARCHIVED";

  return (
    <div className="space-y-4" data-testid="campaign-controls">
      {error ? (
        <Notice tone="danger" testId="campaign-control-error">
          {error}
        </Notice>
      ) : null}

      <label className="block max-w-sm text-sm">
        <span className="mb-1 block font-semibold text-ink">{t("audienceLabel")}</span>
        <SelectInput
          value={segmentId ?? ""}
          disabled={busy || archived || frozen}
          data-testid="campaign-audience"
          onChange={(e) => {
            const next = e.target.value || null;
            setAudience(null);
            void post({ action: "setAudience", segmentId: next }).then((r) => {
              if (r.ok) router.refresh();
            });
          }}
        >
          <option value="">{t("noAudience")}</option>
          {segments.map((segment) => (
            <option key={segment.id} value={segment.id}>
              {segment.name}
            </option>
          ))}
        </SelectInput>
      </label>

      <div className="flex flex-wrap items-center gap-2">
        {canPreview && segmentId ? (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={busy}
            testId="campaign-preview-audience"
            onClick={() =>
              void post({ action: "preview" }).then((r) => {
                if (r.ok) setAudience(r.data as { matched: number; marketingEligible: number; notEligible: number });
              })
            }
          >
            {t("previewAudience")}
          </Button>
        ) : null}

        {state === "DRAFT" || state === "WITHDRAWN" ? (
          <Button type="button" size="sm" variant="primary" disabled={busy} testId="campaign-submit-review" onClick={() => move("IN_REVIEW")}>
            {t("submitReview")}
          </Button>
        ) : null}

        {state === "IN_REVIEW" ? (
          <Button type="button" size="sm" variant="ghost" disabled={busy} testId="campaign-back-to-draft" onClick={() => move("DRAFT")}>
            {t("backToDraft")}
          </Button>
        ) : null}

        {archived ? (
          <Button type="button" size="sm" variant="secondary" disabled={busy} testId="campaign-restore" onClick={() => move("DRAFT")}>
            {t("restore")}
          </Button>
        ) : frozen ? null : (
          <Button type="button" size="sm" variant="ghost" disabled={busy} testId="campaign-archive" onClick={() => move("ARCHIVED")}>
            {t("archive")}
          </Button>
        )}
      </div>

      {audience ? (
        <div className="space-y-1 rounded-xl border border-border bg-surface-muted p-4" data-testid="audience-preview">
          <p className="font-semibold text-ink">{t("audienceMatched", { count: audience.matched })}</p>
          <p className="text-sm text-ink">
            {/* Neutral when the number is zero: "none may be contacted" is not an achievement. */}
            <Badge tone={audience.marketingEligible > 0 ? "success" : "neutral"}>
              {t("audienceEligible", { count: audience.marketingEligible })}
            </Badge>
          </p>
          {/*
           * The difference between the two numbers is the point of showing both: it is what a
           * merchant learns about their own consent records, and it is not a failure.
           */}
          <p className="text-xs text-ink-muted">{t("audienceNotEligible", { count: audience.notEligible })}</p>
          <p className="text-xs text-ink-muted">{t("audienceNoList")}</p>
        </div>
      ) : null}
    </div>
  );
}
