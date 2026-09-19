/**
 * Error classification for keeper submissions.
 *
 * The keeper is untrusted: the guard contract decides whether a schedule may
 * run. When it says no, the keeper must understand *why* so it can back off
 * per schedule instead of hammering the network. Soroban surfaces contract
 * errors as `Error(Contract, #N)` inside the simulation/diagnostic text, so we
 * map N -> a named guard error -> a keeper-side `ErrorKind`.
 */

export type ErrorKind =
  /** Someone else (another keeper, the user) already ran this occurrence. */
  | "already_executed"
  /** Contract clock says the schedule is not due yet (ledger time skew). */
  | "not_due"
  /** Schedule was cancelled / has no runs left. */
  | "inactive"
  /** The user's on-chain rules (limit, allowlist, per-asset cap...) forbid this run. */
  | "rule_violated"
  /** Token allowance to the guard is missing/insufficient (or balance too low). */
  | "allowance_missing"
  /** Contract error with a code this keeper does not know. */
  | "unknown_contract"
  /** Simulation asked for a signature the keeper cannot give (non-source auth). */
  | "auth_required"
  /** Keeper account cannot pay: underfunded / fee too low / fee above local cap. */
  | "keeper_funds"
  /** Sequence number clash; refetch the account and retry. */
  | "bad_seq"
  /** Transaction validity window elapsed without inclusion. */
  | "tx_expired"
  /** Network/RPC transport trouble or `TRY_AGAIN_LATER`. Transient. */
  | "rpc"
  | "unknown";

export interface ClassifiedError {
  kind: ErrorKind;
  /** Stable machine-readable name (guard error name, tx result code, ...). */
  name: string;
  /** Contract error code when one was found in the text. */
  code?: number;
  message: string;
}

export interface GuardErrorDef {
  name: string;
  kind: ErrorKind;
}

/**
 * `polaris_guard` error codes -> names/kinds. Mirrors the `#[contracterror]`
 * enum in `contracts/polaris_guard/src/lib.rs` (codes start at 100 on purpose so
 * they never collide with the built-in contract range 1..15 (code 1 reserved,
 * 2..15 mapped in `TOKEN_ERRORS`); discriminants are public ABI).
 * `errors.test.ts` parses the contract source and fails if this table drifts.
 *
 * Only some of these can come out of `execute_schedule` (the keeper's only
 * write); the rest are listed so a code is never mis-labelled if it does show up.
 * Kinds map onto the keeper's back-off classes:
 *  - policy the owner can change  -> `rule_violated` (waits for the owner)
 *  - schedule cannot run any more -> `inactive`
 *  - keeper called too early      -> `not_due`
 *  - allowance revoked/short      -> `allowance_missing`
 */
export const GUARD_ERRORS: Readonly<Record<number, GuardErrorDef>> = {
  100: { name: "NotConfigured", kind: "rule_violated" }, // owner has no rule published
  101: { name: "InvalidAmount", kind: "rule_violated" }, // create_schedule/pay_*; stored amount invalid
  102: { name: "InvalidRule", kind: "rule_violated" }, // set_rule only
  103: { name: "OverPerTxLimit", kind: "rule_violated" }, // rule tightened below the schedule amount
  104: { name: "OverDailyLimit", kind: "rule_violated" }, // clears when the UTC day rolls over
  105: { name: "NeedsOwnerApproval", kind: "rule_violated" }, // pay_executor only; never from execute_schedule
  106: { name: "AssetNotAllowed", kind: "rule_violated" }, // asset removed from allowed_assets
  107: { name: "NoExecutor", kind: "auth_required" }, // pay_executor only
  108: { name: "NotExecutor", kind: "auth_required" }, // pay_executor only
  109: { name: "ScheduleNotFound", kind: "inactive" },
  110: { name: "ScheduleNotDue", kind: "not_due" },
  111: { name: "ScheduleInactive", kind: "inactive" }, // cancelled or exhausted
  112: { name: "InvalidSchedule", kind: "inactive" }, // create_schedule only
  113: { name: "NotScheduleOwner", kind: "auth_required" }, // cancel_schedule only
  114: { name: "TooManySchedules", kind: "rule_violated" }, // create_schedule only
  115: { name: "Overflow", kind: "unknown_contract" },
  116: { name: "InsufficientAllowance", kind: "allowance_missing" }, // owner revoked/expired the SAC allowance
};

