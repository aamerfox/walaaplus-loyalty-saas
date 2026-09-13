"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/routing";
import { Button, Notice } from "@/components/ui";

/**
 * The two lifecycle verbs a merchant reaches from a program's own page.
 *
 * **Open a draft.** A live version cannot be edited — the database refuses it — so changing a
 * program means drafting the next version and publishing it. This button creates the draft as an
 * exact copy of the live version and goes to the editor. Pressing it twice is safe: the service
 * returns the draft that is already open rather than refusing or creating a second.
 *
 * **Pause and resume.** Pausing stops NEW sign-ups and nothing else: every card already issued
 * keeps earning, keeps redeeming and keeps being reversible, because a customer holding a card did
 * nothing wrong when a merchant paused the program. The confirmation says exactly that, because
 * "pause" is a word a merchant could reasonably read as "stop".
 *
 * There is no delete, and there is no archive button. Deleting a program would orphan the cards
 * pinned to its versions, and the consequences of archiving one have not been designed — so neither
 * is offered rather than offered and refused.
 */
export default function ProgramLifecycle({
  businessId,
  templateId,
  status,
  hasDraft,
}: {
  businessId: string;
  templateId: string;
  status: "ACTIVE" | "PAUSED" | "DRAFT" | "ARCHIVED";
  hasDraft: boolean;
}) {
  const t = useTranslations("Programs");
  const tc = useTranslations("Common");
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(body: Record<string, unknown>, then: "draft" | "refresh") {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const response = await fetch("/api/staff/program-version", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ businessId, templateId, ...body }),
      });
      if (!response.ok) {
        setError(tc("genericError"));
        return;
      }
      if (then === "draft") router.push(`/business/programs/${templateId}/draft`);
      else router.refresh();
    } catch {
      setError(tc("genericError"));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-2">
      {error ? (
        <Notice tone="danger" testId="lifecycle-error">
          {error}
        </Notice>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="primary"
          disabled={pending}
          testId="open-draft"
          onClick={() => void run({ action: "createDraft" }, "draft")}
        >
          {hasDraft ? t("continueDraft") : t("newDraft")}
        </Button>

        {status === "ACTIVE" ? (
          <Button
            type="button"
            variant="secondary"
            disabled={pending}
            testId="pause-program"
            onClick={() => {
              if (window.confirm(t("confirmPause"))) void run({ action: "setStatus", status: "PAUSED" }, "refresh");
            }}
          >
            {t("pause")}
          </Button>
        ) : status === "PAUSED" ? (
          <Button
            type="button"
            variant="secondary"
            disabled={pending}
            testId="resume-program"
            onClick={() => void run({ action: "setStatus", status: "ACTIVE" }, "refresh")}
          >
            {t("resume")}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
