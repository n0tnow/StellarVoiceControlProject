/**
 * `@polaris/stellar` payments: the real `sendPayment` ChainTool.
 *
 * Public surface:
 *   - `createSendPayment(deps)`        — build a tool with injected dependencies.
 *   - `configurePayments(deps)`        — install the process-wide default tool.
 *   - `sendPayment`                    — the configured default (throws
 *                                        `PaymentRefusal("not_configured")` before config).
 *   - `defaultPaymentDeps(env)`        — wires real Horizon `loadAccount`
 *                                        (NOT executed in tests).
 */
export {
  findAliasCollisions,
  parseAliasBook,
  resolveAlias,
  type AliasBook,
  type AliasEntry,
  type ParsedAliasBook,
} from "./aliases.ts";
export {
  defaultAssetRegistry,
  toSdkAsset,
  TESTNET_USDC_ISSUER,
  type AssetRegistry,
  type AssetSpec,
} from "./assets.ts";
export {
  buildPaymentSummary,
  formatAmount,
  payloadHashOf,
  stroopsToXlm,
  toHex,
  type BuiltPaymentSummary,
  type PaymentSummaryInput,
} from "./summary.ts";
export {
  createSendPayment,
  PaymentRefusal,
  type AccountLike,
  type PaymentChainTool,
  type PaymentDeps,
  type PaymentIntent,
  type PaymentMode,
  type PaymentRefusalCode,
  type PaymentRoute,
} from "./sendPayment.ts";
export {
  buildTrustlineSummary,
  createAddTrustline,
  defaultTrustlineAssets,
  resolveTrustlineAsset,
  TESTNET_SRT_ISSUER,
  TrustlineRefusal,
  type BuiltTrustlineSummary,
  type TrustlineDeps,
  type TrustlineRefusalCode,
} from "./trustline.ts";

import { Horizon } from "@stellar/stellar-sdk";
import type { ChainTool } from "@polaris/interfaces";
import { TESTNET_HORIZON_URL, TESTNET_PASSPHRASE } from "../anchor/config.ts";
import type { AliasBook } from "./aliases.ts";
import { defaultAssetRegistry } from "./assets.ts";
import { createSendPayment, PaymentRefusal, type PaymentDeps } from "./sendPayment.ts";

let active: ChainTool | undefined;

/** Installs the process-wide payment tool (call once at app start). */
export function configurePayments(deps: PaymentDeps): ChainTool {
  active = createSendPayment(deps);
  return active;
}

/** The installed tool, or a typed `not_configured` refusal. */
export function getConfiguredPayments(): ChainTool {
  if (!active) {
    throw new PaymentRefusal("not_configured", "payments are not configured: call configurePayments(deps) first");
  }
  return active;
}

/** The configured default `sendPayment`. Throws `PaymentRefusal` before configuration. */
export const sendPayment: ChainTool = (intent) => getConfiguredPayments()(intent);

export interface PaymentEnv {
  ownerAddress: string;
  aliases: AliasBook;
  horizonUrl?: string;
  networkPassphrase?: string;
  explorerBase?: string;
}

/**
 * The only place real network dependencies are wired. Test code never calls
 * this; only the app/bootstrap does. `loadAccount` hits Horizon lazily.
 */
export function defaultPaymentDeps(env: PaymentEnv): PaymentDeps {
  const horizonUrl = env.horizonUrl ?? TESTNET_HORIZON_URL;
  const server = new Horizon.Server(horizonUrl);
  return {
    ownerAddress: env.ownerAddress,
    aliases: env.aliases,
    loadAccount: (address) => server.loadAccount(address),
    networkPassphrase: env.networkPassphrase ?? TESTNET_PASSPHRASE,
    horizonUrl,
    explorerBase: env.explorerBase ?? "https://stellar.expert/explorer/testnet",
    assets: defaultAssetRegistry(),
  };
}
