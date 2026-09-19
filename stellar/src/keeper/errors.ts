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
 * Guard contract error codes -> names/kinds.
 *
 * SYNC POINT with `contracts/polaris_guard` (`#[contracterror]` enum): when the
 * contract's error enum changes, update this table. Unknown codes are still
 * handled (kind `unknown_contract`, backed off), so drift degrades gracefully.
 */
export const GUARD_ERRORS: Readonly<Record<number, GuardErrorDef>> = {
  // Populated from contracts/DEPLOYED.md / the contract source (see README).
};

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
  table: Readonly<Record<number, GuardErrorDef>> = GUARD_ERRORS,
): ClassifiedError {
  const m = CONTRACT_ERROR_RE.exec(text);
  if (m?.[1] !== undefined) {
    const code = Number(m[1]);
    const def = table[code];
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
