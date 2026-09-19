/**
 * Public types for the `polaris_guard` owner/executor client.
 *
 * The contract is **contract-id parametrised** (decision D9): nothing here
 * hard-codes the deployed v0.1 id. `createGuardClient` takes the id as an
 * option, so a future `polaris_guard_v2` (new crate, new deployment, new ABI)
 * can be targeted side by side. An ABI difference is handled by an explicit
 * version adapter at the call site — never by a silent assumption here.
 *
 * The struct fields mirror `contracts/polaris_guard/src/lib.rs` exactly
 * (snake_case, `i128`/`u64` as `bigint`) so a decoded contract value is
 * directly usable as a `Rule`/`Schedule` without a translation layer.
 */
import type { rpc as StellarRpc } from "@stellar/stellar-sdk";
import type { ChainToolResult } from "@polaris/interfaces";

/**
 * The subset of `rpc.Server` the guard client uses. Injected so tests can
 * supply a scripted fake; the keeper's `RpcLike` is the sibling of this type.
 * `getLatestLedger` is required for the SAC allowance window (see
 * `allowance.ts`).
 */
export type GuardRpcLike = Pick<StellarRpc.Server, "getAccount" | "simulateTransaction" | "getLatestLedger">;

/** `Rule` as defined in the contract: one spending policy per owner address. */
export interface Rule {
  /** Ceiling for unattended agent payments (i128 raw units). */
  auto_approve_limit: bigint;
  /** Hard ceiling for a single payment on every path. */
  per_tx_limit: bigint;
  /** Hard ceiling for the sum of guard payments in one UTC day. */
  daily_limit: bigint;
  /** SAC / SEP-41 addresses the agent and keeper may spend. */
  allowed_assets: string[];
  /** When set, the agent may only pay addresses in the owner's alias book. */
  known_recipients_only: boolean;
}

/** `Schedule` as defined in the contract. */
export interface Schedule {
  id: number;
  owner: string;
  to: string;
  asset: string;
  /** i128 raw units. */
  amount: bigint;
  /** Unix timestamp (seconds). */
  next_run_at: bigint;
  /** `0` = one-shot. */
  interval_secs: bigint;
  runs_left: number;
  active: boolean;
}

/** The approval-card shape shared with the shell (`ChainToolResult["summary"]`). */
export type GuardSummary = ChainToolResult["summary"];

/**
 * An unsigned, assembled guard invocation plus the summary decoded from that
 * exact XDR and the Touch ID payload hash. Nothing is signed or submitted.
 */
export interface GuardCall {
  /** base64 XDR, unsigned. */
  unsignedXdr: string;
  summary: GuardSummary;
  /** hex sha256 of the transaction signature base (`tx.hash()`). */
  payloadHash: string;
}

/**
 * The owner-side and executor-side surface. Method names and argument order
 * mirror the contract functions; the first actor argument is also the
 * transaction source (and therefore the address that must sign).
 */
export interface GuardClient {
  readonly contractId: string;

  // -- owner: policy --------------------------------------------------------
  setRule(owner: string, rule: Rule): Promise<GuardCall>;
  getRule(owner: string): Promise<Rule | null>;

  // -- owner: executor ------------------------------------------------------
  setExecutor(owner: string, executor: string): Promise<GuardCall>;
  revokeExecutor(owner: string): Promise<GuardCall>;
  getExecutor(owner: string): Promise<string | null>;

  // -- owner: alias book ----------------------------------------------------
  setAlias(owner: string, alias: string, address: string): Promise<GuardCall>;
  removeAlias(owner: string, alias: string): Promise<GuardCall>;
  getAlias(owner: string, alias: string): Promise<string | null>;
  isKnownRecipient(owner: string, to: string): Promise<boolean>;

  // -- payments -------------------------------------------------------------
  payOwner(owner: string, to: string, asset: string, amount: bigint): Promise<GuardCall>;
  payExecutor(executor: string, owner: string, to: string, asset: string, amount: bigint): Promise<GuardCall>;
  spentToday(owner: string): Promise<bigint>;

  // -- schedules ------------------------------------------------------------
  createSchedule(
    owner: string,
    to: string,
    asset: string,
    amount: bigint,
    firstRunAt: bigint,
    intervalSecs: bigint,
    runs: number,
  ): Promise<GuardCall>;
  cancelSchedule(owner: string, id: number): Promise<GuardCall>;
  getSchedule(id: number): Promise<Schedule | null>;
  listSchedules(owner: string): Promise<Schedule[]>;
  nextScheduleId(): Promise<number>;
}
