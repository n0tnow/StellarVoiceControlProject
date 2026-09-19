/**
 * The deterministic suggestions engine.
 *
 * `suggest(history, context, options) -> Suggestion[]` is **pure**: it never touches the network, a
 * clock, randomness or the filesystem, and it never applies anything (D11). It becomes a draft that
 * the UI hands to the normal read-back + approval-card flow.
 *
 * See `docs/approval-and-scheduling.md` §6 (kinds/worked example) and §11 (PROPOSED defaults), and
 * `docs/interfaces.md` §6.1 for the seam shapes.
 */
import {
  CONFIDENCE_HIGH_MIN_PAYMENTS,
  CONFIDENCE_HIGH_MIN_SPAN_DAYS,
  CONFIDENCE_MEDIUM_MIN_PAYMENTS,
  DAILY_LIMIT_MIN_ACTIVE_DAYS,
  DAILY_LIMIT_MULTIPLIER_DEN,
  DAILY_LIMIT_MULTIPLIER_NUM,
  DEFAULT_ASSET_DECIMALS,
  DEFAULT_MIN_PAYMENTS,
  DEFAULT_MIN_SPAN_DAYS,
  DEFAULT_SCHEDULE_RUNS,
  DEFAULT_WINDOW_DAYS,
  DORMANT_DAYS,
  MAX_FIRST_RUN_ADVANCE_STEPS,
  RECURRENCE_AMOUNT_TOLERANCE_PCT,
  RECURRENCE_CONFIDENCE_HIGH_OCCURRENCES,
  RECURRENCE_CONFIDENCE_MEDIUM_OCCURRENCES,
  RECURRENCE_MAX_INTERVAL_JITTER_PCT,
  RECURRENCE_MIN_OCCURRENCES,
  ROUNDING_STEP_DISPLAY,
  UNUSUAL_MULTIPLIER,
  UNUSUAL_WINDOW_DAYS,
  DAY_SECONDS,
} from "./constants.ts";
import { formatAmount, mulDivCeil, parseAmount, roundUpToDisplayMultiple } from "./amount.ts";
import {
  dailyTotals,
  dropAmountOutliers,
  maxOf,
  median,
  medianInt,
  percentileNearestRank,
  sortBigints,
  spanDays,
} from "./stats.ts";
import type {
  Confidence,
  HistoryRecord,
  LlmSafeSuggestion,
  NoSuggestionsExplanation,
  RuleDraft,
  ScheduleDraft,
  SuggestContext,
  SuggestOptions,
  Suggestion,
  SuggestionChange,
  SuggestionKind,
} from "./types.ts";

/**
 * Typed input error. Thrown **only** by the explicit `validateSuggestContext` validator; `suggest()`
 * itself is defensive and never throws on a malformed rule string (B2/hygiene).
 */
export class SuggestInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SuggestInputError";
  }
}

/** Parse an optional decimal rule string without throwing; `undefined` = absent, `null` = malformed. */
function tryParseAmount(display: string | undefined, decimals: number): bigint | null | undefined {
  if (display === undefined) return undefined;
  try {
    return parseAmount(display, decimals);
  } catch {
    return null;
  }
}

/**
 * Explicit input validator for a trust boundary. `suggest()` tolerates malformed rule strings by
 * dropping the affected suggestion; call this when you want to fail loudly instead.
 */
export function validateSuggestContext(context: SuggestContext): void {
  const decimals = context.assetDecimals ?? DEFAULT_ASSET_DECIMALS;
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 100) {
    throw new SuggestInputError(`invalid assetDecimals: ${decimals}`);
  }
  const rule = context.rule;
  if (!rule) return;
  const keys = ["autoApproveLimit", "perTxLimit", "dailyLimit"] as const;
  for (const key of keys) {
    const value = rule[key];
    if (value === undefined) continue;
    if (tryParseAmount(value, decimals) === null) {
      throw new SuggestInputError(`invalid rule.${key}: ${JSON.stringify(value)}`);
    }
  }
}

interface Resolved {
  windowDays: number;
  minPayments: number;
  minSpanDays: number;
  decimals: number;
}

interface GuardResult {
  /** Confirmed + public + in-window + displayAsset records. */
  records: HistoryRecord[];
  count: number;
  spanDays: number;
  enough: boolean;
}

