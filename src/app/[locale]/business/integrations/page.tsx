import { IntegrationEventType, MembershipRole } from "@prisma/client";
import { getFormatter, getTranslations } from "next-intl/server";
import { notFound, redirect } from "next/navigation";
import { PageHeader } from "@/components/ui";
import { getCurrentUserId } from "@/server/auth/session";
import { isAppError } from "@/server/errors";
import { listIntegrationEvents } from "@/server/integrations/events";
import { resolveScannerContext } from "@/server/tenant/scanner-context";

/**
 * What this business has recorded for a delivery mechanism that does not exist yet.
 *
 * **Owner and manager only.** A cashier serves the customer in front of them; a feed of everything
 * the business has done is a different thing, and they get a 404 rather than an empty screen.
 *
 * The screen's first job is to not lie. There is no provider connected, no key, no endpoint and no
 * "Connect" button, and the notice at the top says so in as many words — because an integrations
 * page with provider names on it is how a product comes to be described as integrated with things
 * it has never contacted. `docs/INTEGRATIONS-CAPABILITY-MATRIX.md` §0.
 *
 * Rendered on the server with no client component: there is nothing to interact with. Every value
 * shown is an internal id, a type or a time — the table has no column that could hold anything else.
 */

/** A server-rendered row. Ids are internal uuids; the shortened form is for reading, not security. */
const REFERENCE_PREFIX = 8;

export default async function IntegrationsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const userId = await getCurrentUserId();
  if (!userId) redirect(`/${locale}/auth/login`);

  const t = await getTranslations("Integrations");
  const format = await getFormatter();
  const resolved = await resolveScannerContext(userId, null);
  if (resolved.kind !== "ready") notFound();
  const { ctx } = resolved.context;

  if (ctx.role !== MembershipRole.OWNER && ctx.role !== MembershipRole.MANAGER) notFound();

  let events;
  try {
    events = await listIntegrationEvents(ctx);
  } catch (e) {
    if (isAppError(e)) notFound();
    throw e;
  }

  const label: Record<IntegrationEventType, string> = {
    [IntegrationEventType.PROMOTION_REDEMPTION_RECORDED]: t("typeRedemptionRecorded"),
    [IntegrationEventType.PROMOTION_REDEMPTION_VOIDED]: t("typeRedemptionVoided"),
  };

  return (
    <>
      <PageHeader title={t("title")} description={t("subtitle")} />

      <div className="space-y-6" data-testid="integrations">
        <p
          className="rounded-xl bg-slate-100 px-4 py-3 text-sm text-slate-700"
          data-testid="integrations-nothing-connected"
        >
          {t("nothingConnected")}
        </p>

        <section className="rounded-2xl border border-slate-200 bg-white p-5" data-testid="integration-events">
          <h2 className="text-lg font-semibold text-slate-900">{t("historyTitle")}</h2>
          <p className="mt-1 text-sm text-slate-500">{t("historyHint")}</p>

          {events.length === 0 ? (
            <div className="mt-6 text-center" data-testid="integration-events-empty">
              <p className="font-semibold text-slate-900">{t("emptyTitle")}</p>
              <p className="mt-1 text-sm text-slate-500">{t("emptyBody")}</p>
            </div>
          ) : (
            <ul className="mt-4 divide-y divide-slate-100">
              {events.map((event) => (
                <li key={event.id} className="flex flex-wrap items-baseline gap-x-4 gap-y-1 py-3" data-testid="integration-event-row">
                  <span className="font-medium text-slate-900">{label[event.eventType]}</span>
                  <span className="text-sm text-slate-500">
                    {t("occurredAt")}{" "}
                    {/* An ISO-shaped date inside an Arabic sentence needs isolating, as everywhere else. */}
                    <bdi>{format.dateTime(event.occurredAt, { dateStyle: "medium", timeStyle: "short" })}</bdi>
                  </span>
                  <span className="text-sm text-slate-400">
                    {t("reference")} <bdi className="font-mono">{event.entityId.slice(0, REFERENCE_PREFIX)}</bdi>
                  </span>
                  <span className="text-sm text-slate-400">
                    {t("envelope")} <bdi>{t("envelopeValue", { version: event.envelopeVersion })}</bdi>
                  </span>
                </li>
              ))}
            </ul>
          )}

          <p className="mt-5 text-xs text-slate-500" data-testid="integrations-no-contact-data">
            {t("noContactData")}
          </p>
        </section>

        <p className="text-xs text-slate-500">{t("roadmap")}</p>
      </div>
    </>
  );
}
