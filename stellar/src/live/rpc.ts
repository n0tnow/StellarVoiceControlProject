/**
 * Live RPC plumbing: a real `rpc.Server` plus a bounded wrapper that satisfies
 * the guard client's injected `GuardRpcLike` (and adds a hard timeout to every
 * call). No secrets, no signing here.
 *
 * The timeout implementation is the single one from `timeout.ts`
 * (`withNetworkTimeout` / `NetworkTimeoutError`); the names formerly defined
 * here are kept as backwards-compatible aliases so existing importers keep
 * compiling.
 */
import { rpc as StellarRpc } from "@stellar/stellar-sdk";
import type { GuardRpcLike } from "../guard/types.ts";
import { NETWORK_CALL_TIMEOUT_MS, withNetworkTimeout } from "./timeout.ts";

/** Default network-call timeout. The task caps every network call at 30 s. */
export const DEFAULT_RPC_TIMEOUT_MS = NETWORK_CALL_TIMEOUT_MS;

/** @deprecated Backwards-compatible alias of `NetworkTimeoutError`. */
export class RpcTimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} did not complete within ${ms} ms`);
    this.name = "RpcTimeoutError";
  }
}

/**
 * Race a promise against a hard timeout so no network call can hang a run.
 *
 * @deprecated Use `withNetworkTimeout(promise, label, ms)` from `timeout.ts`;
 * this adapter only preserves the old `(promise, ms, label)` argument order.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return withNetworkTimeout(promise, label, ms);
}

/** A Soroban RPC server bound to the configured (testnet-asserted) URL. */
export function createServer(url: string): StellarRpc.Server {
  if (!url.startsWith("https://")) {
    throw new Error(`refusing a non-HTTPS RPC URL: ${url}`);
  }
  return new StellarRpc.Server(url);
}

/**
 * Wrap a `rpc.Server` so every call the guard client makes is timeout-bounded.
 * The returned object is structurally the `GuardRpcLike` the client expects.
 */
export function createLiveRpc(server: StellarRpc.Server, timeoutMs = DEFAULT_RPC_TIMEOUT_MS): GuardRpcLike {
  return {
    getAccount: (address: string) => withNetworkTimeout(server.getAccount(address), "getAccount", timeoutMs),
    simulateTransaction: (tx) => withNetworkTimeout(server.simulateTransaction(tx), "simulateTransaction", timeoutMs),
    getLatestLedger: () => withNetworkTimeout(server.getLatestLedger(), "getLatestLedger", timeoutMs),
  };
}
