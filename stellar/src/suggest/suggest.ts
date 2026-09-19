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
  MAX_SCHEDULE_RUNS,
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
import { dailyTotals, maxOf, median, medianInt, percentileNearestRank, sortBigints, spanDays } from "./stats.ts";
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
  const records = history.filter(
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

function amountStats(records: readonly HistoryRecord[], decimals: number): AmountStats {
  const amounts = sortBigints(records.map((record) => record.amountRaw));
  return {
    count: records.length,
    median: formatAmount(median(amounts), decimals),
    p90: formatAmount(percentileNearestRank(amounts, 90), decimals),
    max: formatAmount(maxOf(amounts), decimals),
    p90Raw: percentileNearestRank(amounts, 90),
    maxRaw: maxOf(amounts),
  };
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

function autoPayThresholdSuggestion(
  result: GuardResult,
  context: SuggestContext,
  resolved: Resolved,
): Suggestion | null {
  const pool = thresholdPool(result.records, context);
  if (pool.length === 0) return null;
  const amounts = sortBigints(pool.map((record) => record.amountRaw));
  const p90Raw = percentileNearestRank(amounts, 90);
  if (p90Raw <= 0n) return null;
  const maxRaw = maxOf(amounts);

  let proposedRaw = roundUpToDisplayMultiple(p90Raw, resolved.decimals, ROUNDING_STEP_DISPLAY);
  // Guard: never propose more than the maximum observed payment, rounded up by one step.
  const roundedMax = roundUpToDisplayMultiple(maxRaw, resolved.decimals, ROUNDING_STEP_DISPLAY);
  if (proposedRaw > roundedMax) proposedRaw = roundedMax;

  let capped = false;
  let capDisplay = "";
  if (context.rule?.perTxLimit !== undefined) {
    const capRaw = parseAmount(context.rule.perTxLimit, resolved.decimals);
    if (capRaw <= 0n) return null;
    capDisplay = formatAmount(capRaw, resolved.decimals);
    if (proposedRaw > capRaw) {
      proposedRaw = capRaw;
      capped = true;
    }
  }

  if (context.autoPayEnabled && context.rule?.autoApproveLimit !== undefined) {
    const currentRaw = parseAmount(context.rule.autoApproveLimit, resolved.decimals);
    if (currentRaw >= p90Raw) return null; // already covers p90 — nothing to re-suggest
  }

  const proposedDisplay = formatAmount(proposedRaw, resolved.decimals);
  const count = pool.length;
  const windowDays = resolved.windowDays;
  const contactPhrase =
    context.knownContacts.size > 0 ? `${count} payments to saved contacts` : `${count} payments`;
  let rationale =
    `Over the last ${windowDays} days you sent ${contactPhrase}, all under ${proposedDisplay} ` +
    `${context.displayAsset} (median ${formatAmount(median(amounts), resolved.decimals)}, ` +
    `p90 ${formatAmount(p90Raw, resolved.decimals)}). Allow automatic payments up to ` +
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

  return {
    id: `auto_pay_threshold:${context.displayAsset}:${proposedDisplay}`,
    kind: "auto_pay_threshold",
    title: `Allow auto-pay up to ${proposedDisplay} ${context.displayAsset}`,
    rationale,
    evidence: baseEvidence(resolved, amountStats(pool, resolved.decimals)),
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
    const currentRaw = parseAmount(context.rule.dailyLimit, resolved.decimals);
    if (currentRaw === proposedRaw) return null;
  }

  const proposedDisplay = formatAmount(proposedRaw, resolved.decimals);
  const p95Display = formatAmount(p95, resolved.decimals);
  const stats = amountStats(result.records, resolved.decimals);
  const evidence = baseEvidence(resolved, stats);
  evidence.p95DailyTotal = p95Display;
  evidence.dailyMedian = formatAmount(dailyMedian, resolved.decimals);
  evidence.dailyMax = formatAmount(dailyMax, resolved.decimals);

  // `RuleDraft.autoApproveLimit` is required by the seam. This suggestion only changes the daily
  // mandate, so keep the rule's existing per-tx threshold, or fall back to the p90-based threshold.
  const fallbackThreshold = formatAmount(
    roundUpToDisplayMultiple(stats.p90Raw, resolved.decimals, ROUNDING_STEP_DISPLAY),
    resolved.decimals,
  );
  const draft: RuleDraft = {
    autoApproveLimit: context.rule?.autoApproveLimit ?? fallbackThreshold,
    dailyLimit: proposedDisplay,
    assets: [context.displayAsset],
    knownRecipientsOnly: true,
    source: `suggested from the last ${resolved.windowDays} days of daily totals`,
  };

  return {
    id: `daily_limit:${context.displayAsset}:${proposedDisplay}`,
    kind: "daily_limit",
    title: `Set a daily limit of ${proposedDisplay} ${context.displayAsset}`,
    rationale:
      `Over the last ${resolved.windowDays} days your busiest typical day reached ${p95Display} ` +
      `${context.displayAsset} (p95), so a daily limit of ${proposedDisplay} ${context.displayAsset} ` +
      `(1.5× with headroom) keeps auto-pay bounded. This is the agent's real daily mandate.`,
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
  if ((maxAmount - minAmount) * 100n > BigInt(RECURRENCE_AMOUNT_TOLERANCE_PCT) * medianAmount) {
    return null;
  }

  const proposedInterval = medianInt(intervals);
  if (proposedInterval <= 0) return null;
  const amountDisplay = formatAmount(medianAmount, resolved.decimals);
  const runs = Math.min(DEFAULT_SCHEDULE_RUNS, MAX_SCHEDULE_RUNS);
  const firstRunAt = (sorted[sorted.length - 1] as HistoryRecord).ts + proposedInterval;
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
  const used = result.records.filter((record) => record.route === "pay_executor");
  const lastUsedTs = used.length > 0 ? Math.max(...used.map((record) => record.ts)) : undefined;
  const unusedDays =
    lastUsedTs === undefined ? resolved.windowDays : Math.floor((context.now - lastUsedTs) / DAY_SECONDS);
  const neverUsed = lastUsedTs === undefined;
  if (!neverUsed && unusedDays <= DORMANT_DAYS) return null;

  const stats = amountStats(result.records, resolved.decimals);
  const evidence = baseEvidence(resolved, stats);
  evidence.unusedDays = unusedDays;
  if (lastUsedTs !== undefined) evidence.lastUsedDays = unusedDays;

  return {
    id: `tighten_dormant:${context.displayAsset}`,
    kind: "tighten_dormant",
    title: `Turn off auto-pay for ${context.displayAsset}?`,
    rationale: neverUsed
      ? `Auto-pay is on but no automatic (pay_executor) payment was used in the last ` +
        `${unusedDays} days. Revoking the executor reduces risk.`
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
  const p90Raw = percentileNearestRank(amounts, 90);
  if (p90Raw <= 0n) return [];
  const cutoff = context.now - UNUSUAL_WINDOW_DAYS * DAY_SECONDS;
  const thresholdRaw = BigInt(UNUSUAL_MULTIPLIER) * p90Raw;
  const unusual = result.records
    .filter((record) => record.ts >= cutoff && record.amountRaw > thresholdRaw)
    .sort(byTimestampThenId);

  return unusual.map((record) => {
    const amountDisplay = formatAmount(record.amountRaw, resolved.decimals);
    // Ratio with one decimal, computed in integers (tenths).
    const ratioTenths = (record.amountRaw * 10n) / p90Raw;
    const ratio = `${ratioTenths / 10n}.${ratioTenths % 10n}`;
    return {
      id: `unusual_payment_alert:${context.displayAsset}:${record.id}`,
      kind: "unusual_payment_alert",
      title: `Unusual payment of ${amountDisplay} ${context.displayAsset}`,
      rationale:
        `A payment of ${amountDisplay} ${context.displayAsset} in the last ${UNUSUAL_WINDOW_DAYS} days ` +
        `is ${ratio}× your typical p90 of ${formatAmount(p90Raw, resolved.decimals)} ` +
        `${context.displayAsset}. Consider requiring extra confirmation next time.`,
      evidence: {
        ...baseEvidence(resolved, amountStats(result.records, resolved.decimals)),
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
    evidence: suggestion.evidence,
    proposal: numericProposal(suggestion.kind, suggestion.proposedChange),
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
