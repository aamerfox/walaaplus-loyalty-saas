import { Permission } from "@prisma/client";
import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";
import { Badge, Card, EmptyState, Notice, PageHeader, Section } from "@/components/ui";
import { getCurrentUserId } from "@/server/auth/session";
import { listBusinessPrograms } from "@/server/program/programs";
import { listSourceLinks } from "@/server/program/source-links";
import type { SegmentCondition } from "@/server/segments/definition";
import { listSegments } from "@/server/segments/segments";
import { listReadableLocations } from "@/server/tenant/locations";
import { resolveScannerContext } from "@/server/tenant/scanner-context";
import SegmentBuilder from "./SegmentBuilder";
import SegmentRowControls from "./SegmentRowControls";

/**
 * Saved customer segments.
 *
 * A segment is a rule a merchant saved — "points customers with more than 100 points who joined this
 * year" — and it is re-evaluated against live data every time anybody asks. It is never a stored
 * list of people: a copied list is stale the moment a customer earns a stamp, and it is a second
 * place personal data lives with its own retention question.
 *
 * Nothing on this page sends anything to anybody. Segments are a Phase 2 FOUNDATION: campaigns,
 * messages and automations are later prompts, and a button that promised one now would be promising
 * a capability that does not exist.
 */
export default async function SegmentsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const userId = await getCurrentUserId();
  if (!userId) redirect(`/${locale}/auth/login`);

  const t = await getTranslations("Segments");
  const resolved = await resolveScannerContext(userId, null);
  if (resolved.kind !== "ready") {
    return <EmptyState testId="segments-no-business" title={t("noBusinessTitle")} body={t("noBusinessBody")} />;
  }

  const { ctx } = resolved.context;
  // `VIEW_SEGMENTS` is an existing permission held by an owner and a manager. The server decides
  // again on every read and every write; this only decides what to render.
  if (!ctx.permissions.has(Permission.VIEW_SEGMENTS)) {
    return (
      <>
        <PageHeader title={t("title")} description={t("subtitle")} />
        <Notice tone="warn" testId="segments-forbidden">
          {t("forbidden")}
        </Notice>
      </>
    );
  }

  const mayEdit = ctx.permissions.has(Permission.EDIT_SEGMENTS);
  const [segments, programs, locations, sources] = await Promise.all([
    listSegments(ctx, { includeArchived: true }),
    listBusinessPrograms(ctx).catch(() => []),
    listReadableLocations(ctx),
    listSourceLinks(ctx).catch(() => []),
  ]);

  const programNames = new Map(programs.map((p) => [p.templateId, p.name]));
  const locationNames = new Map(locations.map((l) => [l.id, l.name]));

  /**
   * One saved condition, as a merchant reads it.
   *
   * The FIELD is translated and the VALUE is resolved to a name — a program id or a branch id on a
   * screen would be a raw database identifier, which this product does not show anywhere. Without
   * the value a merchant cannot tell "at least 5 stamps" from "at least 0", which is the difference
   * between a segment and everybody.
   */
  const describe = (condition: SegmentCondition): string => {
    const label = t(`field.${condition.field}`);
    switch (condition.field) {
      case "program":
        return `${label}: ${programNames.get(condition.templateId) ?? t("unknownValue")}`;
      case "programVersion":
        return `${label}: ${programNames.get(condition.templateId) ?? t("unknownValue")} v${condition.versionNumber}`;
      case "cardType":
        return `${label}: ${t(`cardType.${condition.cardType}`)}`;
      case "source":
        return `${label}: ${condition.name}`;
      case "servedAtLocation":
        return `${label}: ${locationNames.get(condition.locationId) ?? t("unknownValue")}`;
      case "stampBalance":
      case "pointBalance":
      case "rewardBalance": {
        const { min, max } = condition.range;
        const bounds = [min !== undefined ? `${t("atLeast")} ${min}` : null, max !== undefined ? `${t("atMost")} ${max}` : null];
        return `${label}: ${bounds.filter(Boolean).join(" · ")}`;
      }
      case "joinedAt":
      case "lastActivityAt": {
        const { after, before } = condition.dateRange;
        const bounds = [after ? `${t("onOrAfter")} ${after}` : null, before ? `${t("onOrBefore")} ${before}` : null];
        return `${label}: ${bounds.filter(Boolean).join(" · ")}`;
      }
    }
  };

  const live = segments.filter((s) => s.archivedAt === null);
  const archived = segments.filter((s) => s.archivedAt !== null);

  return (
    <>
      <PageHeader title={t("title")} description={t("subtitle")} />

      {live.length === 0 ? (
        <EmptyState
          testId="segments-empty"
          title={t("emptyTitle")}
          // Not "you have no customers" and not a zero: there is simply nothing saved yet.
          body={t("emptyBody")}
        />
      ) : (
        <Section title={t("savedTitle")} testId="segment-list">
          <div className="grid gap-4 sm:grid-cols-2">
            {live.map((segment) => (
              <Card key={segment.id} className="space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <p className="font-display text-lg font-bold text-ink">{segment.name}</p>
                  <Badge tone="neutral">
                    {segment.definition ? t(`match.${segment.definition.match}`) : t("unreadable")}
                  </Badge>
                </div>
                {segment.definition ? (
                  <ul className="space-y-1 text-sm text-ink-muted" data-testid={`segment-rules-${segment.id}`}>
                    {segment.definition.conditions.map((condition, index) => (
                      <li key={index}>{describe(condition)}</li>
                    ))}
                  </ul>
                ) : (
                  <Notice tone="warn">{t("unreadableBody")}</Notice>
                )}
                {mayEdit ? <SegmentRowControls businessId={ctx.businessId} segmentId={segment.id} archived={false} /> : null}
              </Card>
            ))}
          </div>
        </Section>
      )}

      {archived.length > 0 ? (
        <Section title={t("archivedTitle")} description={t("archivedSubtitle")} testId="segment-archived">
          <ul className="divide-y divide-border">
            {archived.map((segment) => (
              <li key={segment.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <span className="text-ink-muted">{segment.name}</span>
                {mayEdit ? <SegmentRowControls businessId={ctx.businessId} segmentId={segment.id} archived /> : null}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {mayEdit ? (
        <Section title={t("newTitle")} description={t("newSubtitle")}>
          <SegmentBuilder
            businessId={ctx.businessId}
            options={{
              programs: programs.map((p) => ({ templateId: p.templateId, name: p.name })),
              locations,
              // Display names only. A source token is a capability and never leaves the server.
              sources: [...new Set(sources.map((s) => s.name))],
            }}
          />
        </Section>
      ) : null}

      <Notice tone="info" testId="segments-foundation">
        {t("foundationNote")}
      </Notice>
    </>
  );
}
