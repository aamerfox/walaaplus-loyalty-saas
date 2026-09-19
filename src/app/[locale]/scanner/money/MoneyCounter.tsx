"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/routing";
import { Badge, Button, Card, DetailRow, Notice, Table, Td, Th, TextInput } from "@/components/ui";
import { basisPointsToPercent, inputToMinor, minorToInput } from "@/lib/money-input";

/**
 * The counter for a cashback or discount card.
 *
 * One question at a till — "what do I collect?" — so the screen is one amount field and an answer.
 * Everything else on it is context for saying that answer out loud.
 *
 * **What this screen must never imply.** The amount is what a member of STAFF says the bill was.
 * This product does not see a payment, does not settle one, and issues no receipt: it records an
 * assertion and what the programme gives back for it. The labels say "bill total as entered" and
 * "amount to collect", never "paid", "revenue", "sale" or "total due".
 *
 * **Nothing here computes money.** The net, the rate, the tier and the cap all come back from the
 * server, which recomputed them under the card's lock from the rules pinned to this card's version.
 * A screen that did its own arithmetic would be a second opinion that is wrong whenever it disagrees.
 * The only conversion done here is inserting a decimal point into a string of minor units.
 */

export interface CounterOperation {
  id: string;
  kind: string;
  at: string;
  grossAmountMinor: string;
  netCounterAmountMinor: string;
  cashEffectMinor: string;
  cashBalanceAfterMinor: string;
  discountMinor: string | null;
  rateBasisPoints: number | null;
  reversalOfId: string | null;
  reversed: boolean;
}

export interface CounterCard {
  customerCardId: string;
  customerName: string | null;
  templateName: string;
  cardType: "CASHBACK" | "DISCOUNT";
  versionNumber: number;
  currency: string;
  currencyExponent: number;
  cashBalanceMinor: string;
  qualifiedSpendMinor: string;
  nextRateBasisPoints: number;
  recent: CounterOperation[];
}

/** The server's answer to one operation, as the screen shows it back. */
interface Outcome {
  operationId: string;
  kind: string;
  grossAmountMinor: string;
  netCounterAmountMinor: string;
  cashEffectMinor: string;
  cashBalanceAfterMinor: string;
  discountMinor: string | null;
  rateBasisPoints: number | null;
  reversalOfId: string | null;
  requestedRedemptionMinor: string | null;
}

