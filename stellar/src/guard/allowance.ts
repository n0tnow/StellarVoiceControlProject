/**
 * SAC (SEP-41) allowance helper.
 *
 * The guard never custodies funds: it settles through
 * `transfer_from(spender = <guard>, from = <owner>, to, amount)`, which only
 * works once the owner has approved the guard as a spender on the asset's
 * Stellar Asset Contract. That allowance is the real ceiling and the user's
 * off-contract kill switch — re-approving with `amount = 0` disables the guard
 * instantly.
 *
 * The asset contract id is supplied by the caller (resolved from the owner's
 * allowlist, never from agent input); the guard contract id is the `spender`.
 * `live_until_ledger` is chosen ~30 days out (17,280 ledgers/day), read from
 * the injected RPC's latest ledger — the same window `contracts/scripts/demo.sh`
 * uses.
 */
import { nativeToScVal } from "@stellar/stellar-sdk";
import { I128_MAX, fromRawUnits } from "./amount.ts";
import { buildGuardCallSummary } from "./describe.ts";
import { GuardClientError } from "./errors.ts";
import { buildUnsignedInvoke, simulateReadValue, DEFAULT_TX_TIMEOUT_SECONDS } from "./invoke.ts";
import type { GuardCall, GuardRpcLike } from "./types.ts";

/** Ledgers per day at ~5s per ledger (contracts/scripts/demo.sh). */
export const LEDGERS_PER_DAY = 17_280;
/** Renewal cadence: ~30 days, comfortably under the network's ~180-day entry cap. */
export const ALLOWANCE_WINDOW_DAYS = 30;

function invalidAmount(message: string): GuardClientError {
  return new GuardClientError({ name: "InvalidAmount", kind: "rule_violated", code: 101, message });
}

/**
 * `currentLedger + days * 17280`, with the protocol's per-entry cap left to
 * the network.
 *
 * A caller-supplied `days` large enough to push the result past `u32::MAX`
 * surfaces as a raw `TypeError` from the later `nativeToScVal(..., "u32")`
 * rather than a typed `GuardClientError` — callers must keep `days` sane.
 */
export function allowanceExpiryLedger(currentLedger: number, days: number = ALLOWANCE_WINDOW_DAYS): number {
  if (!Number.isInteger(currentLedger) || currentLedger < 0) {
    throw new GuardClientError({
      name: "InvalidLedger",
      kind: "rpc",
      message: `current ledger must be a non-negative integer, got ${String(currentLedger)}`,
    });
  }
  if (!Number.isInteger(days) || days <= 0) {
    throw new GuardClientError({
      name: "InvalidLedger",
      kind: "rpc",
      message: `allowance window must be a positive number of days, got ${String(days)}`,
    });
  }
  return currentLedger + days * LEDGERS_PER_DAY;
}

export interface ApproveAllowanceInput {
  /** SAC contract id of the asset being approved (from the owner's allowlist). */
  assetContractId: string;
  /** Owner address (`from`); also the transaction source and signer. */
  from: string;
  /** Guard contract id (`spender`). */
  spender: string;
  /** Allowance in raw token units; must be positive and fit in i128. */
  amount: bigint;
  networkPassphrase: string;
  /** Override the ~30-day window (days). */
  days?: number;
  txTimeoutSeconds?: number;
  explorerBase?: string;
}

export interface ApproveAllowanceResult extends GuardCall {
  currentLedger: number;
  liveUntilLedger: number;
}

function assertAllowanceAmount(amount: bigint): void {
  if (typeof amount !== "bigint") throw invalidAmount(`allowance must be a bigint, got ${typeof amount}`);
  if (amount <= 0n) {
    throw invalidAmount(
      `allowance must be positive; to revoke it, approve 0 explicitly (got ${amount} raw units)`,
    );
  }
  if (amount > I128_MAX) throw invalidAmount(`allowance ${amount} raw units exceeds i128::MAX`);
}

/** Build the unsigned SAC `approve(from, spender, amount, live_until_ledger)` call. */
export async function buildApproveAllowance(
  rpc: GuardRpcLike,
  input: ApproveAllowanceInput,
): Promise<ApproveAllowanceResult> {
  assertAllowanceAmount(input.amount);
  const latest = await rpc.getLatestLedger();
  const currentLedger = Number(latest.sequence);
  const liveUntilLedger = allowanceExpiryLedger(currentLedger, input.days ?? ALLOWANCE_WINDOW_DAYS);
  const { unsignedXdr } = await buildUnsignedInvoke(rpc, {
    contractId: input.assetContractId,
    method: "approve",
    args: [
      nativeToScVal(input.from, { type: "address" }),
      nativeToScVal(input.spender, { type: "address" }),
      nativeToScVal(input.amount, { type: "i128" }),
      nativeToScVal(liveUntilLedger, { type: "u32" }),
    ],
    source: input.from,
    networkPassphrase: input.networkPassphrase,
    txTimeoutSeconds: input.txTimeoutSeconds ?? DEFAULT_TX_TIMEOUT_SECONDS,
  });
  const { summary, payloadHash } = buildGuardCallSummary({
    unsignedXdr,
    networkPassphrase: input.networkPassphrase,
    ...(input.explorerBase ? { explorerBase: input.explorerBase } : {}),
  });
  return { unsignedXdr, summary, payloadHash, currentLedger, liveUntilLedger };
}

export interface GetAllowanceInput {
  assetContractId: string;
  from: string;
  spender: string;
  networkPassphrase: string;
  txTimeoutSeconds?: number;
}

/** Read the current SEP-41 allowance (raw units) from the asset's SAC. */
export async function getAllowance(rpc: GuardRpcLike, input: GetAllowanceInput): Promise<bigint> {
  const value = await simulateReadValue(rpc, {
    contractId: input.assetContractId,
    method: "allowance",
    args: [nativeToScVal(input.from, { type: "address" }), nativeToScVal(input.spender, { type: "address" })],
    source: input.from,
    networkPassphrase: input.networkPassphrase,
    txTimeoutSeconds: input.txTimeoutSeconds ?? DEFAULT_TX_TIMEOUT_SECONDS,
  });
  return BigInt(value as bigint);
}

/** Display helper: raw allowance -> decimal string (`105000000n` -> `"10.5"`). */
export function formatAllowance(amount: bigint): string {
  return fromRawUnits(amount);
}
