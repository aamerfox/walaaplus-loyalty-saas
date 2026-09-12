"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Notice } from "@/components/ui";

/**
 * The controls for one staff member.
 *
 * Everything here is a request to a server that decides. The component hides a control it knows the
 * server will refuse — a member's own row has no buttons, because nobody edits their own membership
 * — but hiding is a courtesy, not the rule: the same refusals are enforced in
 * `src/server/tenant/memberships.ts` inside its own transaction, and a request forged past this UI
 * gets the same answer.
 *
 * The refusals are translated from an error CODE rather than from the server's sentence. An Arabic
 * screen must not print an English message from an API, and the code is the stable half of the
 * contract.
 */

type Action =
  | { action: "role"; membershipId: string; role: "MANAGER" | "CASHIER" }
  | { action: "permissions"; membershipId: string; permissions: string[] }
  | { action: "locations"; membershipId: string; locationIds: string[] }
  | { action: "deactivate"; membershipId: string }
  | { action: "reactivate"; membershipId: string };

export default function StaffMemberControls({
  membershipId,
  role,
  active,
  isSelf,
  canEdit,
  assignedLocationIds,
  locations,
  unrestrictedLocations,
}: {
  membershipId: string;
  role: "OWNER" | "MANAGER" | "CASHIER";
  active: boolean;
  isSelf: boolean;
  canEdit: boolean;
  assignedLocationIds: string[];
  locations: { id: string; name: string }[];
  unrestrictedLocations: boolean;
}) {
  const t = useTranslations("Staff");
  const tc = useTranslations("Common");
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [assigned, setAssigned] = useState<string[]>(assignedLocationIds);

  if (isSelf) {
    return (
      <p className="text-sm text-ink-muted" data-testid={`staff-self-${membershipId}`}>
        {t("cannotEditSelf")}
      </p>
    );
  }
  if (!canEdit) {
    return (
      <p className="text-sm text-ink-muted" data-testid={`staff-readonly-${membershipId}`}>
        {t("needEditStaff")}
      </p>
    );
  }
  if (role === "OWNER") {
    return (
      <p className="text-sm text-ink-muted" data-testid={`staff-owner-${membershipId}`}>
        {t("ownerRowNote")}
      </p>
    );
  }

  async function send(body: Action) {
    setBusy(true);
    setFailure(null);
    try {
      const response = await fetch("/api/staff/membership", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: { code?: string } } | null;
        const code = payload?.error?.code;
        setFailure(code === "FORBIDDEN" ? t("refused") : code === "VALIDATION_ERROR" ? t("invalidChange") : tc("genericError"));
        return;
      }
      // The list is re-read from the server rather than patched here: a membership is exactly the
      // kind of state that must not be believed from a local copy.
      router.refresh();
    } catch {
      setFailure(tc("genericError"));
    } finally {
      setBusy(false);
    }
  }

  const toggleLocation = (id: string) => {
    const next = assigned.includes(id) ? assigned.filter((l) => l !== id) : [...assigned, id];
    setAssigned(next);
    void send({ action: "locations", membershipId, locationIds: next });
  };

  return (
    <div className="space-y-3">
      {failure ? (
        <Notice tone="danger" testId={`staff-error-${membershipId}`}>
          {failure}
        </Notice>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <label className="text-sm text-ink-muted" htmlFor={`role-${membershipId}`}>
          {t("role")}
        </label>
        <select
          id={`role-${membershipId}`}
          value={role}
          disabled={busy}
          data-testid={`staff-role-${membershipId}`}
          onChange={(e) => void send({ action: "role", membershipId, role: e.target.value as "MANAGER" | "CASHIER" })}
          className="rounded-xl border border-border bg-surface px-3 py-2 text-sm text-ink"
        >
          <option value="CASHIER">{t("roles.CASHIER")}</option>
          <option value="MANAGER">{t("roles.MANAGER")}</option>
        </select>

        <button
          type="button"
          disabled={busy}
          data-testid={`staff-active-${membershipId}`}
          onClick={() => void send({ action: active ? "deactivate" : "reactivate", membershipId })}
          className="rounded-xl border border-border px-3 py-2 text-sm font-semibold text-ink-muted hover:bg-surface-muted disabled:opacity-50"
        >
          {active ? t("deactivate") : t("reactivate")}
        </button>
      </div>

      {unrestrictedLocations ? (
        <p className="text-sm text-ink-muted">{t("unrestrictedLocations")}</p>
      ) : (
        <fieldset>
          <legend className="text-sm text-ink-muted">{t("assignedLocations")}</legend>
          <div className="mt-2 flex flex-wrap gap-3">
            {locations.map((location) => (
              <label key={location.id} className="flex items-center gap-2 text-sm text-ink">
                <input
                  type="checkbox"
                  checked={assigned.includes(location.id)}
                  disabled={busy}
                  data-testid={`staff-location-${membershipId}-${location.id}`}
                  onChange={() => toggleLocation(location.id)}
                  className="size-4"
                />
                {location.name}
              </label>
            ))}
          </div>
          {assigned.length === 0 ? (
            // An empty assignment is a denial, never "everywhere". Saying so here stops a manager
            // clearing the boxes and wondering why the till stopped working.
            <p className="mt-2 text-sm text-warn-ink" data-testid={`staff-no-locations-${membershipId}`}>
              {t("noLocationsWarning")}
            </p>
          ) : null}
        </fieldset>
      )}
    </div>
  );
}
