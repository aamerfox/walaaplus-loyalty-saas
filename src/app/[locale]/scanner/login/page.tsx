import { redirect } from "next/navigation";

/**
 * Public entry point for staff.
 *
 * It exists as its own route so that a cashier can bookmark "the scanner" and reach a login rather
 * than a redirect loop, and so the proxy has a public path to allow — without that, an unsigned-in
 * cashier opening the scanner would be bounced to a merchant login that is not their screen.
 *
 * The login form itself is the existing one; this only carries the destination through it.
 */
export default async function ScannerLoginPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  redirect(`/${locale}/auth/login?callbackUrl=${encodeURIComponent(`/${locale}/scanner`)}`);
}
