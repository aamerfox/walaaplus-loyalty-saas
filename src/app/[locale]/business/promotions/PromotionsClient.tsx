"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/routing";
import { Badge, Button, Card, EmptyState, Notice, TextInput } from "@/components/ui";

/**
 * Promotions, as a merchant manages them.
 *
 * ## Two things this screen says that it would be easy to leave out
 *
 * **Nothing is calculated here.** A redemption records that a customer is owed something and a
 * person hands it over. A merchant who saw "10% off" in a list would reasonably assume a till
 * somewhere applies it, and nothing does — so the screen says so once, at the top, rather than
 * leaving it to be discovered at a counter.
 *
 * **A code cannot be shown again.** Only a salted digest is stored, so nothing can recover one. That
 * is stated at the moment of creation, next to the field, because finding out afterwards means a
 * merchant has lost a code that is already printed on something.
 *
 * ## The lifecycle
 *
 * A promotion is created as a draft, which is the only moment somebody reads back what they typed
 * before a code goes out. `EXPIRED` is terminal and the confirmation says so: reviving one would
 * silently re-honour every code already handed out, including the ones it was expired to stop.
 */

export type PromotionStateName = "DRAFT" | "ACTIVE" | "PAUSED" | "EXPIRED";

export interface PromotionRow {
  id: string;
  name: string;
  benefitDescription: string;
  state: PromotionStateName;
  startsAt: string | null;
  endsAt: string | null;
  totalLimit: number | null;
  perCustomerLimit: number | null;
  redeemed: number;
  voided: number;
  remaining: number | null;
}

const TONE: Record<PromotionStateName, "success" | "accent" | "warn" | "neutral"> = {
  DRAFT: "neutral",
  ACTIVE: "success",
  PAUSED: "warn",
  EXPIRED: "neutral",
};

