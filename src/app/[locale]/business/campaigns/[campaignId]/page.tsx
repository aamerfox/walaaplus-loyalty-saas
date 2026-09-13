import { Permission } from "@prisma/client";
import { getTranslations } from "next-intl/server";
import { notFound, redirect } from "next/navigation";
import { Link } from "@/i18n/routing";
import { Badge, Card, Notice, PageHeader, Section, Table, Td, Th } from "@/components/ui";
import { getCurrentUserId } from "@/server/auth/session";
import { getApprovedSnapshot, listCampaignDecisions } from "@/server/campaigns/approvals";
import { getCampaign, listCampaignRevisions } from "@/server/campaigns/campaigns";
import { isAppError } from "@/server/errors";
import { listSegments } from "@/server/segments/segments";
import { resolveScannerContext } from "@/server/tenant/scanner-context";
import CampaignEditor from "../CampaignEditor";
import ApprovalPanel from "./ApprovalPanel";
import CampaignControls, { type CampaignStateName } from "./CampaignControls";

/**
 * One campaign draft: its content, its audience, and every revision of it.
 *
 * The revision history is the point of the page. A message a merchant intends to send to their own
 * customers is worth being able to read back — "what did this say on Tuesday" has an answer, because
 * every save appends a revision and the table rejects an update.
 *
 * ## Approval, and what it does not buy
 *
 * A campaign can be approved, which records an append-only decision about one exact revision and
 * freezes the audience into an immutable snapshot. The page says in three separate places that this
 * sends nothing — on the banner, in the approval panel, and in the readiness section that lists why
 * delivery is still impossible and always ends with the reason that never clears.
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
  let decisions;
  let snapshot;
  try {
    // Tenant-scoped: another business's campaign id is a 404, the same as one that does not exist.
    // Four reads, one round trip, and each re-checks the tenant in its own WHERE.
    [campaign, revisions, decisions, snapshot] = await Promise.all([
      getCampaign(ctx, campaignId),
      listCampaignRevisions(ctx, campaignId),
      listCampaignDecisions(ctx, campaignId),
      getApprovedSnapshot(ctx, campaignId),
    ]);
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
        actions={
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
            testId="campaign-state"
          >
            {t(`state.${campaign.state}`)}
          </Badge>
        }
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
              state={campaign.state as CampaignStateName}
              segmentId={campaign.segmentId}
              segments={segments.map((segment) => ({ id: segment.id, name: segment.name }))}
              // A branch-scoped member gets no audience number at all, rather than a smaller one.
              canPreview={ctx.locationIds === null}
            />
          </Card>
        </Section>
      ) : null}

      {mayEdit ? (
        <Section title={t("approvalTitle")} description={t("approvalSubtitle")} testId="campaign-approval">
          <Card>
            <ApprovalPanel
              businessId={ctx.businessId}
              campaignId={campaign.id}
              state={campaign.state as CampaignStateName}
              channel={campaign.channel}
              channelLabel={t(`channel.${campaign.channel}`)}
              latestRevisionNumber={campaign.latestRevision?.revisionNumber ?? null}
              approvedRevisionNumber={campaign.approvedRevisionNumber}
              hasAudience={campaign.segmentId !== null}
              // A branch-scoped member cannot verify a business-wide snapshot, so they cannot sign
              // one off. The server refuses them too; this only explains why.
              canApprove={ctx.locationIds === null}
            />
          </Card>
        </Section>
      ) : null}

      <Section title={t("snapshotTitle")} description={t("snapshotSubtitle")} testId="campaign-snapshot">
        <Card>
          {snapshot ? (
            <div className="space-y-1" data-testid="snapshot-counts">
              <p className="font-semibold text-ink">{t("snapshotMatched", { count: snapshot.matchedCount })}</p>
              <p className="text-sm text-ink">
                <Badge tone={snapshot.eligibleCount > 0 ? "success" : "neutral"}>
                  {t("snapshotEligible", { count: snapshot.eligibleCount })}
                </Badge>
              </p>
              {/* Exclusions as counts. No row is written for an excluded customer at all. */}
              <p className="text-xs text-ink-muted">{t("snapshotUnknown", { count: snapshot.unknownCount })}</p>
              <p className="text-xs text-ink-muted">{t("snapshotWithdrawn", { count: snapshot.withdrawnCount })}</p>
              {/*
                * `bdi` on both values. A Latin segment name and an ISO date are left-to-right runs
                * inside an Arabic sentence, and without isolation the bidi algorithm reorders them
                * — 2026-09-13 renders as 13-09-2026, which is a different date to anybody reading
                * it as written. On a record of a decision that is not a cosmetic problem.
                */}
              <p className="text-xs text-ink-muted">
                {t("snapshotSegment")} <bdi>{snapshot.segmentName}</bdi> ·{" "}
                {t("snapshotTaken")} <bdi>{snapshot.takenAt.toISOString().slice(0, 10)}</bdi>
              </p>
              <p className="text-xs text-ink-muted">{t("snapshotNoList")}</p>
              <Notice tone="info" testId="snapshot-immutable">
                {t("snapshotImmutable")}
              </Notice>
            </div>
          ) : (
            <p className="text-sm text-ink-muted" data-testid="snapshot-none">
              {t("snapshotNone")}
            </p>
          )}
        </Card>
      </Section>

      <Section title={t("readinessTitle")} testId="campaign-readiness">
        <Card>
          <p className="font-semibold text-ink" data-testid="readiness-answer">
            {t("readinessNo")}
          </p>
          <ul className="mt-2 space-y-1 text-sm text-ink-muted" data-testid="readiness-blockers">
            {campaign.readiness.blockers.map((blocker) => (
              <li key={blocker}>{t(`blocker.${blocker}`)}</li>
            ))}
          </ul>
          {/*
           * The rule a future delivery phase inherits, rendered rather than only documented: a
           * snapshot is the ceiling of an audience and never its authority.
           */}
          <Notice tone="info" testId="consent-recheck-note">
            {t("consentRecheckNote")}
          </Notice>
        </Card>
      </Section>

      <Section title={t("decisionsTitle")} description={t("decisionsSubtitle")} testId="campaign-decisions">
        {decisions.length === 0 ? (
          <Card>
            <p className="text-sm text-ink-muted" data-testid="decisions-empty">
              {t("decisionsEmpty")}
            </p>
          </Card>
        ) : (
          <Table testId="decision-table">
            <thead>
              <tr>
                <Th>{t("decisionWhen")}</Th>
                <Th>{t("decisionWhat")}</Th>
                <Th>{t("decisionVersion")}</Th>
                <Th className="hidden sm:table-cell">{t("decisionChannel")}</Th>
                <Th className="hidden sm:table-cell">{t("decisionWho")}</Th>
                <Th>{t("decisionAudience")}</Th>
              </tr>
            </thead>
            <tbody>
              {decisions.map((decision) => (
                <tr key={decision.id}>
                  <Td className="whitespace-nowrap tabular-nums text-ink-muted">
                    {decision.decidedAt.toISOString().slice(0, 10)}
                  </Td>
                  <Td>
                    <Badge tone={decision.decision === "APPROVED" ? "success" : "warn"}>
                      {t(`decision.${decision.decision}`)}
                    </Badge>
                    {decision.note ? <span className="mt-1 block text-xs text-ink-muted">{decision.note}</span> : null}
                  </Td>
                  <Td className="tabular-nums">{decision.revisionNumber}</Td>
                  <Td className="hidden text-ink-muted sm:table-cell">{t(`channel.${decision.intendedChannel}`)}</Td>
                  <Td className="hidden text-ink-muted sm:table-cell">{decision.decidedByName ?? "—"}</Td>
                  {/* The count, never the membership. A withdrawal took no snapshot, so it shows none. */}
                  <Td className="tabular-nums text-ink-muted">
                    {decision.snapshot ? decision.snapshot.eligibleCount : "—"}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Section>

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
