/**
 * Deterministic test kit for the suggestions engine.
 *
 * No `Math.random`, no `Date.now`, no network: fixtures use a seeded PRNG and fixed unix timestamps.
 */
import { parseAmount } from "../amount.ts";
import type { HistoryRecord, SuggestContext } from "../types.ts";

export const DAY = 86400;
/** Fixed "now" in unix seconds (2023-11-14T22:13:20Z). */
export const NOW = 1_700_000_000;
export const ASSET = "USDC";
export const DECIMALS = 7;

/** Deterministic pseudo-address, e.g. `addr(3) -> "GADDR0000000000000000000000000000000000000000000000000003"`. */
export function addr(index: number): string {
  return `GADDR${String(index).padStart(3, "0")}`;
}

/** Raw units for a display amount, e.g. `raw("18.4") === 184000000n`. */
export function raw(display: string, decimals: number = DECIMALS): bigint {
  return parseAmount(display, decimals);
}

let sequence = 0;

/** Build a history record with sensible defaults; pass explicit `id`s in fixtures that need determinism. */
export function rec(overrides: Partial<HistoryRecord> = {}): HistoryRecord {
  sequence += 1;
  const record: HistoryRecord = {
    id: overrides.id ?? `h${sequence}`,
    ts: overrides.ts ?? NOW - DAY,
    recipientAddress: overrides.recipientAddress ?? addr(sequence),
    asset: overrides.asset ?? ASSET,
    amountRaw: overrides.amountRaw ?? raw("10"),
    mode: overrides.mode ?? "public",
    route: overrides.route ?? "direct",
    status: overrides.status ?? "confirmed",
  };
  if (overrides.recipientAlias !== undefined) record.recipientAlias = overrides.recipientAlias;
  return record;
}

/** Build a context with test defaults. */
export function ctx(overrides: Partial<SuggestContext> = {}): SuggestContext {
  return {
    now: NOW,
    timeZone: "UTC",
    autoPayEnabled: false,
    knownContacts: new Set<string>(),
    dismissed: new Set<string>(),
    assetDecimals: DECIMALS,
    displayAsset: ASSET,
    ...overrides,
  };
}

/**
 * Simple, fully specified linear-congruential PRNG (Numerical Recipes LCG). Deterministic for a
 * given seed; used only to generate *test fixtures*, never in production code.
 */
export function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

/** Integer in `[min, max]` from a seeded PRNG. */
export function randInt(rng: () => number, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

export interface WorkedExample {
  history: HistoryRecord[];
  contacts: Set<string>;
}

/**
 * The exact `docs/approval-and-scheduling.md` §6.8 worked example: 14 payments in the last 30 days,
 * median 9.5, p90 18.4, max 22, p95 daily total 38 (one day holds 16 + 22 = 38).
 */
export function workedExampleHistory(): WorkedExample {
  // [amount, day offset, recipient index]
  const specs: Array<[string, number, number]> = [
    ["1", 1, 0],
    ["2", 2, 1],
    ["3", 3, 2],
    ["5", 5, 3],
    ["7", 7, 4],
    ["8", 8, 5],
    ["9", 9, 6],
    ["10", 11, 7],
    ["12", 12, 8],
    ["13", 13, 9],
    ["15", 14, 10],
    ["18.4", 15, 11],
    ["16", 10, 12],
    ["22", 10, 13],
  ];
  const contacts = new Set<string>();
  const history = specs.map(([amount, offset, index], position) => {
    const recipientAddress = addr(index);
    contacts.add(recipientAddress);
    return rec({
      id: `w${String(position).padStart(2, "0")}`,
      ts: NOW - offset * DAY,
      recipientAddress,
      amountRaw: raw(amount),
    });
  });
  return { history, contacts };
}

/**
 * A generic "enough history" pool: `count` confirmed public payments on consecutive distinct days,
 * all to distinct recipients, each with the same amount unless overridden.
 */
export function pool(count: number, amountDisplay = "10", startDayOffset = 1): HistoryRecord[] {
  return Array.from({ length: count }, (_, index) =>
    rec({
      id: `p${String(index).padStart(2, "0")}`,
      ts: NOW - (startDayOffset + index) * DAY,
      recipientAddress: addr(index),
      amountRaw: raw(amountDisplay),
    }),
  );
}

/** Every address used by a history array (for privacy-leak assertions). */
export function addressesOf(history: readonly HistoryRecord[]): string[] {
  return [...new Set(history.map((record) => record.recipientAddress))];
}

/** Every alias used by a history array. */
export function aliasesOf(history: readonly HistoryRecord[]): string[] {
  return history.flatMap((record) => (record.recipientAlias === undefined ? [] : [record.recipientAlias]));
}
