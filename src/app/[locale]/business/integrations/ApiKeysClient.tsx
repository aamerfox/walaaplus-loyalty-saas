"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/routing";
import { Badge, Button, Card, EmptyState, Notice, TextInput } from "@/components/ui";

/**
 * API keys, as the owner manages them.
 *
 * ## The one moment the value exists
 *
 * A key is returned exactly once, by `create` and by `rotate`, out of the value that generated it.
 * It is held in component state, shown with a copy button and a warning, and gone the moment the
 * owner dismisses it or navigates away.
 *
 * **It is never persisted anywhere on the client.** Not `localStorage`, not `sessionStorage`, not a
 * cookie, not the URL, not a form value that a browser could offer to save. React state and the
 * clipboard, both of which the owner controls, and nothing else. `tests/unit/api-contract.test.ts`
 * reads this file and fails the gate if a storage API appears in it.
 *
 * ## What the list shows, and what it cannot
 *
 * A name, the **public** prefix, a state, and three dates. The prefix is how an owner recognises
 * which of their keys a row is — it is the first twelve characters of a value whose remaining 43
 * are the secret, and it is stored in its own column precisely so this screen has something safe to
 * print. There is no reveal button, because there is nothing to reveal: the digest is one-way and
 * no route in this product can produce a key from a row.
 */

export type ApiKeyStateName = "ACTIVE" | "EXPIRED" | "REVOKED";

export interface ApiKeyRow {
  id: string;
  name: string;
  /** `wpk_xxxxxxxx` — the public half. Never the secret, which is not stored. */
  keyPrefix: string;
  state: ApiKeyStateName;
  issuedAt: string;
  expiresAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
  /** False once the clock has passed `expiresAt`, whether or not the sweep has run. */
  usable: boolean;
}

const TONE: Record<ApiKeyStateName, "success" | "warn" | "neutral"> = {
  ACTIVE: "success",
  EXPIRED: "neutral",
  REVOKED: "warn",
};

/** Written out rather than derived from the enum name, so a rename cannot silently lose a label. */
const STATE_LABEL = {
  ACTIVE: "stateActive",
  EXPIRED: "stateExpired",
  REVOKED: "stateRevoked",
} as const;

interface Props {
  businessId: string;
  keys: ApiKeyRow[];
  /** `MAX_ACTIVE_KEYS_PER_BUSINESS`, so the screen states the ceiling rather than discovering it. */
  maxActive: number;
  /** `KEY_TTL_DAYS`, so the lifetime is stated before a key is created rather than after. */
  ttlDays: number;
}

