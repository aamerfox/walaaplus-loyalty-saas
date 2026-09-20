"use client";

import { useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/routing";
import { Card, Notice } from "@/components/ui";
import { inputToMinor, minorToInput, percentToBasisPoints } from "@/lib/money-input";

/**
 * Creating an additional loyalty program.
 *
 * ## What this form is careful about
 *
 * **Money is decimal input, and the browser says so first.** Money fields use `inputMode="decimal"`;
 * `inputToMinor` and `percentToBasisPoints` refuse finer precision rather than silently rounding. The
 * server parses the resulting minor units again, because the client is not trusted.
 *
 * **Integers only for non-money fields.** The other numeric fields use `inputMode="numeric"` with
 * `step={1}`, and the form refuses a fraction, a zero and a blank before it sends anything — not
 * because the client is trusted (the server parses all of it again through the same mechanics
 * contract) but because a cashier-turned-owner typing `1.5` deserves an answer in the field rather
 * than a 400 from an endpoint.
 *
 * **It never offers a setting the domain does not have.** The earn modes, the tier fields and the
 * limits here are exactly the Phase 1b contract. There is no expiry picker, no birthday bonus and no
 * cashback toggle, because the server would refuse them and a control that is always refused is a
 * lie told in advance.
 *
 * **A stamp program and a points program are different shapes, not one shape with a switch.** Picking
 * the card type changes which fields exist, because a stamp card has one reward at a threshold and a
 * points card has a list of rewards with prices. Nothing is carried between them.
 */

type CardType = "STAMP" | "POINTS" | "CASHBACK" | "DISCOUNT";
interface LocationOption { id: string; name: string }
type EarnMode = "MANUAL" | "PER_VISIT" | "SPEND_BLOCK";

interface TierDraft {
  name: string;
  requiredPoints: string;
  rewardValueMinor: string;
}

const EMPTY_TIER: TierDraft = { name: "", requiredPoints: "", rewardValueMinor: "" };

/** Parse a required whole number, or null when the field is empty or not one. */
function whole(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === "" || !/^\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return Number.isSafeInteger(n) ? n : null;
}

export default function NewProgramForm({ locale, locations, currency, currencyExponent }: { locale: string; locations: LocationOption[]; currency: string; currencyExponent: number }) {
  const t = useTranslations("Programs");
  const tc = useTranslations("Common");
  const router = useRouter();

  const [cardType, setCardType] = useState<CardType>("POINTS");
  const [moneyLocations, setMoneyLocations] = useState<string[]>(locations.map((location) => location.id));
  const [moneyTiers, setMoneyTiers] = useState<{ threshold: string; rate: string }[]>([]);
  const [name, setName] = useState("");
  const [earnMode, setEarnMode] = useState<EarnMode>("SPEND_BLOCK");
  const [spendPerBlock, setSpendPerBlock] = useState("1000");
  const [unitsPerBlock, setUnitsPerBlock] = useState("1");
  const [unitsPerVisit, setUnitsPerVisit] = useState("1");
  const [dailyLimit, setDailyLimit] = useState("");
  const [welcomeUnits, setWelcomeUnits] = useState("");

  // Stamp-only
  const [stampsRequired, setStampsRequired] = useState("10");
  const [rewardName, setRewardName] = useState("");

  // Points-only
  const [tiers, setTiers] = useState<TierDraft[]>([{ ...EMPTY_TIER }]);

  const [errors, setErrors] = useState<string[]>([]);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const setTier = (index: number, patch: Partial<TierDraft>) =>
    setTiers((current) => current.map((tier, i) => (i === index ? { ...tier, ...patch } : tier)));

  const moveTier = (index: number, direction: -1 | 1) =>
    setTiers((current) => {
      const next = [...current];
      const target = index + direction;
      if (target < 0 || target >= next.length) return current;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });

  /** Everything the server will check, checked here first so the answer lands in the form. */
  function validate(): string[] {
    const found: string[] = [];
    if (name.trim() === "") found.push(t("errors.nameRequired"));

    if ((cardType === "CASHBACK" || cardType === "DISCOUNT")) {
      if (moneyLocations.length === 0) found.push(t("errors.locationRequired"));
      // The initial form is allowed to create an empty DRAFT. The draft editor validates the
      // complete table on save, while the database refuses an incomplete Publish.
      moneyTiers.forEach((tier, index) => {
        const threshold = inputToMinor(tier.threshold, currencyExponent);
        const thresholdNumber = threshold === null ? null : Number(threshold);
        if (threshold === null || !Number.isSafeInteger(thresholdNumber) || percentToBasisPoints(tier.rate) === null) {
          found.push(t("errors.moneyRate", { index: index + 1 }));
        }
      });
      return found;
    }

    if (earnMode === "SPEND_BLOCK") {
      if (whole(spendPerBlock) === null) found.push(t("errors.spendPerBlock"));
      if (whole(unitsPerBlock) === null) found.push(t("errors.unitsPerBlock"));
    }
    if (earnMode === "PER_VISIT" && cardType === "POINTS" && whole(unitsPerVisit) === null) {
      found.push(t("errors.unitsPerVisit"));
    }
    if (dailyLimit.trim() !== "" && whole(dailyLimit) === null) found.push(t("errors.dailyLimit"));
    if (welcomeUnits.trim() !== "" && whole(welcomeUnits) === null) found.push(t("errors.welcome"));

    if (cardType === "STAMP") {
      const required = whole(stampsRequired);
      if (required === null) found.push(t("errors.stampsRequired"));
      if (rewardName.trim() === "") found.push(t("errors.rewardName"));
      const welcome = whole(welcomeUnits);
      // The same rule the mechanics contract enforces: a welcome bonus may not complete a card.
      if (required !== null && welcome !== null && welcome >= required) found.push(t("errors.welcomeTooBig"));
    } else {
      const names = new Set<string>();
      let cheapest = Number.POSITIVE_INFINITY;
      tiers.forEach((tier, index) => {
        const label = index + 1;
        if (tier.name.trim() === "") found.push(t("errors.tierName", { index: label }));
        const cost = whole(tier.requiredPoints);
        if (cost === null) found.push(t("errors.tierPoints", { index: label }));
        else cheapest = Math.min(cheapest, cost);
        if (tier.rewardValueMinor.trim() !== "" && whole(tier.rewardValueMinor) === null) {
          found.push(t("errors.tierValue", { index: label }));
        }
        const key = tier.name.trim().toLocaleLowerCase();
        if (key !== "" && names.has(key)) found.push(t("errors.tierDuplicate", { index: label }));
        names.add(key);
      });
      const welcome = whole(welcomeUnits);
      // The points equivalent: a welcome bonus may not pay for the cheapest reward on its own.
      if (welcome !== null && Number.isFinite(cheapest) && welcome >= cheapest) found.push(t("errors.welcomeTooBigPoints"));
    }
    return found;
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setFailure(null);
    const found = validate();
    setErrors(found);
    if (found.length > 0 || busy) return;

    const optional = (value: string) => (value.trim() === "" ? undefined : whole(value)!);
    const earn =
      earnMode === "SPEND_BLOCK"
        ? { earnMode, spendAmountPerBlockMinor: whole(spendPerBlock)!, [cardType === "POINTS" ? "pointsPerBlock" : "stampsPerBlock"]: whole(unitsPerBlock)! }
        : earnMode === "PER_VISIT"
          ? cardType === "POINTS"
            ? { earnMode, pointsPerVisit: whole(unitsPerVisit)! }
            : { earnMode }
          : { earnMode };

    const body =
      cardType === "CASHBACK" || cardType === "DISCOUNT"
        ? {
            cardType,
            name: name.trim(),
            availableLocations: moneyLocations,
            tiers: moneyTiers.map((tier) => {
              const threshold = inputToMinor(tier.threshold, currencyExponent);
              const rate = percentToBasisPoints(tier.rate);
              if (threshold === null || rate === null) throw new Error("validated money input became invalid");
              const thresholdNumber = Number(threshold);
              if (!Number.isSafeInteger(thresholdNumber)) throw new Error("money input exceeds the supported range");
              return { minCumulativeSpendMinor: thresholdNumber, rateBasisPoints: rate };
            }),
          }
        : cardType === "POINTS"
        ? {
            cardType,
            name: name.trim(),
            ...earn,
            dailyAwardLimit: optional(dailyLimit),
            welcomePoints: optional(welcomeUnits),
            tiers: tiers.map((tier, index) => ({
              name: tier.name.trim(),
              requiredPoints: whole(tier.requiredPoints)!,
              rewardValueMinor: tier.rewardValueMinor.trim() === "" ? undefined : whole(tier.rewardValueMinor)!,
              sortOrder: index,
            })),
          }
        : {
            cardType,
            name: name.trim(),
            stampsRequiredPerReward: whole(stampsRequired)!,
            rewardName: rewardName.trim(),
            ...earn,
            dailyAwardLimit: optional(dailyLimit),
            welcomeStamps: optional(welcomeUnits),
          };

    setBusy(true);
    try {
      const response = await fetch("/api/staff/programs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: { code?: string } } | null;
        // Translated from a CODE, never from the server's sentence: an Arabic screen must not print
        // an English message from an API, and the code is the stable part of the contract.
        setFailure(payload?.error?.code === "CONFLICT" ? t("errors.duplicateName") : tc("genericError"));
        return;
      }
      const created = (await response.json()) as { templateId: string };
      router.push(cardType === "CASHBACK" || cardType === "DISCOUNT" ? `/business/programs/${created.templateId}/rates` : `/business/programs/${created.templateId}`, { locale });
    } catch {
      setFailure(tc("genericError"));
    } finally {
      setBusy(false);
    }
  }

  const field = "w-full rounded-xl border border-border bg-surface px-4 py-3 text-ink outline-none focus:border-turquoise-500";
  const label = "block text-sm font-semibold text-ink";

  return (
    <form onSubmit={submit} className="space-y-6" noValidate data-testid="new-program-form">
      {errors.length > 0 ? (
        <Notice tone="danger" testId="program-errors">
          <span className="sr-only">{t("errors.heading")}</span>
          <span>{errors.join(" · ")}</span>
        </Notice>
      ) : null}
      {failure ? (
        <Notice tone="danger" testId="program-failure">
          {failure}
        </Notice>
      ) : null}

      <Card className="space-y-4">
        <fieldset>
          <legend className={label}>{t("form.cardType")}</legend>
          <p className="mt-1 text-sm text-ink-muted">{t("form.cardTypeHelp")}</p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            {(["POINTS", "STAMP", "CASHBACK", "DISCOUNT"] as const).map((option) => (
              <label
                key={option}
                className={`flex cursor-pointer items-start gap-3 rounded-xl border p-4 ${
                  cardType === option ? "border-turquoise-500 bg-turquoise-50 dark:bg-navy-800" : "border-border"
                }`}
              >
                <input
                  type="radio"
                  name="cardType"
                  value={option}
                  checked={cardType === option}
                  onChange={() => setCardType(option)}
                  data-testid={`card-type-${option}`}
                  className="mt-1"
                />
                <span>
                  <span className="block font-semibold text-ink">{t(`cardType.${option}`)}</span>
                  <span className="block text-sm text-ink-muted">{t(`form.cardTypeHint.${option}`)}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <div>
          <label className={label} htmlFor="program-name">
            {t("form.name")}
          </label>
          <input
            id="program-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={120}
            required
            data-testid="program-name"
            className={`mt-1 ${field}`}
          />
        </div>
      </Card>

      {(cardType === "CASHBACK" || cardType === "DISCOUNT") ? (
        <Card className="space-y-4" data-testid="money-program-config">
          <h2 className="font-display text-lg font-bold text-ink">{t("form.moneyConfiguration")}</h2>
          <p className="text-sm text-ink-muted">{t("form.moneyLifecycle")}</p>
          <fieldset>
            <legend className={label}>{t("form.locations")}</legend>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              {locations.map((location) => (
                <label key={location.id} className="flex items-center gap-2 rounded-lg border border-border p-3">
                  <input type="checkbox" checked={moneyLocations.includes(location.id)} onChange={(event) => setMoneyLocations((current) => event.target.checked ? [...current, location.id] : current.filter((id) => id !== location.id))} />
                  <span>{location.name}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <div className="space-y-3">
            {moneyTiers.map((tier, index) => (
              <div key={index} className="grid gap-3 sm:grid-cols-2">
                <div><label className={label}>{t("form.moneyThreshold", { currency })}</label><input inputMode="decimal" value={tier.threshold} onChange={(event) => setMoneyTiers((current) => current.map((row, i) => i === index ? { ...row, threshold: event.target.value } : row))} data-testid={`money-threshold-${index}`} className={`mt-1 ${field}`} /></div>
                <div><label className={label}>{t("form.moneyRate")}</label><input inputMode="decimal" value={tier.rate} onChange={(event) => setMoneyTiers((current) => current.map((row, i) => i === index ? { ...row, rate: event.target.value } : row))} data-testid={`money-rate-${index}`} className={`mt-1 ${field}`} /></div>
              </div>
            ))}
            <button type="button" onClick={() => setMoneyTiers((current) => [...current, { threshold: minorToInput("0", currencyExponent), rate: "0" }])} data-testid="add-money-tier" className="rounded-xl border border-border px-4 py-2 font-semibold">{t("form.addMoneyTier")}</button>
          </div>
          <p className="text-sm text-ink-muted">{t("form.moneyCurrencyFixed", { exponent: currencyExponent })}</p>
        </Card>
      ) : (
      <Card className="space-y-4">
        <h2 className="font-display text-lg font-bold text-ink">{t("form.earning")}</h2>

        <div>
          <label className={label} htmlFor="earn-mode">
            {t("earnRule")}
          </label>
          <select
            id="earn-mode"
            value={earnMode}
            onChange={(e) => setEarnMode(e.target.value as EarnMode)}
            data-testid="earn-mode"
            className={`mt-1 ${field}`}
          >
            <option value="SPEND_BLOCK">{t("form.earnMode.SPEND_BLOCK")}</option>
            <option value="PER_VISIT">{t("form.earnMode.PER_VISIT")}</option>
            <option value="MANUAL">{t("form.earnMode.MANUAL")}</option>
          </select>
        </div>

        {earnMode === "SPEND_BLOCK" ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className={label} htmlFor="spend-per-block">
                {t("form.spendPerBlock")}
              </label>
              <input
                id="spend-per-block"
                inputMode="numeric"
                pattern="[0-9]*"
                value={spendPerBlock}
                onChange={(e) => setSpendPerBlock(e.target.value)}
                data-testid="spend-per-block"
                className={`mt-1 ${field}`}
              />
              <p className="mt-1 text-xs text-ink-muted">{t("form.minorUnitsHelp")}</p>
            </div>
            <div>
              <label className={label} htmlFor="units-per-block">
                {cardType === "POINTS" ? t("form.pointsPerBlock") : t("form.stampsPerBlock")}
              </label>
              <input
                id="units-per-block"
                inputMode="numeric"
                pattern="[0-9]*"
                value={unitsPerBlock}
                onChange={(e) => setUnitsPerBlock(e.target.value)}
                data-testid="units-per-block"
                className={`mt-1 ${field}`}
              />
            </div>
          </div>
        ) : null}

        {earnMode === "PER_VISIT" && cardType === "POINTS" ? (
          <div>
            <label className={label} htmlFor="units-per-visit">
              {t("form.pointsPerVisit")}
            </label>
            <input
              id="units-per-visit"
              inputMode="numeric"
              pattern="[0-9]*"
              value={unitsPerVisit}
              onChange={(e) => setUnitsPerVisit(e.target.value)}
              data-testid="units-per-visit"
              className={`mt-1 ${field}`}
            />
          </div>
        ) : null}

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className={label} htmlFor="daily-limit">
              {t("form.dailyLimit")}
            </label>
            <input
              id="daily-limit"
              inputMode="numeric"
              pattern="[0-9]*"
              value={dailyLimit}
              onChange={(e) => setDailyLimit(e.target.value)}
              placeholder={t("noLimit")}
              data-testid="daily-limit"
              className={`mt-1 ${field}`}
            />
          </div>
          <div>
            <label className={label} htmlFor="welcome-units">
              {cardType === "POINTS" ? t("form.welcomePoints") : t("form.welcomeStamps")}
            </label>
            <input
              id="welcome-units"
              inputMode="numeric"
              pattern="[0-9]*"
              value={welcomeUnits}
              onChange={(e) => setWelcomeUnits(e.target.value)}
              placeholder={t("none")}
              data-testid="welcome-units"
              className={`mt-1 ${field}`}
            />
          </div>
        </div>
      </Card>
      )}

      {cardType === "STAMP" ? (
        <Card className="space-y-4">
          <h2 className="font-display text-lg font-bold text-ink">{t("theReward")}</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className={label} htmlFor="stamps-required">
                {t("stampsRequired")}
              </label>
              <input
                id="stamps-required"
                inputMode="numeric"
                pattern="[0-9]*"
                value={stampsRequired}
                onChange={(e) => setStampsRequired(e.target.value)}
                data-testid="stamps-required"
                className={`mt-1 ${field}`}
              />
            </div>
            <div>
              <label className={label} htmlFor="reward-name">
                {t("rewardName")}
              </label>
              <input
                id="reward-name"
                value={rewardName}
                onChange={(e) => setRewardName(e.target.value)}
                maxLength={120}
                data-testid="reward-name"
                className={`mt-1 ${field}`}
              />
            </div>
          </div>
        </Card>
      ) : (
        <Card className="space-y-4">
          <div>
            <h2 className="font-display text-lg font-bold text-ink">{t("rewardTiers")}</h2>
            <p className="mt-1 text-sm text-ink-muted">{t("form.tiersHelp")}</p>
          </div>

          <ul className="space-y-4" data-testid="tier-editor">
            {tiers.map((tier, index) => (
              <li key={index} className="rounded-xl border border-border p-4">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-semibold text-ink-muted">{t("form.tierNumber", { index: index + 1 })}</p>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => moveTier(index, -1)}
                      disabled={index === 0}
                      aria-label={t("form.moveUp", { index: index + 1 })}
                      data-testid={`tier-up-${index}`}
                      className="rounded-lg border border-border px-3 py-1 text-ink-muted disabled:opacity-40"
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      onClick={() => moveTier(index, 1)}
                      disabled={index === tiers.length - 1}
                      aria-label={t("form.moveDown", { index: index + 1 })}
                      data-testid={`tier-down-${index}`}
                      className="rounded-lg border border-border px-3 py-1 text-ink-muted disabled:opacity-40"
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      onClick={() => setTiers((current) => current.filter((_, i) => i !== index))}
                      disabled={tiers.length === 1}
                      aria-label={t("form.removeTier", { index: index + 1 })}
                      data-testid={`tier-remove-${index}`}
                      className="rounded-lg border border-border px-3 py-1 text-danger-ink disabled:opacity-40"
                    >
                      ×
                    </button>
                  </div>
                </div>

                <div className="mt-3 grid gap-3 sm:grid-cols-3">
                  <div className="sm:col-span-1">
                    <label className={label} htmlFor={`tier-name-${index}`}>
                      {t("rewardName")}
                    </label>
                    <input
                      id={`tier-name-${index}`}
                      value={tier.name}
                      onChange={(e) => setTier(index, { name: e.target.value })}
                      maxLength={120}
                      data-testid={`tier-name-${index}`}
                      className={`mt-1 ${field}`}
                    />
                  </div>
                  <div>
                    <label className={label} htmlFor={`tier-points-${index}`}>
                      {t("form.tierPoints")}
                    </label>
                    <input
                      id={`tier-points-${index}`}
                      inputMode="numeric"
                      pattern="[0-9]*"
                      value={tier.requiredPoints}
                      onChange={(e) => setTier(index, { requiredPoints: e.target.value })}
                      data-testid={`tier-points-${index}`}
                      className={`mt-1 ${field}`}
                    />
                  </div>
                  <div>
                    <label className={label} htmlFor={`tier-value-${index}`}>
                      {t("form.tierValue")}
                    </label>
                    <input
                      id={`tier-value-${index}`}
                      inputMode="numeric"
                      pattern="[0-9]*"
                      value={tier.rewardValueMinor}
                      onChange={(e) => setTier(index, { rewardValueMinor: e.target.value })}
                      data-testid={`tier-value-${index}`}
                      className={`mt-1 ${field}`}
                    />
                  </div>
                </div>
              </li>
            ))}
          </ul>

          <button
            type="button"
            onClick={() => setTiers((current) => [...current, { ...EMPTY_TIER }])}
            data-testid="add-tier"
            className="rounded-xl border border-border px-4 py-2 font-semibold text-ink-muted hover:bg-surface-muted"
          >
            {t("form.addTier")}
          </button>
        </Card>
      )}

      <Notice tone="info">{cardType === "CASHBACK" || cardType === "DISCOUNT" ? t("form.moneyCreateConfirm") : t("immutableNoteBeforeCreate")}</Notice>

      <button
        type="submit"
        disabled={busy}
        data-testid="create-program"
        className="w-full rounded-xl bg-navy-900 px-5 py-4 font-bold text-white transition-colors hover:bg-navy-800 disabled:opacity-60 sm:w-auto"
      >{busy ? t("form.creating") : cardType === "CASHBACK" || cardType === "DISCOUNT" ? t("form.createDraft") : t("form.create")}</button>
    </form>
  );
}
