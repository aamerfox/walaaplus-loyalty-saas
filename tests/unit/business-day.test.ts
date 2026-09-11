import { describe, expect, it } from "vitest";
import { ValidationError } from "@/server/errors";
import { assertValidTimeZone, businessDayRange, localDateString } from "@/server/time/business-day";

/**
 * `dailyAwardLimit` counts awards per BUSINESS-timezone day (PRODUCT-SPEC §5.6). A server running
 * in UTC must not decide when a Damascus café's day ends, and a café closing at 01:00 is still
 * trading the previous day as far as its staff are concerned.
 */
describe("business-timezone day boundaries", () => {
  describe("Asia/Damascus (UTC+3, no DST since 2022)", () => {
    const tz = "Asia/Damascus";

    it("puts late-evening UTC into the next local day", () => {
      // 22:30Z is 01:30 the next morning in Damascus.
      const range = businessDayRange(new Date("2026-09-11T22:30:00Z"), tz);
      expect(range.localDate).toBe("2026-09-12");
      expect(range.start.toISOString()).toBe("2026-09-11T21:00:00.000Z");
      expect(range.end.toISOString()).toBe("2026-09-12T21:00:00.000Z");
    });

    it("puts midday UTC into the same local day", () => {
      const range = businessDayRange(new Date("2026-09-11T12:00:00Z"), tz);
      expect(range.localDate).toBe("2026-09-11");
      expect(range.start.toISOString()).toBe("2026-09-10T21:00:00.000Z");
      expect(range.end.toISOString()).toBe("2026-09-11T21:00:00.000Z");
    });

    it("is half-open: the instant of local midnight starts the new day", () => {
      const justBefore = businessDayRange(new Date("2026-09-11T20:59:59Z"), tz);
      const atMidnight = businessDayRange(new Date("2026-09-11T21:00:00Z"), tz);
      expect(justBefore.localDate).toBe("2026-09-11");
      expect(atMidnight.localDate).toBe("2026-09-12");
      // No gap and no overlap between consecutive days.
      expect(justBefore.end.getTime()).toBe(atMidnight.start.getTime());
    });
  });

  it("disagrees with UTC where the merchant's day really is different", () => {
    const instant = new Date("2026-09-11T12:00:00Z");
    expect(localDateString(instant, "UTC")).toBe("2026-09-11");
    // UTC+14: already tomorrow.
    expect(localDateString(instant, "Pacific/Kiritimati")).toBe("2026-09-12");
    // UTC-11: still yesterday.
    expect(localDateString(instant, "Pacific/Niue")).toBe("2026-09-11");
    expect(localDateString(new Date("2026-09-11T02:00:00Z"), "Pacific/Niue")).toBe("2026-09-10");
  });

  it("gives each zone its own window for the same instant", () => {
    const instant = new Date("2026-09-11T12:00:00Z");
    const kiritimati = businessDayRange(instant, "Pacific/Kiritimati");
    const niue = businessDayRange(instant, "Pacific/Niue");
    expect(kiritimati.localDate).toBe("2026-09-12");
    expect(niue.localDate).toBe("2026-09-11");
    // The windows are 25 hours apart, which is exactly why the server's clock cannot be used.
    expect(kiritimati.start.getTime()).not.toBe(niue.start.getTime());
    expect(instant.getTime()).toBeGreaterThanOrEqual(kiritimati.start.getTime());
    expect(instant.getTime()).toBeLessThan(kiritimati.end.getTime());
    expect(instant.getTime()).toBeGreaterThanOrEqual(niue.start.getTime());
    expect(instant.getTime()).toBeLessThan(niue.end.getTime());
  });

  describe("daylight saving", () => {
    const tz = "Europe/Berlin"; // still observes DST, unlike Syria

    it("gets a 23-hour day right when the clocks go forward", () => {
      // 29 March 2026: 02:00 local becomes 03:00.
      const range = businessDayRange(new Date("2026-03-29T12:00:00Z"), tz);
      expect(range.localDate).toBe("2026-03-29");
      expect(range.start.toISOString()).toBe("2026-03-28T23:00:00.000Z");
      expect(range.end.toISOString()).toBe("2026-03-29T22:00:00.000Z");
      expect((range.end.getTime() - range.start.getTime()) / 3_600_000).toBe(23);
    });

    it("gets a 25-hour day right when the clocks go back", () => {
      // 25 October 2026: 03:00 local becomes 02:00.
      const range = businessDayRange(new Date("2026-10-25T12:00:00Z"), tz);
      expect(range.localDate).toBe("2026-10-25");
      expect((range.end.getTime() - range.start.getTime()) / 3_600_000).toBe(25);
    });

    it("still contains the instant it was asked about on a transition day", () => {
      for (const iso of ["2026-03-29T00:30:00Z", "2026-03-29T01:30:00Z", "2026-10-25T00:30:00Z", "2026-10-25T23:30:00Z"]) {
        const at = new Date(iso);
        const range = businessDayRange(at, tz);
        expect(at.getTime(), iso).toBeGreaterThanOrEqual(range.start.getTime());
        expect(at.getTime(), iso).toBeLessThan(range.end.getTime());
      }
    });
  });

  it("covers every instant of a year with no gap or overlap, in a half-hour zone", () => {
    // Asia/Kolkata is UTC+5:30: a whole-hour assumption would drift here.
    const tz = "Asia/Kolkata";
    let cursor = new Date("2026-01-01T00:00:00Z");
    const stopAfter = new Date("2027-01-02T00:00:00Z");
    let previousEnd: number | null = null;
    const localDates: string[] = [];
    while (cursor < stopAfter) {
      const range = businessDayRange(cursor, tz);
      expect(cursor.getTime()).toBeGreaterThanOrEqual(range.start.getTime());
      expect(cursor.getTime()).toBeLessThan(range.end.getTime());
      // Each day starts exactly where the previous one ended: no gap, no overlap, no lost hour.
      if (previousEnd !== null) expect(range.start.getTime()).toBe(previousEnd);
      previousEnd = range.end.getTime();
      localDates.push(range.localDate);
      cursor = new Date(range.end.getTime());
    }
    // Every local day of 2026 appears exactly once. The walk starts and ends mid-local-day, so it
    // also touches the neighbouring days; those are excluded rather than counted.
    const of2026 = localDates.filter((d) => d.startsWith("2026-"));
    expect(of2026.length).toBe(365);
    expect(new Set(of2026).size).toBe(365);
    expect(of2026[0]).toBe("2026-01-01");
    expect(of2026[364]).toBe("2026-12-31");
  });

  it("refuses an unknown timezone with a clear error", () => {
    expect(() => assertValidTimeZone("Mars/Olympus")).toThrow(ValidationError);
    expect(() => businessDayRange(new Date(), "Not/AZone")).toThrow(/Unknown IANA timezone/);
    expect(() => assertValidTimeZone("Asia/Damascus")).not.toThrow();
  });
});
