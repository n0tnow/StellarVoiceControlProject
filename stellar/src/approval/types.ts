/**
 * Approval-profile types, the auto-pay draft and its validation.
 *
 * Decision D10: the default profile is `always_ask` — every money-out shows an
 * approval card (plus Touch ID). D10b lets the owner LATER enable auto-pay under
 * a threshold; D10c says enabling/loosening always needs one approval card +
 * Touch ID, while tightening/disabling only needs the lighter confirmation.
 *
 * The app-side preference can only be STRICTER than the chain (D10). The chain
 * rule is the last defence against a compromised agent; this module therefore
 * mirrors `validate_rule` in `contracts/polaris_guard/src/lib.rs` exactly, and
 * may add stricter app-only checks on top.
 *
 * Browser-safe: no `Buffer`, no `node:` imports.
 */
import { StrKey } from "@stellar/stellar-sdk";
import { I128_MAX, toRawUnits } from "../guard/amount.ts";
import type { Rule } from "../guard/types.ts";

/** How much the app asks before an agent may move money. */
export type ApprovalMode = "always_ask" | "auto_under_limit" | "custom";

/** The app-side preference handed to the guarded payment route. */
export interface ApprovalProfile {
  mode: ApprovalMode;
}

/** D10: nothing is auto-approved at first start. */
export const DEFAULT_APPROVAL_PROFILE: ApprovalProfile = Object.freeze({ mode: "always_ask" });

/**
 * The limits the owner is asked to approve when enabling auto-pay. All amounts
 * are raw token units (i128); the decimal-string constructor below converts
 * through the guard client's single conversion point (`toRawUnits`).
 */
export interface AutoPayDraft {
  /** Registered executor address that signs unattended payments. */
  executor: string;
  /** `auto_approve_limit`: biggest single unattended payment. `0` = always ask. */
  thresholdRaw: bigint;
  /** `daily_limit`: the agent's real mandate (presented as such in copy). */
  dailyLimitRaw: bigint;
  /** `per_tx_limit`: hard per-payment ceiling on every path. */
  perTxLimitRaw: bigint;
  /** SAC / SEP-41 contract ids on the owner's allowlist (contract max is 1). */
  allowedAssets: string[];
  /** When set, the agent may only pay addresses in the owner's alias book. */
  knownRecipientsOnly: boolean;
  /** SAC allowance granted to the guard (the money ceiling / kill switch). */
  allowanceRaw: bigint;
  /** Allowance lifetime in days (1..90). */
  allowanceDays: number;
}

/** Every failure the approval layer can raise, as a stable machine code. */
export type ApprovalErrorCode =
  | "invalid_amount_string"
  | "invalid_executor"
  | "threshold_negative"
  | "non_positive_limit"
  | "amount_out_of_range"
  | "limit_order"
  | "too_many_assets"
  | "no_assets"
  | "allowance_too_small"
  | "invalid_allowance_days"
  | "missing_asset"
  | "use_enable_flow";

/** Typed approval failure. Match on `code`, never on the human message. */
export class ApprovalError extends Error {
  readonly code: ApprovalErrorCode;

  constructor(code: ApprovalErrorCode, message: string) {
    super(message);
    this.name = "ApprovalError";
    this.code = code;
  }
}

/**
 * The contract's effective bound on `allowed_assets` is **1** today: `validate_rule`
 * refuses `len() > 1` even though the structural `MAX_ALLOWED_ASSETS` constant is
 * 10 (a single cross-asset daily counter cannot compare raw units across
 * decimals). Mirrored here; lift only together with the contract.
 */
export const MAX_ALLOWED_ASSETS = 1;

/** Allowance window bounds (`allowance_days`). */
export const MIN_ALLOWANCE_DAYS = 1;
export const MAX_ALLOWANCE_DAYS = 90;

/** Default allowance proposal: one week of the daily mandate (source notes D10c). */
export const DEFAULT_ALLOWANCE_DAYS = 30;
export const DEFAULT_ALLOWANCE_MULTIPLIER = 7n;

/** Decimal-string form of the draft, for voice/UI parsing into raw units. */
export interface AutoPayDraftInput {
  executor: string;
  /** Decimal token amount (max 7 fraction digits). */
  threshold: string;
  perTxLimit: string;
  dailyLimit: string;
  allowedAssets: string[];
  knownRecipientsOnly: boolean;
  /** Defaults to `dailyLimit * 7` (must be >= the daily limit). */
  allowance?: string;
  /** Defaults to 30. */
  allowanceDays?: number;
}

/** Strict decimal string -> raw units, surfacing `ApprovalError` on bad input. */
function parseAmount(label: string, value: string): bigint {
  try {
    return toRawUnits(value);
  } catch (e) {
    throw new ApprovalError(
      "invalid_amount_string",
      `${label} must be a non-negative decimal string with at most 7 fraction digits: ${(e as Error).message}`,
    );
  }
}

/**
 * Build an `AutoPayDraft` from decimal strings (both signed digits stripped to
 * raw units by `toRawUnits`, the guard's only conversion point). Does **not**
 * validate; call `validateAutoPayDraft` (or use `buildEnableAutoPay`, which
 * validates) before signing anything.
 */
