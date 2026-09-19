import { CardType, Permission } from "@prisma/client";
import { getTranslations } from "next-intl/server";
import { notFound, redirect } from "next/navigation";
import { Link } from "@/i18n/routing";
import { Badge, Card, DetailRow, EmptyState, Notice, PageHeader, Section, StatTile, Table, Td, Th } from "@/components/ui";
import { getCurrentUserId } from "@/server/auth/session";
import { getConsentHistory, getConsentStatus } from "@/server/consent/consent";
import { getCustomerProfile, listProfileActivity } from "@/server/customers/customer-360";
import { ForbiddenError, NotFoundError } from "@/server/errors";
import { resolveScannerContext } from "@/server/tenant/scanner-context";
import { listCardRedemptions } from "@/server/promotions/redemption";
import { countReferralAttributions, getCardAttribution } from "@/server/share/referrals";
import ConsentControls from "./ConsentControls";
import RedemptionsPanel from "./RedemptionsPanel";
import ReferralPanel from "./ReferralPanel";
import WalletPassPanel from "./WalletPassPanel";
import { minorToInput } from "@/lib/money-input";

/**
 * One customer, and everything this business knows about them.
 *
 * ## What changed, and why it was a defect rather than a gap
 *
 * This page used to be scoped to a CARD. With one program per business that was the same thing; with
 * several it stopped being true, and it stopped WORKING: the balances were read through the stamp
 * contract, so opening a customer who held a points card threw an invariant error the page turned
 * into a 404. A merchant running a points program could not open their own customers. Each card is
 * now read through the contract its own card type owns, and every card the person holds is on one
 * screen — which is also what a merchant means when they say "customer".
 *
 * ## What it does not show
 *
 * No card token, no card URL, no QR, no source token. None of them is selected by any query behind
 * this page. Revealing a card link stays the explicit, audited, branch-scoped action a staff member
 * takes from the scanner with the customer in front of them.
 *
 * Activity is the LEDGER, rendered. A reversal is its own row next to the operation it corrects, not
 * an edit of it, because that is how it is stored — and a merchant who can see the correction can
 * answer a customer's question about it.
 */

/** Operation kinds this product can produce, and therefore the ones with translated labels. */
const LABELLED_KINDS = [
  "MANUAL_AWARD",
  "VISIT_AWARD",
  "PURCHASE_AWARD",
  "STAMP_CONVERTED",
  "REWARD_EARNED",
  "REWARD_REDEEMED",
  "WELCOME_BONUS",
  "REVERSAL",
] as const;
type LabelledKind = (typeof LABELLED_KINDS)[number];

function isLabelledKind(kind: string): kind is LabelledKind {
  return (LABELLED_KINDS as readonly string[]).includes(kind);
}

