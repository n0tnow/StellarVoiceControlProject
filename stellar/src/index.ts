/**
 * @polaris/stellar — the chain layer.
 *
 * OWNERSHIP: Owner B owns this directory (`docs/interfaces.md` §5). You may
 * restructure it freely; the only fixed contract is `@polaris/interfaces`
 * (`Intent`, `ChainTool`, `ChainToolResult`).
 *
 * Skeleton status: this file holds the network constants and *stubs* that throw
 * `NotImplementedError`. Replace each stub during Milestone 3 (anchor, protocol
 * integration, guard contract bindings). Never touch a value-moving tool without
 * the Touch ID gate on the shell side (step A5).
 */
import type { ChainTool, ChainToolResult } from "@polaris/interfaces";

/** Testnet only — mainnet is an explicit non-goal (docs/architecture.md §1). */
export const TESTNET = {
  network: "testnet" as const,
  rpcUrl: "https://soroban-testnet.stellar.org",
  horizonUrl: "https://horizon-testnet.stellar.org",
  networkPassphrase: "Test SDF Network ; September 2015",
} as const;

/** Thrown by every placeholder below until Owner B implements it. */
export class NotImplementedError extends Error {
  constructor(what: string) {
    super(`${what} is not implemented yet (Milestone 3, Owner B)`);
    this.name = "NotImplementedError";
  }
}

function todo(tool: string): ChainTool {
  return async (intent): Promise<ChainToolResult> => {
    throw new NotImplementedError(`${tool} (intent: ${JSON.stringify(intent)})`);
  };
}

/**
 * Chain tools the agent may call. Every one returns an unsigned XDR plus a
 * summary decoded from it (`docs/interfaces.md` §2).
 *
 * TODO(B): implement in this order — `sendPayment` first (it is the M2 vertical
 * slice), then `depositTry` (SEP-10/38/6 mock anchor), then `swap`/`guardPolicy`.
 */
export const sendPayment = todo("sendPayment");
export const depositTry = todo("depositTry");
export const swap = todo("swap");
export const guardPolicy = todo("guardPolicy");

export interface SubmitResult {
  hash: string;
  explorerUrl: string;
}

/**
 * Submits a signed envelope. Receives XDR only after the shell's Touch ID gate
 * (`SigningService`, `docs/interfaces.md` §3) has approved the payload hash.
 *
 * TODO(B): submit via RPC and return an explorer URL (Stellar.Expert / Lab).
 */
export async function submitSignedTx(signedXdr: string): Promise<SubmitResult> {
  throw new NotImplementedError(`submitSignedTx (${signedXdr.length} chars of XDR)`);
}