/**
 * Preflight: before an anchor can pay us tokens the account must (1) exist on
 * the ledger (testnet: Friendbot funds it) and (2) trust the asset (a
 * `changeTrust` operation). Skipping either leaves a deposit stuck in
 * `pending_trust` — the exact failure seen in the SDF workshop demo.
 *
 * Idempotent: every step is skipped when already satisfied. All signing goes
 * through the injected `Signer`.
 */
import { Account, Asset, BASE_FEE, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import { assertSameTransaction } from "./describe.ts";
import { AnchorHttpError, requestJson } from "./http.ts";
import { balanceOf, hasTrustline, loadAccount, submitEnvelope, type HorizonAccount } from "./horizon.ts";
import { shortKey } from "./explain.ts";
import type { AnchorAsset, AnchorContext, Signer } from "./types.ts";

export interface AccountState {
  exists: boolean;
  xlmBalance: string;
  hasTrustline: boolean;
  assetBalance: string;
  raw?: HorizonAccount;
}

export async function inspectAccount(ctx: AnchorContext, account: string, asset: AnchorAsset): Promise<AccountState> {
  const raw = await loadAccount(ctx, account);
  const state: AccountState = {
    exists: !!raw,
    xlmBalance: balanceOf(raw, "native"),
    hasTrustline: hasTrustline(raw, asset),
    assetBalance: balanceOf(raw, asset),
  };
  if (raw) state.raw = raw;
  return state;
}

/** Unsigned `changeTrust` for `asset` (default limit = max). */
export function buildTrustlineTx(input: {
  account: string;
  sequence: string;
  networkPassphrase: string;
  asset: AnchorAsset;
}): string {
  return new TransactionBuilder(new Account(input.account, input.sequence), {
    fee: BASE_FEE,
    networkPassphrase: input.networkPassphrase,
  })
    .addOperation(Operation.changeTrust({ asset: new Asset(input.asset.code, input.asset.issuer) }))
    .setTimeout(300)
    .build()
    .toXDR();
}

export interface PreflightResult {
  account: string;
  /** What we had to do this run (empty when the account was already ready). */
  actions: Array<"friendbot_funded" | "trustline_created">;
  trustlineTxHash?: string;
  state: AccountState;
}

export interface PreflightOptions {
  /** Allow Friendbot funding (testnet only). Default true on testnet. */
  useFriendbot?: boolean;
  /** How long to wait for the ledger to reflect our writes. */
  settleTimeoutMs?: number;
}

async function waitForState(
  ctx: AnchorContext,
  account: string,
  asset: AnchorAsset,
  ok: (s: AccountState) => boolean,
  timeoutMs: number,
): Promise<AccountState> {
  const start = ctx.now().getTime();
  for (;;) {
    const s = await inspectAccount(ctx, account, asset);
    if (ok(s)) return s;
    if (ctx.now().getTime() - start >= timeoutMs) return s;
    await ctx.sleep(1000);
  }
}

export async function preflight(
  ctx: AnchorContext,
  signer: Signer,
  asset: AnchorAsset,
  opts: PreflightOptions = {},
): Promise<PreflightResult> {
  const account = await signer.publicKey();
  const isTestnet = ctx.networkPassphrase.startsWith("Test SDF");
  const useFriendbot = opts.useFriendbot ?? isTestnet;
  const settle = opts.settleTimeoutMs ?? 20_000;
  const actions: PreflightResult["actions"] = [];

  let state = await inspectAccount(ctx, account, asset);

  if (!state.exists) {
    if (!useFriendbot || !isTestnet) {
      throw new Error(`account ${shortKey(account)} does not exist on the network and cannot be funded automatically here`);
    }
    try {
      await requestJson(ctx, ctx.friendbotUrl, { query: { addr: account } });
    } catch (e) {
      // "already funded" races are fine; anything else is real.
      if (!(e instanceof AnchorHttpError && e.status === 400)) throw e;
    }
    state = await waitForState(ctx, account, asset, (s) => s.exists, settle);
    if (!state.exists) throw new Error(`Friendbot ran but ${shortKey(account)} still does not exist after ${settle / 1000}s`);
    actions.push("friendbot_funded");
    ctx.explain.record(
      "preflight.fund",
      `Preflight: ${shortKey(account)} was brand new, so the test-network faucet (Friendbot) sent it starter XLM.`,
      "A Stellar account does not exist until it holds a minimum XLM balance, and every transaction needs a small XLM fee. (On mainnet you would fund it yourself or have a sponsor pay.)",
    );
  }

  let trustlineTxHash: string | undefined;
  if (!state.hasTrustline) {
    const xdr = buildTrustlineTx({
      account,
      sequence: state.raw?.sequence ?? "0",
      networkPassphrase: ctx.networkPassphrase,
      asset,
    });
    const signed = await signer.signTransaction(xdr, { networkPassphrase: ctx.networkPassphrase });
    // Defence in depth: never submit an envelope that differs from the one we built.
    assertSameTransaction(xdr, signed, ctx.networkPassphrase);
    const out = await submitEnvelope(ctx, signed);
    trustlineTxHash = out.hash;
    state = await waitForState(ctx, account, asset, (s) => s.hasTrustline, settle);
    if (!state.hasTrustline) throw new Error(`trustline transaction ${out.hash} was accepted but is not visible yet`);
    actions.push("trustline_created");
    ctx.explain.record(
      "preflight.trustline",
      `Preflight: added a ${asset.code} trustline to ${shortKey(account)} (transaction ${out.hash.slice(0, 8)}...).`,
      `A trustline is the account opting in to hold ${asset.code}. Without it the anchor cannot pay us and holds the deposit in "pending_trust".`,
    );
  }

  if (actions.length === 0) {
    ctx.explain.record(
      "preflight.ready",
      `Preflight: ${shortKey(account)} already exists and already trusts ${asset.code} — nothing to set up.`,
      "Checking first means we never repeat a step or pay a needless fee.",
    );
  }
  const out: PreflightResult = { account, actions, state };
  if (trustlineTxHash) out.trustlineTxHash = trustlineTxHash;
  return out;
}