/**
 * Built-in contract (Stellar Asset Contract / account contract) errors, codes
 * 1..15 from `soroban-env-host`'s shared `ContractError` enum
 * (`src/builtin_contracts/contract_error.rs`, soroban-env-host 28.x). A code
 * below 100 that reaches the keeper came from the token or the host, not from
 * guard policy; these surface when a `transfer_from` inside a schedule run
 * fails for a token/account-level reason.
 *
 * Code 1 is **intentionally unmapped**: it is `_Reserved1` (formerly
 * InternalError, now host-internal), so `ContractError#1` with kind
 * `unknown_contract` is the honest answer and is still backed off.
 * Codes 2..15 are all mapped here.
 */
export const TOKEN_ERRORS: Readonly<Record<number, GuardErrorDef>> = {
  2: { name: "SacOperationNotSupported", kind: "unknown_contract" },
  3: { name: "SacAlreadyInitialized", kind: "unknown_contract" },
  4: { name: "SacUnauthorized", kind: "auth_required" }, // caller is not allowed
  5: { name: "SacAuthentication", kind: "auth_required" }, // auth/signature check failed
  6: { name: "SacAccountMissing", kind: "rule_violated" }, // an account involved does not exist
  7: { name: "SacAccountIsNotClassic", kind: "rule_violated" }, // account contract needs a classic account
  8: { name: "SacNegativeAmount", kind: "rule_violated" },
  9: { name: "SacAllowanceError", kind: "allowance_missing" }, // allowance too small / bad expiry
  10: { name: "SacBalanceError", kind: "allowance_missing" }, // owner balance too low
  11: { name: "SacBalanceDeauthorized", kind: "rule_violated" }, // issuer revoked authorization
  12: { name: "SacOverflow", kind: "unknown_contract" },
  13: { name: "SacTrustlineMissing", kind: "rule_violated" }, // payee/owner has no trustline
  14: { name: "SacInsufficientAccountReserve", kind: "allowance_missing" }, // owner must fund the reserve
  15: { name: "SacTooManyAccountSubentries", kind: "rule_violated" }, // account cannot grow further
};

/** First code in the guard's own range; anything below it belongs to the token/host. */
export const GUARD_ERROR_BASE = 100;

