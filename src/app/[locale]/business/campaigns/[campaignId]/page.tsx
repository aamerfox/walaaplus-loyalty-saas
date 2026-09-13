import { Permission } from "@prisma/client";
import { getTranslations } from "next-intl/server";
import { notFound, redirect } from "next/navigation";
import { Link } from "@/i18n/routing";
import { Badge, Card, Notice, PageHeader, Section, Table, Td, Th } from "@/components/ui";
import { getCurrentUserId } from "@/server/auth/session";
import { getCampaign, listCampaignRevisions } from "@/server/campaigns/campaigns";
import { isAppError } from "@/server/errors";
import { listSegments } from "@/server/segments/segments";
import { resolveScannerContext } from "@/server/tenant/scanner-context";
import CampaignEditor from "../CampaignEditor";
import CampaignControls from "./CampaignControls";

/**
 * One campaign draft: its content, its audience, and every revision of it.
 *
 * The revision history is the point of the page. A message a merchant intends to send to their own
 * customers is worth being able to read back — "what did this say on Tuesday" has an answer, because
 * every save appends a revision and the table rejects an update.
 *
 * **Nothing here sends.** No send control, no schedule control, and no disabled one.
 */
export default async function CampaignDetailPage({
  params,
}: {
  params: Promise<{ locale: string; campaignId: string }>;
}) {
  const { locale, campaignId } = await params;
  const userId = await getCurrentUserId();
  if (!userId) redirect(`/${locale}/auth/login`);

  const t = await getTranslations("Campaigns");
  const resolved = await resolveScannerContext(userId, null);
  if (resolved.kind !== "ready") notFound();
  const { ctx } = resolved.context;

  let campaign;
  let revisions;
  try {
    // Tenant-scoped: another business's campaign id is a 404, the same as one that does not exist.
    [campaign, revisions] = await Promise.all([getCampaign(ctx, campaignId), listCampaignRevisions(ctx, campaignId)]);
  } catch (e) {
    if (isAppError(e)) notFound();
    throw e;
  }

  const mayEdit = ctx.permissions.has(Permission.EDIT_PUSHES);
  const segments = await listSegments(ctx).catch(() => []);

  return (
    <>
      <PageHeader
        title={campaign.name}
        description={t("detailSubtitle", { channel: t(`channel.${campaign.channel}`) })}
        back={
          <Link
            href="/business/campaigns"
            className="inline-flex items-center gap-1 text-sm font-semibold text-ink-muted underline-offset-4 hover:text-ink hover:underline"
          >
            <span aria-hidden="true" className="rtl:rotate-180">
              &#8592;
            </span>
            {t("backToList")}
          </Link>
        }
        actions={<Badge tone={campaign.state === "READY" ? "accent" : "neutral"}>{t(`state.${campaign.state}`)}</Badge>}
      />

      <Notice tone="warn" testId="campaign-draft-only-detail">
        {t("draftOnlyBanner")}
      </Notice>

      {mayEdit ? (
        <Section title={t("audienceTitle")} description={t("audienceSubtitle")}>
          <Card>
            <CampaignControls
              businessId={ctx.businessId}
              campaignId={campaign.id}
              state={campaign.state}
              segmentId={campaign.segmentId}
              segments={segments.map((segment) => ({ id: segment.id, name: segment.name }))}
              // A branch-scoped member gets no audience number at all, rather than a smaller one.
              canPreview={ctx.locationIds === null}
            />
          </Card>
        </Section>
      ) : null}

      {mayEdit && campaign.archivedAt === null ? (
        <Section title={t("contentTitle")} description={t("contentSubtitle")}>
          <CampaignEditor
            businessId={ctx.businessId}
            campaignId={campaign.id}
            mode="revise"
            segments={[]}
            initial={{
              name: campaign.name,
              locale: campaign.locale === "ar" ? "ar" : "en",
              channel: campaign.channel,
              segmentId: campaign.segmentId ?? "",
              subject: campaign.latestRevision?.subject ?? "",
              body: campaign.latestRevision?.body ?? "",
            }}
          />
        </Section>
      ) : null}

      <Section title={t("revisionsTitle")} description={t("revisionsSubtitle")} testId="campaign-revisions">
        <Table testId="revision-table">
          <thead>
            <tr>
              <Th>{t("revision")}</Th>
              <Th>{t("revisionWhen")}</Th>
              <Th className="hidden sm:table-cell">{t("revisionWho")}</Th>
              <Th>{t("revisionBody")}</Th>
            </tr>
          </thead>
          <tbody>
            {revisions.map((revision) => (
              <tr key={revision.revisionNumber}>
                <Td className="font-semibold tabular-nums">{revision.revisionNumber}</Td>
                <Td className="whitespace-nowrap tabular-nums text-ink-muted">
                  {revision.createdAt.toISOString().slice(0, 10)}
                </Td>
                <Td className="hidden text-ink-muted sm:table-cell">{revision.authorName ?? "—"}</Td>
                <Td>
                  {/* The draft's own direction, not the screen's: an Arabic message must read the
                      way its readers will read it, whichever interface it was written on. */}
                  <span className="line-clamp-2 whitespace-pre-wrap" dir={campaign.locale === "ar" ? "rtl" : "ltr"}>
                    {revision.body}
                  </span>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
        <Notice tone="info" testId="campaign-append-only">
          {t("appendOnlyNote")}
        </Notice>
      </Section>
    </>
  );
}
