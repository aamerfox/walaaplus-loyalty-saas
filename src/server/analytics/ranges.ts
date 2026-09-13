import { ValidationError } from "../errors";
import { businessDayRange } from "../time/business-day";
import { MAX_RANGE_DAYS, type MetricsRange } from "./metrics";

/**
 * What "the last 30 days" means, and in whose day.
 *
 * ## The timezone contract, stated where the dashboard uses it
 *
 * This project already has one, and it is not UTC: `dailyAwardLimit` counts awards per **business
 * timezone day** (PRODUCT-SPEC §5.6), `Business.timezone` holds it, and `businessDayRange` turns a
 * local day into the UTC instants that bound it. A dashboard that silently used UTC would tell a
 * Damascus café that the coffees it sold at 01:00 belong to tomorrow, while the same rows counted
 * against yesterday's daily limit at the till an hour earlier. Two screens, two answers, one
 * ledger.
 *
 * So every preset here is computed with `businessDayRange` in the business's own zone:
 *
 *  - **today** — from local midnight to now;
 *  - **7 / 30 / 90 days** — from local midnight N−1 days ago to now, so "7 days" includes today and
 *    six whole days before it. A merchant looking at it on Monday morning sees last Tuesday onward,
 *    which is what they mean;
 *  - **custom** — two local calendar dates, inclusive at both ends: `to` is expanded to the END of
 *    that local day, because a merchant who types 1–7 March means the whole of the 7th.
 *
 * The upper bound is `MAX_RANGE_DAYS`, enforced again by `assertRange` inside the metric reads. A
 * range is refused rather than clamped: a silently shortened range is a wrong number presented as a
 * right one.
 */

export const RANGE_PRESETS = ["today", "7d", "30d", "90d", "custom"] as const;
export type RangePreset = (typeof RANGE_PRESETS)[number];

export function isRangePreset(value: unknown): value is RangePreset {
  return typeof value === "string" && (RANGE_PRESETS as readonly string[]).includes(value);
}

/** How many local days each preset covers, including today. */
const PRESET_DAYS: Record<Exclude<RangePreset, "custom">, number> = { today: 1, "7d": 7, "30d": 30, "90d": 90 };

const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface ResolveRangeInput {
  preset: RangePreset;
  timeZone: string;
  /** `YYYY-MM-DD` in the business's own zone. Required, and only used, when preset is `custom`. */
  from?: string;
  to?: string;
  /** Injectable so a test can pin "now" without pinning the clock. */
  now?: Date;
}

export interface ResolvedRange extends MetricsRange {
  preset: RangePreset;
  /** The local calendar dates the range covers, for the screen to echo back. */
  fromLocalDate: string;
  toLocalDate: string;
}

/**
 * Turn a preset, or two local dates, into the UTC instants the metric reads take.
 *
 * The end of a preset range is **now**, not the end of today: a merchant looking at a dashboard at
 * two in the afternoon is asking what has happened, not what will have happened by midnight.
 */
export function resolveRange(input: ResolveRangeInput): ResolvedRange {
  const now = input.now ?? new Date();
  const today = businessDayRange(now, input.timeZone);

  if (input.preset !== "custom") {
    const days = PRESET_DAYS[input.preset];
    // Step back through local midnights rather than subtracting 86_400_000 milliseconds: on a DST
    // boundary a local day is 23 or 25 hours long, and the arithmetic would land inside a day.
    let start = today.start;
    let cursor = today;
    for (let i = 1; i < days; i += 1) {
      cursor = businessDayRange(new Date(cursor.start.getTime() - 1), input.timeZone);
      start = cursor.start;
    }
    return {
      preset: input.preset,
      from: start,
      to: now,
      fromLocalDate: cursor.localDate,
      toLocalDate: today.localDate,
    };
  }

  if (!input.from || !input.to || !LOCAL_DATE.test(input.from) || !LOCAL_DATE.test(input.to)) {
    throw new ValidationError("A custom range needs a start and an end date, as YYYY-MM-DD");
  }
  // Parsed as local noon, not midnight: noon is inside its own day in every timezone offset, so the
  // day the merchant typed is the day that comes back even where midnight is ambiguous.
  const startDay = businessDayRange(new Date(`${input.from}T12:00:00Z`), input.timeZone);
  const endDay = businessDayRange(new Date(`${input.to}T12:00:00Z`), input.timeZone);
  if (endDay.end.getTime() <= startDay.start.getTime()) {
    throw new ValidationError("The end of the range must not be before its start");
  }
  const days = (endDay.end.getTime() - startDay.start.getTime()) / 86_400_000;
  if (days > MAX_RANGE_DAYS) {
    throw new ValidationError(`A range may cover at most ${MAX_RANGE_DAYS} days`);
  }

  return {
    preset: "custom",
    from: startDay.start,
    // Inclusive of the last day the merchant named: `to` is exclusive, so it is that day's end.
    to: endDay.end,
    fromLocalDate: startDay.localDate,
    toLocalDate: endDay.localDate,
  };
}
