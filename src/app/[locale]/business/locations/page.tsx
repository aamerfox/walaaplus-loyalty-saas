import { Permission } from "@prisma/client";
import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";
import { Badge, Card, EmptyState, Notice, PageHeader, Section } from "@/components/ui";
import { getCurrentUserId } from "@/server/auth/session";
import { listBusinessLocations } from "@/server/tenant/locations";
import { resolveScannerContext } from "@/server/tenant/scanner-context";
import { LocationCreateForm, LocationRowControls } from "./LocationControls";

/**
 * The counters this business operates.
 *
 * Prompt 2 shipped this screen read-only and said why: there was no service to add, rename or close
 * a counter, and a button that reached past the service layer into Prisma to work would have been a
 * lie about what the product could do. Prompt 3 built the contract, so the buttons are real.
 *
 * What the screen has to make legible is the one thing about locations that is not obvious: a
 * counter is **closed, never deleted**. Everything recorded at it stays recorded there, which is
 * why an inactive row is still listed, still counted, and can be opened again with its history
 * intact.
 *
 * `EDIT_LOCATIONS` decides whether the controls render at all — and the server decides again on
 * every request. A cashier who forges the fetch is refused by the service, not by the absence of a
 * button.
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
  const mayEdit = ctx.permissions.has(Permission.EDIT_LOCATIONS);

  return (
    <>
      <PageHeader title={t("title")} description={t("subtitle")} />

      <ul className="grid gap-4 sm:grid-cols-2" data-testid="location-list">
        {locations.map((location) => (
          <Card as="li" key={location.id} className="space-y-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="font-display text-lg font-bold text-ink">{location.name}</p>
                {location.address ? <p className="mt-0.5 text-sm text-ink-muted">{location.address}</p> : null}
              </div>
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

            {/* An inactive counter says what that means, on the row, rather than in a legend. */}
            {!location.active ? (
              <Notice tone="warn" testId={`location-inactive-${location.id}`}>
                {t("inactiveNote")}
              </Notice>
            ) : null}

            {mayEdit ? (
              <LocationRowControls
                businessId={ctx.businessId}
                locationId={location.id}
                name={location.name}
                address={location.address}
                active={location.active}
                isDefault={location.isDefault}
              />
            ) : null}
          </Card>
        ))}
      </ul>

      {mayEdit ? (
        <Section title={t("addTitle")} description={t("addSubtitle")} testId="location-add">
          <Card>
            <LocationCreateForm businessId={ctx.businessId} />
          </Card>
        </Section>
      ) : null}

      <Notice tone="info" testId="locations-note">
        {t("lifecycleNote")}
      </Notice>
    </>
  );
}