const CONTRACT_ERROR_RE = /Error\(Contract,\s*#(\d+)\)/;

/**
 * Ordered fallbacks for guard error *names* that appear in diagnostic text
 * (event logs can carry a symbol next to the numeric code). Deliberately
 * CamelCase-specific so generic host messages ("exceeded limit") never match.
 */
const NAME_PATTERNS: Array<[RegExp, ErrorKind, string]> = [
  [/AlreadyExecuted/, "already_executed", "AlreadyExecuted"],
  [/NotDue/, "not_due", "NotDue"],
  [/ScheduleInactive|Inactive|Cancelled|NoRunsLeft/, "inactive", "ScheduleInactive"],
  [/AllowanceMissing|InsufficientAllowance|InsufficientBalance/, "allowance_missing", "AllowanceMissing"],
  [/LimitExceeded|RecipientNotAllowed|AssetNotAllowed|RuleViolated/, "rule_violated", "RuleViolated"],
];

/** Classify a Soroban simulation error string (`sim.error`) or thrown text. */
export function classifyContractText(
  text: string,
  table?: Readonly<Record<number, GuardErrorDef>>,
): ClassifiedError {
  const m = CONTRACT_ERROR_RE.exec(text);
  if (m?.[1] !== undefined) {
    const code = Number(m[1]);
    // Guard codes are >= 100; below that the error came from the token (SAC) or host.
    const def = (table ?? (code >= GUARD_ERROR_BASE ? GUARD_ERRORS : TOKEN_ERRORS))[code];
    if (def) return { kind: def.kind, name: def.name, code, message: firstLine(text) };
    return { kind: "unknown_contract", name: `ContractError#${code}`, code, message: firstLine(text) };
  }
  // Well-known non-contract host/tx failures.
  if (/txBadSeq/.test(text)) return { kind: "bad_seq", name: "txBadSeq", message: firstLine(text) };
  if (/txInsufficientBalance|txInsufficientFee|txNoAccount/.test(text)) {
    return { kind: "keeper_funds", name: "KeeperUnderfunded", message: firstLine(text) };
  }
  if (/txTooLate|txTooEarly/.test(text)) return { kind: "tx_expired", name: "txTooLate", message: firstLine(text) };
  for (const [re, kind, name] of NAME_PATTERNS) {
    if (re.test(text)) return { kind, name, message: firstLine(text) };
  }
  return { kind: "unknown", name: "Unknown", message: firstLine(text) };
}

/** Classify an exception thrown by the RPC layer (network, HTTP, timeouts). */
export function classifyThrown(err: unknown): ClassifiedError {
  const message = err instanceof Error ? err.message : String(err);
  const name = err instanceof Error ? err.name : "Error";
  const contractish = CONTRACT_ERROR_RE.test(message);
  if (contractish) return classifyContractText(message);
  return { kind: "rpc", name, message: firstLine(message) };
}

/** Map a Stellar `TransactionResultCode` name (e.g. `txBadSeq`) to a classification. */
export function classifyTxResultCode(code: string): ClassifiedError {
  switch (code) {
    case "txBadSeq":
      return { kind: "bad_seq", name: code, message: code };
    case "txInsufficientBalance":
    case "txInsufficientFee":
    case "txNoAccount":
      return { kind: "keeper_funds", name: code, message: code };
    case "txTooLate":
    case "txTooEarly":
      return { kind: "tx_expired", name: code, message: code };
    default:
      return { kind: "unknown", name: code, message: code };
  }
}

/** Trimmed first line: simulation errors carry long event logs we do not want in one log line. */
function firstLine(text: string): string {
  const line = text.split(/\r?\n/, 1)[0] ?? text;
  return line.length > 300 ? `${line.slice(0, 297)}...` : line;
}

export interface BackoffPolicy {
  baseMs: number;
  maxMs: number;
}

const S = 1000;
const M = 60 * S;

/** Per-kind backoff: `base * 2^(failures-1)`, capped at `max`. */
export const BACKOFF: Readonly<Record<ErrorKind, BackoffPolicy>> = {
  already_executed: { baseMs: 1 * M, maxMs: 10 * M },
  not_due: { baseMs: 15 * S, maxMs: 2 * M },
  inactive: { baseMs: 5 * M, maxMs: 60 * M },
  rule_violated: { baseMs: 1 * M, maxMs: 60 * M },
  allowance_missing: { baseMs: 1 * M, maxMs: 60 * M },
  unknown_contract: { baseMs: 1 * M, maxMs: 30 * M },
  auth_required: { baseMs: 5 * M, maxMs: 60 * M },
  keeper_funds: { baseMs: 1 * M, maxMs: 10 * M },
  bad_seq: { baseMs: 5 * S, maxMs: 60 * S },
  tx_expired: { baseMs: 5 * S, maxMs: 60 * S },
  rpc: { baseMs: 5 * S, maxMs: 60 * S },
  unknown: { baseMs: 30 * S, maxMs: 10 * M },
};

export function backoffMs(kind: ErrorKind, consecutiveFailures: number): number {
  const p = BACKOFF[kind];
  const exp = Math.max(0, consecutiveFailures - 1);
  return Math.min(p.maxMs, p.baseMs * 2 ** Math.min(exp, 20));
}