export default function PromotionsClient({ businessId, promotions }: { businessId: string; promotions: PromotionRow[] }) {
  const t = useTranslations("Promotions");
  const tc = useTranslations("Common");
  const router = useRouter();

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [expiring, setExpiring] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [benefit, setBenefit] = useState("");
  const [code, setCode] = useState("");
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState("");
  const [totalLimit, setTotalLimit] = useState("");
  const [perCustomerLimit, setPerCustomerLimit] = useState("");

  async function post(payload: Record<string, unknown>): Promise<boolean> {
    if (busy) return false;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/staff/promotions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ businessId, ...payload }),
      });
      if (response.ok) return true;
      const data = (await response.json().catch(() => null)) as { error?: { code?: string } } | null;
      setError(
        data?.error?.code === "NAME_TAKEN"
          ? t("errorNameTaken")
          : data?.error?.code === "VALIDATION_ERROR"
            ? t("errorInvalid")
            : data?.error?.code === "FORBIDDEN"
              ? t("errorForbidden")
              : t("error"),
      );
      return false;
    } catch {
      setError(t("error"));
      return false;
    } finally {
      setBusy(false);
    }
  }

  /** A `datetime-local` value, or undefined. Sent as an instant so the server never parses a guess. */
  function instant(value: string): string | undefined {
    return value ? new Date(value).toISOString() : undefined;
  }

  function positive(value: string): number | undefined {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  }

  function windowLabel(row: PromotionRow): string {
    const from = row.startsAt?.slice(0, 10);
    const to = row.endsAt?.slice(0, 10);
    if (from && to) return t("window", { from, to });
    if (from) return t("windowFrom", { from });
    if (to) return t("windowTo", { to });
    return t("windowNone");
  }

  return (
    <div className="space-y-6" data-testid="promotions-client">
      {/* Said once, at the top, because a list of offers reads like a list of discounts. */}
      <Notice tone="info" testId="promotions-nothing-automatic">
        {t("nothingAutomatic")}
      </Notice>

      {error ? (
        <Notice tone="danger" testId="promotions-error">
          {error}
        </Notice>
      ) : null}
      {message ? (
        <Notice tone="success" testId="promotions-message">
          {message}
        </Notice>
      ) : null}

      {promotions.length === 0 ? (
        <EmptyState testId="promotions-empty" title={t("emptyTitle")} body={t("emptyBody")} />
      ) : (
        <ul className="space-y-3" data-testid="promotion-list">
          {promotions.map((row) => (
            <li key={row.id}>
              <Card className="space-y-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-display text-lg font-bold text-ink">{row.name}</p>
                    <p className="text-sm text-ink-muted">{row.benefitDescription}</p>
                  </div>
                  <Badge tone={TONE[row.state]} testId={`promotion-state-${row.id}`}>
                    {t(`state.${row.state}`)}
                  </Badge>
                </div>

                <p className="text-xs text-ink-muted" data-testid={`promotion-usage-${row.id}`}>
                  {t("usedCount", { count: row.redeemed })}
                  {row.voided > 0 ? t("voidedCount", { count: row.voided }) : ""} ·{" "}
                  {row.totalLimit === null ? t("noLimit") : t("remaining", { count: row.remaining ?? 0 })}
                  {row.perCustomerLimit !== null ? ` · ${t("perCustomer", { count: row.perCustomerLimit })}` : ""}
                </p>
                <p className="text-xs text-ink-muted">
                  <bdi>{windowLabel(row)}</bdi>
                </p>

                <div className="flex flex-wrap gap-2">
                  {row.state === "DRAFT" || row.state === "PAUSED" ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="primary"
                      disabled={busy}
                      testId={`promotion-activate-${row.id}`}
                      onClick={() =>
                        void post({ action: "setState", promotionId: row.id, state: "ACTIVE" }).then(
                          (ok) => ok && router.refresh(),
                        )
                      }
                    >
                      {row.state === "DRAFT" ? t("activate") : t("resume")}
                    </Button>
                  ) : null}

                  {row.state === "ACTIVE" ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      disabled={busy}
                      testId={`promotion-pause-${row.id}`}
                      onClick={() =>
                        void post({ action: "setState", promotionId: row.id, state: "PAUSED" }).then(
                          (ok) => ok && router.refresh(),
                        )
                      }
                    >
                      {t("pause")}
                    </Button>
                  ) : null}

                  {row.state !== "EXPIRED" ? (
                    expiring === row.id ? (
                      <div className="w-full space-y-2 rounded-lg border border-border bg-surface-muted p-3" data-testid="promotion-expire-confirm">
                        <p className="text-sm text-ink">{t("expireConfirm")}</p>
                        <div className="flex flex-wrap gap-2">
                          <Button
                            type="button"
                            size="sm"
                            variant="danger"
                            disabled={busy}
                            testId={`promotion-expire-yes-${row.id}`}
                            onClick={() =>
                              void post({ action: "setState", promotionId: row.id, state: "EXPIRED" }).then((ok) => {
                                if (!ok) return;
                                setExpiring(null);
                                router.refresh();
                              })
                            }
                          >
                            {t("expireYes")}
                          </Button>
                          <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setExpiring(null)}>
                            {tc("cancel")}
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        testId={`promotion-expire-${row.id}`}
                        onClick={() => setExpiring(row.id)}
                      >
                        {t("expire")}
                      </Button>
                    )
                  ) : null}
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}

      <Card className="space-y-4" testId="promotion-create">
        <p className="font-display text-lg font-bold text-ink">{t("newTitle")}</p>

        <label className="block text-sm">
          <span className="mb-1 block font-semibold text-ink">{t("nameLabel")}</span>
          <TextInput value={name} maxLength={80} data-testid="promotion-name" onChange={(e) => setName(e.target.value)} />
          <span className="mt-1 block text-xs text-ink-muted">{t("nameHint")}</span>
        </label>

        <label className="block text-sm">
          <span className="mb-1 block font-semibold text-ink">{t("benefitLabel")}</span>
          <TextInput
            value={benefit}
            maxLength={200}
            data-testid="promotion-benefit"
            onChange={(e) => setBenefit(e.target.value)}
          />
          <span className="mt-1 block text-xs text-ink-muted">{t("benefitHint")}</span>
        </label>

        <label className="block text-sm">
          <span className="mb-1 block font-semibold text-ink">{t("codeLabel")}</span>
          <TextInput
            value={code}
            maxLength={64}
            dir="ltr"
            autoComplete="off"
            spellCheck={false}
            data-testid="promotion-code"
            onChange={(e) => setCode(e.target.value)}
          />
          <span className="mt-1 block text-xs text-ink-muted">{t("codeHint")}</span>
        </label>

        {/* The consequence of never storing it, next to the field rather than in a doc. */}
        <Notice tone="warn" testId="promotion-code-warning">
          {t("codeWarning")}
        </Notice>

        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block text-sm">
            <span className="mb-1 block font-semibold text-ink">{t("startsLabel")}</span>
            <TextInput
              type="datetime-local"
              value={startsAt}
              data-testid="promotion-starts"
              onChange={(e) => setStartsAt(e.target.value)}
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-semibold text-ink">{t("endsLabel")}</span>
            <TextInput
              type="datetime-local"
              value={endsAt}
              data-testid="promotion-ends"
              onChange={(e) => setEndsAt(e.target.value)}
            />
          </label>
        </div>
        <p className="text-xs text-ink-muted">{t("windowHint")}</p>

        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block text-sm">
            <span className="mb-1 block font-semibold text-ink">{t("totalLimitLabel")}</span>
            <TextInput
              type="number"
              min={1}
              value={totalLimit}
              data-testid="promotion-total-limit"
              onChange={(e) => setTotalLimit(e.target.value)}
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-semibold text-ink">{t("perCustomerLimitLabel")}</span>
            <TextInput
              type="number"
              min={1}
              value={perCustomerLimit}
              data-testid="promotion-per-customer-limit"
              onChange={(e) => setPerCustomerLimit(e.target.value)}
            />
          </label>
        </div>
        <p className="text-xs text-ink-muted">{t("limitHint")}</p>

        <Button
          type="button"
          disabled={busy || !name.trim() || !benefit.trim() || !code.trim()}
          testId="promotion-save"
          onClick={() =>
            void post({
              action: "create",
              name: name.trim(),
              benefitDescription: benefit.trim(),
              code: code.trim(),
              startsAt: instant(startsAt),
              endsAt: instant(endsAt),
              totalLimit: positive(totalLimit),
              perCustomerLimit: positive(perCustomerLimit),
            }).then((ok) => {
              if (!ok) return;
              setName("");
              setBenefit("");
              // The code is cleared with everything else. It is gone from this device too.
              setCode("");
              setStartsAt("");
              setEndsAt("");
              setTotalLimit("");
              setPerCustomerLimit("");
              setMessage(t("created"));
              router.refresh();
            })
          }
        >
          {t("create")}
        </Button>
      </Card>
    </div>
  );
}
