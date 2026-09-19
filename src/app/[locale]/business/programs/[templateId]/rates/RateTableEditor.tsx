"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/routing";
import { Button, Card, DetailRow, Notice, Table, Td, Th, TextInput } from "@/components/ui";
import { basisPointsToPercent, inputToMinor, minorToInput, percentToBasisPoints } from "@/lib/money-input";

/**
 * The rate table a cashback or discount programme is rated by, and the four verbs around it.
 *
 * **There is no currency field on this screen and no exponent field, and that is the design.** A
 * programme is denominated in the business's own currency; this product has no conversion layer and
 * no rate source, so there is nothing for a merchant to choose. Both are rendered as text below.
 * `/api/staff/money-version` has no parameter for either, and the monetary rule guard in migration 22
 * would refuse a rule that disagreed with the business anyway — an input here would be a field whose
 * only possible effect is an error.
 *
 * **Discard RETIRES the draft; it does not delete it.** The button says so, because "discard" reads
 * like "delete" and the row survives as a record of what was considered. The database refuses the
 * delete outright, so a screen that promised one would be lying.
 *
 * Amounts are handled as STRINGS of minor units end to end. A threshold typed as `125.50` is read
 * with the programme's exponent into `12550` minor units by integer string work, never by
 * `parseFloat` — a float would put a threshold a fraction of a unit away from where the merchant put
 * it, and nothing downstream would notice.
 */

export interface TierRow {
  tierIndex: number;
  minCumulativeSpendMinor: string;
  rateBasisPoints: number;
}

export interface RateTable {
  versionNumber: number;
  currency: string;
  currencyExponent: number;
  kind: "CASHBACK" | "DISCOUNT";
  tiers: TierRow[];
}

interface Draft {
  threshold: string;
  percent: string;
}

export default function RateTableEditor({
  businessId,
  templateId,
  live,
  draft,
}: {
  businessId: string | null;
  templateId: string;
  live: RateTable | null;
  draft: RateTable | null;
}) {
  const t = useTranslations("MoneyRates");
  const router = useRouter();
  const exponent = draft?.currencyExponent ?? live?.currencyExponent ?? 2;

  const [rows, setRows] = useState<Draft[]>(
    (draft ?? live)?.tiers.length
      ? (draft ?? live)!.tiers.map((tier) => ({
          threshold: minorToInput(tier.minCumulativeSpendMinor, exponent),
          percent: basisPointsToPercent(tier.rateBasisPoints),
        }))
      : [{ threshold: minorToInput("0", exponent), percent: "0" }],
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const currency = draft?.currency ?? live?.currency ?? "";

  async function send(body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/staff/money-version", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ businessId: businessId ?? undefined, templateId, ...body }),
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as { error?: { code?: string } | string; message?: string };
        const code = typeof payload.error === "object" ? payload.error.code : undefined;
        setError(code === "VALIDATION_ERROR" && body.action === "publish" ? t("publishIncomplete") : t("failed"));
        return false;
      }
      router.refresh();
      return true;
    } finally {
      setBusy(false);
    }
  }

  function save() {
    const tiers: { minCumulativeSpendMinor: number; rateBasisPoints: number }[] = [];
    for (const [index, row] of rows.entries()) {
      const minor = inputToMinor(row.threshold, exponent);
      const bp = percentToBasisPoints(row.percent);
      if (minor === null) return setError(t("badThreshold", { row: index + 1 }));
      if (bp === null) return setError(t("badRate", { row: index + 1 }));
      tiers.push({ minCumulativeSpendMinor: Number(minor), rateBasisPoints: bp });
    }
    void send({ action: "updateRateTable", tiers });
  }

  return (
    <div className="space-y-6" data-testid="money-rate-editor">
      <Card>
        {/* Display only. Neither of these is an input anywhere in this product. */}
        <DetailRow label={t("currency")}>
          <span data-testid="money-currency">{currency}</span>
        </DetailRow>
        <DetailRow label={t("exponent")}>
          <span data-testid="money-exponent">{exponent}</span>
        </DetailRow>
        <p className="mt-2 text-sm text-neutral-600">{t("currencyFixed")}</p>
      </Card>

      {error ? <Notice tone="danger">{error}</Notice> : null}

      {draft ? (
        <>
          <Notice tone="info">{t("draftOpen", { version: draft.versionNumber })}</Notice>
          <Table testId="money-rate-rows">
            <thead>
              <tr>
                <Th>{t("tier")}</Th>
                <Th>{t("threshold", { currency })}</Th>
                <Th>{t("rate")}</Th>
                <Th>{t("actions")}</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr key={index} data-testid={`money-tier-${index}`}>
                  <Td>{index + 1}</Td>
                  <Td>
                    <TextInput
                      inputMode="decimal"
                      aria-label={t("threshold", { currency })}
                      data-testid={`money-threshold-${index}`}
                      value={row.threshold}
                      // Tier 1 is the rate a card with no history earns, so its threshold is zero.
                      disabled={index === 0}
                      onChange={(e) =>
                        setRows((r) => r.map((x, i) => (i === index ? { ...x, threshold: e.target.value } : x)))
                      }
                    />
                  </Td>
                  <Td>
                    <TextInput
                      inputMode="decimal"
                      aria-label={t("rate")}
                      data-testid={`money-rate-${index}`}
                      value={row.percent}
                      onChange={(e) =>
                        setRows((r) => r.map((x, i) => (i === index ? { ...x, percent: e.target.value } : x)))
                      }
                    />
                  </Td>
                  <Td>
                    <Button
                      variant="ghost"
                      data-testid={`money-remove-${index}`}
                      onClick={() => setRows((r) => r.filter((_, i) => i !== index))}
                    >
                      {t("remove")}
                    </Button>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>

          <div className="flex flex-wrap gap-3">
            <Button
              variant="secondary"
              data-testid="money-add-tier"
              onClick={() => setRows((r) => [...r, { threshold: "", percent: "" }])}
            >
              {t("addTier")}
            </Button>
            <Button data-testid="money-save" disabled={busy} onClick={save}>
              {t("save")}
            </Button>
            <Button
              variant="primary"
              data-testid="money-publish"
              disabled={busy}
              onClick={() => void send({ action: "publish", expectedVersionNumber: draft.versionNumber })}
            >
              {t("publish")}
            </Button>
            <Button
              variant="ghost"
              data-testid="money-discard"
              disabled={busy}
              onClick={() => void send({ action: "discardDraft" })}
            >
              {t("discard")}
            </Button>
          </div>
          {/* Said plainly, because "discard" reads like "delete" and this is not one. */}
          <p className="text-sm text-neutral-600">{t("discardExplained")}</p>
        </>
      ) : (
        <>
          <Notice tone="info">{t("liveFrozen")}</Notice>
          {live ? (
            <Table testId="money-live-rows">
              <thead>
                <tr>
                  <Th>{t("tier")}</Th>
                  <Th>{t("threshold", { currency })}</Th>
                  <Th>{t("rate")}</Th>
                </tr>
              </thead>
              <tbody>
                {live.tiers.map((tier) => (
                  <tr key={tier.tierIndex} data-testid={`money-live-tier-${tier.tierIndex}`}>
                    <Td>{tier.tierIndex + 1}</Td>
                    <Td>{minorToInput(tier.minCumulativeSpendMinor, live.currencyExponent)}</Td>
                    <Td>{basisPointsToPercent(tier.rateBasisPoints)}%</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          ) : null}
          <Button data-testid="money-open-draft" disabled={busy} onClick={() => void send({ action: "createDraft" })}>
            {t("openDraft")}
          </Button>
        </>
      )}
    </div>
  );
}