export default function ApiKeysClient({ businessId, keys, maxActive, ttlDays }: Props) {
  const t = useTranslations("ApiKeys");
  const router = useRouter();

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The one value that exists outside the database, and only until the owner dismisses it. */
  const [secret, setSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirming, setConfirming] = useState<{ id: string; action: "revoke" | "rotate" } | null>(null);
  const [name, setName] = useState("");
  const [rotateName, setRotateName] = useState("");

  /**
   * Where the keyboard goes when a key appears.
   *
   * A sighted owner sees a card arrive above the form. Somebody using a screen reader gets nothing:
   * the card is not a live region and the focus stays on the Create button they just pressed, so
   * the one moment this value exists can pass unnoticed — and it cannot be recovered afterwards.
   * That is a worse outcome here than on any other screen in the product, because every other
   * screen's content is still there tomorrow.
   *
   * So the region is announced AND focus moves into it. The live region alone would read the value
   * at somebody without putting them anywhere useful; moving focus alone would be silent for
   * anyone whose reader does not announce the focused container. Together they say "this happened"
   * and leave the user standing next to the thing they have to copy.
   */
  const revealRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (secret !== null) revealRef.current?.focus();
  }, [secret]);

  const activeCount = keys.filter((k) => k.state === "ACTIVE").length;
  const atCeiling = activeCount >= maxActive;

  async function post(body: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/staff/api-keys", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ businessId, ...body }),
      });
      const payload = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      if (!res.ok) {
        /*
         * One of our own translated sentences, selected by the server's error CODE.
         *
         * Nothing from the response body is rendered. The server's message is written in English
         * for a log; this screen is bilingual and the owner should read their own language. The
         * two conflict codes are distinguished because "you already have five" and "that key is
         * finished" call for different actions.
         */
        const code = (payload?.error as { code?: string } | undefined)?.code;
        setError(
          res.status === 403
            ? t("errorForbidden")
            : code === "API_KEY_LIMIT_REACHED"
              ? t("errorLimit", { max: maxActive })
              : code === "API_KEY_NOT_ACTIVE"
                ? t("errorNotActive")
                : code === "NAME_TAKEN"
                  ? t("errorNameTaken")
                  : res.status === 400
                    ? t("errorInvalid")
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

  /** Show a freshly minted value. Resets the copy acknowledgement so it is never stale. */
  function reveal(payload: Record<string, unknown>) {
    setCopied(false);
    setSecret(String(payload.apiKey ?? ""));
  }

  async function create(e: React.FormEvent) {
    e.preventDefault();
    const payload = await post({ action: "create", name: name.trim() });
    if (!payload) return;
    setName("");
    reveal(payload);
    router.refresh();
  }

  async function rotate(id: string) {
    const payload = await post({ action: "rotate", keyId: id, name: rotateName.trim() });
    if (!payload) return;
    setConfirming(null);
    setRotateName("");
    reveal(payload);
    router.refresh();
  }

  async function revoke(id: string) {
    if (!(await post({ action: "revoke", keyId: id }))) return;
    setConfirming(null);
    router.refresh();
  }

  /**
   * Copy, with a fallback and with an honest failure.
   *
   * `navigator.clipboard` needs a secure context and the user's permission, and it is absent or
   * refused often enough that a button which silently does nothing would be worse than no button.
   * On failure the value stays on screen and selectable, and the owner is told to copy it by hand —
   * the value is not lost, only the convenience is.
   */
  async function copy() {
    if (secret === null) return;
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
    } catch {
      setCopied(false);
      setError(t("copyFailed"));
    }
  }

  return (
    <section className="space-y-4" data-testid="api-keys">
      <div>
        <h2 className="text-lg font-semibold text-slate-900">{t("title")}</h2>
        <p className="mt-1 text-sm text-slate-500">{t("hint")}</p>
      </div>

      {/* What the key can and cannot do, before one exists. */}
      <Notice tone="info" testId="api-keys-scope">
        {t("scopeNotice")}
      </Notice>
      <p className="text-xs text-slate-500" data-testid="api-keys-lifetime">
        {t("lifetimeNotice", { days: ttlDays, max: maxActive })}
      </p>

      {error && (
        <Notice tone="danger" testId="api-keys-error">
          {error}
        </Notice>
      )}

      {secret !== null && (
        /*
         * `role="status"` matches what `Notice` already does for every other transient message in
         * this product, so assistive technology treats this the same way. `tabIndex={-1}` makes the
         * region focusable by script without adding it to the tab order.
         */
        <div ref={revealRef} role="status" aria-live="polite" tabIndex={-1} className="outline-none">
        <Card testId="api-key-secret">
          <h3 className="font-semibold text-slate-900">{t("secretTitle")}</h3>
          <p className="mt-1 text-sm text-amber-700" data-testid="api-key-secret-warning">
            {t("secretWarning")}
          </p>
          {/* `<bdi>` because a base64url key is left-to-right inside an Arabic paragraph. */}
          <p className="mt-3 overflow-x-auto rounded-lg bg-slate-100 px-3 py-2 font-mono text-sm">
            <bdi data-testid="api-key-secret-value">{secret}</bdi>
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button type="button" onClick={() => void copy()} data-testid="api-key-secret-copy">
              {t("copy")}
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setSecret(null);
                setCopied(false);
              }}
              data-testid="api-key-secret-done"
            >
              {t("secretDone")}
            </Button>
            {/*
              * Its own live region, and always present rather than conditionally rendered: a region
              * that appears at the same moment its text does is a region some readers never
              * announce, because they were not watching an element that did not exist yet.
              */}
            <span
              role="status"
              aria-live="polite"
              className="text-sm text-emerald-700"
              data-testid="api-key-secret-copied"
            >
              {copied ? t("copied") : ""}
            </span>
          </div>
          <p className="mt-3 text-xs text-slate-500">{t("secretHow")}</p>
        </Card>
        </div>
      )}

      <Card testId="api-key-create">
        <h3 className="font-semibold text-slate-900">{t("createTitle")}</h3>
        <form className="mt-3 space-y-3" onSubmit={(e) => void create(e)}>
          <div>
            <label className="block text-sm font-medium text-slate-700" htmlFor="api-key-name">
              {t("nameLabel")}
            </label>
            <TextInput
              id="api-key-name"
              className="mt-1"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={60}
              required
              data-testid="api-key-name"
            />
            <p className="mt-1 text-xs text-slate-500">{t("nameHint")}</p>
          </div>
          <Button type="submit" disabled={busy || atCeiling} data-testid="api-key-create-submit">
            {t("create")}
          </Button>
          {atCeiling && (
            <p className="text-sm text-slate-600" data-testid="api-keys-at-ceiling">
              {t("atCeiling", { max: maxActive })}
            </p>
          )}
        </form>
      </Card>

      {keys.length === 0 ? (
        <EmptyState testId="api-keys-empty" title={t("emptyTitle")} body={t("emptyBody")} />
      ) : (
        <ul className="space-y-3" data-testid="api-key-list">
          {keys.map((k) => (
            <li key={k.id}>
              <Card testId="api-key-row">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-semibold text-slate-900">{k.name}</span>
                  <Badge tone={TONE[k.state]} testId={`api-key-state-${k.id}`}>
                    {t(STATE_LABEL[k.state])}
                  </Badge>
                </div>

                {/* The public prefix. The remaining 43 characters are the secret and are not stored. */}
                <p className="mt-1 text-sm text-slate-500">
                  <bdi className="font-mono" data-testid={`api-key-prefix-${k.id}`}>
                    {k.keyPrefix}…
                  </bdi>
                </p>

                <p className="mt-1 text-sm text-slate-500" data-testid={`api-key-dates-${k.id}`}>
                  {t("issued")} <bdi>{k.issuedAt.slice(0, 10)}</bdi> · {t("expires")}{" "}
                  <bdi>{k.expiresAt.slice(0, 10)}</bdi> ·{" "}
                  {k.lastUsedAt === null ? t("neverUsed") : `${t("lastUsed")} ${k.lastUsedAt.slice(0, 10)}`}
                </p>

                {k.state === "ACTIVE" && !k.usable && (
                  <p className="mt-2 text-sm text-slate-600" data-testid={`api-key-lapsed-${k.id}`}>
                    {t("lapsedNotice")}
                  </p>
                )}

                {k.state === "ACTIVE" && (
                  <div className="mt-3 space-y-3">
                    {confirming?.id === k.id && confirming.action === "rotate" ? (
                      <div className="space-y-2" data-testid={`api-key-rotate-form-${k.id}`}>
                        <p className="text-sm text-slate-700">{t("rotateConfirm")}</p>
                        <TextInput
                          aria-label={t("nameLabel")}
                          value={rotateName}
                          onChange={(e) => setRotateName(e.target.value)}
                          maxLength={60}
                          data-testid={`api-key-rotate-name-${k.id}`}
                        />
                        <div className="flex flex-wrap gap-2">
                          <Button
                            type="button"
                            disabled={busy || rotateName.trim().length === 0}
                            onClick={() => void rotate(k.id)}
                            data-testid={`api-key-rotate-yes-${k.id}`}
                          >
                            {t("rotateYes")}
                          </Button>
                          <Button type="button" variant="secondary" onClick={() => setConfirming(null)}>
                            {t("cancel")}
                          </Button>
                        </div>
                      </div>
                    ) : confirming?.id === k.id && confirming.action === "revoke" ? (
                      <div className="space-y-2" data-testid={`api-key-revoke-form-${k.id}`}>
                        <p className="text-sm text-slate-700">{t("revokeConfirm")}</p>
                        <div className="flex flex-wrap gap-2">
                          <Button
                            type="button"
                            variant="danger"
                            disabled={busy}
                            onClick={() => void revoke(k.id)}
                            data-testid={`api-key-revoke-yes-${k.id}`}
                          >
                            {t("revokeYes")}
                          </Button>
                          <Button type="button" variant="secondary" onClick={() => setConfirming(null)}>
                            {t("cancel")}
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex flex-wrap gap-2">
                        <Button
                          type="button"
                          variant="secondary"
                          disabled={busy}
                          onClick={() => {
                            setRotateName(k.name);
                            setConfirming({ id: k.id, action: "rotate" });
                          }}
                          data-testid={`api-key-rotate-${k.id}`}
                        >
                          {t("rotate")}
                        </Button>
                        <Button
                          type="button"
                          variant="secondary"
                          disabled={busy}
                          onClick={() => setConfirming({ id: k.id, action: "revoke" })}
                          data-testid={`api-key-revoke-${k.id}`}
                        >
                          {t("revoke")}
                        </Button>
                      </div>
                    )}
                  </div>
                )}
              </Card>
            </li>
          ))}
        </ul>
      )}

      <p className="text-xs text-slate-500" data-testid="api-keys-readonly">
        {t("readOnlyNotice")}
      </p>
    </section>
  );
}
