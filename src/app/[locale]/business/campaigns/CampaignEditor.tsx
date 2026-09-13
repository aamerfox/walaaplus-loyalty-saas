"use client";

import { useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/routing";
import { Badge, Button, Card, Field, Notice, SelectInput, TextInput } from "@/components/ui";

/**
 * Writing a campaign draft, and seeing what it would look like.
 *
 * ## Nothing here sends anything
 *
 * The banner says so, and it is true structurally rather than as a promise: the route this form
 * posts to has no send action, the domain has no sent state, and there is no provider, queue or
 * worker behind any of it.
 *
 * ## The preview is rendered in the browser, from constants
 *
 * `{{firstName}}` becomes a SAMPLE name from the placeholder contract — never a real customer's.
 * No query runs while somebody types, and no customer is read to draw a preview, which is why a
 * preview cannot leak one.
 *
 * The `check` call is the one request the editor makes while typing, and it is pure: the server
 * validates the placeholder grammar and returns problems. It reads no customer and touches no
 * database. It exists so a merchant learns that `{{programName}}` is unavailable — and why — before
 * they save rather than after.
 */

/** Kept in step with `src/server/campaigns/placeholders.ts`, which is the authority. */
const SAMPLES: Record<string, { en: string; ar: string }> = {
  firstName: { en: "Layla", ar: "ليلى" },
  businessName: { en: "Your business", ar: "نشاطك التجاري" },
};

const PLACEHOLDER = /\{\{\s*([A-Za-z][A-Za-z0-9]*)\s*\}\}/g;

function renderSample(text: string, locale: "en" | "ar"): string {
  return text.replace(PLACEHOLDER, (whole, name: string) => SAMPLES[name]?.[locale] ?? whole);
}

export interface CampaignEditorProps {
  businessId: string;
  /** Present when editing; absent when writing a new draft. */
  campaignId?: string;
  initial: { name: string; locale: "en" | "ar"; channel: string; segmentId: string; subject: string; body: string };
  segments: { id: string; name: string }[];
  /** Editing an existing draft changes only its content; the name and channel are fixed at creation. */
  mode: "create" | "revise";
}

interface Problem {
  field: string;
  token: string;
  reason: string;
}

export default function CampaignEditor(props: CampaignEditorProps) {
  const t = useTranslations("Campaigns");
  const tc = useTranslations("Common");
  const router = useRouter();

  const [name, setName] = useState(props.initial.name);
  const [locale, setLocale] = useState<"en" | "ar">(props.initial.locale);
  const [channel, setChannel] = useState(props.initial.channel);
  const [segmentId, setSegmentId] = useState(props.initial.segmentId);
  const [subject, setSubject] = useState(props.initial.subject);
  const [body, setBody] = useState(props.initial.body);

  const [problems, setProblems] = useState<Problem[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "danger"; text: string } | null>(null);

  async function post(payload: Record<string, unknown>): Promise<{ ok: boolean; data?: unknown; code?: string }> {
    const response = await fetch("/api/staff/campaigns", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ businessId: props.businessId, ...payload }),
    });
    const data = (await response.json().catch(() => null)) as { error?: { code?: string } } | null;
    return response.ok ? { ok: true, data } : { ok: false, code: data?.error?.code };
  }

  /** Ask the server whether every placeholder is one it can honour. Pure on both sides. */
  async function check() {
    if (body.trim() === "") return;
    const response = await fetch("/api/staff/campaigns", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        businessId: props.businessId,
        action: "check",
        subject: subject.trim() || undefined,
        body,
      }),
    });
    if (!response.ok) return;
    const payload = (await response.json()) as { problems: Problem[] };
    setProblems(payload.problems);
  }

  function refusal(code: string | undefined): string {
    if (code === "NAME_TAKEN") return t("errorNameTaken");
    if (code === "VALIDATION_ERROR") return t("errorInvalid");
    if (code === "FORBIDDEN") return t("errorForbidden");
    return tc("genericError");
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setMessage(null);

    const content = { subject: subject.trim() || undefined, body };
    const result =
      props.mode === "create"
        ? await post({ action: "create", name, locale, channel, segmentId: segmentId || undefined, ...content })
        : await post({ action: "revise", campaignId: props.campaignId, ...content });
    setBusy(false);

    if (result.ok) {
      setMessage({ tone: "success", text: props.mode === "create" ? t("created") : t("revised") });
      if (props.mode === "create") router.push("/business/campaigns");
      else router.refresh();
      return;
    }
    // A refused save is almost always a placeholder, so the field-level list is refreshed with it.
    void check();
    setMessage({ tone: "danger", text: refusal(result.code) });
  }

  return (
    <Card>
      {/*
       * No draft-only banner here: both screens that mount this editor say it above, and a warning
       * repeated twice on one screen is read once. The badge beside the save button carries the
       * reminder to the place a merchant might forget it.
       */}
      <form className="mt-4 space-y-5" onSubmit={onSubmit} data-testid="campaign-editor" noValidate>
        {props.mode === "create" ? (
          <div className="grid gap-4 sm:grid-cols-3">
            <Field id="campaign-name" label={t("nameLabel")}>
              <TextInput
                id="campaign-name"
                required
                maxLength={80}
                value={name}
                onChange={(e) => setName(e.target.value)}
                data-testid="campaign-name"
              />
            </Field>
            <Field id="campaign-locale" label={t("localeLabel")} hint={t("localeHint")}>
              <SelectInput
                id="campaign-locale"
                value={locale}
                onChange={(e) => setLocale(e.target.value as "en" | "ar")}
                data-testid="campaign-locale"
              >
                <option value="ar">{t("localeAr")}</option>
                <option value="en">{t("localeEn")}</option>
              </SelectInput>
            </Field>
            <Field id="campaign-channel" label={t("channelLabel")} hint={t("channelHint")}>
              <SelectInput
                id="campaign-channel"
                value={channel}
                onChange={(e) => setChannel(e.target.value)}
                data-testid="campaign-channel"
              >
                {(["PUSH", "SMS", "WHATSAPP", "EMAIL"] as const).map((option) => (
                  <option key={option} value={option}>
                    {t(`channel.${option}`)}
                  </option>
                ))}
              </SelectInput>
            </Field>
          </div>
        ) : null}

        {props.mode === "create" ? (
          <Field id="campaign-segment" label={t("audienceLabel")} hint={t("audienceHint")}>
            <SelectInput
              id="campaign-segment"
              value={segmentId}
              onChange={(e) => setSegmentId(e.target.value)}
              data-testid="campaign-segment"
            >
              <option value="">{t("noAudience")}</option>
              {props.segments.map((segment) => (
                <option key={segment.id} value={segment.id}>
                  {segment.name}
                </option>
              ))}
            </SelectInput>
          </Field>
        ) : null}

        <Field id="campaign-subject" label={t("subjectLabel")} hint={t("subjectHint")}>
          <TextInput
            id="campaign-subject"
            maxLength={120}
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            onBlur={() => void check()}
            data-testid="campaign-subject"
          />
        </Field>

        <Field id="campaign-body" label={t("bodyLabel")} hint={t("bodyHint")}>
          <textarea
            id="campaign-body"
            required
            rows={5}
            maxLength={1000}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            onBlur={() => void check()}
            data-testid="campaign-body"
            className="w-full rounded-xl border border-border bg-surface px-4 py-3 text-sm text-ink outline-none transition-colors focus:border-turquoise-500"
          />
        </Field>

        <div className="space-y-2" data-testid="campaign-placeholders">
          <p className="text-sm font-semibold text-ink">{t("placeholdersTitle")}</p>
          <div className="flex flex-wrap gap-2">
            {Object.keys(SAMPLES).map((placeholder) => (
              <Button
                key={placeholder}
                type="button"
                size="sm"
                variant="secondary"
                testId={`placeholder-${placeholder}`}
                onClick={() => setBody((current) => `${current}{{${placeholder}}}`)}
              >
                {t(`placeholder.${placeholder}`)}
              </Button>
            ))}
          </div>
          {/* The ones that exist in the domain and are deliberately withheld, with the reason. */}
          <p className="text-xs text-ink-muted">{t("withheldNote")}</p>
        </div>

        {problems.length > 0 ? (
          <Notice tone="danger" testId="campaign-problems">
            {problems
              .map((problem) =>
                t(`problem.${problem.reason}`, { token: problem.token, field: t(`field.${problem.field}`) }),
              )
              .join(" ")}
          </Notice>
        ) : null}

        <div className="space-y-2" data-testid="campaign-preview">
          <p className="text-sm font-semibold text-ink">{t("previewTitle")}</p>
          <p className="text-xs text-ink-muted">{t("previewNote")}</p>
          {/*
           * `dir` follows the DRAFT's language, not the screen's: a merchant writing an Arabic
           * message on an English interface must see it laid out the way its readers will.
           */}
          <div
            dir={locale === "ar" ? "rtl" : "ltr"}
            lang={locale}
            className="rounded-xl border border-border bg-surface-muted p-4"
          >
            {subject.trim() ? (
              <p className="font-display font-bold text-ink" data-testid="preview-subject">
                {renderSample(subject, locale)}
              </p>
            ) : null}
            <p className="whitespace-pre-wrap leading-relaxed text-ink" data-testid="preview-body">
              {renderSample(body, locale) || t("previewEmpty")}
            </p>
          </div>
        </div>

        {message ? (
          <Notice tone={message.tone} testId="campaign-message">
            {message.text}
          </Notice>
        ) : null}

        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={busy} testId="campaign-save">
            {busy ? t("saving") : props.mode === "create" ? t("create") : t("saveRevision")}
          </Button>
          <Badge tone="warn">{t("draftOnlyBadge")}</Badge>
        </div>
      </form>
    </Card>
  );
}