export default function MoneyCounter({ businessId, card }: { businessId: string | null; card: CounterCard }) {
  const t = useTranslations("MoneyCounter");
  const router = useRouter();
  const exponent = card.currencyExponent;

  const [bill, setBill] = useState("");
  const [redeem, setRedeem] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  // Scanner lookup keeps the selected card in client memory, so refresh cannot be relied on to
  // replace its server-rendered recent list. Keep the append-only result visible locally as well.
  const [recent, setRecent] = useState<CounterOperation[]>(card.recent);

  const isCashback = card.cardType === "CASHBACK";

  async function send(body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/scanner/money", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          businessId: businessId ?? undefined,
          // A fresh key per attempt: a retry after a visible failure is a NEW operation, while a
          // double-click sends the same key twice and the server returns the first row.
          idempotencyKey: crypto.randomUUID(),
          ...body,
        }),
      });
      const payload = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        setError((payload.error as string) ?? (payload.message as string) ?? t("failed"));
        return;
      }
      const operation = payload as unknown as Outcome;
      setOutcome(operation);
      setRecent((current) => {
        const row: CounterOperation = {
          id: operation.operationId,
          kind: operation.kind,
          at: new Date().toISOString(),
          grossAmountMinor: operation.grossAmountMinor,
          netCounterAmountMinor: operation.netCounterAmountMinor,
          cashEffectMinor: operation.cashEffectMinor,
          cashBalanceAfterMinor: operation.cashBalanceAfterMinor,
          discountMinor: operation.discountMinor,
          rateBasisPoints: operation.rateBasisPoints,
          reversalOfId: operation.reversalOfId,
          reversed: false,
        };
        if (operation.reversalOfId) {
          return [row, ...current.map((item) =>
            item.id === operation.reversalOfId ? { ...item, reversed: true } : item,
          )];
        }
        return [row, ...current];
      });
      setBill("");
      setRedeem("");
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  function amounts(): { gross: string } | null {
    const gross = inputToMinor(bill, exponent);
    if (gross === null) {
      setError(t("badAmount"));
      return null;
    }
    return { gross };
  }

  return (
    <div className="space-y-6" data-testid="money-counter">
      <Card>
        <DetailRow label={t("customer")}>{card.customerName ?? t("noName")}</DetailRow>
        <DetailRow label={t("programme")}>
          {card.templateName} <Badge>{t(`cardType.${card.cardType}`)}</Badge>
        </DetailRow>
        <DetailRow label={t("balance")}>
          <strong data-testid="money-balance">
            {minorToInput(card.cashBalanceMinor, exponent)} {card.currency}
          </strong>
        </DetailRow>
        <DetailRow label={t("nextRate")}>
          <span data-testid="money-next-rate">{basisPointsToPercent(card.nextRateBasisPoints)}%</span>
        </DetailRow>
        {/* Stated, because a cashier is asked "why am I on that rate?" and needs an answer. */}
        <DetailRow label={t("qualifiedSpend")}>
          {minorToInput(card.qualifiedSpendMinor, exponent)} {card.currency}
        </DetailRow>
      </Card>

      {error ? <Notice tone="danger">{error}</Notice> : null}

      {outcome ? (
        <Card>
          <Notice tone="success">{t("done")}</Notice>
          {/* The one number the person at the till needs, said first and largest. */}
          <DetailRow label={t("collect")}>
            <strong data-testid="money-collect">
              {minorToInput(outcome.netCounterAmountMinor, exponent)} {card.currency}
            </strong>
          </DetailRow>
          <DetailRow label={t("billEntered")}>
            {minorToInput(outcome.grossAmountMinor, exponent)} {card.currency}
          </DetailRow>
          {outcome.discountMinor ? (
            <DetailRow label={t("discountApplied")}>
              {minorToInput(outcome.discountMinor, exponent)} {card.currency}
            </DetailRow>
          ) : null}
          {outcome.requestedRedemptionMinor &&
          outcome.requestedRedemptionMinor !== outcome.cashEffectMinor.replace("-", "") ? (
            // Asked for more than could be applied. Shown rather than hidden, so the cashier can say so.
            <Notice tone="info" testId="money-capped">
              {t("capped", {
                requested: minorToInput(outcome.requestedRedemptionMinor, exponent),
                applied: minorToInput(outcome.cashEffectMinor.replace("-", ""), exponent),
                currency: card.currency,
              })}
            </Notice>
          ) : null}
          <DetailRow label={t("balanceAfter")}>
            {minorToInput(outcome.cashBalanceAfterMinor, exponent)} {card.currency}
          </DetailRow>
          <p className="mt-2 text-sm text-neutral-600">{t("notAReceipt")}</p>
        </Card>
      ) : null}

      <Card>
        <label className="block text-sm font-medium" htmlFor="money-bill">
          {t("billLabel", { currency: card.currency })}
        </label>
        <TextInput
          id="money-bill"
          inputMode="decimal"
          data-testid="money-bill"
          value={bill}
          onChange={(e) => setBill(e.target.value)}
        />
        {/* Said at the point of entry, not in a footnote. */}
        <p className="mt-1 text-sm text-neutral-600">{t("billIsAnAssertion")}</p>

        {isCashback ? (
          <>
            <label className="mt-4 block text-sm font-medium" htmlFor="money-redeem">
              {t("redeemLabel", { currency: card.currency })}
            </label>
            <TextInput
              id="money-redeem"
              inputMode="decimal"
              data-testid="money-redeem-amount"
              value={redeem}
              onChange={(e) => setRedeem(e.target.value)}
            />
            <p className="mt-1 text-sm text-neutral-600">{t("redeemCapped")}</p>
          </>
        ) : null}

        <div className="mt-4 flex flex-wrap gap-3">
          {isCashback ? (
            <>
              <Button
                data-testid="money-earn"
                disabled={busy}
                onClick={() => {
                  const a = amounts();
                  if (a) void send({ action: "earn", customerCardId: card.customerCardId, grossAmountMinor: a.gross });
                }}
              >
                {t("earn")}
              </Button>
              <Button
                variant="secondary"
                data-testid="money-redeem"
                disabled={busy}
                onClick={() => {
                  const a = amounts();
                  if (!a) return;
                  const requested = inputToMinor(redeem, exponent);
                  if (requested === null) return setError(t("badRedeem"));
                  void send({
                    action: "redeem",
                    customerCardId: card.customerCardId,
                    grossAmountMinor: a.gross,
                    requestedRedemptionMinor: requested,
                  });
                }}
              >
                {t("redeem")}
              </Button>
            </>
          ) : (
            <Button
              data-testid="money-discount"
              disabled={busy}
              onClick={() => {
                const a = amounts();
                if (a) void send({ action: "discount", customerCardId: card.customerCardId, grossAmountMinor: a.gross });
              }}
            >
              {t("applyDiscount")}
            </Button>
          )}
        </div>
      </Card>

      <Card>
        <h2 className="mb-2 text-base font-semibold">{t("recent")}</h2>
        {recent.length === 0 ? (
          <p className="text-sm text-neutral-600">{t("noneYet")}</p>
        ) : (
          <Table testId="money-recent">
            <thead>
              <tr>
                <Th>{t("what")}</Th>
                <Th>{t("billEntered")}</Th>
                <Th>{t("effect")}</Th>
                <Th>{t("balanceAfter")}</Th>
                <Th>{t("actions")}</Th>
              </tr>
            </thead>
            <tbody>
              {recent.map((row) => (
                <tr key={row.id} data-testid={`money-op-${row.id}`}>
                  <Td>
                    {t(`kind.${row.kind}`)}
                    {row.reversed ? <Badge tone="warn">{t("reversedBadge")}</Badge> : null}
                  </Td>
                  <Td>{minorToInput(row.grossAmountMinor, exponent)}</Td>
                  <Td>{minorToInput(row.cashEffectMinor, exponent)}</Td>
                  <Td>{minorToInput(row.cashBalanceAfterMinor, exponent)}</Td>
                  <Td>
                    {/* A reversal is never offered twice, and a reversal row is not itself reversible. */}
                    {row.reversed || row.reversalOfId ? null : (
                      <ReverseButton busy={busy} onReverse={(reason) => send({ action: "reverse", monetaryOperationId: row.id, reason })} />
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}

/**
 * Reversing asks for a reason before it does anything.
 *
 * Required, not optional: the reversal row is a correction to a financial history, and "who undid
 * this and why" is exactly the question an owner reviewing it will have. The server refuses a blank
 * one too, so this is the polite half of a rule rather than the whole of it.
 */
function ReverseButton({ busy, onReverse }: { busy: boolean; onReverse: (reason: string) => void }) {
  const t = useTranslations("MoneyCounter");
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");

  if (!open) {
    return (
      <Button variant="ghost" data-testid="money-reverse-open" disabled={busy} onClick={() => setOpen(true)}>
        {t("reverse")}
      </Button>
    );
  }
  return (
    <div className="space-y-2">
      <TextInput
        aria-label={t("reasonLabel")}
        data-testid="money-reverse-reason"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
      <Button
        variant="danger"
        data-testid="money-reverse-confirm"
        disabled={busy || reason.trim().length < 3}
        onClick={() => onReverse(reason.trim())}
      >
        {t("confirmReverse")}
      </Button>
    </div>
  );
}
