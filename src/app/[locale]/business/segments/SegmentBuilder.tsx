"use client";

import { useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/routing";
import { Badge, Button, Card, Field, Notice, SelectInput, TextInput } from "@/components/ui";

/**
 * Describing a set of customers, and checking it before saving it.
 *
 * The builder offers exactly the conditions the server allowlists — there is no free-text field, no
 * operator box and no way to express anything the domain cannot prove. That is not a UI
 * simplification: a segment a merchant can describe but the server cannot validate is a segment
 * that fails on save, and a builder that offered one would be promising a capability twice over.
 *
 * **Count comes from the server, every time.** The browser never computes a membership number, and
 * the one shown is discarded the moment a condition changes — a stale count next to an edited
 * definition is how a campaign gets sent to the wrong people.
 */

type Match = "all" | "any";
type Field =
  | "program"
  | "cardType"
  | "stampBalance"
  | "pointBalance"
  | "rewardBalance"
  | "source"
  | "servedAtLocation"
  | "joinedAt"
  | "lastActivityAt";

interface Row {
  field: Field;
  /** One text-ish value: a template id, a source name, a branch id, or a date. */
  value: string;
  /** Second value for ranges: a maximum, or a second date. */
  value2: string;
}

const EMPTY: Row = { field: "stampBalance", value: "", value2: "" };

export interface BuilderOptions {
  programs: { templateId: string; name: string }[];
  locations: { id: string; name: string }[];
  sources: string[];
}

/** A row as the server's condition schema expects it, or null when the row is not usable yet. */
function toCondition(row: Row): Record<string, unknown> | null {
  const whole = (v: string) => (/^\d+$/.test(v.trim()) ? Number(v.trim()) : undefined);
  const range = () => {
    const min = whole(row.value);
    const max = whole(row.value2);
    if (min === undefined && max === undefined) return null;
    return { ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}) };
  };
  const dates = () => {
    const after = row.value.trim();
    const before = row.value2.trim();
    if (!after && !before) return null;
    return { ...(after ? { after } : {}), ...(before ? { before } : {}) };
  };

  switch (row.field) {
    case "program":
      return row.value ? { field: "program", templateId: row.value } : null;
    case "cardType":
      return row.value ? { field: "cardType", cardType: row.value } : null;
    case "source":
      return row.value ? { field: "source", name: row.value } : null;
    case "servedAtLocation":
      return row.value ? { field: "servedAtLocation", locationId: row.value } : null;
    case "stampBalance":
    case "pointBalance":
    case "rewardBalance": {
      const r = range();
      return r ? { field: row.field, range: r } : null;
    }
    case "joinedAt":
    case "lastActivityAt": {
      const d = dates();
      return d ? { field: row.field, dateRange: d } : null;
    }
  }
}

