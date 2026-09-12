import { Permission } from "@prisma/client";
import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";
import { Badge, Card, EmptyState, Notice, PageHeader } from "@/components/ui";
import { getCurrentUserId } from "@/server/auth/session";
import { listBusinessLocations } from "@/server/tenant/locations";
import { resolveScannerContext } from "@/server/tenant/scanner-context";

/**
 * The counters this business operates.
 *
 * **Read-only, and honestly so.** The Phase 1b core creates the one `Main` location at registration
 * and offers no service to add, rename or deactivate another — so this screen shows what exists and
 * says what cannot be done here yet, rather than carrying an "Add location" button that would have
 * to reach past the service layer into Prisma to work. The missing contract is recorded in
 * `docs/evidence/phase-1b-prompt-2.md`.
 *
 * What it does show is the thing a merchant actually needs before they can use several counters:
 * which locations exist, which programs run at each, and how many staff are assigned there.
 */
export default async function LocationsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const userId = await getCurrentUserId();
  if (!userId) redirect(`/${locale}/auth/login`);

  const t = await getTranslations("Locations");
  const resolved = await resolveScannerContext(userId, null);
  if (resolved.kind !== "ready") {
    return <EmptyState testId="locations-no-business" title={t("noBusinessTitle")} body={t("noBusinessBody")} />;
  }

  const { ctx } = resolved.context;
  if (!ctx.permissions.has(Permission.VIEW_LOCATIONS)) {
    return (
      <>
        <PageHeader title={t("title")} description={t("subtitle")} />
        <Notice tone="warn" testId="locations-forbidden">
          {t("forbidden")}
        </Notice>
      </>
    );
  }

  const locations = await listBusinessLocations(ctx);

  return (
    <>
      <PageHeader title={t("title")} description={t("subtitle")} />

      <ul className="grid gap-4 sm:grid-cols-2" data-testid="location-list">
        {locations.map((location) => (
          <Card as="li" key={location.id} className="space-y-3">
            <div className="flex items-start justify-between gap-3">
              <p className="font-display text-lg font-bold text-ink">{location.name}</p>
              <div className="flex shrink-0 gap-2">
                {location.isDefault ? <Badge tone="brand">{t("main")}</Badge> : null}
                <Badge tone={location.active ? "success" : "warn"}>{location.active ? t("active") : t("inactive")}</Badge>
              </div>
            </div>
            <dl className="text-sm text-ink-muted">
              <div className="flex justify-between gap-3 py-1">
                <dt>{t("programsHere")}</dt>
                <dd className="font-semibold tabular-nums text-ink">
                  {location.programCount === 0 ? t("mainOnlyPrograms") : location.programCount}
                </dd>
              </div>
              <div className="flex justify-between gap-3 py-1">
                <dt>{t("staffHere")}</dt>
                <dd className="font-semibold tabular-nums text-ink">{location.assignedStaffCount}</dd>
              </div>
            </dl>
          </Card>
        ))}
      </ul>

      <Notice tone="info" testId="locations-readonly">
        {t("readOnlyNote")}
      </Notice>
    </>
  );
}
