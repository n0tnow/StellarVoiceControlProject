/**
 * Live RPC plumbing: a real `rpc.Server` plus a bounded wrapper that satisfies
 * the guard client's injected `GuardRpcLike` (and adds a hard timeout to every
 * call). No secrets, no signing here.
 */
import { rpc as StellarRpc } from "@stellar/stellar-sdk";
import type { GuardRpcLike } from "../guard/types.ts";

/** Default network-call timeout. The task caps every network call at 30 s. */
export const DEFAULT_RPC_TIMEOUT_MS = 30_000;

export class RpcTimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} did not complete within ${ms} ms`);
    this.name = "RpcTimeoutError";
  }
}

/** Race a promise against a hard timeout so no network call can hang a run. */
export async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new RpcTimeoutError(label, ms)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
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
    getAccount: (address: string) => withTimeout(server.getAccount(address), timeoutMs, "getAccount"),
    simulateTransaction: (tx) => withTimeout(server.simulateTransaction(tx), timeoutMs, "simulateTransaction"),
    getLatestLedger: () => withTimeout(server.getLatestLedger(), timeoutMs, "getLatestLedger"),
  };
}
