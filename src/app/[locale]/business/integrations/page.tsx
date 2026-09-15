import { IntegrationEventType, MembershipRole } from "@prisma/client";
import { getFormatter, getTranslations } from "next-intl/server";
import { notFound, redirect } from "next/navigation";
import { PageHeader } from "@/components/ui";
import { getCurrentUserId } from "@/server/auth/session";
import { isAppError } from "@/server/errors";
import { listIntegrationEvents } from "@/server/integrations/events";
import { listDestinations, webhooksConfigured } from "@/server/integrations/webhooks/destinations";
import { KEY_TTL_DAYS, listKeys, MAX_ACTIVE_KEYS_PER_BUSINESS } from "@/server/api/keys";
import { resolveScannerContext } from "@/server/tenant/scanner-context";
import ApiKeysClient, { type ApiKeyRow } from "./ApiKeysClient";
import WebhooksClient, { type DestinationRow } from "./WebhooksClient";

/**
 * What this business has recorded for a delivery mechanism that does not exist yet.
 *
 * **Owner and manager only.** A cashier serves the customer in front of them; a feed of everything
 * the business has done is a different thing, and they get a 404 rather than an empty screen.
 *
 * The screen's first job is to not lie. **No named provider is connected** — no email, SMS,
 * WhatsApp, payment or point-of-sale integration exists, and there is no key that could make one.
 * The notice at the top says so in as many words, because an integrations page with provider names
 * on it is how a product comes to be described as integrated with things it has never contacted.
 * `docs/INTEGRATIONS-CAPABILITY-MATRIX.md` §0.
 *
 * Since Phase 3B Prompt 2 the page has a second half: **custom webhook destinations**, which are
 * the one outbound capability the product has. That half is **owner only** — stricter than the
 * event history above it, because a destination is a standing instruction to send this business's
 * activity to a third party, and a manager should not be able to arrange one.
 *
 * Phase 3B.1 Prompt 2 adds a third: **public API keys**, the one INBOUND capability. Owner only for
 * the same reason and then some — a key is unattended read access to this history, valid for ninety
 * days, usable by anyone holding it.
 *
 * The three sections belong on one screen because they are one subject: what reaches this business
 * from outside, and what leaves it. Putting keys on their own page would have meant a new sidebar
 * entry, and the sidebar does not filter by role — so it would have advertised an owner-only screen
 * to every cashier.
 *
 * The event history is rendered on the server with no client component. Every value shown is an
 * internal id, a type or a time — the table has no column that could hold anything else.
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

  /*
   * The webhook half, for an owner only.
   *
   * A manager reaching this page sees the event history and nothing below it — not an empty
   * destinations list, not a disabled form. `listDestinations` would refuse them anyway; this is
   * what keeps the screen from advertising a capability they cannot use.
   */
  const isOwner = ctx.role === MembershipRole.OWNER;
  const destinations: DestinationRow[] = isOwner
    ? (await listDestinations(ctx)).map((row) => ({
        id: row.id,
        name: row.name,
        endpointHost: row.endpointHost,
        state: row.state,
        cipherKeyVersion: row.cipherKeyVersion,
        secretIssuedAt: row.secretIssuedAt.toISOString(),
        pending: row.pending,
        delivered: row.delivered,
        failed: row.failed,
        lastErrorClass: row.lastErrorClass,
      }))
    : [];

  /*
   * The owner's API keys.
   *
   * `listKeys` refuses a manager, so this is guarded by the same `isOwner` as the destinations
   * above rather than being allowed to throw. Every field here is metadata: a name, the PUBLIC
   * prefix, a state and three dates. **The digest is not in `KEY_SELECT` and the raw value is not
   * stored**, so there is nothing on this path that could carry a secret to the browser.
   */
  const apiKeys: ApiKeyRow[] = isOwner
    ? (await listKeys(ctx)).map((row) => ({
        id: row.id,
        name: row.name,
        keyPrefix: row.keyPrefix,
        state: row.state,
        issuedAt: row.issuedAt.toISOString(),
        expiresAt: row.expiresAt.toISOString(),
        revokedAt: row.revokedAt?.toISOString() ?? null,
        lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
        usable: row.usable,
      }))
    : [];

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

        {isOwner ? (
          <WebhooksClient businessId={ctx.businessId} destinations={destinations} configured={webhooksConfigured()} />
        ) : null}

        {isOwner ? (
          <ApiKeysClient
            businessId={ctx.businessId}
            keys={apiKeys}
            maxActive={MAX_ACTIVE_KEYS_PER_BUSINESS}
            ttlDays={KEY_TTL_DAYS}
          />
        ) : null}

        <p className="text-xs text-slate-500">{t("roadmap")}</p>
      </div>
    </>
  );
}
