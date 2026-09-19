/**
 * AnchorSession — the high-level object the agent drives. Each public method is
 * ONE narratable step and returns `{ data, explain }`, where `explain` holds the
 * plain-English records that step produced (including any prerequisite steps it
 * ran implicitly, e.g. discovery or SEP-10 login).
 *
 * The session never holds a key: all signing goes through the injected Signer.
 */
import { DEFAULT_ASSET_CODE, DEFAULT_HOME_DOMAIN, TESTNET_FRIENDBOT_URL, TESTNET_HORIZON_URL, TESTNET_PASSPHRASE } from "./config.ts";
import { ExplainLog, shortKey } from "./explain.ts";
import { balanceOf, loadAccount, submitEnvelope, explorerTxUrl } from "./horizon.ts";
import { preflight, type PreflightOptions, type PreflightResult } from "./preflight.ts";
import { authenticate, isExpired } from "./sep10.ts";
import { discoverAnchor, findAsset, normaliseHomeDomain } from "./sep1.ts";
import { ensureCustomer, type CustomerInfo } from "./sep12.ts";
import { getPrice } from "./sep38.ts";
import {
  buildWithdrawPayment,
  getInfo,
  getTransaction,
  listTransactions,
  pollTransaction,
  startDeposit,
  startWithdraw,
  type PollOptions,
  type PollResult,
  type Sep6Info,
} from "./sep6.ts";
import { simulateBankTransfer } from "./sandbox.ts";
import { fiatAssetId, stellarAssetId } from "./types.ts";
import type {
  AnchorAsset,
  AnchorContext,
  AnchorToml,
  AnchorTransaction,
  AuthToken,
  DepositInstructions,
  FetchLike,
  Quote,
  Signer,
  StepResult,
  WithdrawInstructions,
} from "./types.ts";

export interface AnchorSessionConfig {
  signer: Signer;
  /** Anchor home domain (SEP-1). Default: the TR mock anchor. */
  homeDomain?: string;
  /** On-chain asset code to move. Default USDC. */
  assetCode?: string;
  fetch?: FetchLike;
  horizonUrl?: string;
  friendbotUrl?: string;
  networkPassphrase?: string;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  requestTimeoutMs?: number;
  /** Share a log with other components (e.g. the narrator). */
  explain?: ExplainLog;
}

const DECIMAL = /^\d+(\.\d{1,7})?$/;

/** Rejects floats-as-numbers, negatives, zero and >7 decimals. */
export function assertAmount(amount: string, label = "amount"): void {
  if (typeof amount !== "string" || !DECIMAL.test(amount) || Number(amount) <= 0) {
    throw new Error(`${label} must be a positive decimal string with at most 7 decimals, got ${JSON.stringify(amount)}`);
  }
}

export class AnchorSession {
  readonly explain: ExplainLog;
  readonly ctx: AnchorContext;
  readonly homeDomain: string;
  readonly assetCode: string;
  private readonly signer: Signer;
  private tomlCache: AnchorToml | undefined;
  private tokenCache: AuthToken | undefined;
  private customerOk = false;
  private assetCache: (AnchorAsset & { fiat?: string }) | undefined;

  constructor(config: AnchorSessionConfig) {
    this.signer = config.signer;
    this.homeDomain = normaliseHomeDomain(config.homeDomain ?? DEFAULT_HOME_DOMAIN);
    this.assetCode = config.assetCode ?? DEFAULT_ASSET_CODE;
    this.explain = config.explain ?? new ExplainLog(config.now);
    this.ctx = {
      fetch: config.fetch ?? ((input, init) => fetch(input, init)),
      explain: this.explain,
      horizonUrl: (config.horizonUrl ?? TESTNET_HORIZON_URL).replace(/\/$/, ""),
      friendbotUrl: config.friendbotUrl ?? TESTNET_FRIENDBOT_URL,
      networkPassphrase: config.networkPassphrase ?? TESTNET_PASSPHRASE,
      sleep: config.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
      now: config.now ?? (() => new Date()),
      requestTimeoutMs: config.requestTimeoutMs ?? 20_000,
    };
  }

  // ---- plumbing ----

  private async step<T>(fn: () => Promise<T>): Promise<StepResult<T>> {
    const mark = this.explain.mark();
    const data = await fn();
    return { data, explain: this.explain.since(mark) };
  }