function resolve(context: SuggestContext, options?: SuggestOptions): Resolved {
  return {
    windowDays: options?.windowDays ?? DEFAULT_WINDOW_DAYS,
    minPayments: options?.minPayments ?? DEFAULT_MIN_PAYMENTS,
    minSpanDays: options?.minSpanDays ?? DEFAULT_MIN_SPAN_DAYS,
    decimals: context.assetDecimals ?? DEFAULT_ASSET_DECIMALS,
  };
}

/**
 * Apply the window and the eligible-record rules: `confirmed` only, `public` only (confidential
 * amounts are invisible to the guard and cannot be analysed — see §8.1), and only the rule's single
 * asset (`docs/approval-and-scheduling.md` §2 "one asset per rule").
 */
function guard(history: readonly HistoryRecord[], context: SuggestContext, resolved: Resolved): GuardResult {
  const start = context.now - resolved.windowDays * DAY_SECONDS;
  // Defensive hygiene: the history reader may merge local + chain sources and see the same record
  // twice. Keep the first occurrence of each `id` so counts/percentiles are not inflated.
  const seen = new Set<string>();
  const deduped: HistoryRecord[] = [];
  for (const record of history) {
    if (seen.has(record.id)) continue;
    seen.add(record.id);
    deduped.push(record);
  }
  const records = deduped.filter(
    (record) =>
      record.status === "confirmed" &&
      record.mode === "public" &&
      record.asset === context.displayAsset &&
      record.ts >= start &&
      record.ts <= context.now,
  );
  const span = spanDays(records);
  return {
    records,
    count: records.length,
    spanDays: span,
    enough: records.length >= resolved.minPayments && span >= resolved.minSpanDays,
  };
}

/**
 * Explain why the engine would return nothing. Returns `null` when there **is** enough history (the
 * engine may still return `[]` because every suggestion is dismissed, for example).
 */
export function explainNoSuggestions(
  history: readonly HistoryRecord[],
  context: SuggestContext,
  options?: SuggestOptions,
): NoSuggestionsExplanation | null {
  const resolved = resolve(context, options);
  const result = guard(history, context, resolved);
  if (result.enough) return null;
  return {
    reason: "not_enough_history",
    count: result.count,
    minPayments: resolved.minPayments,
    spanDays: result.spanDays,
    minSpanDays: resolved.minSpanDays,
    windowDays: resolved.windowDays,
  };
}

function confidenceFor(count: number, span: number): Confidence {
  if (count >= CONFIDENCE_HIGH_MIN_PAYMENTS && span >= CONFIDENCE_HIGH_MIN_SPAN_DAYS) return "high";
  if (count >= CONFIDENCE_MEDIUM_MIN_PAYMENTS) return "medium";
  return "low";
}

function recurrenceConfidence(occurrences: number): Confidence {
  if (occurrences >= RECURRENCE_CONFIDENCE_HIGH_OCCURRENCES) return "high";
  if (occurrences >= RECURRENCE_CONFIDENCE_MEDIUM_OCCURRENCES) return "medium";
  return "low";
}

interface AmountStats {
  count: number;
  median: string;
  p90: string;
  max: string;
  p90Raw: bigint;
  maxRaw: bigint;
}

function amountStatsFromSorted(amounts: readonly bigint[], decimals: number): AmountStats {
  return {
    count: amounts.length,
    median: formatAmount(median(amounts), decimals),
    p90: formatAmount(percentileNearestRank(amounts, 90), decimals),
    max: formatAmount(maxOf(amounts), decimals),
    p90Raw: percentileNearestRank(amounts, 90),
    maxRaw: maxOf(amounts),
  };
}

function amountStats(records: readonly HistoryRecord[], decimals: number): AmountStats {
  return amountStatsFromSorted(sortBigints(records.map((record) => record.amountRaw)), decimals);
}

/**
 * Auto-pay threshold pool. §6.3 describes "payments to known contacts"; when the caller has no
 * saved contacts yet (`knownContacts` empty) there is nothing to restrict to, so all eligible
 * public recipients are considered.
 */
function thresholdPool(records: readonly HistoryRecord[], context: SuggestContext): HistoryRecord[] {
  if (context.knownContacts.size === 0) return [...records];
  return records.filter((record) => context.knownContacts.has(record.recipientAddress));
}

