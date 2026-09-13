import { Permission } from "@prisma/client";
import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";
import { Link } from "@/i18n/routing";
import { Badge, buttonClass, Card, EmptyState, Notice, PageHeader, Section } from "@/components/ui";
import { getCurrentUserId } from "@/server/auth/session";
import { listCampaigns } from "@/server/campaigns/campaigns";
import { listSegments } from "@/server/segments/segments";
import { resolveScannerContext } from "@/server/tenant/scanner-context";
import CampaignEditor from "./CampaignEditor";

/**
 * Campaign drafts.
 *
 * **Nothing on this screen sends anything, and nothing on it ever will without a separate build.**
 * There is no send button, no schedule picker and no disabled "coming soon" control, because a
 * disabled control is a promise. The banner says what the product does: a merchant writes a message
 * and sees what it would look like.
 *
 * The audience is a saved segment, chosen by name, re-evaluated live whenever anyone asks how many
 * people it matches. No recipient list is stored anywhere, and none is shown here — the preview is
 * three integers on the draft's own page.
 */
export default async function CampaignsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const userId = await getCurrentUserId();
  if (!userId) redirect(`/${locale}/auth/login`);

  const t = await getTranslations("Campaigns");
  const resolved = await resolveScannerContext(userId, null);
  if (resolved.kind !== "ready") {
    return <EmptyState testId="campaigns-no-business" title={t("noBusinessTitle")} body={t("noBusinessBody")} />;
  }

  const { ctx } = resolved.context;
  // `VIEW_PUSHES` / `EDIT_PUSHES` already existed and are the product's engagement permissions. The
  // server decides again on every read and write; this only decides what to render.
  if (!ctx.permissions.has(Permission.VIEW_PUSHES)) {
    return (
      <>
        <PageHeader title={t("title")} description={t("subtitle")} />
        <Notice tone="warn" testId="campaigns-forbidden">
          {t("forbidden")}
        </Notice>
      </>
    );
  }

  const mayEdit = ctx.permissions.has(Permission.EDIT_PUSHES);
  const [campaigns, segments] = await Promise.all([
    listCampaigns(ctx, { includeArchived: true }),
    listSegments(ctx).catch(() => []),
  ]);

  const live = campaigns.filter((campaign) => campaign.archivedAt === null);
  const archived = campaigns.filter((campaign) => campaign.archivedAt !== null);

  return (
    <>
      <PageHeader title={t("title")} description={t("subtitle")} />

      <Notice tone="warn" testId="campaigns-draft-only">
        {t("draftOnlyBanner")}
      </Notice>

      {live.length === 0 ? (
        <EmptyState testId="campaigns-empty" title={t("emptyTitle")} body={t("emptyBody")} />
      ) : (
        <Section title={t("draftsTitle")} testId="campaign-list">
          <div className="grid gap-4 sm:grid-cols-2">
            {live.map((campaign) => (
              <Card key={campaign.id} className="space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-display text-lg font-bold text-ink">{campaign.name}</p>
                    <p className="text-xs text-ink-muted">
                      {t("revisionCount", { count: campaign.revisionCount })}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-wrap gap-2">
                    <Badge
                      tone={
                        campaign.state === "APPROVED"
                          ? "success"
                          : campaign.state === "IN_REVIEW"
                            ? "accent"
                            : campaign.state === "WITHDRAWN"
                              ? "warn"
                              : "neutral"
                      }
                    >
                      {t(`state.${campaign.state}`)}
                    </Badge>
                    <Badge tone="neutral">{t(`channel.${campaign.channel}`)}</Badge>
                  </div>
                </div>

                <p className="line-clamp-3 whitespace-pre-wrap text-sm text-ink-muted" dir={campaign.locale === "ar" ? "rtl" : "ltr"}>
                  {campaign.latestRevision?.body ?? ""}
                </p>

                <p className="text-xs text-ink-muted">
                  {campaign.segmentName ? t("audienceIs", { name: campaign.segmentName }) : t("noAudienceYet")}
                </p>

                <Link href={`/business/campaigns/${campaign.id}`} className={buttonClass("secondary", "sm")}>
                  {t("open")}
                </Link>
              </Card>
            ))}
          </div>
        </Section>
      )}

      {archived.length > 0 ? (
        <Section title={t("archivedTitle")} description={t("archivedSubtitle")} testId="campaign-archived">
          <ul className="divide-y divide-border">
            {archived.map((campaign) => (
              <li key={campaign.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <span className="text-ink-muted">{campaign.name}</span>
                <Link href={`/business/campaigns/${campaign.id}`} className="text-sm font-semibold text-accent-ink underline-offset-4 hover:underline">
                  {t("open")}
                </Link>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {mayEdit ? (
        <Section title={t("newTitle")} description={t("newSubtitle")}>
          <CampaignEditor
            businessId={ctx.businessId}
            mode="create"
            segments={segments.map((segment) => ({ id: segment.id, name: segment.name }))}
            initial={{ name: "", locale: locale === "ar" ? "ar" : "en", channel: "PUSH", segmentId: "", subject: "", body: "" }}
          />
        </Section>
      ) : null}

      <Notice tone="info" testId="campaigns-foundation">
        {t("foundationNote")}
      </Notice>
    </>
  );
}
