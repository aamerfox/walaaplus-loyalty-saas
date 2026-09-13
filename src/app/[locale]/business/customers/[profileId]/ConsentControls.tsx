"use client";

import { useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/routing";
import { Button, Field, Notice, TextInput } from "@/components/ui";

/**
 * Recording that a customer changed their mind.
 *
 * Two buttons and a reason box. The reason is what the merchant heard — "asked me at the counter",
 * "said stop" — and it is stored on the consent record and deliberately NOT copied into the audit
 * log, which is read by more people and kept far longer.
 *
 * Nothing here edits the enrolment answer. Every change appends a record, and the history above
 * shows both, which is the point: a merchant asked to prove somebody agreed can see when, and by
 * what route.
 */
export default function ConsentControls({
  businessId,
  profileId,
  state,
}: {
  businessId: string;
  profileId: string;
  state: "GRANTED" | "WITHDRAWN" | "UNKNOWN";
}) {
  const t = useTranslations("Consent");
  const tc = useTranslations("Common");
  const router = useRouter();

  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "danger"; text: string } | null>(null);

  async function submit(next: "GRANTED" | "WITHDRAWN") {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/staff/consent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          businessId,
          customerBusinessProfileId: profileId,
          scope: "MARKETING",
          state: next,
          reason: reason.trim() || undefined,
        }),
      });
      if (response.ok) {
        setReason("");
        setMessage({ tone: "success", text: t("recorded") });
        router.refresh(); // the status and the history above are server-rendered
        return;
      }
      const payload = (await response.json().catch(() => null)) as { error?: { code?: string } } | null;
      setMessage({
        tone: "danger",
        text: payload?.error?.code === "FORBIDDEN" ? t("errorForbidden") : tc("genericError"),
      });
    } catch {
      setMessage({ tone: "danger", text: tc("genericError") });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="space-y-3"
      data-testid="consent-controls"
      onSubmit={(event: FormEvent) => event.preventDefault()}
      noValidate
    >
      <Field id="consent-reason" label={t("reasonLabel")} hint={t("reasonHint")}>
        <TextInput
          id="consent-reason"
          maxLength={280}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          data-testid="consent-reason"
        />
      </Field>

      {message ? (
        <Notice tone={message.tone} testId="consent-message">
          {message.text}
        </Notice>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {/*
         * The button that is not the current state is the one offered. A control that records the
         * state a customer is already in would add a row describing no change, and the server
         * refuses to write one anyway.
         */}
        {state !== "GRANTED" ? (
          <Button type="button" size="sm" variant="secondary" disabled={busy} testId="consent-grant" onClick={() => void submit("GRANTED")}>
            {t("recordGranted")}
          </Button>
        ) : null}
        {state !== "WITHDRAWN" ? (
          <Button type="button" size="sm" variant="danger" disabled={busy} testId="consent-withdraw" onClick={() => void submit("WITHDRAWN")}>
            {t("recordWithdrawn")}
          </Button>
        ) : null}
      </div>
    </form>
  );
}
