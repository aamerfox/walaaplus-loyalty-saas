"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/routing";
import { Badge, Button, Card, EmptyState, Notice, TextInput } from "@/components/ui";

/**
 * Webhook destinations, as the owner manages them.
 *
 * ## Three things this screen says that it would be easy to leave out
 *
 * **The same event may arrive more than once.** Exactly-once delivery over a network does not
 * exist, and a receiver written on the assumption that it does is a receiver that double-counts.
 * The sentence is at the top, before the first destination is created, rather than in a
 * documentation page nobody reads.
 *
 * **The secret cannot be shown again.** It is stored encrypted and no route can produce it, so the
 * warning sits next to the value at the one moment it exists.
 *
 * **Nothing is sent from the till.** Delivery happens in the worker, within about a minute. An
 * owner who pressed "send a test" and saw nothing for thirty seconds would reasonably think it was
 * broken.
 *
 * ## Nothing here reveals anything
 *
 * The list shows a name, a hostname and counts. There is no URL — the full address is encrypted and
 * no selection reads it back — and no secret, and the delivery history has no body, no header and
 * no error text, because those columns do not exist.
 */

export type DestinationStateName = "DISABLED" | "ENABLED" | "REVOKED";

export interface DestinationRow {
  id: string;
  name: string;
  endpointHost: string;
  state: DestinationStateName;
  cipherKeyVersion: number;
  secretIssuedAt: string;
  pending: number;
  delivered: number;
  failed: number;
  /** The most recent attempt's category, or null if nothing has been tried yet. */
  lastErrorClass: string | null;
}

const TONE: Record<DestinationStateName, "success" | "warn" | "neutral"> = {
  DISABLED: "neutral",
  ENABLED: "success",
  REVOKED: "warn",
};

/** Written out rather than derived from the enum name, so a rename cannot silently lose a label. */
const STATE_LABEL = {
  DISABLED: "stateDisabled",
  ENABLED: "stateEnabled",
  REVOKED: "stateRevoked",
} as const;

/**
 * What the owner is told about the last attempt.
 *
 * Operational words only. **No cryptographic detail**: a missing key reads as "a setting this
 * server needs", and an unreadable ciphertext reads as "settings that can no longer be read" —
 * enough for an owner to know whether to wait, call an administrator, or make a new destination,
 * and nothing about algorithms, versions or which value failed.
 *
 * The two the review asked to be distinguishable are the first two: one is temporary and will be
 * retried, the other is not and will not.
 */
const OUTCOME_LABEL: Record<string, string> = {
  NONE: "outcomeNone",
  ENCRYPTION_UNAVAILABLE: "outcomeKeyMissing",
  CIPHERTEXT_INVALID: "outcomeUnreadable",
  DESTINATION_NOT_ELIGIBLE: "outcomeNotEligible",
  UNSAFE_ADDRESS: "outcomeAddress",
  TIMEOUT: "outcomeTimeout",
  NETWORK: "outcomeNetwork",
  TLS: "outcomeTls",
  HTTP_REDIRECT: "outcomeRedirect",
  HTTP_CLIENT_ERROR: "outcomeClientError",
  HTTP_RATE_LIMITED: "outcomeRateLimited",
  HTTP_SERVER_ERROR: "outcomeServerError",
};

interface Props {
  businessId: string;
  destinations: DestinationRow[];
  /** False when `INTEGRATION_ENCRYPTION_KEY` is absent or malformed. The screen says so and stops. */
  configured: boolean;
}