export function makeAutoPayDraft(input: AutoPayDraftInput): AutoPayDraft {
  const dailyLimitRaw = parseAmount("dailyLimit", input.dailyLimit);
  const allowanceRaw =
    input.allowance === undefined
      ? dailyLimitRaw * DEFAULT_ALLOWANCE_MULTIPLIER
      : parseAmount("allowance", input.allowance);
  return {
    executor: input.executor,
    thresholdRaw: parseAmount("threshold", input.threshold),
    perTxLimitRaw: parseAmount("perTxLimit", input.perTxLimit),
    dailyLimitRaw,
    allowedAssets: [...input.allowedAssets],
    knownRecipientsOnly: input.knownRecipientsOnly,
    allowanceRaw,
    allowanceDays: input.allowanceDays ?? DEFAULT_ALLOWANCE_DAYS,
  };
}

function assertBigInt(label: string, value: bigint): void {
  if (typeof value !== "bigint") {
    throw new ApprovalError("amount_out_of_range", `${label} must be a bigint, got ${typeof value}`);
  }
}

function assertAtMostI128(label: string, value: bigint): void {
  if (value > I128_MAX) {
    throw new ApprovalError("amount_out_of_range", `${label} ${value} exceeds i128::MAX`);
  }
}

/**
 * Validate a draft against the contract's real `validate_rule` plus stricter
 * app-side rules that make the enable flow well-defined. Order of checks is
 * documented by the tests; every failure is a typed `ApprovalError`.
 */
export function validateAutoPayDraft(draft: AutoPayDraft): void {
  if (typeof draft.executor !== "string" || !StrKey.isValidEd25519PublicKey(draft.executor)) {
    throw new ApprovalError("invalid_executor", `executor must be a valid G... address, got ${JSON.stringify(draft.executor)}`);
  }

  assertBigInt("thresholdRaw", draft.thresholdRaw);
  assertBigInt("perTxLimitRaw", draft.perTxLimitRaw);
  assertBigInt("dailyLimitRaw", draft.dailyLimitRaw);
  assertBigInt("allowanceRaw", draft.allowanceRaw);

  // Contract: 0 <= auto_approve_limit (0 is the contract's "always ask me").
  if (draft.thresholdRaw < 0n) {
    throw new ApprovalError("threshold_negative", `auto_approve_limit must not be negative, got ${draft.thresholdRaw}`);
  }
  // Contract: per_tx_limit > 0, daily_limit > 0.
  if (draft.perTxLimitRaw <= 0n || draft.dailyLimitRaw <= 0n) {
    throw new ApprovalError("non_positive_limit", "per_tx_limit and daily_limit must be strictly positive");
  }
  if (draft.allowanceRaw <= 0n) {
    throw new ApprovalError("non_positive_limit", "allowance must be strictly positive");
  }

  assertAtMostI128("thresholdRaw", draft.thresholdRaw);
  assertAtMostI128("perTxLimitRaw", draft.perTxLimitRaw);
  assertAtMostI128("dailyLimitRaw", draft.dailyLimitRaw);
  assertAtMostI128("allowanceRaw", draft.allowanceRaw);

  // Contract: auto_approve_limit <= per_tx_limit <= daily_limit.
  if (draft.thresholdRaw > draft.perTxLimitRaw || draft.perTxLimitRaw > draft.dailyLimitRaw) {
    throw new ApprovalError(
      "limit_order",
      `require auto_approve_limit <= per_tx_limit <= daily_limit, got ${draft.thresholdRaw} / ${draft.perTxLimitRaw} / ${draft.dailyLimitRaw}`,
    );
  }

  // Contract: at most one asset (effective); the app cannot enable auto-pay
  // without an asset to approve the SAC allowance on.
  if (draft.allowedAssets.length > MAX_ALLOWED_ASSETS) {
    throw new ApprovalError(
      "too_many_assets",
      `the guard accepts at most ${MAX_ALLOWED_ASSETS} allowed asset, got ${draft.allowedAssets.length}`,
    );
  }
  if (draft.allowedAssets.length === 0) {
    throw new ApprovalError("no_assets", "at least one allowed asset is required to grant the SAC allowance");
  }

  // App-side: the allowance is the money ceiling and must cover the daily mandate.
  if (draft.allowanceRaw < draft.dailyLimitRaw) {
    throw new ApprovalError(
      "allowance_too_small",
      `allowance ${draft.allowanceRaw} must be at least the daily limit ${draft.dailyLimitRaw}`,
    );
  }

  if (
    !Number.isInteger(draft.allowanceDays) ||
    draft.allowanceDays < MIN_ALLOWANCE_DAYS ||
    draft.allowanceDays > MAX_ALLOWANCE_DAYS
  ) {
    throw new ApprovalError(
      "invalid_allowance_days",
      `allowanceDays must be an integer in ${MIN_ALLOWANCE_DAYS}..${MAX_ALLOWANCE_DAYS}, got ${draft.allowanceDays}`,
    );
  }
}

/** Project a validated draft onto the on-chain `Rule` shape (snake_case, exact). */
export function ruleFromDraft(draft: AutoPayDraft): Rule {
  return {
    auto_approve_limit: draft.thresholdRaw,
    per_tx_limit: draft.perTxLimitRaw,
    daily_limit: draft.dailyLimitRaw,
    allowed_assets: [...draft.allowedAssets],
    known_recipients_only: draft.knownRecipientsOnly,
  };
}