/**
 * A suggestion carrying the base aggregate stats, so every evidence object satisfies the seam shape
 * (`median`, `p90`, `max`, `count`, `windowDays`) even when the kind adds more fields.
 */
function baseEvidence(
  resolved: Resolved,
  stats: AmountStats,
): Suggestion["evidence"] {
  return {
    windowDays: resolved.windowDays,
    count: stats.count,
    median: stats.median,
    p90: stats.p90,
    max: stats.max,
  };
}

interface ThresholdComputation {
  proposedRaw: bigint;
  capped: boolean;
  capDisplay: string;
}

/**
 * Shared auto-approve-threshold computation (used by both `auto_pay_threshold` and the
 * `daily_limit` draft's required `autoApproveLimit`). Rounds `p90Raw` UP to the display step, never
 * above the rounded-up maximum observed, then clamps to `rule.perTxLimit` when present (B2).
 * Returns `null` when the rule cap is zero/negative or malformed.
 */
function computeAutoApproveThreshold(
  p90Raw: bigint,
  maxRaw: bigint,
  context: SuggestContext,
  decimals: number,
): ThresholdComputation | null {
  let proposedRaw = roundUpToDisplayMultiple(p90Raw, decimals, ROUNDING_STEP_DISPLAY);
  // Guard: never propose more than the maximum observed payment, rounded up by one step.
  const roundedMax = roundUpToDisplayMultiple(maxRaw, decimals, ROUNDING_STEP_DISPLAY);
  if (proposedRaw > roundedMax) proposedRaw = roundedMax;

  let capped = false;
  let capDisplay = "";
  if (context.rule?.perTxLimit !== undefined) {
    const capRaw = tryParseAmount(context.rule.perTxLimit, decimals);
    if (capRaw === null || capRaw === undefined || capRaw <= 0n) return null;
    capDisplay = formatAmount(capRaw, decimals);
    if (proposedRaw > capRaw) {
      proposedRaw = capRaw;
      capped = true;
    }
  }
  return { proposedRaw, capped, capDisplay };
}

/**
 * Pure check of the contract rule ordering `0 <= autoApproveLimit <= perTxLimit <= dailyLimit`.
 * When `perTxLimit` is absent the `dailyLimit` (if present) must still be `>= autoApproveLimit`.
 * A draft that cannot satisfy the ordering is dropped rather than proposed (B2).
 */
function isRuleDraftOrdered(draft: RuleDraft, decimals: number): boolean {
  const autoApprove = tryParseAmount(draft.autoApproveLimit, decimals);
  if (autoApprove === null || autoApprove === undefined || autoApprove < 0n) return false;
  const perTx = tryParseAmount(draft.perTxLimit, decimals);
  if (perTx === null || (perTx !== undefined && perTx < 0n)) return false;
  const daily = tryParseAmount(draft.dailyLimit, decimals);
  if (daily === null || (daily !== undefined && daily < 0n)) return false;
  if (perTx !== undefined && autoApprove > perTx) return false;
  if (daily !== undefined) {
    if (perTx !== undefined) {
      if (daily < perTx) return false;
    } else if (daily < autoApprove) {
      return false;
    }
  }
  return true;
}

interface RobustThreshold {
  /** Sorted, outlier-robust amount pool — the single source of truth for a proposed threshold. */
  pool: bigint[];
  /** Proposed auto-approve threshold in raw units (rounded up, clamped to `rule.perTxLimit`). */
  thresholdRaw: bigint;
  /** True when `thresholdRaw` was clamped down to an existing `rule.perTxLimit`. */
  capped: boolean;
  /** Display string of the existing per-tx cap when `capped`; `""` otherwise. */
  capDisplay: string;
  /** Aggregate statistics over `pool` (used for evidence and the rationale). */
  stats: AmountStats;
}

/**
 * Single source of truth for the auto-approve threshold (B1). Builds the outlier-robust pool
 * (median-based exclusion, `UNUSUAL_MULTIPLIER × median`), requires `minPayments` to survive, then
 * rounds up and clamps via `computeAutoApproveThreshold`.
 *
 * BOTH `auto_pay_threshold` and the required `autoApproveLimit` fallback of `daily_limit` call this,
 * so the daily draft can never be derived from the full (non-robust) pool again.
 */
