"use client";

import { Wordmark } from "@/components/brand/Wordmark";
import { useState, type FormEvent } from "react";
import { useLocale, useTranslations } from "next-intl";
import { signIn } from "next-auth/react";
import { useRouter } from "next/navigation";
import { Link } from "@/i18n/routing";
import { ArrowLeft, Store } from "lucide-react";

/**
 * Registration. Real this time.
 *
 * What stood here was prototype markup that looked finished and did nothing: uncontrolled
 * inputs, no submit handler, and a "Create Account" **link to `/business`**. A merchant on
 * staging filled it in, was taken to the dashboard, and had no account — the subsequent sign-in
 * returned 401, correctly, because `POST /api/auth/register` had never been called. The
 * registration service and its route were tested and working the whole time; nothing connected
 * the two. A page that navigates on submit is worse than a page with no form at all, because it
 * reports success.
 *
 * Three things this page must not do, all of them about not undoing work that already exists:
 *
 *  - **it must not reveal whether an email is already registered.** The API answers a duplicate
 *    and a new account with the same 202 and the same body, on purpose. So this form treats
 *    every accepted response identically, and the only branch after it is whether the SIGN-IN
 *    worked — which tells the person holding the right password what they need, and tells anyone
 *    else nothing;
 *  - **it must not log what was submitted.** No console call anywhere in this file. An email and
 *    a password in a browser console outlive the tab they were typed in;
 *  - **it must not offer what the product cannot do.** The prototype's "Agency" account type is
 *    gone rather than disabled: Phase 1a onboards local businesses, and a greyed-out option is
 *    still a promise.
 *
 * Syria-first defaults — `SYP`, `Asia/Damascus` — are sent explicitly rather than left to the
 * schema, so the value a business is created with is visible here and not two files away.
 */

const CURRENCY = "SYP";
const TIMEZONE = "Asia/Damascus";
const MIN_PASSWORD_LENGTH = 10;

type FieldName = "firstName" | "businessName" | "email" | "password";

