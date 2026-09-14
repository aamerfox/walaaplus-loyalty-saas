import { MembershipRole } from "@prisma/client";
import { getTranslations } from "next-intl/server";
import { notFound, redirect } from "next/navigation";
import { PageHeader } from "@/components/ui";
import { getCurrentUserId } from "@/server/auth/session";
import { isAppError } from "@/server/errors";
import { listPromotions } from "@/server/promotions/promotions";
import { resolveScannerContext } from "@/server/tenant/scanner-context";
import PromotionsClient, { type PromotionRow } from "./PromotionsClient";

/**
 * The merchant's promotions.
 *
 * **Owner and manager only.** A cashier redeems a code a customer presents, at the till; they never
 * reach this screen, because a list of live promotions is a list of codes to hand out — and the
 * codes themselves are not on it either, because only a salted digest is stored.
 *
 * Nothing here calculates anything. A promotion is a name, a sentence about what the customer gets,
 * a window and some limits; a redemption records that somebody is owed it. See
 * `docs/PROMOTIONS-CAPABILITY-MATRIX.md` for what that deliberately excludes.
 */
export default async function PromotionsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const userId = await getCurrentUserId();
  if (!userId) redirect(`/${locale}/auth/login`);

  const t = await getTranslations("Promotions");
  const resolved = await resolveScannerContext(userId, null);
  if (resolved.kind !== "ready") notFound();
  const { ctx } = resolved.context;

  // A cashier gets a 404 rather than an empty screen: they are not being told there is a page here.
  if (ctx.role !== MembershipRole.OWNER && ctx.role !== MembershipRole.MANAGER) notFound();

  let promotions;
  try {
    promotions = await listPromotions(ctx);
  } catch (e) {
    if (isAppError(e)) notFound();
    throw e;
  }

  // Serialised for the client boundary: dates as ISO strings. No digest and no salt is in the view
  // to begin with, so there is nothing here to leave out.
  const rows: PromotionRow[] = promotions.map((row) => ({
    id: row.id,
    name: row.name,
    benefitDescription: row.benefitDescription,
    state: row.state,
    startsAt: row.startsAt?.toISOString() ?? null,
    endsAt: row.endsAt?.toISOString() ?? null,
    totalLimit: row.totalLimit,
    perCustomerLimit: row.perCustomerLimit,
    redeemed: row.redeemed,
    voided: row.voided,
    remaining: row.remaining,
  }));

  return (
    <>
      <PageHeader title={t("title")} description={t("subtitle")} />
      <div data-testid="promotions">
        <PromotionsClient businessId={ctx.businessId} promotions={rows} />
      </div>
    </>
  );
}
