/**
 * PROPOSED constants for the deterministic suggestions engine.
 *
 * Every value here is **PROPOSED** and mirrors `docs/approval-and-scheduling.md` §6.2/§6.3 and §11.
 * They live in exactly one place so the reviewer can attack each threshold independently.
 */

/** §6.2 minimum-data rule: analyse the last 30 days by default. */
export const DEFAULT_WINDOW_DAYS = 30;

/** §6.2 minimum-data rule: at least 8 payments … */
export const DEFAULT_MIN_PAYMENTS = 8;

/** §6.2 minimum-data rule: … over at least 7 days. */
export const DEFAULT_MIN_SPAN_DAYS = 7;

/** Default asset decimals (USDC on Stellar). */
export const DEFAULT_ASSET_DECIMALS = 7;

/** §6.3 rounding: round UP to the nearest multiple of 5 display units. */
export const ROUNDING_STEP_DISPLAY = 5;

/** §6.3 `daily_limit`: p95 daily total × 1.5, expressed as an integer fraction. */
export const DAILY_LIMIT_MULTIPLIER_NUM = 3;
export const DAILY_LIMIT_MULTIPLIER_DEN = 2;

/** `daily_limit` needs at least this many active spending days before its p95 is meaningful. */
export const DAILY_LIMIT_MIN_ACTIVE_DAYS = 3;

/** Recurrence detection: minimum occurrences (docs §6.3 "same recipient + similar amount at a regular cadence"). */
export const RECURRENCE_MIN_OCCURRENCES = 3;

/** Recurrence detection: interval jitter tolerance, percent. `(max-min)*n*100 <= sum` ⇔ jitter <= 10%. */
export const RECURRENCE_MAX_INTERVAL_JITTER_PCT = 10;

/** Recurrence detection: amount tolerance relative to the median, percent. */
export const RECURRENCE_AMOUNT_TOLERANCE_PCT = 10;

/** Recurrence proposal: a finite number of future runs is always proposed, never "infinite". */
export const DEFAULT_SCHEDULE_RUNS = 12;

/**
 * Bound for advancing a proposed `firstRunAt` to the first regular slot strictly after `now` (B3).
 * Keeps the advance loop O(bounded); a direct arithmetic fallback handles pathological intervals.
 */
export const MAX_FIRST_RUN_ADVANCE_STEPS = 10_000;

/** `tighten_dormant`: auto-pay on but no `pay_executor` route used for more than 30 days. */
export const DORMANT_DAYS = 30;

/** `unusual_payment_alert`: look back 7 days … */
export const UNUSUAL_WINDOW_DAYS = 7;

/** `unusual_payment_alert`: … for a payment strictly greater than 3 × p90. */
export const UNUSUAL_MULTIPLIER = 3;

/** Confidence ladder (PROPOSED). */
export const CONFIDENCE_MEDIUM_MIN_PAYMENTS = 12;
export const CONFIDENCE_HIGH_MIN_PAYMENTS = 20;
export const CONFIDENCE_HIGH_MIN_SPAN_DAYS = 14;

/** Recurrence confidence ladder (PROPOSED). */
export const RECURRENCE_CONFIDENCE_MEDIUM_OCCURRENCES = 4;
export const RECURRENCE_CONFIDENCE_HIGH_OCCURRENCES = 6;

/** Seconds per day; timestamps are unix seconds UTC. */
export const DAY_SECONDS = 86400;