export default function RegisterPage() {
  const locale = useLocale();
  const dir = locale === "ar" ? "rtl" : "ltr";
  const t = useTranslations("Register");
  const tc = useTranslations("Common");
  const router = useRouter();

  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [businessName, setBusinessName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const [fieldErrors, setFieldErrors] = useState<Partial<Record<FieldName, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  /** Client-side checks that mirror the server's, so the obvious mistakes cost no round trip. */
  function validate(): Partial<Record<FieldName, string>> {
    const errors: Partial<Record<FieldName, string>> = {};
    if (firstName.trim().length === 0) errors.firstName = t("errorFirstName");
    if (businessName.trim().length < 2) errors.businessName = t("errorBusinessName");
    // Deliberately loose. The server owns the real rule; a clever pattern here only rejects
    // addresses that work.
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) errors.email = t("errorEmail");
    if (password.length < MIN_PASSWORD_LENGTH) errors.password = t("errorPassword");
    return errors;
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;

    const errors = validate();
    setFieldErrors(errors);
    setNotice(null);
    if (Object.keys(errors).length > 0) {
      // Nothing is sent. The form stays put; `noValidate` means this is the only gate, and it
      // holds.
      setFormError(t("errorFix"));
      return;
    }

    setPending(true);
    setFormError(null);

    try {
      const response = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          firstName: firstName.trim(),
          lastName: lastName.trim() || undefined,
          businessName: businessName.trim(),
          email: email.trim(),
          password,
          locale,
          currency: CURRENCY,
          timezone: TIMEZONE,
        }),
      });

      if (response.status === 429) {
        setFormError(t("errorRateLimited"));
        return;
      }
      if (!response.ok) {
        // 400 is a field the server refused that the checks above let through. Anything else is
        // a failure this form cannot explain, and guessing would be worse than a generic line.
        setFormError(response.status === 400 ? t("errorFix") : tc("genericError"));
        return;
      }

      // Accepted. This says NOTHING about whether an account was created or already existed, and
      // neither does anything below: the only question now is whether these credentials sign in.
      const result = await signIn("credentials", { redirect: false, email: email.trim(), password });

      if (result?.ok && !result.error) {
        // Straight to the thing a new owner needs: their first loyalty card.
        router.push(`/${locale}/business/program`);
        router.refresh();
        return;
      }

      // Sign-in did not work. For a genuinely new account that would be surprising; for an
      // address that already has an account with a different password it is expected. The same
      // neutral sentence covers both, which is the point.
      setNotice(t("signInManually"));
    } catch {
      setFormError(tc("genericError"));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950 font-sans flex text-zinc-900 dark:text-zinc-50" dir={dir}>
      {/* Visual panel, hidden on the phone this product is used on. */}
      <div className="hidden lg:flex w-[45%] bg-indigo-600 relative overflow-hidden flex-col justify-between p-12">
        <div className="absolute top-0 right-0 w-96 h-96 bg-white/10 rounded-full blur-3xl -translate-y-1/2 translate-x-1/2" />
        <div className="absolute bottom-0 left-0 w-96 h-96 bg-rose-500/20 rounded-full blur-3xl translate-y-1/2 -translate-x-1/2" />

        <div className="relative z-10">
          <Link href="/" aria-label="Zademi" className="inline-flex">
            {/* A navy splash panel: the approved white treatment, not the colour logo dimmed. */}
            <Wordmark tone="white" height={40} className="h-10 w-auto" />
          </Link>
        </div>

        <div className="relative z-10 text-white max-w-md">
          <h2 className="text-4xl font-black mb-6 leading-[1.2]">{t("splashTitle")}</h2>
          <p className="text-indigo-200 text-lg font-medium leading-relaxed">{t("splashBody")}</p>
        </div>
      </div>

      <div className="flex-1 flex flex-col justify-center p-6 sm:p-12 relative">
        <Link
          href="/"
          className="absolute top-8 start-8 flex items-center gap-2 text-zinc-500 hover:text-zinc-900 dark:hover:text-white font-bold text-sm bg-white dark:bg-zinc-900 px-4 py-2 rounded-full border border-zinc-200 dark:border-zinc-800 shadow-sm transition-all hover:scale-105"
        >
          <ArrowLeft size={16} className={locale === "ar" ? "rotate-180" : ""} />
          {t("back")}
        </Link>

        <div className="max-w-md mx-auto w-full">
          <div className="mb-8 mt-12">
            <h1 className="text-3xl font-black mb-2">{t("title")}</h1>
            <p className="text-zinc-500 font-medium">{t("subtitle")}</p>
          </div>

          {/*
            What used to be a two-way account-type chooser. Phase 1a onboards local businesses,
            so this states that instead of offering a choice that does not exist.
          */}
          <div
            data-testid="register-scope"
            className="mb-6 flex items-start gap-3 rounded-2xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900"
          >
            <Store size={20} className="mt-0.5 flex-shrink-0 text-indigo-600" />
            <p className="text-sm font-medium text-zinc-600 dark:text-zinc-400">{t("localBusinessOnly")}</p>
          </div>

          <form onSubmit={onSubmit} noValidate data-testid="register-form" className="space-y-6">
            <div className="grid grid-cols-2 gap-4">
              <TextField
                id="firstName"
                label={t("firstName")}
                value={firstName}
                onChange={setFirstName}
                autoComplete="given-name"
                required
                error={fieldErrors.firstName}
              />
              <TextField
                id="lastName"
                label={t("lastName")}
                hint={t("optional")}
                value={lastName}
                onChange={setLastName}
                autoComplete="family-name"
              />
            </div>

            <TextField
              id="businessName"
              label={t("businessName")}
              value={businessName}
              onChange={setBusinessName}
              autoComplete="organization"
              required
              error={fieldErrors.businessName}
            />

            <TextField
              id="email"
              label={t("email")}
              type="email"
              placeholder="name@company.com"
              value={email}
              onChange={setEmail}
              autoComplete="email"
              required
              error={fieldErrors.email}
              dir="ltr"
            />

            <TextField
              id="password"
              label={t("password")}
              type="password"
              placeholder="••••••••"
              value={password}
              onChange={setPassword}
              autoComplete="new-password"
              required
              error={fieldErrors.password}
              hint={t("passwordHelp")}
              dir="ltr"
            />

            {formError !== null && (
              <p
                role="alert"
                data-testid="register-error"
                className="rounded-xl bg-rose-50 px-4 py-3 text-sm font-medium text-rose-700 dark:bg-rose-500/10 dark:text-rose-400"
              >
                {formError}
              </p>
            )}

            {notice !== null && (
              <div
                role="status"
                data-testid="register-notice"
                className="rounded-xl bg-amber-50 px-4 py-3 text-sm font-medium text-amber-800 dark:bg-amber-500/10 dark:text-amber-300"
              >
                <p>{notice}</p>
                <Link href="/auth/login" className="mt-2 inline-block font-bold text-indigo-600 hover:underline">
                  {t("signIn")}
                </Link>
              </div>
            )}

            <div className="pt-2">
              <button
                type="submit"
                disabled={pending}
                data-testid="register-submit"
                className="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-4 rounded-xl flex justify-center items-center shadow-lg shadow-indigo-600/20 transition-transform active:scale-95 text-lg disabled:cursor-not-allowed disabled:opacity-60"
              >
                {pending ? t("submitting") : t("submit")}
              </button>
              <p className="text-xs font-bold text-zinc-400 text-center mt-4">{t("terms")}</p>
            </div>
          </form>

          <div className="mt-8 text-center pt-8 border-t border-zinc-200 dark:border-zinc-800">
            <p className="text-sm font-medium text-zinc-500">
              {t("haveAccount")}{" "}
              <Link href="/auth/login" className="text-indigo-600 font-bold hover:underline">
                {t("signIn")}
              </Link>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

function TextField({
  id,
  label,
  value,
  onChange,
  type = "text",
  placeholder,
  autoComplete,
  required = false,
  error,
  hint,
  dir,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  placeholder?: string;
  autoComplete?: string;
  required?: boolean;
  error?: string;
  hint?: string;
  dir?: "ltr" | "rtl";
}) {
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;
  return (
    <div className="space-y-2">
      <label htmlFor={id} className="block text-xs font-bold uppercase tracking-wider text-zinc-500">
        {label}
        {hint && !error ? <span className="ms-2 normal-case font-medium text-zinc-400">{hint}</span> : null}
      </label>
      <input
        id={id}
        name={id}
        type={type}
        dir={dir}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete={autoComplete}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className="w-full bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl px-4 py-3 text-sm focus:ring-2 focus:ring-indigo-500 outline-none transition-all dark:text-white aria-[invalid=true]:border-rose-500"
      />
      {error ? (
        <p id={`${id}-error`} data-testid={`${id}-error`} className="text-xs font-medium text-rose-600 dark:text-rose-400">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="sr-only">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
