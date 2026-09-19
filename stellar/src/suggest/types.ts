/**
 * Type surface for the deterministic suggestions engine (T3).
 *
 * SCOPE / ISOLATION
 * -----------------
 * This module is **pure**: no network, no clock, no randomness, no I/O. It exists to be unit-tested
 * offline against fixtures (D11). It is intentionally self-contained.
 *
 * Some types this engine conceptually shares with other modules are **not on this branch yet**
 * (the guard `Rule` from the approval/guard work, the approval profile, and the `RuleDraft` /
 * `ScheduleDraft` / `DisableAutoPay` seam shapes from `docs/interfaces.md` §6.1 and
 * `docs/approval-and-scheduling.md` §4/§11c). They are re-declared **minimally and structurally**
 * here so this branch never imports unmerged code. Every such declaration is marked
 * `structural copy; unify when branches merge` and must be replaced by the canonical type once the
 * owning branch lands.
 *
 * All amounts in this module are `bigint` **raw token units** (i128-safe). Display-unit decimal
 * strings only appear in the seam drafts (`RuleDraft`, `ScheduleDraft`) and are produced/consumed by
 * the float-free helpers in `amount.ts`.
 */

/** Payment privacy mode (`docs/confidential-payments.md`). Only `public` amounts are analysable by the guard. */
export type HistoryMode = "public" | "confidential" | "private";

/** Which call path settled the payment (`docs/approval-and-scheduling.md` §2). */
export type HistoryRoute = "direct" | "pay_owner" | "pay_executor" | "schedule_run";

/** Settlement status. Only `confirmed` records count towards statistics. */
export type HistoryStatus = "confirmed" | "failed" | "partial";

/** One payment row from the local encrypted history / chain reader (T4 supplies these). */
export interface HistoryRecord {
  /** Stable local record id. Never sent to an LLM. */
  id: string;
  /** Unix seconds, UTC. */
  ts: number;
  recipientAddress: string;
  recipientAlias?: string;
  asset: string;
  /** Raw token units (already scaled by the asset decimals). */
  amountRaw: bigint;
  mode: HistoryMode;
  route: HistoryRoute;
  status: HistoryStatus;
}

/**
 * Minimal, read-only view of the on-chain guard rule needed to cap suggestions.
 * structural copy; unify when branches merge (guard `Rule`).
 *
 * Decimal strings are in **display units**, mirroring `RuleDraft` (docs/approval-and-scheduling.md
 * §4.2). They are parsed with `parseAmount(..., assetDecimals)` before any comparison so no floats
 * are used.
 */
export interface RuleView {
  autoApproveLimit?: string;
  perTxLimit?: string;
  dailyLimit?: string;
  assets?: string[];
  knownRecipientsOnly?: boolean;
}

/**
 * Speech-derived rule draft (docs/interfaces.md §6.1 / docs/approval-and-scheduling.md §4.2).
 * structural copy; unify when branches merge (shared seam `RuleDraft`).
 * Flat camelCase, decimal strings in **display units**.
 */
export interface RuleDraft {
  autoApproveLimit: string;
  perTxLimit?: string;
  dailyLimit?: string;
  assets?: string[];
  knownRecipientsOnly?: boolean;
  source?: string;
}

/**
 * Speech-derived schedule draft (docs/approval-and-scheduling.md §5.1).
 * structural copy; unify when branches merge (shared seam `ScheduleDraft`).
 * `firstRunAt` is unix seconds UTC; `runs` must always be finite.
 */
export interface ScheduleDraft {
  recipient: string;
  recipientAlias?: string;
  asset: string;
  /** Decimal display units. */
  amount: string;
  firstRunAt: number;
  intervalSecs: number;
  runs: number;
  source?: string;
}

/**
 * Description of a disable-auto-pay change.
 * structural copy; unify when branches merge. The canonical PROPOSED result shape is
 * `{ steps: [...], summary, confirmation: "light" }` (docs/approval-and-scheduling.md §11c); a
 * suggestion only *describes* the change — it never builds unsigned XDR — so the chain-call steps
 * are reduced away here and owned by `disableAutoPay`.
 */
export interface DisableAutoPay {
  kind: "disable_auto_pay";
  confirmation: "light";
}

/** Informational suggestion that proposes **no** rule change (used by `unusual_payment_alert`). */
export interface NoChange {
  kind: "none";
  action: "require_extra_confirmation";
}

