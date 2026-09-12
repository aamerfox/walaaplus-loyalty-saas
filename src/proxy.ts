import createIntlMiddleware from "next-intl/middleware";
import { getToken } from "next-auth/jwt";
import { NextResponse, type NextRequest } from "next/server";
import { routing } from "./i18n/routing";

/**
 * Next 16 `proxy` (successor of the deprecated `middleware` convention).
 *
 * Responsibilities, in order:
 *  1. Public routes pass straight to next-intl locale handling.
 *  2. Everything else requires a signed-in merchant session; otherwise redirect to login.
 *  3. Locale negotiation and rewriting via next-intl.
 *
 * Authorization (which business, which role, which permission) is NOT decided here. It is
 * resolved per request from the database in src/server/tenant/context.ts. The proxy only
 * answers "is anyone signed in?".
 *
 * Public route rules cover pages that later phases will add (enrollment, customer card, scanner
 * login). Declaring them now means those pages can never accidentally redirect a customer to a
 * merchant login. No such pages exist yet in Phase 0.
 *
 * Fail-closed: if NEXTAUTH_SECRET is missing the proxy refuses every protected request.
 */

const intl = createIntlMiddleware(routing);

const LOCALE_PREFIX = new RegExp(`^/(${routing.locales.join("|")})(?=/|$)`);

/** Matched against the path WITHOUT its locale prefix. */
const PUBLIC_ROUTES: readonly RegExp[] = [
  /^\/$/, // landing
  /^\/pricing\/?$/,
  /^\/auth\/(login|register|forgot-password|reset-password)(\/.*)?$/,
  /^\/join(\/.*)?$/, // withdrawn enrolment links: a static notice, public so old printed links still explain themselves
  /^\/card(\/.*)?$/, // Phase 1a: public customer PWA card, manifest, service worker
  /^\/scanner\/login\/?$/, // scanner login is public; the scanner itself is protected
];

function stripLocale(pathname: string): { locale: string; path: string } {
  const m = pathname.match(LOCALE_PREFIX);
  if (!m) return { locale: routing.defaultLocale, path: pathname || "/" };
  const path = pathname.slice(m[0].length) || "/";
  return { locale: m[1], path };
}

export default async function proxy(req: NextRequest) {
  const { locale, path } = stripLocale(req.nextUrl.pathname);

  if (PUBLIC_ROUTES.some((re) => re.test(path))) {
    return intl(req);
  }

  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret || secret.length < 32) {
    // Misconfigured server: never let protected routes through.
    return new NextResponse("Server configuration error", { status: 500 });
  }

  const token = await getToken({ req, secret });
  if (!token?.sub) {
    const login = new URL(`/${locale}/auth/login`, req.url);
    login.searchParams.set("callbackUrl", req.nextUrl.pathname + req.nextUrl.search);
    return NextResponse.redirect(login);
  }

  return intl(req);
}

export const config = {
  // Skip API routes, Next internals, and any file with an extension (assets, manifest, sw.js).
  matcher: ["/((?!api|_next|.*\\..*).*)"],
};
