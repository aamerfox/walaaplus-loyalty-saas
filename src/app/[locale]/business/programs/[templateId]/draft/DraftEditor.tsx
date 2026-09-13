"use client";

import { useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/routing";
import { Badge, Button, Card, Field, Notice, SelectInput, Section, TextInput } from "@/components/ui";

/**
 * Editing the next version of a program, and publishing it.
 *
 * ## Why this form replaces everything rather than patching
 *
 * The draft is sent whole on every save. A patch over a JSON mechanics column means the server
 * merges two states it did not both validate, and the field a merchant CLEARED is exactly the one a
 * merge silently restores. Sending the whole object makes "what will the rules be" a question with
 * one answer — the one on this screen.
 *
 * ## What it will not let a merchant do
 *
 * The fields here are exactly the mechanics contract for this card type. There is no expiry picker,
 * no cashback toggle and no tier-per-location switch, because the server would refuse them and a
 * control that is always refused is a promise made in advance and broken later.
 *
 * `availableLocations` is a list of **counters by name**, never by id: a merchant chooses "Branch",
 * and the id is this component's business. An empty selection means the main counter only, which is
 * what every program created before multi-location says and what their cards keep saying.
 *
 * ## Publishing
 *
 * The publish button carries the draft's version NUMBER, which the server compares with the draft it
 * actually holds. If somebody else published while this page was open, the number no longer matches
 * and the publish is refused — so nobody ever publishes a version they did not read.
 */

type EarnMode = "MANUAL" | "PER_VISIT" | "SPEND_BLOCK";

export interface TierDraft {
  name: string;
  requiredPoints: string;
  rewardValueMinor: string;
}

export interface DraftEditorProps {
  businessId: string;
  templateId: string;
  cardType: "STAMP" | "POINTS";
  draftVersionNumber: number;
  liveVersionNumber: number;
  cardsOnLiveVersion: number;
  locations: { id: string; name: string }[];
  changes: { field: string; before: string | number | boolean | null; after: string | number | boolean | null }[];
  initial: {
    earnMode: EarnMode;
    spendAmountPerBlockMinor: string;
    unitsPerBlock: string;
    pointsPerVisit: string;
    dailyAwardLimit: string;
    welcomeUnits: string;
    requirePurchaseAmount: boolean;
    countRewardRedemptionAsVisit: boolean;
    maxPointsPerManualAward: string;
    pointsLabel: string;
    stampsRequiredPerReward: string;
    rewardName: string;
    rewardDescription: string;
    rewardValueMinor: string;
    availableLocations: string[];
    tiers: TierDraft[];
  };
}

/** A required whole number, or null when the field is empty or is not one. */
function whole(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === "" || !/^\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return Number.isSafeInteger(n) ? n : null;
}

/** An optional whole number: `undefined` when blank, `null` when present and invalid. */
function optionalWhole(value: string): number | undefined | null {
  return value.trim() === "" ? undefined : whole(value);
}

export default function DraftEditor(props: DraftEditorProps) {
  const t = useTranslations("Versions");
  const tp = useTranslations("Programs");
  const tc = useTranslations("Common");
  const router = useRouter();

  const [earnMode, setEarnMode] = useState<EarnMode>(props.initial.earnMode);
  const [spendPerBlock, setSpendPerBlock] = useState(props.initial.spendAmountPerBlockMinor);
  const [unitsPerBlock, setUnitsPerBlock] = useState(props.initial.unitsPerBlock);
  const [pointsPerVisit, setPointsPerVisit] = useState(props.initial.pointsPerVisit);
  const [dailyLimit, setDailyLimit] = useState(props.initial.dailyAwardLimit);
  const [welcomeUnits, setWelcomeUnits] = useState(props.initial.welcomeUnits);
  const [requirePurchase, setRequirePurchase] = useState(props.initial.requirePurchaseAmount);
  const [countRedemptionAsVisit, setCountRedemptionAsVisit] = useState(props.initial.countRewardRedemptionAsVisit);
  const [maxManual, setMaxManual] = useState(props.initial.maxPointsPerManualAward);
  const [pointsLabel, setPointsLabel] = useState(props.initial.pointsLabel);
  const [stampsRequired, setStampsRequired] = useState(props.initial.stampsRequiredPerReward);
  const [rewardName, setRewardName] = useState(props.initial.rewardName);
  const [rewardDescription, setRewardDescription] = useState(props.initial.rewardDescription);
  const [rewardValue, setRewardValue] = useState(props.initial.rewardValueMinor);
  const [selectedLocations, setSelectedLocations] = useState<string[]>(props.initial.availableLocations);
  const [tiers, setTiers] = useState<TierDraft[]>(props.initial.tiers);

  const [issues, setIssues] = useState<string[]>([]);
  const [failure, setFailure] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  const isPoints = props.cardType === "POINTS";
  const setTier = (index: number, patch: Partial<TierDraft>) =>
    setTiers((current) => current.map((tier, i) => (i === index ? { ...tier, ...patch } : tier)));

  /** The mechanics object exactly as the contract defines it, or a list of field problems. */
  function build(): { mechanics: Record<string, unknown>; tiers?: unknown[] } | { problems: string[] } {
    const problems: string[] = [];
    const common: Record<string, unknown> = {
      contractVersion: 1,
      earnMode,
      requirePurchaseAmount: requirePurchase,
      countRewardRedemptionAsVisit: countRedemptionAsVisit,
    };

    if (earnMode === "SPEND_BLOCK") {
      const spend = whole(spendPerBlock);
      const units = whole(unitsPerBlock);
      if (spend === null || spend < 1) problems.push(t("errorSpend"));
      if (units === null || units < 1) problems.push(t("errorUnitsPerBlock"));
      common.spendAmountPerBlockMinor = spend ?? undefined;
      if (isPoints) common.pointsPerBlock = units ?? undefined;
      else common.stampsPerBlock = units ?? undefined;
    }

    const daily = optionalWhole(dailyLimit);
    if (daily === null || (daily !== undefined && daily < 1)) problems.push(t("errorDailyLimit"));
    if (daily !== undefined) common.dailyAwardLimit = daily;

    const welcome = optionalWhole(welcomeUnits);
    if (welcome === null || (welcome !== undefined && welcome < 1)) problems.push(t("errorWelcome"));

    // An empty selection means "the main counter", which is the absence of the field rather than an
    // empty array: an empty array would be a version that runs nowhere, and the contract refuses it.
    if (selectedLocations.length > 0) common.availableLocations = selectedLocations;

    if (isPoints) {
      if (earnMode === "PER_VISIT") {
        const perVisit = whole(pointsPerVisit);
        if (perVisit === null || perVisit < 1) problems.push(t("errorPerVisit"));
        common.pointsPerVisit = perVisit ?? undefined;
      }
      const manual = optionalWhole(maxManual);
      if (manual === null || (manual !== undefined && manual < 1)) problems.push(t("errorMaxManual"));
      if (manual !== undefined) common.maxPointsPerManualAward = manual;
      if (pointsLabel.trim() !== "") common.pointsLabel = pointsLabel.trim();
      if (welcome !== undefined) common.welcomePoints = welcome;

      const parsedTiers = tiers.map((tier) => {
        const points = whole(tier.requiredPoints);
        const value = optionalWhole(tier.rewardValueMinor);
        if (tier.name.trim() === "") problems.push(t("errorTierName"));
        if (points === null || points < 1) problems.push(t("errorTierPoints"));
        if (value === null) problems.push(t("errorTierValue"));
        return {
          name: tier.name.trim(),
          requiredPoints: points ?? 0,
          ...(value !== undefined && value !== null ? { rewardValueMinor: value } : {}),
        };
      });
      if (parsedTiers.length === 0) problems.push(t("errorNoTiers"));
      if (problems.length > 0) return { problems };
      return { mechanics: { kind: "POINTS", ...common }, tiers: parsedTiers };
    }

    const required = whole(stampsRequired);
    if (required === null || required < 1) problems.push(t("errorStampsRequired"));
    if (rewardName.trim() === "") problems.push(t("errorRewardName"));
    const value = optionalWhole(rewardValue);
    if (value === null) problems.push(t("errorTierValue"));
    if (welcome !== undefined) common.welcomeStamps = welcome;
    if (problems.length > 0) return { problems };

    return {
      mechanics: {
        kind: "STAMP",
        ...common,
        stampsRequiredPerReward: required ?? 0,
        rewardName: rewardName.trim(),
        ...(rewardDescription.trim() !== "" ? { rewardDescription: rewardDescription.trim() } : {}),
        ...(value !== undefined ? { rewardValueMinor: value } : {}),
      },
    };
  }

  async function post(body: Record<string, unknown>): Promise<{ ok: boolean; code?: string }> {
    try {
      const response = await fetch("/api/staff/program-version", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ businessId: props.businessId, templateId: props.templateId, ...body }),
      });
      if (response.ok) return { ok: true };
      const payload = (await response.json().catch(() => null)) as { error?: { code?: string } } | null;
      return { ok: false, code: payload?.error?.code };
    } catch {
      return { ok: false };
    }
  }

  function refusal(code: string | undefined): string {
    if (code === "DRAFT_STALE") return t("errorStale");
    if (code === "VALIDATION_ERROR") return t("errorRejected");
    if (code === "FORBIDDEN") return tp("forbidden");
    return tc("genericError");
  }

  async function onSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setFailure(null);
    setSaved(false);

    const built = build();
    if ("problems" in built) {
      setIssues([...new Set(built.problems)]);
      return;
    }
    setIssues([]);
    setBusy(true);
    const result = await post({ action: "updateDraft", mechanics: built.mechanics, tiers: built.tiers });
    if (result.ok) {
      setSaved(true);
      router.refresh(); // the review panel above is server-rendered from the saved draft
    } else {
      setFailure(refusal(result.code));
    }
    setBusy(false);
  }

  async function onPublish() {
    if (busy) return;
    if (!window.confirm(t("confirmPublish", { count: props.cardsOnLiveVersion }))) return;
    setBusy(true);
    setFailure(null);
    const result = await post({ action: "publish", expectedVersionNumber: props.draftVersionNumber });
    setBusy(false);
    if (result.ok) router.push(`/business/programs/${props.templateId}`);
    else setFailure(refusal(result.code));
  }

  async function onDiscard() {
    if (busy) return;
    if (!window.confirm(t("confirmDiscard"))) return;
    setBusy(true);
    setFailure(null);
    const result = await post({ action: "discardDraft" });
    setBusy(false);
    if (result.ok) router.push(`/business/programs/${props.templateId}`);
    else setFailure(refusal(result.code));
  }

  return (
    <>
      <Section title={t("reviewTitle")} description={t("reviewSubtitle")} testId="draft-review">
        <Card>
          {props.changes.length === 0 ? (
            <p className="text-ink-muted" data-testid="draft-no-changes">
              {t("noChanges")}
            </p>
          ) : (
            <ul className="divide-y divide-border" data-testid="draft-changes">
              {props.changes.map((change, index) => (
                <li key={`${change.field}-${index}`} className="flex flex-wrap items-baseline justify-between gap-3 py-3">
                  <span className="font-semibold text-ink">
                    {change.field.startsWith("reward:")
                      ? t("rewardChanged", { name: change.field.slice("reward:".length) })
                      : t.has(`field.${change.field}`)
                        ? t(`field.${change.field}`)
                        : change.field}
                  </span>
                  <span className="flex items-center gap-2 text-sm">
                    <span className="text-ink-muted line-through">{String(change.before ?? t("notSet"))}</span>
                    <span aria-hidden="true" className="text-ink-faint">
                      →
                    </span>
                    <span className="font-semibold text-accent-ink">{String(change.after ?? t("notSet"))}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}

          <Notice tone="info" testId="draft-immutability">
            {t("immutabilityNote", { count: props.cardsOnLiveVersion, version: props.liveVersionNumber })}
          </Notice>

          <div className="mt-4 flex flex-wrap gap-2">
            <Button type="button" variant="accent" disabled={busy} onClick={() => void onPublish()} testId="publish-draft">
              {t("publish", { number: props.draftVersionNumber })}
            </Button>
            <Button type="button" variant="ghost" disabled={busy} onClick={() => void onDiscard()} testId="discard-draft">
              {t("discard")}
            </Button>
          </div>
          {failure ? (
            <Notice tone="danger" testId="draft-failure">
              {failure}
            </Notice>
          ) : null}
        </Card>
      </Section>

      <Section title={t("editTitle")} description={t("editSubtitle")}>
        <Card>
          <form className="space-y-5" onSubmit={onSave} data-testid="draft-form" noValidate>
            {isPoints ? (
              <Field id="pointsLabel" label={t("pointsLabel")} hint={t("pointsLabelHint")}>
                <TextInput id="pointsLabel" maxLength={40} value={pointsLabel} onChange={(e) => setPointsLabel(e.target.value)} />
              </Field>
            ) : (
              <div className="grid gap-4 sm:grid-cols-2">
                <Field id="stampsRequired" label={t("stampsRequired")}>
                  <TextInput
                    id="stampsRequired"
                    inputMode="numeric"
                    value={stampsRequired}
                    onChange={(e) => setStampsRequired(e.target.value)}
                    data-testid="draft-stamps-required"
                  />
                </Field>
                <Field id="rewardName" label={t("rewardName")}>
                  <TextInput
                    id="rewardName"
                    maxLength={120}
                    value={rewardName}
                    onChange={(e) => setRewardName(e.target.value)}
                    data-testid="draft-reward-name"
                  />
                </Field>
                <Field id="rewardDescription" label={t("rewardDescription")}>
                  <TextInput
                    id="rewardDescription"
                    maxLength={500}
                    value={rewardDescription}
                    onChange={(e) => setRewardDescription(e.target.value)}
                  />
                </Field>
                <Field id="rewardValue" label={t("rewardValue")} hint={t("rewardValueHint")}>
                  <TextInput id="rewardValue" inputMode="numeric" value={rewardValue} onChange={(e) => setRewardValue(e.target.value)} />
                </Field>
              </div>
            )}

            <div className="grid gap-4 sm:grid-cols-2">
              <Field id="earnMode" label={t("earnMode")}>
                <SelectInput id="earnMode" value={earnMode} onChange={(e) => setEarnMode(e.target.value as EarnMode)} data-testid="draft-earn-mode">
                  <option value="MANUAL">{t("earnManual")}</option>
                  <option value="PER_VISIT">{t("earnPerVisit")}</option>
                  <option value="SPEND_BLOCK">{t("earnSpendBlock")}</option>
                </SelectInput>
              </Field>

              {earnMode === "SPEND_BLOCK" ? (
                <>
                  <Field id="spendPerBlock" label={t("spendPerBlock")}>
                    <TextInput id="spendPerBlock" inputMode="numeric" value={spendPerBlock} onChange={(e) => setSpendPerBlock(e.target.value)} />
                  </Field>
                  <Field id="unitsPerBlock" label={isPoints ? t("pointsPerBlock") : t("stampsPerBlock")}>
                    <TextInput id="unitsPerBlock" inputMode="numeric" value={unitsPerBlock} onChange={(e) => setUnitsPerBlock(e.target.value)} />
                  </Field>
                </>
              ) : null}

              {isPoints && earnMode === "PER_VISIT" ? (
                <Field id="pointsPerVisit" label={t("pointsPerVisit")}>
                  <TextInput id="pointsPerVisit" inputMode="numeric" value={pointsPerVisit} onChange={(e) => setPointsPerVisit(e.target.value)} />
                </Field>
              ) : null}

              {isPoints ? (
                <Field id="maxManual" label={t("maxManual")} hint={t("maxManualHint")}>
                  <TextInput id="maxManual" inputMode="numeric" value={maxManual} onChange={(e) => setMaxManual(e.target.value)} />
                </Field>
              ) : null}

              <Field id="dailyLimit" label={t("dailyLimit")} hint={t("dailyLimitHint")}>
                <TextInput id="dailyLimit" inputMode="numeric" value={dailyLimit} onChange={(e) => setDailyLimit(e.target.value)} data-testid="draft-daily-limit" />
              </Field>

              <Field id="welcomeUnits" label={isPoints ? t("welcomePoints") : t("welcomeStamps")} hint={t("welcomeHint")}>
                <TextInput id="welcomeUnits" inputMode="numeric" value={welcomeUnits} onChange={(e) => setWelcomeUnits(e.target.value)} />
              </Field>
            </div>

            <div className="space-y-2">
              <label className="flex items-center gap-2 text-sm text-ink">
                <input type="checkbox" checked={requirePurchase} onChange={(e) => setRequirePurchase(e.target.checked)} className="size-4" />
                {t("requirePurchase")}
              </label>
              <label className="flex items-center gap-2 text-sm text-ink">
                <input
                  type="checkbox"
                  checked={countRedemptionAsVisit}
                  onChange={(e) => setCountRedemptionAsVisit(e.target.checked)}
                  className="size-4"
                />
                {t("countRedemptionAsVisit")}
              </label>
            </div>

            {/* Counters by NAME. The ids never appear on screen; they are this component's business. */}
            <fieldset className="space-y-2" data-testid="draft-locations">
              <legend className="text-sm font-semibold text-ink">{t("whereItRuns")}</legend>
              <p className="text-xs text-ink-muted">{t("whereItRunsHint")}</p>
              {props.locations.map((location) => (
                <label key={location.id} className="flex items-center gap-2 text-sm text-ink">
                  <input
                    type="checkbox"
                    className="size-4"
                    checked={selectedLocations.includes(location.id)}
                    onChange={(e) =>
                      setSelectedLocations((current) =>
                        e.target.checked ? [...current, location.id] : current.filter((id) => id !== location.id),
                      )
                    }
                  />
                  {location.name}
                </label>
              ))}
            </fieldset>

            {isPoints ? (
              <div className="space-y-3" data-testid="draft-tiers">
                <p className="text-sm font-semibold text-ink">{t("rewards")}</p>
                {tiers.map((tier, index) => (
                  <div key={index} className="grid gap-3 rounded-xl border border-border p-3 sm:grid-cols-3">
                    <Field id={`tier-name-${index}`} label={t("tierName")}>
                      <TextInput
                        id={`tier-name-${index}`}
                        maxLength={120}
                        value={tier.name}
                        onChange={(e) => setTier(index, { name: e.target.value })}
                        data-testid={`draft-tier-name-${index}`}
                      />
                    </Field>
                    <Field id={`tier-points-${index}`} label={t("tierPoints")}>
                      <TextInput
                        id={`tier-points-${index}`}
                        inputMode="numeric"
                        value={tier.requiredPoints}
                        onChange={(e) => setTier(index, { requiredPoints: e.target.value })}
                        data-testid={`draft-tier-points-${index}`}
                      />
                    </Field>
                    <Field id={`tier-value-${index}`} label={t("tierValue")}>
                      <div className="flex gap-2">
                        <TextInput
                          id={`tier-value-${index}`}
                          inputMode="numeric"
                          value={tier.rewardValueMinor}
                          onChange={(e) => setTier(index, { rewardValueMinor: e.target.value })}
                        />
                        {tiers.length > 1 ? (
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            onClick={() => setTiers((current) => current.filter((_, i) => i !== index))}
                          >
                            {t("removeReward")}
                          </Button>
                        ) : null}
                      </div>
                    </Field>
                  </div>
                ))}
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  onClick={() => setTiers((current) => [...current, { name: "", requiredPoints: "", rewardValueMinor: "" }])}
                  testId="draft-add-tier"
                >
                  {t("addReward")}
                </Button>
              </div>
            ) : null}

            {issues.length > 0 ? (
              <Notice tone="danger" testId="draft-issues">
                {issues.join(" ")}
              </Notice>
            ) : null}
            {saved ? (
              <Notice tone="success" testId="draft-saved">
                {t("saved")}
              </Notice>
            ) : null}

            <div className="flex flex-wrap items-center gap-3">
              <Button type="submit" disabled={busy} testId="save-draft">
                {busy ? t("saving") : t("save")}
              </Button>
              <Badge tone="neutral">{t("draftBadge", { number: props.draftVersionNumber })}</Badge>
            </div>
          </form>
        </Card>
      </Section>
    </>
  );
}
