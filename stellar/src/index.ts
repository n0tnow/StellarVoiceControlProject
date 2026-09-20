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
 * Chain-lane implementations live under `stellar/src/{payments,guard,approval,schedule,suggest,live}`; anchor in ./anchor; `swap`/`guardPolicy` remain stubs.
 */
// Real payment builder (Intent -> unsigned XDR + decoded summary). Configure it once
// with `configurePayments(deps)`; calling it before that throws a typed refusal.
// The shell's composition root (`app/src/lib/chain.ts`) needs the config and
// alias-book helpers too, so they are re-exported here.
export { sendPayment } from "./payments/index.ts";
// `payloadHashOf` is the Stellar *transaction hash* (`Transaction.hash()`), used
// by the chain summary / explorer URL. It is NOT the agent seam's `payloadHash`
// (that is the XDR digest, SHA-256 of the base64 unsigned-XDR string); never pass
// this value to the approval gate. Re-exported so callers can tell them apart.
export { payloadHashOf } from "./payments/index.ts";
export {
  configurePayments,
  createAddTrustline,
  defaultAssetRegistry,
  defaultPaymentDeps,
  defaultTrustlineAssets,
  parseAliasBook,
  resolveTrustlineAsset,
  toSdkAsset,
  PaymentRefusal,
  TrustlineRefusal,
  TESTNET_SRT_ISSUER,
  type AliasBook,
  type AssetRegistry,
  type AssetSpec,
  type PaymentDeps,
  type TrustlineDeps,
} from "./payments/index.ts";
export const swap = todo("swap");
export const guardPolicy = todo("guardPolicy");

// Anchor client (SEP-1/10/12/38/6): `depositTry`, `withdrawTry` and `submitSignedTx` live in
// ./anchor/chainTools.ts. `submitSignedTx` receives XDR only after the shell's Touch ID gate
// has approved the payload hash.
export { depositTry, withdrawTry, submitSignedTx, type SubmitResult } from "./anchor/chainTools.ts";
export * as anchor from "./anchor/index.ts";

/** Off-chain keeper that triggers due `polaris_guard` schedules (untrusted; see src/keeper/README.md). */
export * as keeper from "./keeper/index.ts";

/** Owner/executor-side `polaris_guard` client, SAC allowance helper and routing policy (contract id is a parameter). */
export * as guard from "./guard/index.ts";

/** App-side approval policy: profiles, auto-pay drafts, classification, read-back and the enable/disable builders (D10). */
export * as approval from "./approval/index.ts";

/** Schedule tools: unsigned `create_schedule`/`cancel_schedule` + "Upcoming payments" view models + time helpers. */
export * as schedule from "./schedule/index.ts";

/** Deterministic, offline suggestions engine (T3). Pure: never applies a change (D11). */
export * as suggest from "./suggest/index.ts";

/** P2P escrow client (W8): unsigned `create_offer`/`accept`/`confirm_fiat`/`cancel`/`reclaim` + read helpers (contract id is a parameter). */
export * as p2p from "./p2p/index.ts";
// Root type re-exports so the shell can type a P2P client without a namespace import.
export type { Offer, OfferState, P2pCall, P2pClient } from "./p2p/index.ts";
/**
 * Resequencing helpers for multi-step approval flows: every step built up front
 * embeds the same account sequence, so each one is rewritten to its source's
 * current next sequence right before it is approved. Re-exported for the app's
 * shared `txPipeline` (the single no-copy source is `live/submit.ts`).
 */
export { resequenceEnvelope, setSequence } from "./live/submit.ts";
