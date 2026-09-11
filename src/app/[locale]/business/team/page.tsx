import { MembershipRole } from "@prisma/client";
import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";
import { getCurrentUserId } from "@/server/auth/session";
import { listBusinessStaff } from "@/server/tenant/memberships";
import { resolveScannerContext } from "@/server/tenant/scanner-context";
import CashierForm from "./CashierForm";

/**
 * The minimal staff screen Phase 1a needs: make an account for the person on the till.
 *
 * Not a staff-management page. There is no role picker, no permission editor, no location
 * assignment and no way to change or remove an existing membership — all of that is Phase 1b, and
 * shipping half of it now would mean shipping a screen that implies capabilities the server
 * refuses. The list below is read-only for the same reason.
 *
 * Creation is owner-only, enforced by the service on the ROLE. A manager reaching this page sees
 * the list and a form that the server will refuse, which is the honest outcome: the alternative is
 * hiding a button and letting them believe the permission does not exist.
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
    return <p className="text-zinc-500">{t("none")}</p>;
  }

  const { ctx } = resolved.context;
  // Through the service, like every other read: the tenant filter and the permission check live
  // there, so a page cannot forget either of them.
  const staff = await listBusinessStaff(ctx);

  const isOwner = ctx.role === MembershipRole.OWNER;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-3xl font-bold tracking-tight text-zinc-900 dark:text-zinc-100">{t("title")}</h1>
        <p className="mt-1 text-zinc-500 dark:text-zinc-400">{t("subtitle")}</p>
      </header>

      {isOwner ? (
        <CashierForm businessId={ctx.businessId} />
      ) : (
        <p className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-300">
          {t("ownerOnly")}
        </p>
      )}

      <section>
        <h2 className="mb-3 text-lg font-semibold text-zinc-900 dark:text-zinc-100">{t("listTitle")}</h2>
        <div className="overflow-hidden rounded-2xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
          <table className="w-full text-start text-sm">
            <thead className="border-b border-zinc-200 text-xs uppercase tracking-wide text-zinc-500 dark:border-zinc-800">
              <tr>
                <th className="px-4 py-3 text-start">{t("firstName")}</th>
                <th className="px-4 py-3 text-start">{t("email")}</th>
                <th className="px-4 py-3 text-start">{t("role")}</th>
              </tr>
            </thead>
            <tbody data-testid="staff-rows">
              {staff.map((member) => (
                <tr key={member.id} className="border-b border-zinc-100 last:border-0 dark:border-zinc-800/60">
                  <td className="px-4 py-3 font-medium text-zinc-900 dark:text-zinc-100">
                    {[member.user.firstName, member.user.lastName].filter(Boolean).join(" ") || "—"}
                  </td>
                  <td className="px-4 py-3 text-zinc-500" dir="ltr">
                    {member.user.email}
                  </td>
                  <td className="px-4 py-3 text-zinc-500">{member.role}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
