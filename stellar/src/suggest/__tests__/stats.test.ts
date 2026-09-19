import { describe, expect, it } from "vitest";
import {
  dailyTotals,
  localDayKey,
  maxOf,
  median,
  medianInt,
  percentileNearestRank,
  recipientFrequency,
  sortBigints,
  spanDays,
} from "../stats.ts";
import { DAY, NOW, addr, rec } from "./helpers.ts";

const sec = (year: number, monthIndex: number, day: number, hour = 0, minute = 0): number =>
  Math.floor(Date.UTC(year, monthIndex, day, hour, minute) / 1000);

describe("percentileNearestRank", () => {
  it("returns the single value for n = 1", () => {
    expect(percentileNearestRank([5n], 90)).toBe(5n);
  });

  it("uses the documented nearest rank for n = 2", () => {
    expect(percentileNearestRank([1n, 2n], 50)).toBe(1n);
    expect(percentileNearestRank([1n, 2n], 90)).toBe(2n);
  });

  it("computes an odd-count percentile", () => {
    expect(percentileNearestRank([1n, 2n, 3n, 4n, 5n], 50)).toBe(3n);
    expect(percentileNearestRank([1n, 2n, 3n, 4n, 5n], 90)).toBe(5n);
  });

  it("computes an even-count percentile", () => {
    expect(percentileNearestRank([1n, 2n, 3n, 4n], 50)).toBe(2n);
    expect(percentileNearestRank([1n, 2n, 3n, 4n], 90)).toBe(4n);
  });

  it("handles duplicates", () => {
    expect(percentileNearestRank([2n, 2n, 2n], 90)).toBe(2n);
    expect(percentileNearestRank([1n, 5n, 5n, 5n], 90)).toBe(5n);
  });

  it("selects the 13th of 14 values for p90 (worked example)", () => {
    const values = [1n, 2n, 3n, 5n, 7n, 8n, 9n, 10n, 12n, 13n, 15n, 16n, 184n, 220n];
    expect(percentileNearestRank(values, 90)).toBe(184n);
  });

  it("rejects an empty input", () => {
    expect(() => percentileNearestRank([], 90)).toThrow(/empty/);
  });

  it("rejects out-of-range or non-integer percentiles", () => {
    expect(() => percentileNearestRank([1n], 0)).toThrow(/percentile/);
    expect(() => percentileNearestRank([1n], 101)).toThrow(/percentile/);
    expect(() => percentileNearestRank([1n], 90.5)).toThrow(/percentile/);
  });
});

describe("median", () => {
  it("returns the middle value for odd n", () => {
    expect(median([1n, 2n, 3n])).toBe(2n);
  });

  it("returns the integer mean of the two middles for even n", () => {
    expect(median([90_000_000n, 100_000_000n])).toBe(95_000_000n);
    expect(median([1n, 2n])).toBe(1n);
  });

  it("returns the single value for n = 1", () => {
    expect(median([7n])).toBe(7n);
  });

  it("rejects an empty input", () => {
    expect(() => median([])).toThrow(/empty/);
  });
});

describe("maxOf", () => {
  it("returns the maximum regardless of order", () => {
    expect(maxOf([3n, 9n, 1n])).toBe(9n);
  });

  it("returns the single value", () => {
    expect(maxOf([4n])).toBe(4n);
  });

  it("rejects an empty input", () => {
    expect(() => maxOf([])).toThrow(/empty/);
  });
});

describe("sortBigints", () => {
  it("sorts ascending without mutating the input", () => {
    const input = [3n, 1n, 2n];
    expect(sortBigints(input)).toEqual([1n, 2n, 3n]);
    expect(input).toEqual([3n, 1n, 2n]);
  });
});

