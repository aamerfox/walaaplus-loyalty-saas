"use client";

import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { signIn } from "next-auth/react";
import { useRouter, useSearchParams } from "next/navigation";
import { Eye, EyeOff } from "lucide-react";
import { Link } from "@/i18n/routing";
import { Wordmark } from "@/components/brand/Wordmark";
import { Button, Card, Field, Notice, TextInput } from "@/components/ui";

/**
 * Sign in.
 *
 * ## What this page used to be
 *
 * It was the single clearest piece of evidence for the owner's verdict. It rendered a navy square
 * with a white **"W"** in it — the previous product's letter placeholder — directly above a form whose
 * every string was an inline `locale === 'ar' ? … : …` ternary, in a zinc palette belonging to no
 * brand, with a **dead `href="#"` "Forgot password?" link** and a "Secure 256-bit SSL Connection"
 * badge underneath. Three separate rules broken on one screen: a temporary text wordmark standing
 * in for the logo, a control that looks like a feature and does nothing, and a security claim made
 * by a decorative element rather than by the connection.
 *
 * All three are gone. The mark is the official wordmark on light ground, every string comes from
 * the `Login` message group, the form is built from the same `Field`/`TextInput`/`Button` the rest
 * of the product uses, and nothing on the page promises something that is not wired up.
 *
 * The `callbackUrl` handling below is unchanged and deliberately so — it is a security control,
 * not decoration, and its reasoning is preserved verbatim.
 */
export default function LoginPage() {
  const locale = useLocale();
  const t = useTranslations("Login");
  const tc = useTranslations("Common");
  const [showPassword, setShowPassword] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const router = useRouter();
  const searchParams = useSearchParams();

  /**
   * Where to go after signing in.
   *
   * Only a path within this site is accepted — a `callbackUrl` of `https://elsewhere/` would turn
   * the login form into an open redirect, which is worth more to a phisher than the form itself.
   * The scanner's public login uses this to land a cashier on the scanner rather than the
   * merchant dashboard.
   */
  const destination = (() => {
    const requested = searchParams.get("callbackUrl");
    if (!requested) return `/${locale}/business`;
    try {
      /*
       * Parse it, do not pattern-match it.
       *
       * The previous test was `startsWith('/') && !startsWith('//')`, which rejects `//evil.tld`
       * and accepts `/\evil.tld`. Browsers treat a backslash as a forward slash in a URL with a
       * special scheme, so that resolves to `https://evil.tld/` — an open redirect that fires
       * AFTER a successful sign-in, which is the most valuable kind to a phisher: the victim
       * really did authenticate, on the real domain, and is then handed to a clone.
       *
       * Comparing the parsed origin leaves nothing to enumerate.
       */
      const url = new URL(requested, window.location.origin);
      if (url.origin === window.location.origin) return url.pathname + url.search + url.hash;
    } catch {
      // Not a URL at all. Fall through to the default rather than guess.
    }
    return `/${locale}/business`;
  })();

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");

    const res = await signIn("credentials", { redirect: false, email, password });

    if (res?.error) {
      // One message for a wrong address and a wrong password alike: the form must not say which
      // half was right.
      setError(tc("invalidCredentials"));
      setLoading(false);
    } else {
      router.push(destination);
      router.refresh();
    }
  }

  return (
    <div className="flex min-h-screen flex-col justify-center bg-app px-4 py-12">
      <div className="mx-auto w-full max-w-md">
        <div className="mb-8 flex justify-center">
          <Link href="/" aria-label="Zademi" className="inline-flex">
            <Wordmark height={32} className="h-8 w-auto" />
          </Link>
        </div>

        <Card className="p-6 sm:p-8">
          <div className="mb-6 text-center">
            <h1 className="font-display text-2xl font-extrabold text-ink">{t("title")}</h1>
            <p className="mt-2 text-sm leading-relaxed text-ink-muted">{t("subtitle")}</p>
          </div>

          <form className="space-y-5" onSubmit={handleLogin} data-testid="login-form">
            {error ? (
              <Notice tone="danger" testId="login-error">
                {error}
              </Notice>
            ) : null}

            <Field id="email" label={t("email")}>
              <TextInput
                id="email"
                type="email"
                dir="ltr"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="email"
                placeholder="name@company.com"
              />
            </Field>

            <Field id="password" label={t("password")}>
              <div className="relative">
                <TextInput
                  id="password"
                  type={showPassword ? "text" : "password"}
                  dir="ltr"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  autoComplete="current-password"
                  className="pe-12"
                />
                {/*
                 * A real control with a real label. It is the only button beside submit on this
                 * page, because it is the only other thing the page can actually do.
                 */}
                <button
                  type="button"
                  onClick={() => setShowPassword((shown) => !shown)}
                  aria-label={showPassword ? t("hidePassword") : t("showPassword")}
                  className="absolute inset-y-0 end-0 flex w-12 items-center justify-center text-ink-faint transition-colors hover:text-ink"
                >
                  {showPassword ? <EyeOff size={18} aria-hidden="true" /> : <Eye size={18} aria-hidden="true" />}
                </button>
              </div>
            </Field>

            <Button type="submit" size="lg" className="w-full" disabled={loading} testId="login-submit">
              {loading ? t("submitting") : t("submit")}
            </Button>
          </form>

          <p className="mt-8 text-center text-sm text-ink-muted">
            {t("noAccount")}{" "}
            <Link href="/auth/register" className="font-semibold text-accent-ink underline-offset-4 hover:underline">
              {t("createAccount")}
            </Link>
          </p>
        </Card>
      </div>
    </div>
  );
}
