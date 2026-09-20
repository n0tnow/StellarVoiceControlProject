/**
 * The owner's local app preferences, persisted in the webview's `localStorage`
 * (per-window origin; per Tauri data dir on disk).
 *
 * Today there is exactly one preference: `approvalThresholdUsd`, the
 * **app-side** auto-approval ceiling in USD (decision D10's "always ask"
 * default is `0`). It is deliberately a *client convenience*, not a security
 * boundary: it can only skip the local Touch ID card for small USD-stablecoin
 * payments. The precedence is:
 *
 * 1. **The chain always wins.** A summary line `Approval card required: yes`
 *    from the guard/contract overrides the threshold — the app can only be
 *    stricter than the chain, never looser (D10c).
 * 2. **Non-USD assets always ask.** `XLM` has no price oracle here, so its USD
 *    value is unknown and unknown means "ask" (fail-closed).
 *
 * Parsing is fail-closed too: a NaN/negative/huge amount, an unreadable stored
 * value, or an absent store all resolve to "always ask", never to a silent
 * approval.
 */

/** Asset codes treated as 1:1 with USD (the registry in `stellar/src/payments/`). */
export const USD_STABLE_ASSETS: readonly string[] = ["USDC", "PGUSD", "USD"];

/** Largest storable threshold; anything bigger is nonsense, not a preference. */
export const MAX_THRESHOLD_USD = 1_000_000;

export interface PolarisPreferences {
  /**
   * USD ceiling under which a payment skips the Touch ID card. `0` (the
   * default, D10) means *always ask*. Values are display dollars, not raw
   * chain units.
   */
  approvalThresholdUsd: number;
}

export const DEFAULT_PREFERENCES: PolarisPreferences = { approvalThresholdUsd: 0 };

/** The one storage key; the whole preferences object is one JSON blob. */
export const PREFERENCES_STORAGE_KEY = "polaris.preferences";

/**
 * The smallest storage seam the preference needs. `localStorage` satisfies it;
 * tests inject a `Map`-backed fake. Stored under `key` as the raw string.
 */
export interface PreferenceStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** The browser store, or `null` where storage is unavailable/disabled. */
export function defaultStore(): PreferenceStore | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    // A blocked localStorage (privacy mode) is not a failure: always ask.
    return null;
  }
}

/** Clamps a parsed value into a sane, finite, non-negative threshold. */
function sanitizeThreshold(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 0;
  return Math.min(value, MAX_THRESHOLD_USD);
}

/**
 * Reads the persisted preferences, returning the defaults on any failure. A
 * corrupt blob or an unknown shape can therefore never *raise* the effective
 * threshold above `0`.
 */
export function loadPreferences(
  store: PreferenceStore | null = defaultStore(),
): PolarisPreferences {
  if (store === null) return DEFAULT_PREFERENCES;
  try {
    const raw = store.getItem(PREFERENCES_STORAGE_KEY);
    if (raw === null) return DEFAULT_PREFERENCES;
    const parsed = JSON.parse(raw) as { approvalThresholdUsd?: unknown };
    return { approvalThresholdUsd: sanitizeThreshold(parsed?.approvalThresholdUsd) };
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

/** Persists one threshold value (sanitised first). No-op without a store. */
export function saveApprovalThresholdUsd(
  thresholdUsd: number,
  store: PreferenceStore | null = defaultStore(),
): void {
  if (store === null) return;
  try {
    const next: PolarisPreferences = { approvalThresholdUsd: sanitizeThreshold(thresholdUsd) };
    store.setItem(PREFERENCES_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // A failed write only means the preference did not stick; nothing moves.
  }
}
