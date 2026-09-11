"use client";

import { useState, type FormEvent } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";

/**
 * The enrollment form.
 *
 * Two details are security, not styling:
 *
 *  - the **honeypot** input. It is present in the DOM, labelled plausibly for a script, and hidden
 *    with the clip-based pattern rather than `display:none`, which many bots skip. A human never
 *    meets it; a form-filling bot fills every input it finds, and the server answers a filled one
 *    exactly like an ordinary failure;
 *  - the **generic failure text**. The server refuses to say whether a phone number is already a
 *    customer of this café, and this component must not reconstruct that signal either. Only two
 *    specific messages are shown — an unusable phone number and a dead link, both of which the
 *    customer can act on — and everything else is one generic line.
 */
export default function JoinForm({ sourceToken }: { sourceToken: string }) {
  const t = useTranslations("Join");
  const locale = useLocale();
  const router = useRouter();

  const [phone, setPhone] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [consent, setConsent] = useState(false);
  const [honeypot, setHoneypot] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return; // a double tap must not become two requests
    setPending(true);
    setError(null);

    try {
      const response = await fetch("/api/enroll", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sourceToken,
          phone,
          firstName: firstName.trim() || undefined,
          lastName: lastName.trim() || undefined,
          marketingConsent: consent,
          companyWebsite: honeypot,
        }),
      });

      if (response.ok) {
        const { cardToken } = (await response.json()) as { cardToken: string };
        // Replace, not push: the back button should not resubmit the form.
        router.replace(`/${locale}/card/${cardToken}`);
        return;
      }

      if (response.status === 429) setError(t("rateLimited"));
      else if (response.status === 404) setError(t("linkNotFound"));
      else if (response.status === 400) setError(t("invalidPhone"));
      else setError(t("failed"));
    } catch {
      setError(t("failed"));
    } finally {
      setPending(false);
    }
  }

  return (
    <form
      onSubmit={onSubmit}
      noValidate
      data-testid="join-form"
      className="space-y-4 rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900"
    >
      <div>
        <label htmlFor="phone" className="mb-1 block text-sm font-medium text-zinc-700 dark:text-zinc-300">
          {t("phoneLabel")}
        </label>
        <input
          id="phone"
          name="phone"
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          required
          dir="ltr"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder={t("phonePlaceholder")}
          className="w-full rounded-xl border border-zinc-300 px-4 py-3 text-lg text-zinc-900 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
        />
        <p className="mt-1 text-xs text-zinc-400">{t("phoneHelp")}</p>
      </div>

      <div>
        <label htmlFor="firstName" className="mb-1 block text-sm font-medium text-zinc-700 dark:text-zinc-300">
          {t("firstNameLabel")}
        </label>
        <input
          id="firstName"
          name="firstName"
          autoComplete="given-name"
          value={firstName}
          onChange={(e) => setFirstName(e.target.value)}
          placeholder={t("firstNamePlaceholder")}
          className="w-full rounded-xl border border-zinc-300 px-4 py-3 text-zinc-900 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
        />
      </div>

      <div>
        <label htmlFor="lastName" className="mb-1 block text-sm font-medium text-zinc-700 dark:text-zinc-300">
          {t("lastNameLabel")}
        </label>
        <input
          id="lastName"
          name="lastName"
          autoComplete="family-name"
          value={lastName}
          onChange={(e) => setLastName(e.target.value)}
          className="w-full rounded-xl border border-zinc-300 px-4 py-3 text-zinc-900 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
        />
      </div>

      {/*
        Honeypot.

        Hidden with the clip-based `sr-only` pattern rather than `display:none` — which many bots
        skip — and rather than a large negative offset, which pushes the document's edge and, in
        RTL, moves every other control out from under the pointer. `aria-hidden` and `tabIndex={-1}`
        keep it away from people and assistive technology; a form-filling script still sees an
        ordinary text input.
      */}
      <div aria-hidden="true" className="sr-only">
        <label htmlFor="companyWebsite">Company website</label>
        <input
          id="companyWebsite"
          name="companyWebsite"
          type="text"
          tabIndex={-1}
          autoComplete="off"
          value={honeypot}
          onChange={(e) => setHoneypot(e.target.value)}
        />
      </div>

      <label className="flex items-start gap-3 text-sm text-zinc-600 dark:text-zinc-400">
        <input
          type="checkbox"
          name="marketingConsent"
          checked={consent}
          onChange={(e) => setConsent(e.target.checked)}
          className="mt-0.5 h-5 w-5 rounded border-zinc-300 text-indigo-600 focus:ring-indigo-500"
        />
        <span>{t("consentLabel")}</span>
      </label>

      {error !== null && (
        <p role="alert" data-testid="join-error" className="rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-500/10 dark:text-rose-400">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={pending}
        data-testid="join-submit"
        className="w-full rounded-xl bg-indigo-600 py-4 text-lg font-bold text-white shadow-lg transition-colors hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {pending ? t("submitting") : t("submit")}
      </button>
    </form>
  );
}
