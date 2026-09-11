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
      className="space-y-4 rounded-2xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900"
    >
      <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">{t("createTitle")}</h2>

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block text-sm">
          <span className="mb-1 block font-medium text-zinc-700 dark:text-zinc-300">{t("firstName")}</span>
          <input
            required
            value={firstName}
            onChange={(e) => setFirstName(e.target.value)}
            data-testid="cashier-firstName"
            className="w-full rounded-xl border border-zinc-300 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
          />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-medium text-zinc-700 dark:text-zinc-300">{t("lastName")}</span>
          <input
            value={lastName}
            onChange={(e) => setLastName(e.target.value)}
            className="w-full rounded-xl border border-zinc-300 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
          />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-medium text-zinc-700 dark:text-zinc-300">{t("email")}</span>
          <input
            required
            type="email"
            autoComplete="off"
            dir="ltr"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            data-testid="cashier-email"
            className="w-full rounded-xl border border-zinc-300 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
          />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-medium text-zinc-700 dark:text-zinc-300">{t("password")}</span>
          <input
            required
            type="password"
            autoComplete="new-password"
            minLength={10}
            dir="ltr"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            data-testid="cashier-password"
            className="w-full rounded-xl border border-zinc-300 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
          />
          <span className="mt-1 block text-xs text-zinc-400">{t("passwordHint")}</span>
        </label>
      </div>

      {message !== null && (
        <p
          role="status"
          data-testid="cashier-message"
          className={`rounded-xl px-3 py-2 text-sm ${
            message.tone === "ok"
              ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400"
              : "bg-rose-50 text-rose-700 dark:bg-rose-500/10 dark:text-rose-400"
          }`}
        >
          {message.text}
        </p>
      )}

      <button
        type="submit"
        disabled={pending}
        data-testid="cashier-submit"
        className="rounded-xl bg-indigo-600 px-5 py-2.5 font-semibold text-white disabled:opacity-60"
      >
        {pending ? t("creating") : t("create")}
      </button>
    </form>
  );
}
