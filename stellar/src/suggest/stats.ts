/**
 * Pure statistics over payment history.
 *
 * Only the caller decides which records are eligible (confirmed + public + asset); these helpers do
 * not filter. Amounts stay `bigint` throughout.
 */
import { DAY_SECONDS } from "./constants.ts";
import type { HistoryRecord } from "./types.ts";

/** Ascending copy; never mutates the input. */
export function sortBigints(values: readonly bigint[]): bigint[] {
  return [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Nearest-rank percentile (the documented method): for `n` sorted values and integer percentile
 * `p` in `(0, 100]`, `rank = ceil(p * n / 100)` (1-based) and the result is the value at
 * `rank - 1`. For `n = 1` the single value is returned. Ties are kept as-is (no interpolation).
 */
export function percentileNearestRank(sortedAsc: readonly bigint[], percentile: number): bigint {
  if (sortedAsc.length === 0) throw new Error("percentileNearestRank: empty input");
  if (!Number.isInteger(percentile) || percentile <= 0 || percentile > 100) {
    throw new Error(`percentileNearestRank: percentile must be an integer in (0, 100], got ${percentile}`);
  }
  const rank = Math.floor((percentile * sortedAsc.length + 99) / 100);
  const index = Math.min(Math.max(rank, 1), sortedAsc.length) - 1;
  return sortedAsc[index] as bigint;
}

/** Classic median: middle value for odd `n`, integer mean of the two middles for even `n`. */
export function median(sortedAsc: readonly bigint[]): bigint {
  if (sortedAsc.length === 0) throw new Error("median: empty input");
  const middle = sortedAsc.length >> 1;
  if (sortedAsc.length % 2 === 1) return sortedAsc[middle] as bigint;
  return ((sortedAsc[middle - 1] as bigint) + (sortedAsc[middle] as bigint)) / 2n;
}

/** Maximum of a non-empty list (sorted or not). */
export function maxOf(values: readonly bigint[]): bigint {
  if (values.length === 0) throw new Error("maxOf: empty input");
  let out = values[0] as bigint;
  for (const value of values) if (value > out) out = value;
  return out;
}

const dayFormatters = new Map<string, Intl.DateTimeFormat>();

function dayFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = dayFormatters.get(timeZone);
  if (!formatter) {
    // `formatToParts` is used (not `format`) so the key is independent of locale punctuation.
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    dayFormatters.set(timeZone, formatter);
  }
  return formatter;
}

/**
 * DST-safe local calendar day key (`YYYY-MM-DD`) for a unix-seconds timestamp in `timeZone`.
 * `Intl` resolves the zone (including half-hour offsets and DST transitions), so no manual offset
 * arithmetic is done here.
 */
export function localDayKey(unixSeconds: number, timeZone: string): string {
  const parts = dayFormatter(timeZone).formatToParts(new Date(unixSeconds * 1000));
  let year = "";
  let month = "";
  let day = "";
  for (const part of parts) {
    if (part.type === "year") year = part.value;
    else if (part.type === "month") month = part.value;
    else if (part.type === "day") day = part.value;
  }
  return `${year}-${month}-${day}`;
}

/** Sum of raw amounts per local day; only days with at least one record appear. Sorted ascending. */
export function dailyTotals(records: readonly HistoryRecord[], timeZone: string): bigint[] {
  const byDay = new Map<string, bigint>();
  for (const record of records) {
    const key = localDayKey(record.ts, timeZone);
    byDay.set(key, (byDay.get(key) ?? 0n) + record.amountRaw);
  }
  return sortBigints([...byDay.values()]);
}

/** Whole days between the earliest and latest record timestamp (floored), 0 for <2 records. */
export function spanDays(records: readonly HistoryRecord[]): number {
  if (records.length < 2) return 0;
  let min = records[0]?.ts ?? 0;
  let max = min;
  for (const record of records) {
    if (record.ts < min) min = record.ts;
    if (record.ts > max) max = record.ts;
  }
  return Math.floor((max - min) / DAY_SECONDS);
}

/** Count of records per recipient address. */
export function recipientFrequency(records: readonly HistoryRecord[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const record of records) {
    counts.set(record.recipientAddress, (counts.get(record.recipientAddress) ?? 0) + 1);
  }
  return counts;
}

/**
 * Drop amounts strictly greater than `multiplier × median` from a sorted-ascending amount list (B1).
 *
 * The median is robust to a small number of large outliers, so this yields the pool used to derive
 * the auto-pay threshold and the unusual-payment baseline. For `multiplier >= 1` the median itself
 * always survives, so the result is never empty for a non-empty input. Only the values are
 * filtered; callers must still require a minimum remaining count.
 *
 * Known limit (deliberate): once MORE than half the records are "outliers" the median itself is
 * contaminated and nothing is excluded, so the "robust" pool equals the full pool. At that point the
 * large amounts are the normal spend, so proposing them is defensible; the roundUp5(max) bound still
 * holds because it is derived from the returned pool.
 */
export function dropAmountOutliers(sortedAsc: readonly bigint[], multiplier: number): bigint[] {
  if (sortedAsc.length === 0) throw new Error("dropAmountOutliers: empty input");
  if (!Number.isInteger(multiplier) || multiplier < 1) {
    throw new Error(`dropAmountOutliers: multiplier must be an integer >= 1, got ${multiplier}`);
  }
  const cutoff = BigInt(multiplier) * median(sortedAsc);
  return sortedAsc.filter((value) => value <= cutoff);
}

/** Integer median (used for recurrence intervals in seconds). */
export function medianInt(values: readonly number[]): number {
  if (values.length === 0) throw new Error("medianInt: empty input");
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  if (sorted.length % 2 === 1) return sorted[middle] as number;
  return Math.floor(((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2);
}
