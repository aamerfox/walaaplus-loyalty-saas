import { Permission } from "@prisma/client";
import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";
import { getCurrentUserId } from "@/server/auth/session";
import { publicEnrollmentUrl } from "@/server/program/enrollment-url";
import { getStampProgramOverview } from "@/server/program/stamp-program";
import { qrSvg } from "@/server/qr";
import { resolveScannerContext } from "@/server/tenant/scanner-context";
import EnrollmentLink from "./EnrollmentLink";
import ProgramForm from "./ProgramForm";

/**
 * The owner's loyalty card: create it once, then live here to get the link customers scan.
 *
 * This page exists because the product had a hole in the middle of it. Registration created a
 * business, a Main location and an OWNER. The stamp engine could award, redeem and reverse. But
 * nothing let a merchant create the card itself, so no enrolment link existed, no customer could
 * join, and a real pilot could not begin — the services were all there and unreachable.
 *
 * Two states, and the second is not optional politeness: if a program already exists this page
 * shows ITS link rather than offering to create another. Phase 1a is one active program per
 * business, the service enforces it with a row lock and a 409, and a screen that keeps offering a
 * button the server will refuse is a screen that teaches its user to distrust it.
 *
 * The enrolment token is a CAPABILITY: it is enough to enrol customers into this business. So the
 * read is tenant-scoped and needs VIEW_TEMPLATES, which a CASHIER does not hold. A cashier who
 * reaches this URL is told they cannot see it, not shown an empty form.
 */
export default async function ProgramPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ b?: string }>;
}) {
  const { locale } = await params;
  const { b } = await searchParams;

  const userId = await getCurrentUserId();
  if (!userId) redirect(`/${locale}/auth/login`);

  const t = await getTranslations("Program");
  const resolved = await resolveScannerContext(userId, b ?? null);
  if (resolved.kind !== "ready") {
    return <p className="text-zinc-500">{t("noBusiness")}</p>;
  }

  const { ctx, businessName } = resolved.context;

  // Read permission, checked before the service so the page can render a sentence instead of an
  // error boundary. The service checks it again; this is presentation, not enforcement.
  if (!ctx.permissions.has(Permission.VIEW_TEMPLATES)) {
    return (
      <div className="space-y-6">
        <Header title={t("title")} subtitle={businessName} />
        <p
          data-testid="program-forbidden"
          className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-300"
        >
          {t("forbidden")}
        </p>
      </div>
    );
  }

  const program = await getStampProgramOverview(ctx);
  const canCreate = ctx.permissions.has(Permission.EDIT_TEMPLATES);

  if (program && program.directSourceToken) {
    const enrollmentUrl = publicEnrollmentUrl(program.directSourceToken);
    return (
      <div className="space-y-6">
        <Header title={t("title")} subtitle={businessName} />
        <EnrollmentLink
          locale={locale}
          enrollmentUrl={enrollmentUrl}
          qrSvgMarkup={qrSvg(enrollmentUrl, { cellSize: 5, margin: 4 })}
          programName={program.templateName}
          stampsRequiredPerReward={program.mechanics.stampsRequiredPerReward}
          rewardName={program.mechanics.rewardName}
          welcomeStamps={program.mechanics.welcomeStamps ?? 0}
          justCreated={false}
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Header title={t("title")} subtitle={businessName} />
      {canCreate ? (
        <ProgramForm locale={locale} businessId={ctx.businessId} />
      ) : (
        <p
          data-testid="program-forbidden"
          className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-300"
        >
          {t("forbidden")}
        </p>
      )}
    </div>
  );
}

function Header({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <header>
      <h1 className="text-3xl font-bold tracking-tight text-zinc-900 dark:text-zinc-100">{title}</h1>
      <p className="mt-1 text-zinc-500 dark:text-zinc-400">{subtitle}</p>
    </header>
  );
}
