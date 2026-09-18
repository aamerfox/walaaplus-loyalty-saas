import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";
import Link from "next/link";
import { getCurrentUserId } from "@/server/auth/session";
import { getScannerScope, listMoneyCounterPrograms } from "@/server/program/program-detail";
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
 * than assumed. Locations now appear on this screen, but only where one is a real decision: a
 * program that runs at Main only sends no location at all, and a program that runs at several
 * requires the cashier to say which — because the server refuses to guess between them.
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
      <main className="flex min-h-screen items-center justify-center bg-navy-950 p-6 text-center text-white/70">
        <p>{t("noBusiness")}</p>
      </main>
    );
  }

  if (resolved.kind === "choose") {
    return (
      <main className="min-h-screen bg-navy-950 p-6 text-white">
        <h1 className="mb-4 text-xl font-bold">{t("chooseBusiness")}</h1>
        <ul className="space-y-2">
          {resolved.businesses.map((business) => (
            <li key={business.id}>
              <Link
                href={`/${locale}/scanner?b=${business.id}`}
                className="block rounded-xl bg-navy-900 px-4 py-3 font-semibold ring-1 ring-white/10 hover:bg-navy-800"
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
  /*
   * What this member may operate, resolved on the server before the screen renders.
   *
   * The picker below is built from this and nothing else: a location the member is not assigned to
   * never reaches the browser, so the screen cannot offer an option the write would refuse.
   */
  const [scope, moneyPrograms] = await Promise.all([getScannerScope(ctx), listMoneyCounterPrograms(ctx)]);
  return (
    <>
      <ScannerClient businessId={ctx.businessId} businessName={businessName} scope={scope} />
      {/*
        * Cashback and discount programmes are run from their own counter, so this screen links to it
        * rather than pretending it can serve them. Rendered only when the business actually has one:
        * a link to an empty counter teaches staff to ignore links.
        */}
      {moneyPrograms.length > 0 && (
        <nav aria-label={t("moneyCounterTitle")} className="mx-auto w-full max-w-md px-4 pb-8">
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-zinc-400">
            {t("moneyCounterTitle")}
          </h2>
          <ul className="space-y-2" data-testid="scanner-money-programs">
            {moneyPrograms.map((program) => (
              <li key={program.templateId}>
                <Link
                  href={`/${locale}/scanner/money?programme=${program.templateId}`}
                  data-testid={`scanner-money-${program.templateId}`}
                  className="block rounded-xl bg-navy-900 px-4 py-3 font-semibold ring-1 ring-white/10 hover:bg-navy-800"
                >
                  {program.name}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      )}
    </>
  );
}
