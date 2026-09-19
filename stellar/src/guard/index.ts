/**
 * `@polaris/stellar` guard namespace: the owner/executor-side client for the
 * deployed `polaris_guard` contract, the SAC allowance helper and the pure
 * routing policy. Contract id is always a parameter (D9).
 */
export { createGuardClient, type GuardClientOptions } from "./client.ts";
export {
  ALLOWANCE_WINDOW_DAYS,
  LEDGERS_PER_DAY,
  allowanceExpiryLedger,
  buildApproveAllowance,
  formatAllowance,
  getAllowance,
  type ApproveAllowanceInput,
  type ApproveAllowanceResult,
  type GetAllowanceInput,
} from "./allowance.ts";
export { chooseGuardedRoute, type GuardRoute, type GuardRouteDecision, type GuardRouteInput } from "./route.ts";
export {
  I128_MAX,
  I128_MIN,
  RAW_UNITS_PER_TOKEN,
  TOKEN_DECIMALS,
  fromRawUnits,
  toRawUnits,
} from "./amount.ts";
export {
  GUARD_ERROR_BASE,
  GUARD_ERROR_NAMES,
  TOKEN_ERROR_NAMES,
  GuardClientError,
  asGuardClientError,
  classifyGuardText,
  guardErrorFromClassified,
  guardErrorFromCode,
  isGuardClientError,
  type ErrorKind,
  type GuardErrorDef,
} from "./errors.ts";
export {
  buildGuardCallSummary,
  buildGuardedPaymentSummary,
  decodeInvocation,
  shortKey,
  stroopsToXlm,
  toHex,
  type BuiltGuardSummary,
  type DecodedInvocation,
  type GuardedPaymentSummaryInput,
} from "./describe.ts";
export { DEFAULT_TX_TIMEOUT_SECONDS, type InvokeOptions } from "./invoke.ts";
export type { GuardCall, GuardClient, GuardRpcLike, GuardSummary, Rule, Schedule } from "./types.ts";