  private async toml(): Promise<AnchorToml> {
    if (!this.tomlCache) this.tomlCache = await discoverAnchor(this.ctx, this.homeDomain);
    return this.tomlCache;
  }

  private async asset(): Promise<AnchorAsset & { fiat?: string }> {
    if (!this.assetCache) {
      const found = findAsset(await this.toml(), this.assetCode);
      const a: AnchorAsset & { fiat?: string } = { code: found.code, issuer: found.issuer };
      if (found.anchorAsset) a.fiat = found.anchorAsset;
      this.assetCache = a;
    }
    return this.assetCache;
  }

  private async fiat(): Promise<string> {
    return (await this.asset()).fiat ?? "TRY";
  }

  private async token(): Promise<AuthToken> {
    if (isExpired(this.tokenCache, this.ctx.now())) {
      this.tokenCache = await authenticate(this.ctx, await this.toml(), this.signer);
    }
    return this.tokenCache as AuthToken;
  }

  private async kyc(): Promise<CustomerInfo | undefined> {
    if (this.customerOk) return undefined;
    const info = await ensureCustomer(this.ctx, await this.toml(), await this.token());
    this.customerOk = true;
    return info;
  }

  // ---- steps the agent can call ----

  /** SEP-1: learn the anchor's endpoints from its domain. */
  discover(): Promise<StepResult<AnchorToml>> {
    return this.step(() => this.toml());
  }

  /** SEP-6 /info for our asset. */
  info(): Promise<StepResult<Sep6Info>> {
    return this.step(async () => getInfo(this.ctx, await this.toml(), this.assetCode));
  }

  /** SEP-10: log in by signing the anchor's challenge (cached until near expiry). */
  login(): Promise<StepResult<AuthToken>> {
    return this.step(() => this.token());
  }

  /** SEP-12: register as a customer (auto-approved on the mock). */
  registerCustomer(): Promise<StepResult<CustomerInfo | undefined>> {
    return this.step(() => this.kyc());
  }

  /** Friendbot funding (testnet) + asset trustline, through the injected signer. Idempotent. */
  prepareAccount(opts?: PreflightOptions): Promise<StepResult<PreflightResult>> {
    return this.step(async () => preflight(this.ctx, this.signer, await this.asset(), opts));
  }

  /** SEP-38 indicative quote: how much asset does `amountFiat` of local currency buy? */
  quoteDeposit(amountFiat: string): Promise<StepResult<Quote>> {
    return this.step(async () => {
      assertAmount(amountFiat, "deposit amount");
      const [toml, asset, fiat] = await Promise.all([this.toml(), this.asset(), this.fiat()]);
      return getPrice(
        this.ctx,
        toml,
        { sellAsset: fiatAssetId(fiat), buyAsset: stellarAssetId(asset), sellAmount: amountFiat, deliveryMethod: "bank_account" },
        `if you deposit ${amountFiat} ${fiat}, how much ${asset.code} would you get?`,
      );
    });
  }

  /** SEP-38 indicative quote: how much local currency does `amountAsset` cash out to? */
  quoteWithdraw(amountAsset: string): Promise<StepResult<Quote>> {
    return this.step(async () => {
      assertAmount(amountAsset, "withdraw amount");
      const [toml, asset, fiat] = await Promise.all([this.toml(), this.asset(), this.fiat()]);
      return getPrice(
        this.ctx,
        toml,
        { sellAsset: stellarAssetId(asset), buyAsset: fiatAssetId(fiat), sellAmount: amountAsset, deliveryMethod: "bank_account" },
        `if you cash out ${amountAsset} ${asset.code}, how much ${fiat} would you get?`,
      );
    });
  }

  /**
   * SEP-6 deposit. Runs prerequisites (discover, login, KYC) as needed. Does NOT
   * fund the account: call `prepareAccount()` first (or use `waitForTransaction`,
   * which repairs `pending_trust`).
   */
  startDeposit(amountFiat: string): Promise<StepResult<DepositInstructions>> {
    return this.step(async () => {
      assertAmount(amountFiat, "deposit amount");
      await this.kyc();
      return startDeposit(this.ctx, await this.toml(), await this.token(), {
        assetCode: this.assetCode,
        account: await this.signer.publicKey(),
        amount: amountFiat,
        fiatCode: await this.fiat(),
      });
    });
  }

