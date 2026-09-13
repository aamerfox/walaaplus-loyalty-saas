"use client";

import { useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/routing";
import { Badge, Button, Field, Notice, TextInput } from "@/components/ui";

/**
 * Internal named sources, managed.
 *
 * ## What a source is here, and what it is not
 *
 * A source answers one question for a merchant: **where did this customer come from?** It is a
 * label a member of staff picks at the counter and a column in a report. Owner decision **B7** is
 * unchanged by this screen, and the screen is built so that it stays unchanged:
 *
 *  - there is **no link, URL, QR code, slug or landing page** here, because none exists on the
 *    server either. A source has an opaque token in the database that nothing returns and no route
 *    accepts;
 *  - there is **no "share" or "copy link" control**, not even a disabled one, because a disabled
 *    control is a promise that the feature is coming;
 *  - the built-in counter source is shown, badged, and carries no controls at all. It is what staff
 *    enrol through, so renaming or switching it off would stop the till working.
 *
 * Everything that decides is on the server. This sends a request and translates the answer.
 */
export interface SourceRow {
  id: string;
  name: string;
  utmSource: string;
  utmMedium: string | null;
  utmCampaign: string | null;
  active: boolean;
  isDirect: boolean;
  cardCount: number;
}

export default function SourceManager({
  businessId,
  templateId,
  sources,
  mayEdit,
}: {
  businessId: string;
  templateId: string;
  sources: SourceRow[];
  mayEdit: boolean;
}) {
  const t = useTranslations("Sources");
  const tc = useTranslations("Common");
  const router = useRouter();

  const [name, setName] = useState("");
  const [channel, setChannel] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "danger"; text: string } | null>(null);

  function refusal(code: string | undefined): string {
    if (code === "NAME_TAKEN") return t("errorNameTaken");
    if (code === "SOURCE_PROTECTED") return t("errorProtected");
    if (code === "VALIDATION_ERROR") return t("errorInvalid");
    if (code === "FORBIDDEN") return t("forbidden");
    return tc("genericError");
  }

  async function post(body: Record<string, unknown>): Promise<boolean> {
    if (busy) return false;
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/staff/sources", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ businessId, ...body }),
      });
      if (response.ok) {
        router.refresh();
        return true;
      }
      const payload = (await response.json().catch(() => null)) as { error?: { code?: string } } | null;
      setMessage({ tone: "danger", text: refusal(payload?.error?.code) });
      return false;
    } catch {
      setMessage({ tone: "danger", text: tc("genericError") });
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function onCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const ok = await post({
      action: "create",
      templateId,
      name,
      // The channel a merchant types IS the utmSource. Asking for both a "name" and a "source" would
      // be asking the same question twice in words only an analyst would tell apart.
      utmSource: channel.trim() === "" ? name.trim().toLocaleLowerCase() : channel.trim().toLocaleLowerCase(),
    });
    if (ok) {
      setName("");
      setChannel("");
      setMessage({ tone: "success", text: t("created") });
    }
  }

  return (
    <div className="space-y-4">
      <ul className="divide-y divide-border" data-testid="source-list">
        {sources.map((source) => (
          <li key={source.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
            {editingId === source.id ? (
              <form
                className="flex w-full flex-wrap items-end gap-2"
                onSubmit={async (event) => {
                  event.preventDefault();
                  if (await post({ action: "update", sourceLinkId: source.id, name: editName })) setEditingId(null);
                }}
              >
                <Field id={`source-name-${source.id}`} label={t("nameLabel")} className="min-w-48 flex-1">
                  <TextInput
                    id={`source-name-${source.id}`}
                    required
                    maxLength={120}
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    data-testid="source-edit-name"
                  />
                </Field>
                <Button type="submit" size="sm" disabled={busy} testId="source-save">
                  {t("save")}
                </Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => setEditingId(null)}>
                  {tc("cancel")}
                </Button>
              </form>
            ) : (
              <>
                <div className="min-w-0">
                  <p className="font-semibold text-ink">{source.name}</p>
                  <p className="text-xs text-ink-muted">
                    {source.isDirect ? t("builtInHint") : t("channel", { channel: source.utmSource })}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-3 text-sm text-ink-muted">
                  <span className="tabular-nums">{t("cards", { count: source.cardCount })}</span>
                  {source.isDirect ? <Badge tone="brand">{t("builtIn")}</Badge> : null}
                  <Badge tone={source.active ? "success" : "neutral"}>{source.active ? t("active") : t("inactive")}</Badge>
                  {mayEdit && !source.isDirect ? (
                    <span className="flex gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        onClick={() => {
                          setEditingId(source.id);
                          setEditName(source.name);
                        }}
                        testId="source-edit"
                      >
                        {t("rename")}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        testId={source.active ? "source-deactivate" : "source-activate"}
                        onClick={() => void post({ action: source.active ? "deactivate" : "activate", sourceLinkId: source.id })}
                      >
                        {source.active ? t("deactivate") : t("activate")}
                      </Button>
                    </span>
                  ) : null}
                </div>
              </>
            )}
          </li>
        ))}
      </ul>

      {message ? (
        <Notice tone={message.tone} testId="source-message">
          {message.text}
        </Notice>
      ) : null}

      {mayEdit ? (
        <form onSubmit={onCreate} className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end" data-testid="source-form">
          <Field id="source-name" label={t("nameLabel")} hint={t("nameHint")}>
            <TextInput
              id="source-name"
              required
              maxLength={120}
              value={name}
              onChange={(e) => setName(e.target.value)}
              data-testid="source-name"
            />
          </Field>
          <Field id="source-channel" label={t("channelLabel")} hint={t("channelHint")}>
            <TextInput
              id="source-channel"
              maxLength={60}
              dir="ltr"
              value={channel}
              onChange={(e) => setChannel(e.target.value)}
              data-testid="source-channel"
            />
          </Field>
          <Button type="submit" disabled={busy} testId="source-submit">
            {busy ? t("adding") : t("add")}
          </Button>
        </form>
      ) : null}

      <Notice tone="info" testId="sources-internal">
        {t("internalNote")}
      </Notice>
    </div>
  );
}