describe("localDayKey (timezone/DST bucketing)", () => {
  it("buckets in UTC", () => {
    expect(localDayKey(sec(2024, 0, 15, 23, 30), "UTC")).toBe("2024-01-15");
    expect(localDayKey(sec(2024, 0, 16, 0, 30), "UTC")).toBe("2024-01-16");
  });

  it("buckets a half-hour zone (Asia/Kolkata, +05:30)", () => {
    expect(localDayKey(sec(2024, 2, 9, 18, 45), "Asia/Kolkata")).toBe("2024-03-10");
    expect(localDayKey(sec(2024, 2, 9, 18, 15), "Asia/Kolkata")).toBe("2024-03-09");
  });

  it("is DST-safe across the US spring-forward", () => {
    // 01:30 EST and 03:30 EDT are both local 2024-03-10 in New York.
    expect(localDayKey(sec(2024, 2, 10, 6, 30), "America/New_York")).toBe("2024-03-10");
    expect(localDayKey(sec(2024, 2, 10, 7, 30), "America/New_York")).toBe("2024-03-10");
    expect(localDayKey(sec(2024, 2, 11, 3, 30), "America/New_York")).toBe("2024-03-10");
  });

  it("is DST-safe across the US fall-back", () => {
    // 01:30 EDT and 01:30 EST are the same wall time on local 2024-11-03.
    expect(localDayKey(sec(2024, 10, 3, 5, 30), "America/New_York")).toBe("2024-11-03");
    expect(localDayKey(sec(2024, 10, 3, 6, 30), "America/New_York")).toBe("2024-11-03");
  });
});

describe("dailyTotals", () => {
  it("sums same-day records and returns sorted active-day totals", () => {
    const dayA = NOW - 2 * DAY;
    const dayB = NOW - 3 * DAY;
    const records = [
      rec({ id: "a1", ts: dayA, amountRaw: 5_000_000n }),
      rec({ id: "a2", ts: dayA + 3600, amountRaw: 7_000_000n }),
      rec({ id: "b1", ts: dayB, amountRaw: 3_000_000n }),
    ];
    expect(dailyTotals(records, "UTC")).toEqual([3_000_000n, 12_000_000n]);
  });

  it("returns an empty array for no records", () => {
    expect(dailyTotals([], "UTC")).toEqual([]);
  });

  it("keeps records from different local days apart", () => {
    const records = [
      rec({ id: "x", ts: sec(2024, 5, 1, 23, 0), amountRaw: 1_000_000n }),
      rec({ id: "y", ts: sec(2024, 5, 2, 1, 0), amountRaw: 2_000_000n }),
    ];
    expect(dailyTotals(records, "UTC")).toEqual([1_000_000n, 2_000_000n]);
  });
});

describe("spanDays", () => {
  it("returns 0 for fewer than two records", () => {
    expect(spanDays([])).toBe(0);
    expect(spanDays([rec()])).toBe(0);
  });

  it("returns whole days between first and last", () => {
    const records = [rec({ id: "a", ts: NOW - 3 * DAY }), rec({ id: "b", ts: NOW })];
    expect(spanDays(records)).toBe(3);
  });

  it("floors a partial day", () => {
    const records = [rec({ id: "a", ts: NOW - (3 * DAY + 100) }), rec({ id: "b", ts: NOW })];
    expect(spanDays(records)).toBe(3);
  });
});

describe("recipientFrequency", () => {
  it("counts records per recipient", () => {
    const records = [
      rec({ id: "a", recipientAddress: addr(1) }),
      rec({ id: "b", recipientAddress: addr(1) }),
      rec({ id: "c", recipientAddress: addr(2) }),
    ];
    const counts = recipientFrequency(records);
    expect(counts.get(addr(1))).toBe(2);
    expect(counts.get(addr(2))).toBe(1);
  });
});

describe("medianInt", () => {
  it("returns the middle for odd counts", () => {
    expect(medianInt([3, 1, 2])).toBe(2);
  });

  it("floors the mean of two middles for even counts", () => {
    expect(medianInt([1, 2, 3, 4])).toBe(2);
  });

  it("rejects an empty input", () => {
    expect(() => medianInt([])).toThrow(/empty/);
  });
});
