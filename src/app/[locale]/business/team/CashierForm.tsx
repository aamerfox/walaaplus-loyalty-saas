"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";

/**
 * Create one cashier account.
 *
 * The password is typed here and sent once. It is never echoed back by the API, never stored in
 * component state after submission, and never written to the audit log — the owner is told the
 * account exists, and hands the password over themselves.
 */
export default function CashierForm({ businessId }: { businessId: string }) {
  const t = useTranslations("Staff");
  const tc = useTranslations("Common");
  const router = useRouter();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setMessage(null);

    try {
      const response = await fetch("/api/staff/cashiers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ businessId, email, password, firstName, lastName: lastName.trim() || undefined }),
      });

      if (response.ok) {
        setMessage({ tone: "ok", text: t("created") });
        setEmail("");
        setPassword("");
        setFirstName("");
        setLastName("");
        router.refresh(); // the list above is server-rendered
        return;
      }
      if (response.status === 409) setMessage({ tone: "error", text: t("emailTaken") });
      else if (response.status === 403) setMessage({ tone: "error", text: t("ownerOnly") });
      else setMessage({ tone: "error", text: tc("genericError") });
    } catch {
      setMessage({ tone: "error", text: tc("genericError") });
    } finally {
      setPending(false);
    }
  }

  return (
    <form
      onSubmit={onSubmit}
      data-testid="cashier-form"
      className="space-y-4 rounded-2xl border border-border bg-surface p-5"
    >
      <h2 className="font-display text-lg font-bold text-ink">{t("createTitle")}</h2>

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block text-sm">
          <span className="mb-1 block font-semibold text-ink">{t("firstName")}</span>
          <input
            required
            value={firstName}
            onChange={(e) => setFirstName(e.target.value)}
            data-testid="cashier-firstName"
            className="h-11 w-full rounded-xl border border-border bg-surface px-4 text-sm text-ink outline-none transition-colors focus:border-turquoise-500"
          />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-semibold text-ink">{t("lastName")}</span>
          <input
            value={lastName}
            onChange={(e) => setLastName(e.target.value)}
            className="h-11 w-full rounded-xl border border-border bg-surface px-4 text-sm text-ink outline-none transition-colors focus:border-turquoise-500"
          />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-semibold text-ink">{t("email")}</span>
          <input
            required
            type="email"
            autoComplete="off"
            dir="ltr"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            data-testid="cashier-email"
            className="h-11 w-full rounded-xl border border-border bg-surface px-4 text-sm text-ink outline-none transition-colors focus:border-turquoise-500"
          />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-semibold text-ink">{t("password")}</span>
          <input
            required
            type="password"
            autoComplete="new-password"
            minLength={10}
            dir="ltr"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            data-testid="cashier-password"
            className="h-11 w-full rounded-xl border border-border bg-surface px-4 text-sm text-ink outline-none transition-colors focus:border-turquoise-500"
          />
          <span className="mt-1 block text-xs text-ink-faint">{t("passwordHint")}</span>
        </label>
      </div>

      {message !== null && (
        <p
          role="status"
          data-testid="cashier-message"
          className={`rounded-xl px-3 py-2 text-sm ${
            message.tone === "ok"
              ? "bg-success-bg text-success-ink dark:bg-mint-500/10 dark:text-success-ink"
              : "bg-danger-bg text-danger-ink dark:bg-turquoise-500/20 dark:text-danger-ink"
          }`}
        >
          {message.text}
        </p>
      )}

      <button
        type="submit"
        disabled={pending}
        data-testid="cashier-submit"
        className="rounded-xl bg-navy-900 px-5 py-2.5 font-semibold text-white disabled:opacity-60"
      >
        {pending ? t("creating") : t("create")}
      </button>
    </form>
  );
}
