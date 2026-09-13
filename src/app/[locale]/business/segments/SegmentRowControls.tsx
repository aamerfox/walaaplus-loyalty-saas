"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/routing";
import { Button, Notice } from "@/components/ui";

/**
 * Archive a saved segment, or bring one back.
 *
 * There is no delete button, because there is no delete verb: a campaign in a later phase will
 * reference a segment by id, and a row that vanished would take "who did we send this to" with it.
 * Archiving hides it from the working list and keeps the record.
 */
export default function SegmentRowControls({
  businessId,
  segmentId,
  archived,
}: {
  businessId: string;
  segmentId: string;
  archived: boolean;
}) {
  const t = useTranslations("Segments");
  const tc = useTranslations("Common");
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(action: "archive" | "restore") {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/staff/segments", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ businessId, action, segmentId }),
      });
      if (response.ok) {
        router.refresh();
        return;
      }
      const payload = (await response.json().catch(() => null)) as { error?: { code?: string } } | null;
      setError(payload?.error?.code === "NAME_TAKEN" ? t("errorNameTaken") : tc("genericError"));
    } catch {
      setError(tc("genericError"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <Button
        type="button"
        size="sm"
        variant={archived ? "secondary" : "ghost"}
        disabled={busy}
        testId={archived ? "segment-restore" : "segment-archive"}
        onClick={() => void run(archived ? "restore" : "archive")}
      >
        {archived ? t("restore") : t("archive")}
      </Button>
    </div>
  );
}
