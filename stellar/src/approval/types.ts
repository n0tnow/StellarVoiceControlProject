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
  | "invalid_asset"
  | "allowance_too_small"
  | "invalid_allowance_days"
  | "missing_asset"
  | "already_armed"
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
 * Validate a rule payload plus the allowance that funds it. Shared by the
 * auto-pay enable draft and the Always-ask baseline setup so both mirror the
 * contract's real `validate_rule` exactly and add the same app-side rules.
 * Every failure is a typed `ApprovalError`; the order of checks is documented
 * by the tests.
 */
export function validateRuleAndAllowance(rule: Rule, allowanceRaw: bigint, allowanceDays: number): void {
  assertBigInt("auto_approve_limit", rule.auto_approve_limit);
  assertBigInt("per_tx_limit", rule.per_tx_limit);
  assertBigInt("daily_limit", rule.daily_limit);
  assertBigInt("allowanceRaw", allowanceRaw);

  // Contract: 0 <= auto_approve_limit (0 is the contract's "always ask me").
  if (rule.auto_approve_limit < 0n) {
    throw new ApprovalError(
      "threshold_negative",
      `auto_approve_limit must not be negative, got ${rule.auto_approve_limit}`,
    );
  }
  // Contract: per_tx_limit > 0, daily_limit > 0.
  if (rule.per_tx_limit <= 0n || rule.daily_limit <= 0n) {
    throw new ApprovalError("non_positive_limit", "per_tx_limit and daily_limit must be strictly positive");
  }
  if (allowanceRaw <= 0n) {
    throw new ApprovalError("non_positive_limit", "allowance must be strictly positive");
  }

  assertAtMostI128("auto_approve_limit", rule.auto_approve_limit);
  assertAtMostI128("per_tx_limit", rule.per_tx_limit);
  assertAtMostI128("daily_limit", rule.daily_limit);
  assertAtMostI128("allowanceRaw", allowanceRaw);

  // Contract: auto_approve_limit <= per_tx_limit <= daily_limit.
  if (rule.auto_approve_limit > rule.per_tx_limit || rule.per_tx_limit > rule.daily_limit) {
    throw new ApprovalError(
      "limit_order",
      `require auto_approve_limit <= per_tx_limit <= daily_limit, got ${rule.auto_approve_limit} / ${rule.per_tx_limit} / ${rule.daily_limit}`,
    );
  }

  // Contract: at most one asset (effective); the app cannot build a guard flow
  // without an asset to approve the SAC allowance on.
  if (rule.allowed_assets.length > MAX_ALLOWED_ASSETS) {
    throw new ApprovalError(
      "too_many_assets",
      `the guard accepts at most ${MAX_ALLOWED_ASSETS} allowed asset, got ${rule.allowed_assets.length}`,
    );
  }
  if (rule.allowed_assets.length === 0) {
    throw new ApprovalError("no_assets", "at least one allowed asset is required to grant the SAC allowance");
  }
  // The allowance targets a real contract; a malformed id would only fail in
  // the SDK/network after the user has already approved the card.
  for (const asset of rule.allowed_assets) {
    assertValidAsset(asset, "allowed asset");
  }

  // App-side: the allowance is the money ceiling and must cover the daily mandate.
  if (allowanceRaw < rule.daily_limit) {
    throw new ApprovalError(
      "allowance_too_small",
      `allowance ${allowanceRaw} must be at least the daily limit ${rule.daily_limit}`,
    );
  }

  if (
    !Number.isInteger(allowanceDays) ||
    allowanceDays < MIN_ALLOWANCE_DAYS ||
    allowanceDays > MAX_ALLOWANCE_DAYS
  ) {
    throw new ApprovalError(
      "invalid_allowance_days",
      `allowanceDays must be an integer in ${MIN_ALLOWANCE_DAYS}..${MAX_ALLOWANCE_DAYS}, got ${allowanceDays}`,
    );
  }
}

/** A `C...` contract id, as required by `allowed_assets` and the `approve` target. */
function assertValidAsset(asset: unknown, label: string): asserts asset is string {
  if (typeof asset !== "string" || !StrKey.isValidContract(asset)) {
    throw new ApprovalError(
      "invalid_asset",
      `${label} must be a valid C... contract id, got ${JSON.stringify(asset)}`,
    );
  }
}

/**
 * The SAC allowance target and the rule's first allowed asset must agree when
 * both are present: a mismatch would grant the allowance on an asset the agent
 * may never spend (or list an asset the guard flow never approves). Shared by
 * the enable draft and the Always-ask baseline so neither can drift.
 */
export function assertAssetMatchesRule(assetContractId: string | undefined, rule: Rule): void {
  if (assetContractId === undefined) return;
  const first = rule.allowed_assets[0];
  if (first !== undefined && first !== assetContractId) {
    throw new ApprovalError(
      "invalid_asset",
      `assetContractId ${assetContractId} must equal the rule's first allowed asset ${first}`,
    );
  }
}

/** The input the Always-ask baseline builder validates (rule + allowance + asset). */
export interface BaselineSetupInput {
  /** The published rule; `auto_approve_limit` may be 0 (the "always ask" value). */
  rule: Rule;
  /** SAC allowance granted to the guard (raw units). */
  allowanceRaw: bigint;
  /** Allowance lifetime in days (1..90). */
  allowanceDays: number;
  /** SAC contract id the allowance is granted on. */
  assetContractId: string;
}

/**
 * Validate the Always-ask baseline setup. It mirrors the enable draft where
 * relevant, but there is no executor field: the baseline deliberately leaves
 * the executor unregistered, so `pay_executor` can never succeed.
 */
export function validateBaselineSetup(input: BaselineSetupInput): void {
  validateRuleAndAllowance(input.rule, input.allowanceRaw, input.allowanceDays);
  assertValidAsset(input.assetContractId, "assetContractId");
  assertAssetMatchesRule(input.assetContractId, input.rule);
}

/**
 * Validate a draft against the contract's real `validate_rule` plus stricter
 * app-side rules that make the enable flow well-defined.
 */
export function validateAutoPayDraft(draft: AutoPayDraft): void {
  if (typeof draft.executor !== "string" || !StrKey.isValidEd25519PublicKey(draft.executor)) {
    throw new ApprovalError("invalid_executor", `executor must be a valid G... address, got ${JSON.stringify(draft.executor)}`);
  }
  const rule = ruleFromDraft(draft);
  validateRuleAndAllowance(rule, draft.allowanceRaw, draft.allowanceDays);
  assertAssetMatchesRule(draft.allowedAssets[0], rule);
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
