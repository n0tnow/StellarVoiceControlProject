/**
 * The unsigned `changeTrust` builder behind the wallet's "Add asset" action
 * (task W18). A Stellar account cannot receive or hold an issued asset until it
 * opts in with a trustline, so a Circle-faucet USDC delivery or an anchor
 * deposit otherwise stalls (`pending_trust`).
 *
 * Boundaries (deliberate):
 *  - No signing, no submission, no Horizon calls. `loadAccount` is injected.
 *  - The asset is resolved from a pinned in-code catalog; an unknown code is
 *    refused, so an agent cannot add a look-alike trustline.
 *
 * Browser-safe: no `Buffer`, no `node:` imports.
 */
import {
  BASE_FEE,
  Operation,
  Transaction,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import type { ChainToolResult } from "@polaris/interfaces";
import { TESTNET_USDC_ISSUER, toSdkAsset, type AssetSpec } from "./assets.ts";
import type { AccountLike } from "./sendPayment.ts";
import { payloadHashOf, stroopsToXlm } from "./summary.ts";

/** The SDF public test anchor's SRT issuer (from its stellar.toml; testnet only). */
export const TESTNET_SRT_ISSUER = "GCDNJUBQSX7AJWLJACMJ7I4BC3Z47BQUTMHEICZLE6MU4KQBRYG5JY6B";

const DEFAULT_EXPLORER_BASE = "https://stellar.expert/explorer/testnet";

/** The assets the Wallet's "Add asset" list may add a trustline for. */
export function defaultTrustlineAssets(): AssetSpec[] {
  return [
    { code: "USDC", issuer: TESTNET_USDC_ISSUER, native: false },
    { code: "SRT", issuer: TESTNET_SRT_ISSUER, native: false },
  ];
}

/** Case-insensitive lookup of a pinned, non-native asset. */
export function resolveTrustlineAsset(
  assets: readonly AssetSpec[],
  code: string,
): AssetSpec | undefined {
  const wanted = code.trim().toUpperCase();
  return assets.find((spec) => !spec.native && spec.code.toUpperCase() === wanted);
}

export type TrustlineRefusalCode = "unsupported_asset" | "account_not_found";

/** Machine-readable refusal; the caller matches on `code`, never on `message`. */
export class TrustlineRefusal extends Error {
  readonly code: TrustlineRefusalCode;
  constructor(code: TrustlineRefusalCode, message: string) {
    super(message);
    this.name = "TrustlineRefusal";
    this.code = code;
  }
}

export interface TrustlineDeps {
  ownerAddress: string;
  loadAccount(address: string): Promise<AccountLike>;
  networkPassphrase: string;
  /** The pinned catalog; defaults to `defaultTrustlineAssets()`. */
  assets?: readonly AssetSpec[];
  explorerBase?: string;
  /** Injected clock for deterministic time bounds in tests. */
  now?: () => Date;
  /** Transaction validity window in seconds (default 300). */
  timeboundSeconds?: number;
}

export interface BuiltTrustlineSummary {
  summary: ChainToolResult["summary"];
  payloadHash: string;
}

function shortKey(address: string): string {
  return address.length > 8 ? `${address.slice(0, 4)}…${address.slice(-4)}` : address;
}

/** Decodes the `changeTrust` summary FROM the XDR (never from the requested code). */
export function buildTrustlineSummary(input: {
  unsignedXdr: string;
  networkPassphrase: string;
  explorerBase?: string;
}): BuiltTrustlineSummary {
  const tx = TransactionBuilder.fromXDR(input.unsignedXdr, input.networkPassphrase);
  if (!(tx instanceof Transaction)) throw new Error("fee-bump envelopes are not supported for trustlines");
  const op = tx.operations[0];
  if (!op || op.type !== "changeTrust") throw new Error("the built transaction is not a change_trust");
  const line = op.line as { code?: string; issuer?: string; isNative?: () => boolean } | undefined;
  if (!line || typeof line.isNative !== "function" || line.isNative()) {
    throw new Error("the built change_trust does not target an issued asset");
  }
  const code = line.code ?? "?";
  const issuer = line.issuer ?? "";
  const payloadHash = payloadHashOf(input.unsignedXdr, input.networkPassphrase);
  const fee = `${stroopsToXlm(tx.fee)} XLM`;
  const summary: ChainToolResult["summary"] = {
    title: `Add ${code} to your wallet`,
    lines: [
      `Trust ${code} (issuer ${shortKey(issuer)})`,
      `To ${tx.source}`,
      `Network: ${input.networkPassphrase}`,
      `Fee: ${fee}`,
      "Without a trustline this account cannot receive or hold the asset.",
    ],
    explorerUrl: `${input.explorerBase ?? DEFAULT_EXPLORER_BASE}/tx/${payloadHash}`,
    estimatedFee: fee,
  };
  return { summary, payloadHash };
}

/**
 * Builds the unsigned `changeTrust` for `assetCode` on the injected owner
 * account. The sequence/fee and a short upper time bound mirror `sendPayment`.
 * A non-native asset always uses the SDK's default maximum limit.
 */
export function createAddTrustline(deps: TrustlineDeps) {
  const catalog = deps.assets ?? defaultTrustlineAssets();
  return async (assetCode: string): Promise<ChainToolResult> => {
    const spec = resolveTrustlineAsset(catalog, assetCode);
    if (!spec) {
      throw new TrustlineRefusal(
        "unsupported_asset",
        `${JSON.stringify(assetCode)} is not an asset this wallet can add`,
      );
    }

    let source: AccountLike;
    try {
      source = await deps.loadAccount(deps.ownerAddress);
    } catch (error) {
      throw new TrustlineRefusal(
        "account_not_found",
        `could not load the owner account ${deps.ownerAddress}: ${(error as Error).message}`,
      );
    }

    const now = deps.now ? deps.now() : new Date();
    const windowSeconds = deps.timeboundSeconds ?? 300;
    const unsignedXdr = new TransactionBuilder(source, {
      fee: BASE_FEE,
      networkPassphrase: deps.networkPassphrase,
      timebounds: { minTime: 0, maxTime: new Date(now.getTime() + windowSeconds * 1000) },
    })
      .addOperation(Operation.changeTrust({ asset: toSdkAsset(spec) }))
      .build()
      .toXDR();

    const { summary } = buildTrustlineSummary({
      unsignedXdr,
      networkPassphrase: deps.networkPassphrase,
      ...(deps.explorerBase ? { explorerBase: deps.explorerBase } : {}),
    });
    return { unsignedXdr, summary };
  };
}