function deriveRobustThreshold(
  records: readonly HistoryRecord[],
  context: SuggestContext,
  resolved: Resolved,
): RobustThreshold | null {
  const pool = thresholdPool(records, context);
  if (pool.length === 0) return null;
  const amounts = sortBigints(pool.map((record) => record.amountRaw));
  const robustAmounts = dropAmountOutliers(amounts, UNUSUAL_MULTIPLIER);
  if (robustAmounts.length < resolved.minPayments) return null;
  const stats = amountStatsFromSorted(robustAmounts, resolved.decimals);
  if (stats.p90Raw <= 0n) return null;
  const computation = computeAutoApproveThreshold(stats.p90Raw, stats.maxRaw, context, resolved.decimals);
  if (!computation) return null;
  return {
    pool: robustAmounts,
    thresholdRaw: computation.proposedRaw,
    capped: computation.capped,
    capDisplay: computation.capDisplay,
    stats,
  };
}

function autoPayThresholdSuggestion(
  result: GuardResult,
  context: SuggestContext,
  resolved: Resolved,
): Suggestion | null {
  // B1: derive the threshold from an outlier-robust pool. The median is robust, so amounts above
  // `UNUSUAL_MULTIPLIER × median` are dropped BEFORE the p90 is taken. A single outlier can no
  // longer become the auto-approve threshold, and a small sample cannot silently auto-approve it.
  const derivation = deriveRobustThreshold(result.records, context, resolved);
  if (!derivation) return null;
  const { stats, thresholdRaw, capped, capDisplay } = derivation;
  const p90Raw = stats.p90Raw;

  if (context.autoPayEnabled && context.rule?.autoApproveLimit !== undefined) {
    const currentRaw = tryParseAmount(context.rule.autoApproveLimit, resolved.decimals);
    if (currentRaw === null) return null;
    if (currentRaw !== undefined && currentRaw >= p90Raw) return null; // already covers p90
  }

  const proposedDisplay = formatAmount(thresholdRaw, resolved.decimals);
  const count = stats.count;
  const windowDays = resolved.windowDays;
  const contactPhrase =
    context.knownContacts.size > 0 ? `${count} payments to saved contacts` : `${count} payments`;
  let rationale =
    `Over the last ${windowDays} days you sent ${contactPhrase}, all under ${proposedDisplay} ` +
    `${context.displayAsset} (median ${stats.median}, ` +
    `p90 ${stats.p90}). Allow automatic payments up to ` +
    `${proposedDisplay} ${context.displayAsset}?`;
  if (capped) {
    rationale += ` Capped at your existing on-chain per-transaction limit of ${capDisplay} ${context.displayAsset}.`;
  } else if (context.rule?.perTxLimit === undefined) {
    rationale += ` No on-chain per-transaction cap is set yet, so this would create one.`;
  }

  const draft: RuleDraft = {
    autoApproveLimit: proposedDisplay,
    assets: [context.displayAsset],
    knownRecipientsOnly: true,
    source: `suggested from the last ${windowDays} days of payments`,
  };
  if (context.rule?.perTxLimit === undefined) draft.perTxLimit = proposedDisplay;
  if (!isRuleDraftOrdered(draft, resolved.decimals)) return null;

  return {
    id: `auto_pay_threshold:${context.displayAsset}:${proposedDisplay}`,
    kind: "auto_pay_threshold",
    title: `Allow auto-pay up to ${proposedDisplay} ${context.displayAsset}`,
    rationale,
    evidence: baseEvidence(resolved, stats),
    proposedChange: draft,
    confidence: confidenceFor(count, result.spanDays),
  };
}

