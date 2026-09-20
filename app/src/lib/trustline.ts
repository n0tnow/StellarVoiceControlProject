/**
 * The wallet's "Add asset" (trustline) flow (task W18).
 *
 * A Stellar account can only receive an issued asset (Circle-faucet USDC, the
 * SDF test anchor's SRT) after it opts in with a `changeTrust` operation. This
 * module composes the `@polaris/stellar` unsigned builder and pushes the
 * transaction through the **existing** approval pipeline (`runTx`: approval card
 * → Touch ID → sign in Rust → submit). No new signing path, no auto-approve.
 *
 * The display catalog and the pure trustline-state helpers live in
 * `walletAssets.ts`; the issuer pins live in `@polaris/stellar`.
 */
import type { ChainToolResult, Intent } from "@polaris/interfaces";

import { DEFAULT_EXPLORER_BASE } from "@/lib/history";
import { getStellarConfig } from "@/lib/stellarConfig";
import { runTx, type TxRunOutcome } from "@/lib/txPipeline";

export { TRUSTLINE_ASSETS, USDC_FAUCET_HINT, USDC_FAUCET_URL } from "@/lib/walletAssets";
export { hasTrustline, trustlineRows, type TrustlineRow } from "@/lib/walletAssets";

/**
 * Builds the unsigned trustline transaction for `code` against the active
 * owner account. Read-only until approved: no signing, no submission.
 */
export async function buildAddTrustline(code: string): Promise<ChainToolResult> {
  const config = await getStellarConfig();
  if (!config.ownerAddress) {
    throw new Error("POLARIS_OWNER_ADDRESS is not set");
  }
  const [{ createAddTrustline, defaultTrustlineAssets }, { Horizon }] = await Promise.all([
    import("@polaris/stellar"),
    import("@stellar/stellar-sdk"),
  ]);
  const server = new Horizon.Server(config.horizonUrl);
  const build = createAddTrustline({
    ownerAddress: config.ownerAddress,
    loadAccount: (address) => server.loadAccount(address),
    networkPassphrase: config.networkPassphrase,
    assets: defaultTrustlineAssets(),
    explorerBase: DEFAULT_EXPLORER_BASE,
  });
  return build(code);
}

/**
 * Builds and runs the trustline through the shared pipeline. Never throws: the
 * outcome is a discriminated `TxRunOutcome` a panel renders and settles on.
 */
export async function runAddTrustline(code: string): Promise<TxRunOutcome> {
  const label = `Add ${code.toUpperCase()} to your wallet`;
  let result: ChainToolResult;
  try {
    result = await buildAddTrustline(code);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { status: "failed", label, detail, atMs: Date.now() };
  }
  // `raw_tx` is the seam's "already-built XDR" kind: the pipeline signs exactly
  // this result and no chain tool rebuilds it.
  const intent: Intent = {
    kind: "raw_tx",
    asset: code.toUpperCase(),
    amount: "0",
    source: "wallet-add-asset",
  };
  return runTx(result, { intent, label });
}
