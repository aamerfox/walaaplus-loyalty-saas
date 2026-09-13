"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/routing";
import { Badge, Button, Notice, TextInput } from "@/components/ui";

/**
 * The approval decision, and the confirmation that has to precede it.
 *
 * ## Why there is a confirmation step at all
 *
 * Approving is the only action on this screen that produces something a person cannot take back:
 * the approval row and its audience snapshot are append-only, and a later withdrawal adds a row
 * rather than removing one. A single click that writes permanent history is a click somebody makes
 * by accident, so the button opens a panel that states what is about to be recorded — which
 * revision, which channel, and how many people the snapshot will cover — and asks again.
 *
 * The same applies to withdrawing, which is equally permanent in the record.
 *
 * ## What approval is not
 *
 * The panel says it, every time, in the same words as the rest of the product: **approval sends
 * nothing.** There is no provider, no queue and no schedule in this build, and a future delivery
 * phase must re-check each customer's current consent at the moment it contacts them — a snapshot
 * is a ceiling, never an authority. That sentence is rendered here rather than only documented,
 * because the person who needs to read it is the one clicking the button.
 *
 * ## Where the decision is made
 *
 * On the server. This component sends `approve` or `withdraw` and renders what comes back; it does
 * not decide who may approve, which states allow it, or what the audience is. Every one of those
 * is re-derived in `src/server/campaigns/approvals.ts` from the caller's live membership.
 */
export default function ApprovalPanel({
  businessId,
  campaignId,
  state,
  channel,
  channelLabel,
  latestRevisionNumber,
  approvedRevisionNumber,
  hasAudience,
  canApprove,
}: {
  businessId: string;
  campaignId: string;
  state: "DRAFT" | "IN_REVIEW" | "APPROVED" | "WITHDRAWN" | "ARCHIVED";
  /** The enum value, which is what gets DECLARED on the decision row. */
  channel: "PUSH" | "SMS" | "WHATSAPP" | "EMAIL";
  /** The same thing in the reader's language. Shown, never sent. */
  channelLabel: string;
  latestRevisionNumber: number | null;
  approvedRevisionNumber: number | null;
  hasAudience: boolean;
  /** False for a branch-scoped member: a snapshot is business-wide and they cannot verify it. */
  canApprove: boolean;
}) {
  const t = useTranslations("Campaigns");
  const tc = useTranslations("Common");
  const router = useRouter();

  const [intent, setIntent] = useState<"approve" | "withdraw" | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function decide(action: "approve" | "withdraw") {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/staff/campaigns", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action,
          businessId,
          campaignId,
          note: note.trim() || undefined,
          // Sent so the server can refuse an approval of words that changed while this was open.
          ...(action === "approve" ? { revisionNumber: latestRevisionNumber, intendedChannel: channel } : {}),
        }),
      });
      if (response.ok) {
        setIntent(null);
        setNote("");
        router.refresh();
        return;
      }
      const data = (await response.json().catch(() => null)) as { error?: { code?: string } } | null;
      setError(
        data?.error?.code === "FORBIDDEN"
          ? t("errorApproveForbidden")
          : data?.error?.code === "CONFLICT"
            ? t("errorApproveStale")
            : data?.error?.code === "VALIDATION_ERROR"
              ? t("errorNoAudience")
              : tc("genericError"),
      );
    } catch {
      setError(tc("genericError"));
    } finally {
      setBusy(false);
    }
  }

  // An archived campaign is out of the decision flow entirely, in both directions.
  if (state === "ARCHIVED") {
    return (
      <Notice tone="info" testId="approval-archived">
        {t("approvalArchivedNote")}
      </Notice>
    );
  }

  if (!canApprove) {
    return (
      <Notice tone="info" testId="approval-not-permitted">
        {t("approvalBranchScoped")}
      </Notice>
    );
  }

  const stale = state === "APPROVED" && approvedRevisionNumber !== latestRevisionNumber;

  return (
    <div className="space-y-4" data-testid="approval-panel">
      {error ? (
        <Notice tone="danger" testId="approval-error">
          {error}
        </Notice>
      ) : null}

      {/* The standing fact, above every control that leads to a decision. */}
      <Notice tone="warn" testId="approval-sends-nothing">
        {t("approvalSendsNothing")}
      </Notice>

      {state === "APPROVED" ? (
        <p className="text-sm text-ink" data-testid="approval-standing">
          <Badge tone="success">{t("approvedAtRevision", { revision: approvedRevisionNumber ?? 0 })}</Badge>{" "}
          {stale ? <span className="text-warn-ink">{t("approvalStaleWarning")}</span> : null}
        </p>
      ) : null}

      {intent === null ? (
        <div className="flex flex-wrap items-center gap-2">
          {state === "APPROVED" ? (
            <Button type="button" size="sm" variant="danger" testId="campaign-withdraw" onClick={() => setIntent("withdraw")}>
              {t("withdrawApproval")}
            </Button>
          ) : (
            <Button
              type="button"
              size="sm"
              variant="primary"
              testId="campaign-approve"
              // Refused on the server too; disabling here only avoids a pointless round trip, and
              // the reason is spelled out below rather than left to a greyed-out button.
              disabled={!hasAudience || latestRevisionNumber === null}
              onClick={() => setIntent("approve")}
            >
              {t("approveCampaign")}
            </Button>
          )}
        </div>
      ) : (
        <div className="space-y-3 rounded-xl border border-border bg-surface-muted p-4" data-testid="approval-confirm">
          <p className="font-semibold text-ink">
            {intent === "approve"
              ? t("confirmApproveTitle", { revision: latestRevisionNumber ?? 0, channel: channelLabel })
              : t("confirmWithdrawTitle")}
          </p>
          <p className="text-sm text-ink-muted">
            {intent === "approve" ? t("confirmApproveBody") : t("confirmWithdrawBody")}
          </p>
          <label className="block text-sm">
            <span className="mb-1 block font-semibold text-ink">{t("decisionNote")}</span>
            <TextInput
              value={note}
              maxLength={280}
              data-testid="approval-note"
              onChange={(e) => setNote(e.target.value)}
            />
            <span className="mt-1 block text-xs text-ink-muted">{t("decisionNoteHint")}</span>
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant={intent === "approve" ? "primary" : "danger"}
              disabled={busy}
              testId="approval-confirm-yes"
              onClick={() => void decide(intent)}
            >
              {busy ? t("saving") : intent === "approve" ? t("confirmApprove") : t("confirmWithdraw")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy}
              testId="approval-confirm-no"
              onClick={() => {
                setIntent(null);
                setNote("");
              }}
            >
              {tc("cancel")}
            </Button>
          </div>
        </div>
      )}

      {!hasAudience && state !== "APPROVED" ? (
        <p className="text-sm text-ink-muted" data-testid="approval-needs-audience">
          {t("approvalNeedsAudience")}
        </p>
      ) : null}
    </div>
  );
}