function dailyLimitSuggestion(
  result: GuardResult,
  context: SuggestContext,
  resolved: Resolved,
): Suggestion | null {
  const totals = dailyTotals(result.records, context.timeZone);
  if (totals.length < DAILY_LIMIT_MIN_ACTIVE_DAYS) return null;
  const p95 = percentileNearestRank(totals, 95);
  if (p95 <= 0n) return null;
  const dailyMax = maxOf(totals);
  const dailyMedian = median(totals);
  const target = mulDivCeil(p95, BigInt(DAILY_LIMIT_MULTIPLIER_NUM), BigInt(DAILY_LIMIT_MULTIPLIER_DEN));
  const proposedRaw = roundUpToDisplayMultiple(target, resolved.decimals, ROUNDING_STEP_DISPLAY);

  if (context.rule?.dailyLimit !== undefined) {
    const currentRaw = tryParseAmount(context.rule.dailyLimit, resolved.decimals);
    if (currentRaw === null) return null;
    if (currentRaw !== undefined && currentRaw === proposedRaw) return null;
  }

  const proposedDisplay = formatAmount(proposedRaw, resolved.decimals);
  const p95Display = formatAmount(p95, resolved.decimals);
  // Evidence stays full-pool: `daily_limit` deliberately includes every confirmed public day (an
  // exceptional day is still a real spend), so `dailyMedian`/`p95DailyTotal`/`dailyMax` are not
  // outlier-filtered. The auto-approve fallback below IS outlier-robust (B1-residual).
  const stats = amountStats(result.records, resolved.decimals);
  const evidence = baseEvidence(resolved, stats);
  evidence.p95DailyTotal = p95Display;
  evidence.dailyMedian = formatAmount(dailyMedian, resolved.decimals);
  evidence.dailyMax = formatAmount(dailyMax, resolved.decimals);

  // `RuleDraft.autoApproveLimit` is required by the seam. This suggestion only changes the daily
  // mandate, so keep the rule's existing threshold, or fall back to the SAME outlier-robust
  // derivation used by `auto_pay_threshold` (B1-residual), clamped to the rule's per-tx limit so the
  // draft can never violate `autoApproveLimit <= perTxLimit`.
  let autoApproveLimit: string;
  let fallbackCapped = false;
  let fallbackCapDisplay = "";
  if (context.rule?.autoApproveLimit !== undefined) {
    const currentRaw = tryParseAmount(context.rule.autoApproveLimit, resolved.decimals);
    if (currentRaw === null || currentRaw === undefined || currentRaw < 0n) return null;
    autoApproveLimit = context.rule.autoApproveLimit;
  } else {
    const derivation = deriveRobustThreshold(result.records, context, resolved);
    if (!derivation) return null;
    autoApproveLimit = formatAmount(derivation.thresholdRaw, resolved.decimals);
    fallbackCapped = derivation.capped;
    fallbackCapDisplay = derivation.capDisplay;
  }
  const draft: RuleDraft = {
    autoApproveLimit,
    dailyLimit: proposedDisplay,
    assets: [context.displayAsset],
    knownRecipientsOnly: true,
    source: `suggested from the last ${resolved.windowDays} days of daily totals`,
  };
  // Carry an existing per-tx cap so accepting the draft cannot silently drop it (B2).
  if (context.rule?.perTxLimit !== undefined) draft.perTxLimit = context.rule.perTxLimit;
  if (!isRuleDraftOrdered(draft, resolved.decimals)) return null;

  let rationale =
    `Over the last ${resolved.windowDays} days your busiest typical day reached ${p95Display} ` +
    `${context.displayAsset} (p95), so a daily limit of ${proposedDisplay} ${context.displayAsset} ` +
    `(1.5× with headroom) keeps auto-pay bounded. This is the agent's real daily mandate.`;
  if (fallbackCapped) {
    rationale += ` The auto-pay threshold is capped at your existing on-chain per-transaction limit of ${fallbackCapDisplay} ${context.displayAsset}.`;
  }

  return {
    id: `daily_limit:${context.displayAsset}:${proposedDisplay}`,
    kind: "daily_limit",
    title: `Set a daily limit of ${proposedDisplay} ${context.displayAsset}`,
    rationale,
    evidence,
    proposedChange: draft,
    confidence: confidenceFor(stats.count, result.spanDays),
  };
}

function groupByRecipient(records: readonly HistoryRecord[]): Map<string, HistoryRecord[]> {
  const groups = new Map<string, HistoryRecord[]>();
  for (const record of records) {
    const list = groups.get(record.recipientAddress);
    if (list) list.push(record);
    else groups.set(record.recipientAddress, [record]);
  }
  return groups;
}

