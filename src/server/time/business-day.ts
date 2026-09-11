import { ValidationError } from "../errors";

/**
 * Day boundaries in a business's own timezone.
 *
 * `dailyAwardLimit` counts award operations per card per **business-timezone day**
 * (PRODUCT-SPEC §5.6). A café in Damascus closing at 01:00 must see that as the previous day's
 * trading, and a server running in UTC must not decide otherwise. Timezone lives on `Business`.
 *
 * The range is computed as absolute UTC instants rather than as a SQL date expression, so the
 * query stays a plain `createdAt >= start AND createdAt < end` and uses
 * `LoyaltyOperation_customerCardId_createdAt_idx`. A `("createdAt" AT TIME ZONE …)::date = …`
 * predicate would be correct but unindexable, which on the highest-volume table is a real cost.
 */

/** The UTC offset of `timeZone` at the instant `at`, in milliseconds. */
function offsetMsAt(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);

  const field = (type: string): number => {
    const found = parts.find((p) => p.type === type);
    if (!found) throw new ValidationError(`Timezone ${timeZone} produced no ${type}`);
    return Number(found.value);
  };
  // Intl renders midnight as hour 24 in some locales/engines; normalise it.
  const hour = field("hour") % 24;
  const asIfUtc = Date.UTC(field("year"), field("month") - 1, field("day"), hour, field("minute"), field("second"));
  // Milliseconds are not in the formatted parts, so compare on whole seconds.
  return asIfUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/** Validate an IANA zone once, with a clear error rather than a RangeError from deep inside Intl. */
export function assertValidTimeZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
  } catch {
    throw new ValidationError(`Unknown IANA timezone: ${timeZone}`);
  }
}

export interface DayRange {
  /** First instant of the local day, inclusive. */
  start: Date;
  /** First instant of the next local day, exclusive. */
  end: Date;
  /** The local calendar date, `YYYY-MM-DD`, for logging and audit metadata. */
  localDate: string;
}

/**
 * The local calendar date of `at` in `timeZone`, as `YYYY-MM-DD`.
 * `en-CA` formats as ISO, which is why it is used here rather than string surgery on en-US.
 */
export function localDateString(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

/**
 * The UTC instants bounding the local day that contains `at`.
 *
 * Midnight is found by converting the local wall-clock date back to UTC using the offset in
 * force, then re-checking with the offset at the candidate instant. The second pass matters on
 * DST transition days, where the offset before midnight differs from the offset after it: a
 * single-pass conversion lands an hour inside the neighbouring day. Syria has not observed DST
 * since 2022, but the function is used with whatever zone a merchant configures.
 */
export function businessDayRange(at: Date, timeZone: string): DayRange {
  assertValidTimeZone(timeZone);
  const localDate = localDateString(at, timeZone);
  const [year, month, day] = localDate.split("-").map(Number);

  const midnightUtcFor = (y: number, m: number, d: number): Date => {
    const wallClockAsUtc = Date.UTC(y, m - 1, d, 0, 0, 0);
    let instant = new Date(wallClockAsUtc - offsetMsAt(at, timeZone));
    // Re-resolve with the offset actually in force at the candidate, then once more if it moved.
    for (let pass = 0; pass < 2; pass++) {
      const corrected = new Date(wallClockAsUtc - offsetMsAt(instant, timeZone));
      if (corrected.getTime() === instant.getTime()) break;
      instant = corrected;
    }
    return instant;
  };

  const start = midnightUtcFor(year, month, day);
  const nextDay = new Date(Date.UTC(year, month - 1, day + 1));
  const end = midnightUtcFor(nextDay.getUTCFullYear(), nextDay.getUTCMonth() + 1, nextDay.getUTCDate());

  return { start, end, localDate };
}
