"use client";

import { useTranslations } from "next-intl";
import { usePathname, useRouter } from "@/i18n/routing";
import { useSearchParams } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button, Field, SelectInput, TextInput, Toolbar } from "@/components/ui";

/**
 * What the dashboard is counting, and where.
 *
 * The control writes its choice into the URL and lets the server re-read everything. That is not a
 * style preference: the numbers are computed on the server from the ledger, inside the caller's
 * tenant and location scope, and a filter held in component state would be a second place where
 * "which range am I looking at" is decided. A URL is also shareable, reloadable, and back-buttonable
 * — which is what a merchant comparing two months actually does.
 *
 * The branch list is the one the SERVER resolved for this member. A cashier-scoped membership never
 * sees a branch they cannot read, and choosing one they could somehow name is refused by
 * `getBusinessMetrics` anyway: this picker cannot widen anybody's access, only narrow their view.
 */
export default function DashboardFilters({
  preset,
  fromLocalDate,
  toLocalDate,
  locationId,
  locations,
}: {
  preset: string;
  fromLocalDate: string;
  toLocalDate: string;
  locationId: string;
  locations: { id: string; name: string }[];
}) {
  const t = useTranslations("Dashboard");
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const [from, setFrom] = useState(fromLocalDate);
  const [to, setTo] = useState(toLocalDate);

  /** Replace one or more query values, keeping everything else — `b` in particular. */
  function go(changes: Record<string, string | null>) {
    const next = new URLSearchParams(params.toString());
    for (const [key, value] of Object.entries(changes)) {
      if (value === null || value === "") next.delete(key);
      else next.set(key, value);
    }
    router.replace(`${pathname}?${next.toString()}`);
  }

  function onCustom(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    go({ range: "custom", from, to });
  }

  return (
    <div className="space-y-3" data-testid="dashboard-filters">
      <Toolbar>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label={t("rangeLabel")}>
          {(["today", "7d", "30d", "90d"] as const).map((option) => (
            <Button
              key={option}
              type="button"
              size="sm"
              variant={preset === option ? "primary" : "secondary"}
              aria-pressed={preset === option}
              testId={`range-${option}`}
              onClick={() => go({ range: option, from: null, to: null })}
            >
              {t(`range.${option}`)}
            </Button>
          ))}
        </div>

        {locations.length > 1 ? (
          <label className="ms-auto flex items-center gap-2 text-sm text-ink-muted">
            <span>{t("locationFilter")}</span>
            <SelectInput
              className="h-9 w-auto"
              value={locationId}
              data-testid="location-filter"
              onChange={(e) => go({ loc: e.target.value || null })}
            >
              <option value="">{t("allLocations")}</option>
              {locations.map((location) => (
                <option key={location.id} value={location.id}>
                  {location.name}
                </option>
              ))}
            </SelectInput>
          </label>
        ) : null}
      </Toolbar>

      <form onSubmit={onCustom} className="flex flex-wrap items-end gap-3" data-testid="custom-range">
        <Field id="range-from" label={t("fromLabel")} className="w-40">
          <TextInput
            id="range-from"
            type="date"
            dir="ltr"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            data-testid="range-from"
          />
        </Field>
        <Field id="range-to" label={t("toLabel")} className="w-40">
          <TextInput id="range-to" type="date" dir="ltr" value={to} onChange={(e) => setTo(e.target.value)} data-testid="range-to" />
        </Field>
        <Button type="submit" size="sm" variant="secondary" testId="range-apply">
          {t("applyRange")}
        </Button>
      </form>
    </div>
  );
}
