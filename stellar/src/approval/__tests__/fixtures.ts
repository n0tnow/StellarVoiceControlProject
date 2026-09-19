/**
 * Offline fixtures for the approval tests: a deterministic clock, a valid
 * draft and a guard client backed by the guard tests' scripted fake RPC.
 */
import { Networks, xdr } from "@stellar/stellar-sdk";
import { createGuardClient } from "../../guard/client.ts";
import { ASSET_SAC, EXECUTOR, FakeGuardRpc, GUARD_ID, OWNER, okSim } from "../../guard/__tests__/helpers.ts";
import type { GuardClient, GuardRpcLike, Rule } from "../../guard/types.ts";
import { makeAutoPayDraft, type AutoPayDraft } from "../types.ts";

export { ASSET_SAC, EXECUTOR, GUARD_ID, OWNER };

/**
 * Real testnet USDC SAC id from `contracts/DEPLOYED.md` (anchor path). Used
 * where a realistic `C...` id matters, so asset validation is exercised against
 * a genuine contract address rather than only the synthetic fixture.
 */
export const USDC_SAC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";

export const FIXED_NOW = new Date("2026-09-19T12:00:00.000Z");

/** 25 threshold / 50 per-tx / 100 daily / 700 allowance (7x) / 30 days. */
export const DRAFT: AutoPayDraft = makeAutoPayDraft({
  executor: EXECUTOR,
  threshold: "25",
  perTxLimit: "50",
  dailyLimit: "100",
  allowedAssets: [ASSET_SAC],
  knownRecipientsOnly: true,
});

/** Always-ask baseline rule: no executor, `auto_approve_limit` 0, real USDC SAC. */
export const BASELINE_RULE: Rule = {
  auto_approve_limit: 0n,
  per_tx_limit: 500_000000n,
  daily_limit: 1_000_000000n,
  allowed_assets: [USDC_SAC],
  known_recipients_only: true,
};

/** Baseline allowance: 7x the daily limit, 30 days. */
export const BASELINE_ALLOWANCE = 7_000_000000n;
export const BASELINE_DAYS = 30;

/** A write-success RPC that serves every simulation with `okSim(void)`. */
export function writeRpc(): FakeGuardRpc {
  const rpc = new FakeGuardRpc();
  rpc.sims = [okSim(xdr.ScVal.scvVoid())];
  return rpc;
}

export function guardClient(rpc: FakeGuardRpc): GuardClient {
  return createGuardClient({
    contractId: GUARD_ID,
    rpc: rpc as unknown as GuardRpcLike,
    networkPassphrase: Networks.TESTNET,
    source: OWNER,
  });
}

export function rpcLike(rpc: FakeGuardRpc): GuardRpcLike {
  return rpc as unknown as GuardRpcLike;
}

export const TESTNET = Networks.TESTNET;

export function now(): Date {
  return new Date(FIXED_NOW);
}