  /** SEP-6 withdraw request. Returns the account + memo we must pay; call `payWithdrawal` next. */
  startWithdraw(amountAsset: string): Promise<StepResult<WithdrawInstructions>> {
    return this.step(async () => {
      assertAmount(amountAsset, "withdraw amount");
      await this.kyc();
      return startWithdraw(this.ctx, await this.toml(), await this.token(), {
        assetCode: this.assetCode,
        account: await this.signer.publicKey(),
        amount: amountAsset,
      });
    });
  }

  /** Pays the anchor the on-chain asset it asked for (signed via the injected Signer). */
  payWithdrawal(w: WithdrawInstructions, amountAsset: string): Promise<StepResult<{ hash: string; explorerUrl: string }>> {
    return this.step(async () => {
      assertAmount(amountAsset, "payment amount");
      const account = await this.signer.publicKey();
      const acct = await loadAccount(this.ctx, account);
      if (!acct) throw new Error(`account ${shortKey(account)} does not exist yet`);
      const asset = await this.asset();
      const have = balanceOf(acct, asset);
      if (Number(have) < Number(amountAsset)) {
        throw new Error(`not enough ${asset.code}: have ${have}, need ${amountAsset}`);
      }
      const xdr = buildWithdrawPayment({
        sourceAccount: account,
        sequence: acct.sequence,
        networkPassphrase: this.ctx.networkPassphrase,
        asset,
        amount: amountAsset,
        destination: w.accountId,
        memo: w.memo,
        memoType: w.memoType,
      });
      const signed = await this.signer.signTransaction(xdr, { networkPassphrase: this.ctx.networkPassphrase });
      const out = await submitEnvelope(this.ctx, signed);
      const explorerUrl = explorerTxUrl(out.hash, this.ctx.networkPassphrase);
      this.explain.record(
        "withdraw.pay",
        `Sent ${amountAsset} ${asset.code} to the anchor's account ${shortKey(w.accountId)}${w.memo ? ` with memo ${w.memo}` : ""} ` +
          `(transaction ${out.hash.slice(0, 8)}...).`,
        "This on-chain payment is the anchor's trigger: when it sees the tokens and memo it pays out the local currency to your bank.",
      );
      return { hash: out.hash, explorerUrl };
    });
  }

  /**
   * Polls an order to a final status. If the anchor reports `pending_trust` the
   * session repairs it (adds the trustline through the signer) and keeps polling.
   */
  waitForTransaction(id: string, opts: Omit<PollOptions, "onPendingTrust"> = {}): Promise<StepResult<PollResult>> {
    return this.step(async () =>
      pollTransaction(this.ctx, await this.toml(), await this.token(), id, {
        ...opts,
        onPendingTrust: async () => {
          this.explain.record(
            "sep6.repair_trust",
            "The anchor is stuck waiting for a trustline, so we are adding it now.",
            "Once the trustline exists the anchor's pending payment can go through — no need to start over.",
          );
          await preflight(this.ctx, this.signer, await this.asset());
        },
      }),
    );
  }

  /** Fetch one order. */
  transaction(id: string): Promise<StepResult<AnchorTransaction>> {
    return this.step(async () => getTransaction(this.ctx, await this.toml(), await this.token(), id));
  }

  /** Past orders for our asset. */
  history(): Promise<StepResult<AnchorTransaction[]>> {
    return this.step(async () => listTransactions(this.ctx, await this.toml(), await this.token(), this.assetCode));
  }

  /** On-chain balance of the anchor asset, from Horizon. */
  balance(): Promise<StepResult<{ asset: string; balance: string }>> {
    return this.step(async () => {
      const account = await this.signer.publicKey();
      const asset = await this.asset();
      const bal = balanceOf(await loadAccount(this.ctx, account), asset);
      this.explain.record(
        "horizon.balance",
        `Checked the ledger: ${shortKey(account)} holds ${bal} ${asset.code}.`,
        "The blockchain is the source of truth for the balance, not the anchor's word.",
      );
      return { asset: asset.code, balance: bal };
    });
  }

  /** SANDBOX ONLY: play the bank for a deposit order (see sandbox.ts). */
  simulateBank(id: string, amountFiat: string): Promise<StepResult<void>> {
    return this.step(async () => simulateBankTransfer(this.ctx, await this.toml(), id, amountFiat, await this.fiat()));
  }
}