export default async function CustomerProfilePage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; profileId: string }>;
  searchParams: Promise<{ b?: string }>;
}) {
  const { locale, profileId } = await params;
  const { b } = await searchParams;

  const userId = await getCurrentUserId();
  if (!userId) redirect(`/${locale}/auth/login`);

  const t = await getTranslations("Customers");
  const tReferral = await getTranslations("Referral");
  const kinds = await getTranslations("OperationKinds");
  const tConsent = await getTranslations("Consent");
  const resolved = await resolveScannerContext(userId, b ?? null);
  if (resolved.kind !== "ready") notFound();
  const { ctx } = resolved.context;

  let profile;
  let activity;
  let consent;
  let consentHistory;
  try {
    // Four reads, all tenant-scoped. A profile id from another business, and one this member may
    // not read, both end here as the same 404.
    [profile, activity, consent, consentHistory] = await Promise.all([
      getCustomerProfile(ctx, profileId),
      listProfileActivity(ctx, profileId),
      getConsentStatus(ctx, profileId),
      getConsentHistory(ctx, profileId),
    ]);
  } catch (e) {
    // Only the expected tenant/authorization denials become the generic non-enumerating 404.
    // Unexpected failures must retain their normal error path and must not be disguised as access control.
    if (e instanceof ForbiddenError || e instanceof NotFoundError) notFound();
    throw e;
  }
  const mayEditConsent = ctx.permissions.has(Permission.EDIT_CUSTOMERS) && ctx.role !== "CASHIER";
  // Withdrawing a referral record is a correction to the business's own history, not counter work.
  const mayVoidReferral = mayEditConsent && (ctx.role === "OWNER" || ctx.role === "MANAGER");

  /*
   * How each card arrived, and the business-wide count.
   *
   * Per card, because an attribution belongs to the card it was recorded against. The count is an
   * aggregate and stays one: nothing here lists attributions, names a referrer or ranks anybody.
   */
  const [attributions, referralCounts, redemptions] = await Promise.all([
    Promise.all(
      profile.cards.map(async (card) => [card.customerCardId, await getCardAttribution(ctx, card.customerCardId)] as const),
    ).then((entries) => new Map(entries)),
    countReferralAttributions(ctx),
    // What each card has been recorded as owed. Per card, because a redemption attaches to one.
    Promise.all(
      profile.cards.map(async (card) => [card.customerCardId, await listCardRedemptions(ctx, card.customerCardId)] as const),
    ).then((entries) => new Map(entries)),
  ]);

  const numbers = new Intl.NumberFormat(locale === "ar" ? "ar-SY-u-nu-latn" : "en");
  const name = [profile.firstName, profile.lastName].filter(Boolean).join(" ");

  return (
    <>
      <PageHeader
        title={name || t("unnamedCustomer")}
        description={t("profileSubtitle")}
        back={
          <Link
            href="/business/customers"
            className="inline-flex items-center gap-1 text-sm font-semibold text-ink-muted underline-offset-4 hover:text-ink hover:underline"
          >
            <span aria-hidden="true" className="rtl:rotate-180">
              &#8592;
            </span>
            {t("backToList")}
          </Link>
        }
      />

      <Card>
        <dl data-testid="customer-identity">
          <DetailRow label={t("phone")}>
            {/* Latin digits in both locales, so `dir="ltr"` keeps the + at the front. */}
            <span dir="ltr">{profile.phone}</span>
          </DetailRow>
          <DetailRow label={t("joined")}>{profile.firstSeenAt.toISOString().slice(0, 10)}</DetailRow>
          <DetailRow label={t("lastSeen")}>
            {profile.lastSeenAt ? profile.lastSeenAt.toISOString().slice(0, 10) : t("neverSeen")}
          </DetailRow>
          <DetailRow label={t("marketingConsent")}>
            <span className="inline-flex items-center gap-2">
              <Badge
                tone={consent.state === "GRANTED" ? "success" : consent.state === "WITHDRAWN" ? "neutral" : "warn"}
                testId="consent-state"
              >
                {tConsent(`state.${consent.state}`)}
              </Badge>
              {/*
               * "Ticked a box, but we cannot say when or to what" is not a permission, and the
               * screen says so rather than showing a green tick over a gap in the record.
               */}
              {consent.marketingEligible ? null : (
                <span className="text-xs text-ink-muted">{tConsent("notEligible")}</span>
              )}
            </span>
          </DetailRow>
        </dl>
      </Card>

      <Section title={t("cardsTitle")} description={t("cardsSubtitle")} testId="customer-cards">
        {profile.cards.length === 0 ? (
          <EmptyState testId="customer-no-cards" title={t("noCardsTitle")} body={t("noCardsBody")} />
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            {profile.cards.map((card) => (
              <Card key={card.customerCardId} className="space-y-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-display text-lg font-bold text-ink">{card.programName}</p>
                    <p className="text-xs text-ink-muted">{t("serial", { serial: card.serialNumber })}</p>
                  </div>
                  <div className="flex shrink-0 flex-wrap gap-2">
                    <Badge tone={card.cardType === CardType.POINTS ? "accent" : "brand"}>
                      {t(`cardType.${card.cardType}`)}
                    </Badge>
                    {/* The rules this card was SOLD under. A new version does not move it. */}
                    <Badge tone="neutral">{t("onVersion", { number: card.versionNumber })}</Badge>
                  </div>
                </div>

                {/*
                  * Each tile is gated on the card type that OWNS that balance, never on
                  * "not points, therefore stamps".
                  *
                  * A cashback or discount card fell into the stamp arm before this change and
                  * rendered "Stamps: 0" on a customer's record - a plausible, wrong number about
                  * somebody's account. A money card's balance is in currency minor units and its
                  * screen is Phase 4 Prompt 2; until then this shows the card's TYPE and no balance,
                  * which is the honest answer rather than a confident wrong one.
                  */}
                <div className="grid grid-cols-2 gap-3">
                  {card.cardType === CardType.POINTS ? (
                    <StatTile label={t("points")} value={numbers.format(card.pointBalance)} testId="card-points" />
                  ) : card.cardType === CardType.STAMP ? (
                    <StatTile
                      label={t("stamps")}
                      value={numbers.format(card.stampBalance)}
                      hint={
                        card.stampsRequiredPerReward === null
                          ? undefined
                          : t("stampsToNext", { count: card.stampsToNextReward ?? 0 })
                      }
                      testId="card-stamps"
                    />
                  ) : (
                    <StatTile
                      label={card.cardType === CardType.CASHBACK ? t("monetaryBalance") : t("discountCard")}
                      value={card.money ? `${minorToInput(card.money.balanceMinor, card.money.currencyExponent)} ${card.money.currency}` : "—"}
                      testId="card-monetary"
                    />
                  )}
                  {/*
                    * Rewards belong to the stamp and points mechanics. A money card has no reward
                    * balance and never will - cashback is spent against a bill, not exchanged for
                    * an item - so showing it "Rewards: 0" would imply a mechanic this card does not
                    * have. Zero is not wrong here; it is about a different programme.
                    */}
                  {card.cardType === CardType.POINTS || card.cardType === CardType.STAMP ? (
                    <StatTile
                      label={t("rewards")}
                      value={numbers.format(card.rewardBalance)}
                      tone="accent"
                      testId="card-rewards"
                    />
                  ) : null}
                </div>

                {card.money ? (
                  <div className="space-y-2 rounded-xl border border-border p-3" data-testid="customer-money-history">
                    <p className="text-sm font-semibold text-ink">{t("monetaryHistory")}</p>
                    {card.money.operations.length === 0 ? <p className="text-sm text-ink-muted">{t("noMonetaryOperations")}</p> : (
                      <ul className="space-y-2 text-sm">
                        {card.money.operations.map((operation) => (
                          <li key={operation.id} className="flex flex-wrap justify-between gap-2 border-b border-border pb-2 last:border-0">
                            <span><strong>{t(`monetaryKind.${operation.kind}`)}</strong> · {operation.at.toISOString().slice(0, 10)}</span>
                            <span className="tabular-nums">{t("billAmount", { amount: operation.grossAmountMinor })} · {t("effectAmount", { amount: operation.cashEffectMinor })}</span>
                            {operation.reversalOfId ? <Badge tone="warn">{t("correction")}</Badge> : null}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ) : null}

                {card.cardType === CardType.POINTS && card.tiers.length > 0 ? (
                  <ul className="space-y-1 text-sm" data-testid="card-tiers">
                    {card.tiers.map((tier) => (
                      <li key={tier.name} className="flex items-center justify-between gap-3">
                        <span className={tier.affordable ? "font-semibold text-ink" : "text-ink-muted"}>{tier.name}</span>
                        <span className="tabular-nums text-ink-muted">
                          {t("costPoints", { count: tier.requiredPoints })}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : null}

                <dl className="text-sm">
                  <DetailRow label={t("branches")}>
                    {card.locationNames.length === 0 ? t("mainBranchOnly") : card.locationNames.join("، ")}
                  </DetailRow>
                  <DetailRow label={t("source")}>{card.sourceName ?? t("noSource")}</DetailRow>
                  <DetailRow label={t("issued")}>{card.issuedAt.toISOString().slice(0, 10)}</DetailRow>
                </dl>

                {/*
                 * Stamp cards only, because that is what the pass builders cover in this phase, and
                 * an inert button on a points card would be a worse answer than no button.
                 */}
                {mayEditConsent && card.cardType === CardType.STAMP ? (
                  <WalletPassPanel businessId={ctx.businessId} customerCardId={card.customerCardId} />
                ) : null}

                {mayEditConsent ? (
                  <RedemptionsPanel
                    businessId={ctx.businessId}
                    mayVoid={mayVoidReferral}
                    redemptions={(redemptions.get(card.customerCardId) ?? []).map((row) => ({
                      id: row.id,
                      promotionName: row.promotionName,
                      benefitDescription: row.benefitDescription,
                      recordedAt: row.recordedAt.toISOString(),
                      voided: row.voided,
                      voidedAt: row.voidedAt?.toISOString() ?? null,
                      voidReason: row.voidReason,
                      recordedByName: row.recordedByName,
                    }))}
                  />
                ) : null}

                {mayEditConsent ? (
                  <ReferralPanel
                    businessId={ctx.businessId}
                    mayVoid={mayVoidReferral}
                    attribution={(() => {
                      const found = attributions.get(card.customerCardId) ?? null;
                      if (!found) return null;
                      // Serialised for the client boundary. Dates as ISO strings, and still nothing
                      // about the referring side — there is nothing here to leave out.
                      return {
                        id: found.id,
                        recordedAt: found.recordedAt.toISOString(),
                        method: found.method,
                        voided: found.voided,
                        voidedAt: found.voidedAt?.toISOString() ?? null,
                        voidReason: found.voidReason,
                        recordedByName: found.recordedByName,
                      };
                    })()}
                  />
                ) : null}
              </Card>
            ))}
          </div>
        )}

        {/*
         * An aggregate, and only an aggregate. There is deliberately no list behind it: a table of
         * attributions ordered by referrer is a reward programme's report, for a reward programme
         * that does not exist (D15).
         */}
        {mayEditConsent ? (
          <Notice tone="info" testId="referral-counts">
            {/* The heading on its own line: run together with the sentence it read as one garbled one. */}
            <span className="block font-semibold">{tReferral("countsTitle")}</span>
            {tReferral("countsBody", { count: referralCounts.standing })}{" "}
            {referralCounts.voided > 0 ? `${tReferral("countsWithdrawn", { count: referralCounts.voided })} ` : ""}
            {tReferral("countsAggregate")}
          </Notice>
        ) : null}
      </Section>

      <Section title={tConsent("title")} description={tConsent("subtitle")} testId="customer-consent">
        <Card className="space-y-4">
          {consent.ambiguity !== null ? (
            <Notice tone="warn" testId="consent-ambiguity">
              {tConsent(`ambiguity.${consent.ambiguity}`)}
            </Notice>
          ) : null}

          <Table testId="consent-history">
            <thead>
              <tr>
                <Th>{tConsent("when")}</Th>
                <Th>{tConsent("what")}</Th>
                <Th className="hidden sm:table-cell">{tConsent("how")}</Th>
                <Th className="hidden sm:table-cell">{tConsent("who")}</Th>
              </tr>
            </thead>
            <tbody>
              {consentHistory.map((entry) => (
                <tr key={entry.id}>
                  <Td className="whitespace-nowrap tabular-nums text-ink-muted">
                    {/* "Not recorded" is the truth for an enrolment taken before the consent
                        version was wired up. Nothing invents a date to fill the column. */}
                    {entry.recordedAt ? entry.recordedAt.toISOString().slice(0, 10) : tConsent("notRecorded")}
                  </Td>
                  <Td>
                    <span className="font-semibold">{tConsent(`state.${entry.state}`)}</span>
                    {entry.isOrigin ? (
                      <Badge tone="neutral" className="ms-2">
                        {tConsent("atSignUp")}
                      </Badge>
                    ) : null}
                    {entry.reason ? <p className="text-xs text-ink-muted">{entry.reason}</p> : null}
                  </Td>
                  <Td className="hidden text-ink-muted sm:table-cell">{tConsent(`capture.${entry.capturedVia}`)}</Td>
                  <Td className="hidden text-ink-muted sm:table-cell">{entry.actorName ?? "—"}</Td>
                </tr>
              ))}
            </tbody>
          </Table>

          {mayEditConsent ? (
            <ConsentControls businessId={ctx.businessId} profileId={profileId} state={consent.state} />
          ) : null}

          <Notice tone="info" testId="consent-append-only">
            {tConsent("appendOnlyNote")}
          </Notice>
        </Card>
      </Section>

      <Section title={t("historySection")} description={t("historySubtitle")} testId="customer-activity">
        {activity.items.length === 0 ? (
          <EmptyState testId="customer-history-empty" title={t("historyEmptyTitle")} body={t("historyEmptyBody")} />
        ) : (
          <Table testId="customer-history">
            <thead>
              <tr>
                <Th>{t("when")}</Th>
                <Th>{t("what")}</Th>
                <Th>{t("program")}</Th>
                <Th className="hidden sm:table-cell">{t("branch")}</Th>
                <Th className="text-end">{t("change")}</Th>
                <Th className="text-end">{t("balanceAfter")}</Th>
              </tr>
            </thead>
            <tbody>
              {activity.items.map((row) => (
                <tr key={row.id}>
                  <Td className="whitespace-nowrap tabular-nums text-ink-muted">
                    {row.createdAt.toISOString().slice(0, 10)}
                  </Td>
                  <Td>
                    <span className="font-semibold">
                      {isLabelledKind(row.kind) ? kinds(row.kind) : row.kind}
                    </span>
                    {/* A reversal is a row, not an edit. Saying so is the point of showing it. */}
                    {row.reversalOfOperationId !== null ? (
                      <Badge tone="warn" className="ms-2">
                        {t("correction")}
                      </Badge>
                    ) : null}
                    {row.countsAsVisit ? (
                      <Badge tone="accent" className="ms-2">
                        {t("countsAsVisit")}
                      </Badge>
                    ) : null}
                  </Td>
                  <Td className="text-ink-muted">{row.programName}</Td>
                  <Td className="hidden text-ink-muted sm:table-cell">{row.locationName}</Td>
                  <Td className="text-end tabular-nums font-semibold">
                    {row.quantity > 0 ? `+${numbers.format(row.quantity)}` : numbers.format(row.quantity)}
                  </Td>
                  <Td className="text-end tabular-nums text-ink-muted">{numbers.format(row.balanceAfter)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}

        {activity.nextCursor !== null ? (
          <p className="text-xs text-ink-muted" data-testid="customer-history-more">
            {t("historyTruncated")}
          </p>
        ) : null}

        <Notice tone="info" testId="customer-ledger-note">
          {t("ledgerNote")}
        </Notice>
      </Section>
    </>
  );
}