export default function WebhooksClient({ businessId, destinations, configured }: Props) {
  const t = useTranslations("Integrations");
  const router = useRouter();

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  /** The one value that exists outside the database, and only until the owner dismisses it. */
  const [secret, setSecret] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<{ id: string; action: "revoke" | "rotate" } | null>(null);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");

  async function post(body: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch("/api/staff/webhooks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ businessId, ...body }),
      });
      const payload = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      if (!res.ok) {
        setError(
          res.status === 403
            ? t("errorForbidden")
            : res.status === 400
              ? t("errorInvalid")
              : res.status === 409
                ? t("errorTaken")
                : t("error"),
        );
        return null;
      }
      return payload;
    } catch {
      setError(t("error"));
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function create(e: React.FormEvent) {
    e.preventDefault();
    const payload = await post({ action: "create", name: name.trim(), url: url.trim() });
    if (!payload) return;
    setName("");
    setUrl("");
    // Held in component state only. Never written anywhere, and gone on the next navigation.
    setSecret(String(payload.signingSecret ?? ""));
    router.refresh();
  }

  async function changeState(id: string, state: DestinationStateName) {
    if (!(await post({ action: "setState", destinationId: id, state }))) return;
    setConfirming(null);
    router.refresh();
  }

  async function rotate(id: string) {
    const payload = await post({ action: "rotate", destinationId: id });
    if (!payload) return;
    setConfirming(null);
    setSecret(String(payload.signingSecret ?? ""));
    router.refresh();
  }

  async function test(id: string) {
    if (!(await post({ action: "test", destinationId: id }))) return;
    setMessage(t("testQueued"));
    router.refresh();
  }

  return (
    <section className="space-y-4" data-testid="webhooks">
      <div>
        <h2 className="text-lg font-semibold text-slate-900">{t("webhooksTitle")}</h2>
        <p className="mt-1 text-sm text-slate-500">{t("webhooksHint")}</p>
      </div>

      {/* The sentence a receiver's author has to read. Always shown, never behind a disclosure. */}
      <Notice tone="info" testId="webhooks-at-least-once">
        {t("atLeastOnce")}
      </Notice>
      <p className="text-xs text-slate-500" data-testid="webhooks-delay-notice">
        {t("delayNotice")}
      </p>

      {!configured && (
        <Notice tone="warn" testId="webhooks-unavailable">
          {t("webhooksUnavailable")}
        </Notice>
      )}

      {error && (
        <Notice tone="danger" testId="webhooks-error">
          {error}
        </Notice>
      )}
      {message && (
        <Notice tone="success" testId="webhooks-message">
          {message}
        </Notice>
      )}

      {secret !== null && (
        <Card testId="webhook-secret">
          <h3 className="font-semibold text-slate-900">{t("secretTitle")}</h3>
          <p className="mt-1 text-sm text-amber-700" data-testid="webhook-secret-warning">
            {t("secretWarning")}
          </p>
          {/* `<bdi>` because a base64url secret is left-to-right inside an Arabic paragraph. */}
          <p className="mt-3 overflow-x-auto rounded-lg bg-slate-100 px-3 py-2 font-mono text-sm">
            <bdi data-testid="webhook-secret-value">{secret}</bdi>
          </p>
          <p className="mt-2 text-xs text-slate-500">{t("secretHow")}</p>
          <div className="mt-3">
            <Button type="button" variant="secondary" onClick={() => setSecret(null)} data-testid="webhook-secret-done">
              {t("secretDone")}
            </Button>
          </div>
        </Card>
      )}

      {destinations.length === 0 ? (
        <EmptyState
          testId="webhooks-empty"
          title={t("destinationsEmptyTitle")}
          body={t("destinationsEmptyBody")}
        />
      ) : (
        <ul className="space-y-3" data-testid="webhook-list">
          {destinations.map((d) => (
            <li key={d.id}>
              <Card testId="webhook-row">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-semibold text-slate-900">{d.name}</span>
                  <Badge tone={TONE[d.state]} testId={`webhook-state-${d.id}`}>
                    {t(STATE_LABEL[d.state])}
                  </Badge>
                </div>
                {/* The hostname, never the path and never the query. */}
                <p className="mt-1 text-sm text-slate-500">
                  <bdi className="font-mono" data-testid={`webhook-host-${d.id}`}>
                    {d.endpointHost}
                  </bdi>
                </p>
                <p className="mt-1 text-sm text-slate-500" data-testid={`webhook-counts-${d.id}`}>
                  {t("statusPending")} {d.pending} · {t("statusDelivered")} {d.delivered} · {t("statusFailed")}{" "}
                  {d.failed}
                </p>
                {d.lastErrorClass !== null && OUTCOME_LABEL[d.lastErrorClass] ? (
                  <p className="mt-1 text-sm text-slate-600" data-testid={`webhook-outcome-${d.id}`}>
                    {t("lastOutcome")}: {t(OUTCOME_LABEL[d.lastErrorClass] as never)}
                  </p>
                ) : null}

                {d.state === "DISABLED" && (
                  <p className="mt-2 text-sm text-slate-600" data-testid={`webhook-disabled-${d.id}`}>
                    {t("disabledNotice")}
                  </p>
                )}

                {d.state !== "REVOKED" && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {d.state === "DISABLED" ? (
                      <Button
                        type="button"
                        disabled={busy || !configured}
                        onClick={() => void changeState(d.id, "ENABLED")}
                        data-testid={`webhook-enable-${d.id}`}
                      >
                        {t("enable")}
                      </Button>
                    ) : (
                      <Button
                        type="button"
                        variant="secondary"
                        disabled={busy}
                        onClick={() => void changeState(d.id, "DISABLED")}
                        data-testid={`webhook-disable-${d.id}`}
                      >
                        {t("disable")}
                      </Button>
                    )}
                    <Button
                      type="button"
                      variant="secondary"
                      disabled={busy || !configured}
                      onClick={() => void test(d.id)}
                      data-testid={`webhook-test-${d.id}`}
                    >
                      {t("test")}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      disabled={busy || !configured}
                      onClick={() => setConfirming({ id: d.id, action: "rotate" })}
                      data-testid={`webhook-rotate-${d.id}`}
                    >
                      {t("rotate")}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => setConfirming({ id: d.id, action: "revoke" })}
                      data-testid={`webhook-revoke-${d.id}`}
                    >
                      {t("revoke")}
                    </Button>
                  </div>
                )}

                {/* Both destructive actions ask twice, and say what cannot be undone. */}
                {confirming?.id === d.id && (
                  <Notice tone="warn" testId="webhook-confirm">
                    <span>{confirming.action === "revoke" ? t("revokeConfirm") : t("rotateConfirm")}</span>
                    <span className="mt-2 flex gap-2">
                      <Button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          confirming.action === "revoke" ? void changeState(d.id, "REVOKED") : void rotate(d.id)
                        }
                        data-testid="webhook-confirm-yes"
                      >
                        {confirming.action === "revoke" ? t("revokeYes") : t("rotateYes")}
                      </Button>
                    </span>
                  </Notice>
                )}
              </Card>
            </li>
          ))}
        </ul>
      )}

      <p className="text-xs text-slate-500" data-testid="webhooks-no-bodies">
        {t("noBodies")}
      </p>

      <Card testId="webhook-create">
        <h3 className="font-semibold text-slate-900">{t("addTitle")}</h3>
        <form className="mt-3 space-y-3" onSubmit={(e) => void create(e)}>
          <label className="block text-sm">
            <span className="font-medium text-ink">{t("nameLabel")}</span>
            <TextInput
              value={name}
              maxLength={60}
              required
              data-testid="webhook-name"
              onChange={(e) => setName(e.target.value)}
            />
            <span className="mt-1 block text-xs text-ink-muted">{t("nameHint")}</span>
          </label>

          <label className="block text-sm">
            <span className="font-medium text-ink">{t("urlLabel")}</span>
            {/* `dir="ltr"` because a URL is left-to-right even on an Arabic screen. */}
            <TextInput
              value={url}
              maxLength={2000}
              required
              inputMode="url"
              dir="ltr"
              data-testid="webhook-url"
              onChange={(e) => setUrl(e.target.value)}
            />
            <span className="mt-1 block text-xs text-ink-muted">{t("urlHint")}</span>
          </label>
          <Button type="submit" disabled={busy || !configured} data-testid="webhook-save">
            {t("add")}
          </Button>
        </form>
      </Card>
    </section>
  );
}
