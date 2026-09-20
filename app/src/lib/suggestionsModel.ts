/**
 * Suggestions view model.
 *
 * Wraps the offline `@polaris/stellar` engine: it reads the owner's outgoing
 * payments, builds the engine's context (never auto-apply, D11) and formats the
 * result for the Diagnostics check. Nothing here signs, submits or changes a
 * rule. Pure, no DOM and no Tauri.
 */
import { suggest } from "@polaris/stellar";

/** Testnet payments are XLM by default; the check picks the busiest asset. */
export const DEFAULT_DISPLAY_ASSET = "XLM";

/** The asset the owner sent the most of in history, XLM breaking ties/clashes. */
export function pickDisplayAsset(records: readonly suggest.HistoryRecord[]): string {
  const counts = new Map<string, number>();
  for (const record of records) {
    counts.set(record.asset, (counts.get(record.asset) ?? 0) + 1);
  }
  if (counts.size === 0) return DEFAULT_DISPLAY_ASSET;
  return [...counts.entries()].sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    if (a[0] === DEFAULT_DISPLAY_ASSET) return -1;
    if (b[0] === DEFAULT_DISPLAY_ASSET) return 1;
    return a[0].localeCompare(b[0]);
  })[0]![0];
}

export interface SuggestInputs {
  history: readonly suggest.HistoryRecord[];
  /** Unix seconds. Injected, never read from a clock inside the engine. */
  now: number;
  timeZone: string;
  displayAsset: string;
  dismissed: readonly string[];
  knownContacts?: readonly string[];
  autoPayEnabled?: boolean;
  autoPayEnabledSince?: number;
}

export interface SuggestRun {
  suggestions: suggest.Suggestion[];
  /** Why the engine returned nothing, or `null` when there was enough history. */
  noSuggestions: suggest.NoSuggestionsExplanation | null;
}

/** Builds the engine context. Auto-pay is off: no live guard rule is read here. */
export function buildSuggestContext(inputs: SuggestInputs): suggest.SuggestContext {
  const context: suggest.SuggestContext = {
    now: inputs.now,
    timeZone: inputs.timeZone,
    autoPayEnabled: inputs.autoPayEnabled ?? false,
    knownContacts: new Set(inputs.knownContacts ?? []),
    dismissed: new Set(inputs.dismissed),
    displayAsset: inputs.displayAsset,
  };
  if (inputs.autoPayEnabledSince !== undefined) context.autoPayEnabledSince = inputs.autoPayEnabledSince;
  return context;
}

/** Runs the pure engine once. Never throws on a malformed history record. */
export function computeSuggestions(inputs: SuggestInputs): SuggestRun {
  const context = buildSuggestContext(inputs);
  return {
    suggestions: suggest.suggest(inputs.history, context),
    noSuggestions: suggest.explainNoSuggestions(inputs.history, context),
  };
}
