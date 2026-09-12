import { getTranslations } from "next-intl/server";

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
    <main className="min-h-screen bg-gradient-to-b from-indigo-50 to-white px-4 py-10 dark:from-zinc-950 dark:to-zinc-900">
      <div className="mx-auto w-full max-w-md">
        <div
          data-testid="join-withdrawn"
          className="rounded-2xl border border-zinc-200 bg-white p-6 text-center shadow-sm dark:border-zinc-800 dark:bg-zinc-900"
        >
          <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-50">{t("movedTitle")}</h1>
          <p className="mt-3 text-zinc-600 dark:text-zinc-400">{t("movedBody")}</p>
          <p className="mt-6 text-xs text-zinc-400">{t("movedHaveCard")}</p>
        </div>
      </div>
    </main>
  );
}
