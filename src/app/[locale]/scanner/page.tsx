import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";
import Link from "next/link";
import { getCurrentUserId } from "@/server/auth/session";
import { resolveScannerContext } from "@/server/tenant/scanner-context";
import ScannerClient from "./ScannerClient";

/**
 * The scanner — the screen a cashier actually uses all day.
 *
 * Authorization happens twice, deliberately. The proxy already refused an anonymous request, and
 * this page resolves the membership from the database again, because a session token says who
 * someone is and never what they may do (PRODUCT-SPEC §2.6). The API routes behind the buttons do
 * the same thing a third time; a page that "already checked" is not an authorization for a route.
 *
 * A user may hold memberships in several businesses, so the acting business is resolved rather
 * than assumed. There is no location anywhere on this screen: Phase 1a operates at Main, the
 * server resolves it, and the UI says so rather than offering a choice that does not exist.
 */
export default async function ScannerPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ b?: string }>;
}) {
  const { locale } = await params;
  const { b } = await searchParams;

  const userId = await getCurrentUserId();
  if (!userId) redirect(`/${locale}/scanner/login`);

  const t = await getTranslations("Scanner");
  const resolved = await resolveScannerContext(userId, b ?? null);

  if (resolved.kind === "none") {
    return (
      <main className="flex min-h-screen items-center justify-center bg-zinc-950 p-6 text-center text-zinc-300">
        <p>{t("noBusiness")}</p>
      </main>
    );
  }

  if (resolved.kind === "choose") {
    return (
      <main className="min-h-screen bg-zinc-950 p-6 text-zinc-100">
        <h1 className="mb-4 text-xl font-bold">{t("chooseBusiness")}</h1>
        <ul className="space-y-2">
          {resolved.businesses.map((business) => (
            <li key={business.id}>
              <Link
                href={`/${locale}/scanner?b=${business.id}`}
                className="block rounded-xl bg-zinc-900 px-4 py-3 font-medium ring-1 ring-white/10 hover:bg-zinc-800"
              >
                {business.name}
              </Link>
            </li>
          ))}
        </ul>
      </main>
    );
  }

  const { ctx, businessName } = resolved.context;
  return <ScannerClient businessId={ctx.businessId} businessName={businessName} />;
}
