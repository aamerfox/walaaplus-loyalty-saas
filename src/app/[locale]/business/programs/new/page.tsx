import { Permission } from "@prisma/client";
import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";
import { Notice, PageHeader } from "@/components/ui";
import { getCurrentUserId } from "@/server/auth/session";
import { resolveScannerContext } from "@/server/tenant/scanner-context";
import NewProgramForm from "./NewProgramForm";

/**
 * Create an additional loyalty program.
 *
 * The permission is checked here so the page can render a sentence rather than an error boundary,
 * and again by `createPointsProgram` / `createStampProgram` behind the endpoint. This check is
 * presentation; that one is enforcement.
 */
export default async function NewProgramPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const userId = await getCurrentUserId();
  if (!userId) redirect(`/${locale}/auth/login`);

  const t = await getTranslations("Programs");
  const resolved = await resolveScannerContext(userId, null);
  if (resolved.kind !== "ready") redirect(`/${locale}/business/programs`);

  const { ctx } = resolved.context;
  if (!ctx.permissions.has(Permission.EDIT_TEMPLATES)) {
    return (
      <>
        <PageHeader title={t("newProgram")} description={t("newSubtitle")} />
        <Notice tone="warn" testId="new-program-forbidden">
          {t("forbidden")}
        </Notice>
      </>
    );
  }

  return (
    <>
      <PageHeader title={t("newProgram")} description={t("newSubtitle")} />
      <NewProgramForm locale={locale} />
    </>
  );
}
