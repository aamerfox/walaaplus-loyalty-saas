import { MembershipRole, Permission } from "@prisma/client";
import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";
import { Badge, Card, Notice, PageHeader } from "@/components/ui";
import { getCurrentUserId } from "@/server/auth/session";
import { listBusinessLocations } from "@/server/tenant/locations";
import { listBusinessStaff } from "@/server/tenant/memberships";
import { resolveScannerContext } from "@/server/tenant/scanner-context";
import CashierForm from "./CashierForm";
import StaffMemberControls from "./StaffMemberControls";

/**
 * Staff, their access, and where they may work.
 *
 * Phase 1a's version of this page was a read-only list and a cashier form, because the server had
 * nothing else: no role change, no permission editor, no location assignment. Phase 1b built those,
 * so the screen now exposes them — and exposes exactly them.
 *
 * Three things this page does NOT do, each for a reason the server enforces anyway:
 *
 *  - it shows no control on the reader's own row (**nobody edits their own membership**, not even an
 *    owner — an owner who removes their own last permission locks the business out of itself);
 *  - it offers no OWNER option in the role picker (promoting an owner is not a staff screen's job);
 *  - it shows no permission editor to a member who could not grant what it contains. The grant
 *    ceiling — nobody hands out access they do not hold — is enforced in the service, and a picker
 *    full of permanently refused checkboxes would be a worse way to learn that.
 *
 * Personal data is the minimum a manager needs to tell two people apart: name, email, role. No
 * phone, no password state, no last-seen.
 */
export default async function TeamPage({
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

  const t = await getTranslations("Staff");
  const resolved = await resolveScannerContext(userId, b ?? null);
  if (resolved.kind !== "ready") {
    return <Notice tone="warn">{t("none")}</Notice>;
  }

  const { ctx, businessName } = resolved.context;
  if (!ctx.permissions.has(Permission.VIEW_STAFF)) {
    return (
      <>
        <PageHeader title={t("title")} subtitle={businessName} />
        <Notice tone="warn" testId="staff-forbidden">
          {t("forbidden")}
        </Notice>
      </>
    );
  }

  // Both through services: the tenant filter and the permission check live there, so a page cannot
  // forget either of them.
  const staff = await listBusinessStaff(ctx, { includeInactive: true });
  const locations = ctx.permissions.has(Permission.VIEW_LOCATIONS) ? await listBusinessLocations(ctx) : [];

  const isOwner = ctx.role === MembershipRole.OWNER;
  const canEdit = ctx.permissions.has(Permission.EDIT_STAFF);

  return (
    <>
      <PageHeader title={t("title")} subtitle={businessName} />

      {isOwner ? (
        <CashierForm businessId={ctx.businessId} />
      ) : (
        <Notice tone="info" testId="staff-owner-only">
          {t("ownerOnly")}
        </Notice>
      )}

      <ul className="space-y-4" data-testid="staff-rows">
        {staff.map((member) => (
          <Card as="li" key={member.id} className="space-y-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="font-semibold text-ink">
                  {[member.user.firstName, member.user.lastName].filter(Boolean).join(" ") || t("unnamed")}
                </p>
                <p className="truncate text-sm text-ink-muted" dir="ltr">
                  {member.user.email}
                </p>
              </div>
              <div className="flex shrink-0 flex-wrap gap-2">
                <Badge tone="brand">{t(`roles.${member.role}`)}</Badge>
                <Badge tone={member.active ? "success" : "warn"}>{member.active ? t("active") : t("inactive")}</Badge>
              </div>
            </div>

            {member.permissions.length > 0 ? (
              <p className="text-xs text-ink-muted">
                {t("extraPermissions", { list: member.permissions.join(", ") })}
              </p>
            ) : null}

            <StaffMemberControls
              membershipId={member.id}
              role={member.role}
              active={member.active}
              isSelf={member.id === ctx.membershipId}
              canEdit={canEdit}
              assignedLocationIds={member.locationIds}
              locations={locations.filter((l) => l.active).map((l) => ({ id: l.id, name: l.name }))}
              unrestrictedLocations={member.unrestrictedLocations}
            />
          </Card>
        ))}
      </ul>

      <Notice tone="info" testId="staff-rules-note">
        {t("rulesNote")}
      </Notice>
    </>
  );
}
