"use client";

import { Wordmark } from "@/components/brand/Wordmark";
import { useState, type FormEvent } from "react";
import { useLocale, useTranslations } from "next-intl";
import { signIn } from "next-auth/react";
import { useRouter } from "next/navigation";
import { Link } from "@/i18n/routing";
import { ArrowLeft, Store } from "lucide-react";
import { Button, Field, Notice, TextInput } from "@/components/ui";

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
    <div className="flex min-h-screen bg-app text-ink" dir={dir}>
      {/* Visual panel, hidden on the phone this product is used on. */}
      <div className="relative hidden w-[45%] flex-col justify-between overflow-hidden bg-navy-900 p-12 lg:flex">
        {/* One turquoise wash, the same one the landing hero uses. Not two competing blooms. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -bottom-40 start-[-10%] size-[32rem] rounded-full bg-turquoise-500/20 blur-3xl"
        />

        <div className="relative z-10">
          <Link href="/" aria-label="Zademi" className="inline-flex">
            {/* A navy splash panel: the approved white treatment, not the colour logo dimmed. */}
            <Wordmark tone="white" height={40} className="h-10 w-auto" />
          </Link>
        </div>

        <div className="relative z-10 text-white max-w-md">
          <h2 className="mb-6 font-display text-4xl font-extrabold leading-[1.2]">{t("splashTitle")}</h2>
          {/* White at 75%, not `accent-ink`: turquoise body text on navy was the one contrast
              failure left on a public page. */}
          <p className="text-lg leading-relaxed text-white/75">{t("splashBody")}</p>
        </div>
      </div>

      <div className="relative flex flex-1 flex-col justify-center p-4 py-12 sm:p-12">
        <Link
          href="/"
          className="absolute top-6 start-4 inline-flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-semibold text-ink-muted transition-colors hover:bg-surface-muted hover:text-ink sm:start-8 sm:top-8"
        >
          <ArrowLeft size={16} aria-hidden="true" className="rtl:rotate-180" />
          {t("back")}
        </Link>

        <div className="max-w-md mx-auto w-full">
          <div className="mb-6 mt-10">
            {/*
             * The splash panel carries the mark on a desktop and is hidden below `lg`, which left a
             * merchant signing up on a phone — the common case — on an unbranded form. The colour
             * treatment here, because this column is light.
             */}
            <Link href="/" aria-label="Zademi" className="mb-6 inline-flex lg:hidden">
              <Wordmark height={28} className="h-7 w-auto" />
            </Link>
            <h1 className="font-display text-3xl font-extrabold text-ink">{t("title")}</h1>
            <p className="mt-2 leading-relaxed text-ink-muted">{t("subtitle")}</p>
          </div>

          {/*
            What used to be a two-way account-type chooser. Phase 1a onboards local businesses,
            so this states that instead of offering a choice that does not exist.
          */}
          <div
            data-testid="register-scope"
            className="mb-6 flex items-start gap-3 rounded-2xl border border-border bg-surface p-4"
          >
            <Store size={20} aria-hidden="true" className="mt-0.5 shrink-0 text-accent-ink" />
            <p className="text-sm leading-relaxed text-ink-muted">{t("localBusinessOnly")}</p>
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
              <Notice tone="danger" testId="register-error">
                {formError}
              </Notice>
            )}

            {notice !== null && (
              <div className="space-y-2">
                <Notice tone="warn" testId="register-notice">
                  {notice}
                </Notice>
                <Link
                  href="/auth/login"
                  className="inline-block font-semibold text-accent-ink underline-offset-4 hover:underline"
                >
                  {t("signIn")}
                </Link>
              </div>
            )}

            <div className="pt-2">
              <Button type="submit" size="lg" className="w-full" disabled={pending} testId="register-submit">
                {pending ? t("submitting") : t("submit")}
              </Button>
              <p className="mt-4 text-center text-xs leading-relaxed text-ink-faint">{t("terms")}</p>
            </div>
          </form>

          <div className="mt-8 border-t border-border pt-8 text-center">
            <p className="text-sm text-ink-muted">
              {t("haveAccount")}{" "}
              <Link href="/auth/login" className="font-semibold text-accent-ink underline-offset-4 hover:underline">
                {t("signIn")}
              </Link>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * The one local wrapper left: registration's fields carry an optional-hint and an error in the same
 * slot, which `Field` already models. This is the adaptor between the two, not a second input.
 */
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
  return (
    <Field id={id} label={label} hint={hint} error={error}>
      <TextInput
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
        aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined}
      />
    </Field>
  );
}
