import { describe, expect, it } from "vitest";
import { resolveRange } from "@/server/analytics/ranges";
import { MAX_RANGE_DAYS } from "@/server/analytics/metrics";

/**
 * What a date preset means, in whose day.
 *
 * The project counts a daily award limit in the BUSINESS's timezone, so a dashboard that counted in
 * UTC would disagree with the till about which day a 01:00 coffee belonged to. These tests pin the
 * boundary in a zone that is not UTC, which is the only way to tell the two apart.
 */

const DAMASCUS = "Asia/Damascus";
/** 2026-03-10, 01:30 local in Damascus (UTC+3) — still "yesterday" to a UTC-minded reader. */
const EARLY_MORNING = new Date("2026-03-09T22:30:00.000Z");

describe("date presets are business-timezone days", () => {
  it("starts today at local midnight, not at UTC midnight", () => {
    const range = resolveRange({ preset: "today", timeZone: DAMASCUS, now: EARLY_MORNING });
    expect(range.fromLocalDate).toBe("2026-03-10");
    expect(range.toLocalDate).toBe("2026-03-10");
    // Local midnight in Damascus is 21:00 UTC the day before.
    expect(range.from.toISOString()).toBe("2026-03-09T21:00:00.000Z");
    expect(range.to).toEqual(EARLY_MORNING);
  });

  it("counts a 7-day preset as today plus six whole days", () => {
    const range = resolveRange({ preset: "7d", timeZone: DAMASCUS, now: EARLY_MORNING });
    expect(range.fromLocalDate).toBe("2026-03-04");
    expect(range.toLocalDate).toBe("2026-03-10");
  });

  it("covers thirty and ninety local days", () => {
    expect(resolveRange({ preset: "30d", timeZone: DAMASCUS, now: EARLY_MORNING }).fromLocalDate).toBe("2026-02-09");
    expect(resolveRange({ preset: "90d", timeZone: DAMASCUS, now: EARLY_MORNING }).fromLocalDate).toBe("2025-12-11");
  });
});

describe("a custom range is inclusive at both ends", () => {
  it("runs to the END of the last local day the merchant named", () => {
    const range = resolveRange({ preset: "custom", timeZone: DAMASCUS, from: "2026-03-01", to: "2026-03-07" });
    expect(range.from.toISOString()).toBe("2026-02-28T21:00:00.000Z");
    // The 8th at local midnight: the whole of the 7th is inside the range.
    expect(range.to.toISOString()).toBe("2026-03-07T21:00:00.000Z");
    expect(range.fromLocalDate).toBe("2026-03-01");
    expect(range.toLocalDate).toBe("2026-03-07");
  });

  it("accepts a single day", () => {
    const range = resolveRange({ preset: "custom", timeZone: DAMASCUS, from: "2026-03-01", to: "2026-03-01" });
    expect(range.to.getTime() - range.from.getTime()).toBe(86_400_000);
  });

  it("refuses a malformed date, a backwards range, and a range past the ceiling", () => {
    const base = { preset: "custom", timeZone: DAMASCUS } as const;
    expect(() => resolveRange({ ...base, from: "01/03/2026", to: "2026-03-07" })).toThrow(/YYYY-MM-DD/);
    expect(() => resolveRange({ ...base, from: "2026-03-07" })).toThrow(/start and an end/);
    expect(() => resolveRange({ ...base, from: "2026-03-07", to: "2026-03-01" })).toThrow(/must not be before/);
    // Refused, never clamped: a silently shortened range is a wrong number shown as a right one.
    expect(() => resolveRange({ ...base, from: "2024-01-01", to: "2026-03-07" })).toThrow(
      new RegExp(`at most ${MAX_RANGE_DAYS} days`),
    );
  });
});