export default function SegmentBuilder({ businessId, options }: { businessId: string; options: BuilderOptions }) {
  const t = useTranslations("Segments");
  const tc = useTranslations("Common");
  const router = useRouter();

  const [name, setName] = useState("");
  const [match, setMatch] = useState<Match>("all");
  const [rows, setRows] = useState<Row[]>([{ ...EMPTY }]);
  const [count, setCount] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "danger"; text: string } | null>(null);

  const setRow = (index: number, patch: Partial<Row>) =>
    setRows((current) => {
      // Any edit invalidates the count that was shown for the previous definition.
      setCount(null);
      return current.map((row, i) => (i === index ? { ...row, ...patch } : row));
    });

  function definition(): { version: 1; match: Match; conditions: Record<string, unknown>[] } | null {
    const conditions = rows.map(toCondition).filter((c): c is Record<string, unknown> => c !== null);
    return conditions.length === 0 ? null : { version: 1, match, conditions };
  }

  async function post(body: Record<string, unknown>): Promise<{ ok: boolean; data?: unknown; code?: string }> {
    const response = await fetch("/api/staff/segments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ businessId, ...body }),
    });
    const payload = (await response.json().catch(() => null)) as { error?: { code?: string } } | null;
    if (response.ok) return { ok: true, data: payload };
    return { ok: false, code: payload?.error?.code };
  }

  function refusal(code: string | undefined): string {
    if (code === "NAME_TAKEN") return t("errorNameTaken");
    if (code === "VALIDATION_ERROR") return t("errorInvalid");
    if (code === "FORBIDDEN") return t("errorForbidden");
    return tc("genericError");
  }

  async function onCount() {
    const def = definition();
    if (!def) {
      setMessage({ tone: "danger", text: t("errorNoConditions") });
      return;
    }
    setBusy(true);
    setMessage(null);
    const result = await post({ action: "count", definition: def });
    setBusy(false);
    if (result.ok) setCount((result.data as { customers: number }).customers);
    else setMessage({ tone: "danger", text: refusal(result.code) });
  }

  async function onSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const def = definition();
    if (!def) {
      setMessage({ tone: "danger", text: t("errorNoConditions") });
      return;
    }
    setBusy(true);
    setMessage(null);
    const result = await post({ action: "create", name, definition: def });
    setBusy(false);
    if (result.ok) {
      setName("");
      setRows([{ ...EMPTY }]);
      setCount(null);
      setMessage({ tone: "success", text: t("saved") });
      router.refresh();
    } else {
      setMessage({ tone: "danger", text: refusal(result.code) });
    }
  }

  const isRange = (field: Field) => field === "stampBalance" || field === "pointBalance" || field === "rewardBalance";
  const isDate = (field: Field) => field === "joinedAt" || field === "lastActivityAt";

  return (
    <Card>
      <form className="space-y-5" onSubmit={onSave} data-testid="segment-builder" noValidate>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="segment-name" label={t("nameLabel")} hint={t("nameHint")}>
            <TextInput
              id="segment-name"
              required
              maxLength={80}
              value={name}
              onChange={(e) => setName(e.target.value)}
              data-testid="segment-name"
            />
          </Field>
          <Field id="segment-match" label={t("matchLabel")} hint={t("matchHint")}>
            <SelectInput
              id="segment-match"
              value={match}
              onChange={(e) => {
                setMatch(e.target.value as Match);
                setCount(null);
              }}
              data-testid="segment-match"
            >
              <option value="all">{t("matchAll")}</option>
              <option value="any">{t("matchAny")}</option>
            </SelectInput>
          </Field>
        </div>

        <div className="space-y-3" data-testid="segment-conditions">
          {rows.map((row, index) => (
            <div key={index} className="grid gap-3 rounded-xl border border-border p-3 sm:grid-cols-[1fr_1fr_1fr_auto]">
              <Field id={`cond-field-${index}`} label={t("conditionField")}>
                <SelectInput
                  id={`cond-field-${index}`}
                  value={row.field}
                  onChange={(e) => setRow(index, { field: e.target.value as Field, value: "", value2: "" })}
                  data-testid={`segment-field-${index}`}
                >
                  {(
                    [
                      "program",
                      "cardType",
                      "stampBalance",
                      "pointBalance",
                      "rewardBalance",
                      "source",
                      "servedAtLocation",
                      "joinedAt",
                      "lastActivityAt",
                    ] as const
                  ).map((field) => (
                    <option key={field} value={field}>
                      {t(`field.${field}`)}
                    </option>
                  ))}
                </SelectInput>
              </Field>

              <Field id={`cond-value-${index}`} label={isRange(row.field) ? t("atLeast") : isDate(row.field) ? t("onOrAfter") : t("is")}>
                {row.field === "program" ? (
                  <SelectInput
                    id={`cond-value-${index}`}
                    value={row.value}
                    onChange={(e) => setRow(index, { value: e.target.value })}
                    data-testid={`segment-value-${index}`}
                  >
                    <option value="">{t("choose")}</option>
                    {options.programs.map((program) => (
                      <option key={program.templateId} value={program.templateId}>
                        {program.name}
                      </option>
                    ))}
                  </SelectInput>
                ) : row.field === "cardType" ? (
                  <SelectInput
                    id={`cond-value-${index}`}
                    value={row.value}
                    onChange={(e) => setRow(index, { value: e.target.value })}
                    data-testid={`segment-value-${index}`}
                  >
                    <option value="">{t("choose")}</option>
                    <option value="STAMP">{t("cardType.STAMP")}</option>
                    <option value="POINTS">{t("cardType.POINTS")}</option>
                  </SelectInput>
                ) : row.field === "servedAtLocation" ? (
                  <SelectInput
                    id={`cond-value-${index}`}
                    value={row.value}
                    onChange={(e) => setRow(index, { value: e.target.value })}
                    data-testid={`segment-value-${index}`}
                  >
                    <option value="">{t("choose")}</option>
                    {options.locations.map((location) => (
                      <option key={location.id} value={location.id}>
                        {location.name}
                      </option>
                    ))}
                  </SelectInput>
                ) : row.field === "source" ? (
                  <SelectInput
                    id={`cond-value-${index}`}
                    value={row.value}
                    onChange={(e) => setRow(index, { value: e.target.value })}
                    data-testid={`segment-value-${index}`}
                  >
                    <option value="">{t("choose")}</option>
                    {options.sources.map((source) => (
                      <option key={source} value={source}>
                        {source}
                      </option>
                    ))}
                  </SelectInput>
                ) : (
                  <TextInput
                    id={`cond-value-${index}`}
                    type={isDate(row.field) ? "date" : "text"}
                    inputMode={isRange(row.field) ? "numeric" : undefined}
                    dir="ltr"
                    value={row.value}
                    onChange={(e) => setRow(index, { value: e.target.value })}
                    data-testid={`segment-value-${index}`}
                  />
                )}
              </Field>

              {isRange(row.field) || isDate(row.field) ? (
                <Field id={`cond-value2-${index}`} label={isDate(row.field) ? t("onOrBefore") : t("atMost")}>
                  <TextInput
                    id={`cond-value2-${index}`}
                    type={isDate(row.field) ? "date" : "text"}
                    inputMode={isRange(row.field) ? "numeric" : undefined}
                    dir="ltr"
                    value={row.value2}
                    onChange={(e) => setRow(index, { value2: e.target.value })}
                    data-testid={`segment-value2-${index}`}
                  />
                </Field>
              ) : (
                <div />
              )}

              {rows.length > 1 ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="self-end"
                  onClick={() => {
                    setRows((current) => current.filter((_, i) => i !== index));
                    setCount(null);
                  }}
                >
                  {t("removeCondition")}
                </Button>
              ) : (
                <div />
              )}
            </div>
          ))}

          <Button
            type="button"
            size="sm"
            variant="secondary"
            testId="segment-add-condition"
            onClick={() => setRows((current) => [...current, { ...EMPTY }])}
          >
            {t("addCondition")}
          </Button>
        </div>

        {message ? (
          <Notice tone={message.tone} testId="segment-message">
            {message.text}
          </Notice>
        ) : null}

        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={busy} testId="segment-save">
            {busy ? t("saving") : t("save")}
          </Button>
          <Button type="button" variant="secondary" disabled={busy} onClick={() => void onCount()} testId="segment-count">
            {t("countThem")}
          </Button>
          {count !== null ? (
            <Badge tone="accent" testId="segment-count-result">
              {t("matches", { count })}
            </Badge>
          ) : null}
        </div>
      </form>
    </Card>
  );
}