function byTimestampThenId(a: HistoryRecord, b: HistoryRecord): number {
  if (a.ts !== b.ts) return a.ts - b.ts;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * First regular run strictly AFTER `now` (B3). Starts at `lastTs + interval` and advances by whole
 * intervals; the loop is bounded and falls back to direct arithmetic for pathological intervals
 * (e.g. a one-second cadence observed long ago).
 */
function advanceFirstRunAt(lastTs: number, interval: number, now: number): number {
  let firstRunAt = lastTs + interval;
  let steps = 0;
  while (firstRunAt <= now && steps < MAX_FIRST_RUN_ADVANCE_STEPS) {
    firstRunAt += interval;
    steps += 1;
  }
  if (firstRunAt <= now) {
    const needed = Math.floor((now - lastTs) / interval) + 1;
    firstRunAt = lastTs + needed * interval;
  }
  return firstRunAt;
}

function scheduleSuggestion(
  address: string,
  group: readonly HistoryRecord[],
  context: SuggestContext,
  resolved: Resolved,
  overallCount: number,
): Suggestion | null {
  if (group.length < RECURRENCE_MIN_OCCURRENCES) return null;
  const sorted = [...group].sort(byTimestampThenId);

  const intervals: number[] = [];
  for (let index = 1; index < sorted.length; index += 1) {
    intervals.push((sorted[index] as HistoryRecord).ts - (sorted[index - 1] as HistoryRecord).ts);
  }
  const minInterval = Math.min(...intervals);
  const maxInterval = Math.max(...intervals);
  const sumIntervals = intervals.reduce((sum, value) => sum + value, 0);
  if (sumIntervals <= 0) return null;
  // Integer jitter test: (max - min) / mean <= pct/100  ⇔  (max - min) * n * 100 <= sum * pct.
  if (
    (maxInterval - minInterval) * intervals.length * 100 >
    sumIntervals * RECURRENCE_MAX_INTERVAL_JITTER_PCT
  ) {
    return null;
  }

  const amounts = sortBigints(sorted.map((record) => record.amountRaw));
  const minAmount = amounts[0] as bigint;
  const maxAmount = amounts[amounts.length - 1] as bigint;
  const medianAmount = median(amounts);
  // A zero (or negative) amount is not a payable schedule; never propose a "0" draft.
  if (medianAmount <= 0n) return null;
  if ((maxAmount - minAmount) * 100n > BigInt(RECURRENCE_AMOUNT_TOLERANCE_PCT) * medianAmount) {
    return null;
  }

  const proposedInterval = medianInt(intervals);
  if (proposedInterval <= 0) return null;
  const amountDisplay = formatAmount(medianAmount, resolved.decimals);
  const runs = DEFAULT_SCHEDULE_RUNS;
  const lastTs = (sorted[sorted.length - 1] as HistoryRecord).ts;
  const firstRunAt = advanceFirstRunAt(lastTs, proposedInterval, context.now);
  const alias = sorted.find((record) => record.recipientAlias)?.recipientAlias;
  const label = alias ?? address;
  const cadenceDays = proposedInterval / DAY_SECONDS;

  const draft: ScheduleDraft = {
    recipient: address,
    asset: context.displayAsset,
    amount: amountDisplay,
    firstRunAt,
    intervalSecs: proposedInterval,
    runs,
    source: `suggested from ${sorted.length} similar payments`,
  };
  if (alias !== undefined) draft.recipientAlias = alias;

  return {
    id: `schedule_from_recurrence:${context.displayAsset}:${address}`,
    kind: "schedule_from_recurrence",
    title: `Create a recurring payment to ${label}`,
    rationale:
      `You sent ${sorted.length} similar payments of about ${amountDisplay} ${context.displayAsset} ` +
      `to ${label} every ~${cadenceDays.toFixed(1)} days. Create a schedule with ` +
      `${runs} future runs instead of paying manually?`,
    evidence: {
      windowDays: resolved.windowDays,
      count: overallCount,
      median: formatAmount(medianAmount, resolved.decimals),
      p90: formatAmount(percentileNearestRank(amounts, 90), resolved.decimals),
      max: formatAmount(maxAmount, resolved.decimals),
      occurrences: sorted.length,
      intervalSecs: proposedInterval,
      intervalDays: cadenceDays,
      amount: amountDisplay,
    },
    proposedChange: draft,
    confidence: recurrenceConfidence(sorted.length),
  };
}

function recurrenceSuggestions(
  result: GuardResult,
  context: SuggestContext,
  resolved: Resolved,
): Suggestion[] {
  const groups = groupByRecipient(result.records);
  const addresses = [...groups.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const suggestions: Suggestion[] = [];
  for (const address of addresses) {
    const suggestion = scheduleSuggestion(
      address,
      groups.get(address) as HistoryRecord[],
      context,
      resolved,
      result.count,
    );
    if (suggestion) suggestions.push(suggestion);
  }
  return suggestions;
}

function dormantSuggestion(
  result: GuardResult,
  context: SuggestContext,
  resolved: Resolved,
): Suggestion | null {
  if (!context.autoPayEnabled) return null;

  // Visible `pay_executor` usage, plus the caller's `lastAutoPayUse` hint (confidential auto-pay
  // usage is invisible to the engine, so the hint is the only way to avoid over-firing). The most
  // recent of the two is the conservative "last used" value.
  const used = result.records.filter((record) => record.route === "pay_executor");
  const historyLastUsed = used.length > 0 ? Math.max(...used.map((record) => record.ts)) : undefined;
  const lastUsedTs =
    historyLastUsed !== undefined && context.lastAutoPayUse !== undefined
      ? Math.max(historyLastUsed, context.lastAutoPayUse)
      : historyLastUsed ?? context.lastAutoPayUse;

  const enabledSince = context.autoPayEnabledSince;
  const enabledDays =
    enabledSince === undefined ? undefined : Math.floor((context.now - enabledSince) / DAY_SECONDS);

  const neverUsed = lastUsedTs === undefined;
  let unusedDays: number;
  if (neverUsed) {
    // Conservative (B1/non-blocking): without `autoPayEnabledSince` the engine cannot distinguish
    // "just enabled" from "idle 31 days", so it does NOT claim auto-pay was never used.
    if (enabledSince === undefined || enabledDays === undefined) return null;
    if (enabledDays <= DORMANT_DAYS) return null;
    unusedDays = enabledDays;
  } else {
    unusedDays = Math.floor((context.now - lastUsedTs) / DAY_SECONDS);
    if (unusedDays <= DORMANT_DAYS) return null;
    // If we know when auto-pay was enabled, it must also have been on long enough to be "dormant".
    if (enabledDays !== undefined && enabledDays <= DORMANT_DAYS) return null;
  }

  const stats = amountStats(result.records, resolved.decimals);
  const evidence = baseEvidence(resolved, stats);
  evidence.unusedDays = unusedDays;
  if (!neverUsed) evidence.lastUsedDays = unusedDays;

  return {
    id: `tighten_dormant:${context.displayAsset}`,
    kind: "tighten_dormant",
    title: `Turn off auto-pay for ${context.displayAsset}?`,
    rationale: neverUsed
      ? `Auto-pay has been on for ${unusedDays} days but no automatic (pay_executor) payment was ` +
        `used in that period. Revoking the executor reduces risk.`
      : `Auto-pay is on but has not been used for ${unusedDays} days ` +
        `(threshold ${DORMANT_DAYS} days). Consider revoking the executor.`,
    evidence,
    proposedChange: { kind: "disable_auto_pay", confirmation: "light" },
    confidence: stats.count >= CONFIDENCE_MEDIUM_MIN_PAYMENTS ? "medium" : "low",
  };
}

function unusualSuggestions(
  result: GuardResult,
  context: SuggestContext,
  resolved: Resolved,
): Suggestion[] {
  if (result.records.length === 0) return [];
  const amounts = sortBigints(result.records.map((record) => record.amountRaw));
  // B1: compare against an outlier-robust baseline. The outlier itself is excluded from the
  // baseline pool (median-based exclusion), so it can no longer hide inside the p90 it is compared
  // against — this makes the alert fire for the 9-record 8×10 + 1×1000 fixture.
  const baselineAmounts = dropAmountOutliers(amounts, UNUSUAL_MULTIPLIER);
  const baselineRaw = percentileNearestRank(baselineAmounts, 90);
  if (baselineRaw <= 0n) return [];
  const cutoff = context.now - UNUSUAL_WINDOW_DAYS * DAY_SECONDS;
  const thresholdRaw = BigInt(UNUSUAL_MULTIPLIER) * baselineRaw;
  const unusual = result.records
    .filter((record) => record.ts >= cutoff && record.amountRaw > thresholdRaw)
    .sort(byTimestampThenId);

  return unusual.map((record) => {
    const amountDisplay = formatAmount(record.amountRaw, resolved.decimals);
    // Ratio with one decimal, computed in integers (tenths).
    const ratioTenths = (record.amountRaw * 10n) / baselineRaw;
    const ratio = `${ratioTenths / 10n}.${ratioTenths % 10n}`;
    return {
      id: `unusual_payment_alert:${context.displayAsset}:${record.id}`,
      kind: "unusual_payment_alert",
      title: `Unusual payment of ${amountDisplay} ${context.displayAsset}`,
      rationale:
        `A payment of ${amountDisplay} ${context.displayAsset} in the last ${UNUSUAL_WINDOW_DAYS} days ` +
        `is ${ratio}× your typical p90 of ${formatAmount(baselineRaw, resolved.decimals)} ` +
        `${context.displayAsset}. Consider requiring extra confirmation next time.`,
      // Note: `evidence.p90` is deliberately overloaded here — it is the outlier-robust baseline
      // (the value the alert is compared against) while `median`/`max`/`count` stay full-pool.
      // Privacy-safe either way; the mixed baseline is intentional so the ratio is reproducible.
      evidence: {
        ...baseEvidence(resolved, amountStats(result.records, resolved.decimals)),
        p90: formatAmount(baselineRaw, resolved.decimals),
        amount: amountDisplay,
        ratio,
        ratioWindowDays: UNUSUAL_WINDOW_DAYS,
      },
      proposedChange: { kind: "none", action: "require_extra_confirmation" },
      confidence: "medium",
    };
  });
}

const KIND_ORDER: Record<SuggestionKind, number> = {
  auto_pay_threshold: 0,
  daily_limit: 1,
  schedule_from_recurrence: 2,
  tighten_dormant: 3,
  unusual_payment_alert: 4,
};

function compareSuggestions(a: Suggestion, b: Suggestion): number {
  const byKind = KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
  if (byKind !== 0) return byKind;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function isDismissed(suggestion: Suggestion, dismissed: Set<string>): boolean {
  return dismissed.has(suggestion.id) || dismissed.has(suggestion.kind);
}

/**
 * Compute suggestions. Returns `[]` when there is not enough history (see `explainNoSuggestions`)
 * or when every candidate is dismissed. The result is sorted by kind priority, then by id, and is
 * independent of the input array order.
 */
export function suggest(
  history: readonly HistoryRecord[],
  context: SuggestContext,
  options?: SuggestOptions,
): Suggestion[] {
  const resolved = resolve(context, options);
  const result = guard(history, context, resolved);
  if (!result.enough) return [];

  const candidates: Suggestion[] = [];
  const threshold = autoPayThresholdSuggestion(result, context, resolved);
  if (threshold) candidates.push(threshold);
  const daily = dailyLimitSuggestion(result, context, resolved);
  if (daily) candidates.push(daily);
  candidates.push(...recurrenceSuggestions(result, context, resolved));
  const dormant = dormantSuggestion(result, context, resolved);
  if (dormant) candidates.push(dormant);
  candidates.push(...unusualSuggestions(result, context, resolved));

  return candidates.filter((suggestion) => !isDismissed(suggestion, context.dismissed)).sort(compareSuggestions);
}

/**
 * Strip a suggestion down to the only payload allowed to reach an LLM: the aggregate `evidence`
 * plus a numeric/action summary of the proposal. Recipients, aliases, ids and per-payment
 * timestamps are removed by construction (the fields simply do not exist in the output).
 */
export function toLlmSafeEvidence(suggestion: Suggestion): LlmSafeSuggestion {
  return {
    kind: suggestion.kind,
    // Deep copy (hygiene): a caller mutating the safe payload must never mutate the suggestion.
    evidence: structuredClone(suggestion.evidence),
    proposal: structuredClone(numericProposal(suggestion.kind, suggestion.proposedChange)),
  };
}

function numericProposal(kind: SuggestionKind, change: SuggestionChange): Record<string, number | string> {
  switch (kind) {
    case "auto_pay_threshold": {
      const draft = change as RuleDraft;
      return { autoApproveLimit: draft.autoApproveLimit };
    }
    case "daily_limit": {
      const draft = change as RuleDraft;
      return draft.dailyLimit === undefined ? {} : { dailyLimit: draft.dailyLimit };
    }
    case "schedule_from_recurrence": {
      const draft = change as ScheduleDraft;
      return { amount: draft.amount, intervalSecs: draft.intervalSecs, runs: draft.runs };
    }
    case "tighten_dormant":
      return { action: "disable_auto_pay" };
    case "unusual_payment_alert":
      return { action: "require_extra_confirmation" };
    default:
      return {};
  }
}
