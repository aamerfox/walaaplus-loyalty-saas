import { Permission } from "@prisma/client";
import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";
import { Link } from "@/i18n/routing";
import { Badge, Card, EmptyState, Notice, PageHeader } from "@/components/ui";
import { getCurrentUserId } from "@/server/auth/session";
import { listBusinessPrograms } from "@/server/program/programs";
import { resolveScannerContext } from "@/server/tenant/scanner-context";

/**
 * Every loyalty program this business runs.
 *
 * Phase 1a had one program and a screen that assumed it. Phase 1b lifted that, so this is the list
 * that replaces the assumption — and the place a merchant tells a stamp card from a points card,
 * which is the distinction the whole rest of the product hangs on.
 *
 * **There is no enrolment link and no QR code here.** Owner decision B7 withdrew public
 * self-service enrolment: cards are issued by staff at the counter, and this screen says so instead
 * of publishing an address that now answers "ask at the counter".
 */
export default async function ProgramsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const userId = await getCurrentUserId();
  if (!userId) redirect(`/${locale}/auth/login`);

  const t = await getTranslations("Programs");
  const resolved = await resolveScannerContext(userId, null);
  if (resolved.kind !== "ready") {
    return <EmptyState testId="programs-no-business" title={t("noBusinessTitle")} body={t("noBusinessBody")} />;
  }

  const { ctx, businessName } = resolved.context;
  if (!ctx.permissions.has(Permission.VIEW_TEMPLATES)) {
    return (
      <>
        <PageHeader title={t("title")} subtitle={businessName} />
        <Notice tone="warn" testId="programs-forbidden">
          {t("forbidden")}
        </Notice>
      </>
    );
  }

  const programs = await listBusinessPrograms(ctx);
  const canCreate = ctx.permissions.has(Permission.EDIT_TEMPLATES);

  return (
    <>
      <PageHeader
        title={t("title")}
        subtitle={businessName}
        actions={
          canCreate ? (
            <Link
              href="/business/programs/new"
              data-testid="new-program"
              className="rounded-xl bg-navy-900 px-5 py-3 font-bold text-white transition-colors hover:bg-navy-800"
            >
              {t("newProgram")}
            </Link>
          ) : null
        }
      />

      <Notice tone="info" testId="programs-enrolment-note">
        {t("counterOnly")}
      </Notice>

      {programs.length === 0 ? (
        <EmptyState testId="programs-empty" title={t("emptyTitle")} body={t("emptyBody")} />
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2" data-testid="program-list">
          {programs.map((program) => (
            <Card as="li" key={program.templateId} className="flex flex-col gap-3">
              <div className="flex items-start justify-between gap-3">
                <Link
                  href={`/business/programs/${program.templateId}`}
                  data-testid={`program-link-${program.cardType}`}
                  className="font-display text-lg font-bold text-ink underline-offset-4 hover:underline"
                >
                  {program.name}
                </Link>
                <Badge tone="brand">{t(`cardType.${program.cardType}`)}</Badge>
              </div>

              <dl className="text-sm text-ink-muted">
                <div className="flex justify-between gap-3 py-1">
                  <dt>{t("status")}</dt>
                  <dd>
                    <Badge tone={program.status === "ACTIVE" ? "success" : "warn"}>{t(`statuses.${program.status}`)}</Badge>
                  </dd>
                </div>
                <div className="flex justify-between gap-3 py-1">
                  <dt>{t("rewards")}</dt>
                  <dd className="font-semibold text-ink tabular-nums">{program.tiers.length}</dd>
                </div>
                <div className="flex justify-between gap-3 py-1">
                  <dt>{t("locations")}</dt>
                  <dd className="font-semibold text-ink">
                    {program.availableLocations === null ? t("mainOnly") : program.availableLocations.length}
                  </dd>
                </div>
              </dl>
            </Card>
          ))}
        </ul>
      )}
    </>
  );
}