/** What a suggestion would change if the user accepted it. */
export type SuggestionChange = RuleDraft | ScheduleDraft | DisableAutoPay | NoChange;

/** Context the pure engine may read. None of it implies I/O. */
export interface SuggestContext {
  /** Unix seconds, UTC. Injected, never read from a clock. */
  now: number;
  /** IANA timezone, e.g. "Europe/Istanbul". Day bucketing uses `Intl` with this zone. */
  timeZone: string;
  /** The current on-chain rule, if any. */
  rule?: RuleView;
  autoPayEnabled: boolean;
  /**
   * Unix seconds when auto-pay was enabled, if known. `tighten_dormant` needs this to distinguish
   * "just enabled" from "idle for 30+ days": without it the engine will not claim auto-pay was
   * never used (conservative — confidential auto-pay usage is invisible to the engine).
   */
  autoPayEnabledSince?: number;
  /**
   * Caller-supplied hint: unix seconds of the last auto-pay (`pay_executor`) use, including
   * confidential payments the engine cannot see. Treated as a lower bound on "last used".
   */
  lastAutoPayUse?: number;
  /** Recipient addresses considered "saved contacts". Empty set = treat all public recipients as candidates. */
  knownContacts: Set<string>;
  /** Dismissed suggestion ids and/or kinds. A suggestion is dropped if either matches. */
  dismissed: Set<string>;
  /** Asset decimals. Defaults to 7 (USDC) when omitted. */
  assetDecimals?: number;
  /** Asset the suggestions are about; statistics filter to this asset (one asset per rule). */
  displayAsset: string;
}

/** Tunables; all have PROPOSED defaults in `constants.ts`. */
export interface SuggestOptions {
  windowDays?: number;
  minPayments?: number;
  minSpanDays?: number;
}

/** The five suggestion kinds (`docs/approval-and-scheduling.md` §6.3). */
export type SuggestionKind =
  | "auto_pay_threshold"
  | "daily_limit"
  | "schedule_from_recurrence"
  | "tighten_dormant"
  | "unusual_payment_alert";

export type Confidence = "low" | "medium" | "high";

/**
 * Aggregate evidence only. Amounts are decimal **display strings** (float-free). No addresses,
 * aliases, record ids or per-payment timestamps ever appear here (`docs/approval-and-scheduling.md`
 * §6.6): this object is the only thing that may reach an LLM.
 */
export interface SuggestionEvidence {
  windowDays: number;
  count: number;
  median: string;
  p90: string;
  max: string;
  /** `daily_limit` only: daily-total statistics. */
  p95DailyTotal?: string;
  dailyMedian?: string;
  dailyMax?: string;
  /** `schedule_from_recurrence` only. */
  occurrences?: number;
  intervalSecs?: number;
  intervalDays?: number;
  amount?: string;
  /** `tighten_dormant` only. `lastUsedDays` is absent when auto-pay was never used. */
  lastUsedDays?: number;
  unusedDays?: number;
  /** `unusual_payment_alert` only. */
  ratio?: string;
  ratioWindowDays?: number;
}

/** A locally computed suggestion. NEVER applied automatically (D11). */
export interface Suggestion {
  /** Deterministic, hash-free, stable id, e.g. `auto_pay_threshold:USDC:20`. */
  id: string;
  kind: SuggestionKind;
  /**
   * LOCAL-UI ONLY: may contain aliases/addresses; send ONLY `toLlmSafeEvidence(...)` to an LLM.
   */
  title: string;
  /**
   * LOCAL-UI ONLY: may contain aliases/addresses; send ONLY `toLlmSafeEvidence(...)` to an LLM.
   */
  rationale: string;
  evidence: SuggestionEvidence;
  proposedChange: SuggestionChange;
  confidence: Confidence;
}

/** Reason returned by `explainNoSuggestions` when the engine produces nothing. */
export interface NoSuggestionsExplanation {
  reason: "not_enough_history";
  /** Confirmed, public, in-window payments for `displayAsset`. */
  count: number;
  minPayments: number;
  /** Whole days between the first and last qualifying payment (floored). */
  spanDays: number;
  minSpanDays: number;
  windowDays: number;
}

/** The only suggestion payload allowed to leave the device for LLM phrasing. */
export interface LlmSafeSuggestion {
  kind: SuggestionKind;
  evidence: SuggestionEvidence;
  /** Numeric/action summary of the proposed change; no recipient, alias, id or timestamp. */
  proposal: Record<string, number | string>;
}
