/**
 * Public surface of the deterministic suggestions engine (`stellar/src/suggest`).
 *
 * Exported from `@polaris/stellar` as the `suggest` namespace. Pure and offline: no network, no
 * clock, no randomness, no I/O (D11).
 */
export * from "./types.ts";
export * from "./constants.ts";
export * from "./amount.ts";
export * from "./stats.ts";
export {
  explainNoSuggestions,
  suggest,
  toLlmSafeEvidence,
  SuggestInputError,
  validateSuggestContext,
} from "./suggest.ts";
