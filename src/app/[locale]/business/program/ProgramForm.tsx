"use client";

import { useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";
import ProgramSummary from "./ProgramSummary";

interface CreatedProgram {
  programName: string;
  stampsRequiredPerReward: number;
  rewardName: string;
  created: boolean;
}

/**
 * Create the business's one stamp card.
 *
 * Five fields, and the shortest list that can describe a café loyalty card: what it is called,
 * how many stamps buy the reward, what the reward is, an optional line of detail, and an optional
 * welcome bonus. Everything else the mechanics contract can express — earn modes, spend blocks,
 * daily limits, purchase amounts — is fixed by the server for Phase 1a and is deliberately not on
 * this screen. A form that can configure something the pilot does not support is a form that
 * generates support questions.
 *
 * Two guards against the double click, because this creates something that may exist only once:
 * the button disables while in flight, and the server answers a second submission with the
 * program that already exists rather than an error. So a merchant who taps twice, or a flaky
 * connection that retries, still lands on the link.
 *
 * There is deliberately no `router.refresh()` after success. It was here, and it was wrong: the
 * refreshed server render replaces this component with the page's own "program exists" branch,
 * which has nothing to confirm and so drops the "your card is ready" message. The owner saw their
 * confirmation appear and vanish, and an end-to-end test caught it only when the machine was
 * busy enough to make the race visible. The response carries everything this screen needs,
 * including the QR, and a reload reads the same state from the server.
 */
export default function ProgramForm({ locale, businessId }: { locale: string; businessId: string }) {
  const t = useTranslations("Program");
  const tc = useTranslations("Common");

  const [name, setName] = useState("");
  const [stamps, setStamps] = useState("6");
  const [rewardName, setRewardName] = useState("");
  const [rewardDescription, setRewardDescription] = useState("");
  const [welcomeStamps, setWelcomeStamps] = useState("0");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CreatedProgram | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);

    try {
      const response = await fetch("/api/staff/program", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          businessId,
          name,
          stampsRequiredPerReward: Number(stamps),
          rewardName,
          rewardDescription: rewardDescription.trim() || undefined,
          welcomeStamps: Number(welcomeStamps) || undefined,
        }),
      });

      if (response.ok) {
        setResult((await response.json()) as CreatedProgram);
        return;
      }

      // The welcome-bonus rule is the one a merchant can plausibly trip, so it gets its own
      // sentence. Everything else is generic: an error message is not the place to teach the
      // shape of the request body.
      if (response.status === 400) setError(t("invalid"));
      else if (response.status === 403) setError(t("forbidden"));
      else setError(tc("genericError"));
    } catch {
      setError(tc("genericError"));
    } finally {
      setPending(false);
    }
  }

  if (result) {
    return (
      <ProgramSummary
        locale={locale}
        programName={result.programName}
        stampsRequiredPerReward={result.stampsRequiredPerReward}
        rewardName={result.rewardName}
        welcomeStamps={Number(welcomeStamps) || 0}
        justCreated={result.created}
      />
    );
  }

  return (
    <form
      onSubmit={onSubmit}
      noValidate
      data-testid="program-form"
      className="max-w-xl space-y-5 rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900"
    >
      <p className="text-sm text-zinc-500 dark:text-zinc-400">{t("intro")}</p>

      <Field id="program-name" label={t("nameLabel")} help={t("nameHelp")}>
        <input
          id="program-name"
          required
          maxLength={120}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("namePlaceholder")}
          className={INPUT}
        />
      </Field>

      <Field id="stamps" label={t("stampsLabel")} help={t("stampsHelp")}>
        <input
          id="stamps"
          type="number"
          inputMode="numeric"
          required
          min={1}
          max={100}
          value={stamps}
          onChange={(e) => setStamps(e.target.value)}
          dir="ltr"
          className={INPUT}
        />
      </Field>

      <Field id="reward-name" label={t("rewardLabel")} help={t("rewardHelp")}>
        <input
          id="reward-name"
          required
          maxLength={120}
          value={rewardName}
          onChange={(e) => setRewardName(e.target.value)}
          placeholder={t("rewardPlaceholder")}
          className={INPUT}
        />
      </Field>

      <Field id="reward-description" label={t("rewardDescriptionLabel")} help={t("optional")}>
        <input
          id="reward-description"
          maxLength={500}
          value={rewardDescription}
          onChange={(e) => setRewardDescription(e.target.value)}
          className={INPUT}
        />
      </Field>

      <Field id="welcome-stamps" label={t("welcomeLabel")} help={t("welcomeHelp")}>
        <input
          id="welcome-stamps"
          type="number"
          inputMode="numeric"
          min={0}
          max={50}
          value={welcomeStamps}
          onChange={(e) => setWelcomeStamps(e.target.value)}
          dir="ltr"
          className={INPUT}
        />
      </Field>

      {error !== null && (
        <p role="alert" data-testid="program-error" className="rounded-xl bg-danger-bg px-3 py-2 text-sm text-danger-ink dark:bg-turquoise-500/20 dark:text-danger-ink">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={pending}
        data-testid="program-submit"
        className="w-full rounded-xl bg-navy-900 py-4 text-lg font-bold text-white shadow-lg transition-colors hover:bg-navy-800 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {pending ? t("creating") : t("create")}
      </button>
    </form>
  );
}

const INPUT =
  "w-full rounded-xl border border-zinc-300 px-4 py-3 text-zinc-900 outline-none focus:border-navy-200 focus:ring-2 focus:ring-turquoise-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100";

function Field({ id, label, help, children }: { id: string; label: string; help: string; children: React.ReactNode }) {
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-sm font-medium text-zinc-700 dark:text-zinc-300">
        {label}
      </label>
      {children}
      <p className="mt-1 text-xs text-zinc-400">{help}</p>
    </div>
  );
}
