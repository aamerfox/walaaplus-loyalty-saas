import { getTranslations } from "next-intl/server";
import { Wordmark } from "@/components/brand/Wordmark";

/**
 * The old public enrolment link — **withdrawn**, and answered identically for every visitor.
 *
 * Owner decision **B7, option 3**. Public self-service enrolment issued a live card to a number
 * that had never enrolled and nothing to a number that had, which told whoever submitted a number
 * which case they hit. That is a property of the flow, not of its wording: no status code or
 * redirect closes it, only proof that the submitter owns the number, and Phase 1a has no channel
 * to obtain one.
 *
 * **This page resolves nothing.** The token in the URL is never read, never looked up and never
 * validated, so a real printed link and an invented one render exactly the same words at exactly
 * the same cost. That matters: turning "enrolment is closed" into "this particular link is dead"
 * would replace one oracle with a smaller one that says which businesses exist.
 *
 * Printed QR codes in the wild therefore keep working as *directions* — a customer who scans one
 * is told, in their own language, to ask at the counter. Their card, if they already have one,
 * keeps working at its own link; nothing was deleted.
 */
export default async function JoinWithdrawnPage() {
  const t = await getTranslations("Join");

  return (
    <main className="flex min-h-screen items-center justify-center bg-app px-4 py-10">
      <div className="mx-auto w-full max-w-md space-y-6">
        {/* A customer reaches this page from a QR printed before enrolment moved to the counter.
            The mark tells them whose product is talking to them before they read the sentence. */}
        <div className="flex justify-center">
          <Wordmark height={28} className="h-7 w-auto" />
        </div>
        <div
          data-testid="join-withdrawn"
          className="w-full rounded-2xl border border-border bg-surface p-8 text-center shadow-sm"
        >
          <h1 className="font-display text-2xl font-extrabold text-ink">{t("movedTitle")}</h1>
          <p className="mt-3 leading-relaxed text-ink-muted">{t("movedBody")}</p>
          <p className="mt-6 text-xs text-ink-faint">{t("movedHaveCard")}</p>
        </div>
      </div>
    </main>
  );
}
