/**
 * SEP-6: programmatic deposit / withdraw. Plain HTTP — the wallet builds its own
 * UI; there is no hosted/interactive page involved (see README).
 *
 *   deposit  (off-chain TRY -> on-chain USDC): anchor returns bank instructions;
 *            when the bank transfer arrives the anchor pays USDC on Stellar.
 *   withdraw (on-chain USDC -> off-chain TRY): anchor returns an account + memo;
 *            WE pay USDC to that account with that memo, then the anchor pays TRY.
 */
import { Account, Asset, BASE_FEE, Memo, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import { AnchorHttpError, requestJson } from "./http.ts";
import { shortKey } from "./explain.ts";
import { KycRequiredError } from "./sep12.ts";
import type {
  AnchorAsset,
  AnchorContext,
  AnchorToml,
  AnchorTransaction,
  AuthToken,
  DepositInstructions,
  TxStatus,
  WithdrawInstructions,
} from "./types.ts";

// ---------- info ----------

export interface Sep6AssetInfo {
  enabled: boolean;
  minAmount?: number;
  maxAmount?: number;
  feePercent?: number;
  feeFixed?: number;
}

export interface Sep6Info {
  deposit: Record<string, Sep6AssetInfo>;
  withdraw: Record<string, Sep6AssetInfo>;
  raw: Record<string, unknown>;
}

function parseAssetInfoMap(v: unknown): Record<string, Sep6AssetInfo> {
  const out: Record<string, Sep6AssetInfo> = {};
  if (!v || typeof v !== "object") return out;
  for (const [code, info] of Object.entries(v as Record<string, Record<string, unknown>>)) {
    const a: Sep6AssetInfo = { enabled: info.enabled === true };
    if (typeof info.min_amount === "number") a.minAmount = info.min_amount;
    if (typeof info.max_amount === "number") a.maxAmount = info.max_amount;
    if (typeof info.fee_percent === "number") a.feePercent = info.fee_percent;
    if (typeof info.fee_fixed === "number") a.feeFixed = info.fee_fixed;
    out[code] = a;
  }
  return out;
}

export async function getInfo(ctx: AnchorContext, toml: AnchorToml, assetCode: string): Promise<Sep6Info> {
  const raw = await requestJson<Record<string, unknown>>(ctx, `${toml.transferServer}/info`);
  const info: Sep6Info = { deposit: parseAssetInfoMap(raw.deposit), withdraw: parseAssetInfoMap(raw.withdraw), raw };
  const d = info.deposit[assetCode]?.enabled ? "deposits" : null;
  const w = info.withdraw[assetCode]?.enabled ? "withdrawals" : null;
  const both = [d, w].filter(Boolean).join(" and ") || "nothing";
  ctx.explain.record(
    "sep6.info",
    `SEP-6: asked the anchor what it supports for ${assetCode}: ${both}.`,
    "Anchors differ in which assets and directions they offer, so we check before promising anything.",
  );
  return info;
}

// ---------- start deposit / withdraw ----------

export interface DepositParams {
  assetCode: string;
  account: string;
  /** Amount of the OFF-CHAIN currency the user sends (TRY for the Turkish anchor), decimal string. */
  amount: string;
  /** Delivery method, e.g. "bank_account". */
  type?: string;
  memo?: string;
  /** Off-chain currency code used only for narration, e.g. "TRY". */
  fiatCode?: string;
}

export interface WithdrawParams {
  assetCode: string;
  account: string;
  /** Amount of the ON-CHAIN asset the user sends (USDC), decimal string. */
  amount: string;
  type?: string;
  /** Destination bank account, if the anchor asks for one. */
  dest?: string;
}

function toKycError(e: AnchorHttpError): KycRequiredError | undefined {
  const t = e.errorType;
  if (e.status !== 403 || !t) return undefined;
  const body = e.body as { fields?: unknown; status?: string; more_info_url?: string };
  if (t === "non_interactive_customer_info_needed") {
    const fields = Array.isArray(body.fields) ? body.fields.filter((f): f is string => typeof f === "string") : [];
    return new KycRequiredError(`the anchor needs more customer information: ${fields.join(", ")}`, "NEEDS_INFO", fields);
  }
  if (t === "customer_info_status") {
    const st = body.status ?? "PROCESSING";
    return new KycRequiredError(`the anchor is still reviewing our customer information (${st})`, st, []);
  }
  return undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

export async function startDeposit(
  ctx: AnchorContext,
  toml: AnchorToml,
  token: AuthToken,
  p: DepositParams,
): Promise<DepositInstructions> {
  const type = p.type ?? "bank_account";
  let raw: Record<string, unknown>;
  try {
    raw = await requestJson<Record<string, unknown>>(ctx, `${toml.transferServer}/deposit`, {
      bearer: token.jwt,
      query: { asset_code: p.assetCode, account: p.account, amount: p.amount, type, funding_method: type, memo: p.memo },
    });
  } catch (e) {
    if (e instanceof AnchorHttpError) {
      const kyc = toKycError(e);
      if (kyc) throw kyc;
    }
    throw e;
  }
  if (typeof raw.id !== "string") throw new Error("anchor returned no transaction id for the deposit");
  const out: DepositInstructions = { id: raw.id, raw };
  if (typeof raw.how === "string") out.how = raw.how;
  if (raw.instructions && typeof raw.instructions === "object") {
    out.instructions = raw.instructions as DepositInstructions["instructions"] & object;
  }
  const min = num(raw.min_amount);
  if (min !== undefined) out.minAmount = min;
  const max = num(raw.max_amount);
  if (max !== undefined) out.maxAmount = max;
  const fee = num(raw.fee_percent);
  if (fee !== undefined) out.feePercent = fee;
  const eta = num(raw.eta);
  if (eta !== undefined) out.eta = eta;
  ctx.explain.record(
    "sep6.deposit",
    `SEP-6: asked the anchor to turn ${p.amount} ${p.fiatCode ?? "of your local currency"} into ${p.assetCode} on ${shortKey(p.account)}. ` +
      `It created order ${out.id} and told us how to pay by bank transfer.`,
    "The order is the anchor's promise: once its bank receives your transfer, it pays the tokens straight to your Stellar account.",
  );
  return out;
}

export async function startWithdraw(
  ctx: AnchorContext,
  toml: AnchorToml,
  token: AuthToken,
  p: WithdrawParams,
): Promise<WithdrawInstructions> {
  const type = p.type ?? "bank_account";
  let raw: Record<string, unknown>;
  try {
    raw = await requestJson<Record<string, unknown>>(ctx, `${toml.transferServer}/withdraw`, {
      bearer: token.jwt,
      query: { asset_code: p.assetCode, account: p.account, amount: p.amount, type, funding_method: type, dest: p.dest },
    });
  } catch (e) {
    if (e instanceof AnchorHttpError) {
      const kyc = toKycError(e);
      if (kyc) throw kyc;
    }
    throw e;
  }
  const accountId = raw.account_id;
  if (typeof accountId !== "string") throw new Error("anchor did not say which account to pay for the withdrawal");
  const id = typeof raw.id === "string" ? raw.id : undefined;
  if (!id) throw new Error("anchor returned no transaction id for the withdrawal");
  const out: WithdrawInstructions = { id, accountId, raw };
  if (typeof raw.memo === "string" || typeof raw.memo === "number") out.memo = String(raw.memo);
  if (typeof raw.memo_type === "string") out.memoType = raw.memo_type;
  const min = num(raw.min_amount);
  if (min !== undefined) out.minAmount = min;
  const max = num(raw.max_amount);
  if (max !== undefined) out.maxAmount = max;
  const fee = num(raw.fee_percent);
  if (fee !== undefined) out.feePercent = fee;
  const eta = num(raw.eta);
  if (eta !== undefined) out.eta = eta;
  ctx.explain.record(
    "sep6.withdraw",
    `SEP-6: asked the anchor to cash out ${p.amount} ${p.assetCode}. It created order ${id} and told us to pay ${shortKey(accountId)}` +
      `${out.memo ? ` with memo ${out.memo}` : ""}.`,
    "The memo is a reference number: it is how the anchor matches our on-chain payment to this order, so it must be included exactly.",
  );
  return out;
}

/**
 * Builds the on-chain payment that funds a withdrawal (unsigned XDR). Pure and
 * unit-tested; the memo type from the anchor is honoured (text | id | hash).
 */
export function buildWithdrawPayment(input: {
  sourceAccount: string;
  sequence: string;
  networkPassphrase: string;
  asset: AnchorAsset;
  amount: string;
  destination: string;
  memo?: string | undefined;
  memoType?: string | undefined;
  fee?: string;
  timeoutSeconds?: number;
}): string {
  const b = new TransactionBuilder(new Account(input.sourceAccount, input.sequence), {
    fee: input.fee ?? BASE_FEE,
    networkPassphrase: input.networkPassphrase,
  });
  b.addOperation(
    Operation.payment({
      destination: input.destination,
      asset: new Asset(input.asset.code, input.asset.issuer),
      amount: input.amount,
    }),
  );
  if (input.memo !== undefined && input.memo !== "") {
    const t = input.memoType ?? "text";
    if (t === "text") b.addMemo(Memo.text(input.memo));
    else if (t === "id") b.addMemo(Memo.id(input.memo));
    else if (t === "hash") b.addMemo(Memo.hash(input.memo));
    else throw new Error(`unsupported withdrawal memo type "${t}"`);
  }
  b.setTimeout(input.timeoutSeconds ?? 300);
  return b.build().toXDR();
}

// ---------- transactions ----------

/** Normalises an anchor transaction record. */
export function parseTransaction(raw: Record<string, unknown>): AnchorTransaction {
  const s = (k: string): string | undefined => (typeof raw[k] === "string" ? (raw[k] as string) : undefined);
  const tx: AnchorTransaction = {
    id: s("id") ?? "",
    kind: s("kind") ?? "",
    status: s("status") ?? "error",
    raw,
  };
  const set = <K extends keyof AnchorTransaction>(k: K, v: AnchorTransaction[K] | undefined): void => {
    if (v !== undefined) tx[k] = v;
  };
  set("message", s("message"));
  set("moreInfoUrl", s("more_info_url"));
  set("amountIn", s("amount_in"));
  set("amountInAsset", s("amount_in_asset"));
  set("amountOut", s("amount_out"));
  set("amountOutAsset", s("amount_out_asset"));
  set("amountFee", s("amount_fee"));
  set("amountFeeAsset", s("amount_fee_asset"));
  set("stellarTransactionId", s("stellar_transaction_id"));
  set("externalTransactionId", s("external_transaction_id"));
  set("withdrawAnchorAccount", s("withdraw_anchor_account"));
  set("withdrawMemo", s("withdraw_memo"));
  set("withdrawMemoType", s("withdraw_memo_type"));
  set("startedAt", s("started_at"));
  if (raw.completed_at === null || typeof raw.completed_at === "string") tx.completedAt = raw.completed_at as string | null;
  return tx;
}

export async function getTransaction(ctx: AnchorContext, toml: AnchorToml, token: AuthToken, id: string): Promise<AnchorTransaction> {
  const res = await requestJson<{ transaction?: Record<string, unknown> }>(ctx, `${toml.transferServer}/transaction`, {
    bearer: token.jwt,
    query: { id },
  });
  if (!res.transaction) throw new Error(`anchor has no transaction ${id}`);
  return parseTransaction(res.transaction);
}

export async function listTransactions(
  ctx: AnchorContext,
  toml: AnchorToml,
  token: AuthToken,
  assetCode: string,
): Promise<AnchorTransaction[]> {
  const res = await requestJson<{ transactions?: Array<Record<string, unknown>> }>(ctx, `${toml.transferServer}/transactions`, {
    bearer: token.jwt,
    query: { asset_code: assetCode, account: token.account },
  });
  return (res.transactions ?? []).map(parseTransaction);
}

// ---------- status state machine ----------

export const FINAL_STATUSES: readonly string[] = ["completed", "refunded", "expired", "no_market", "too_small", "too_large", "error"];

export type StatusClass = "in_progress" | "needs_trustline" | "needs_user" | "waiting_user_transfer" | "success" | "failed";

/** Pure classification of a SEP-6 status; unit-tested. */
export function classifyStatus(status: TxStatus): StatusClass {
  switch (status) {
    case "completed":
      return "success";
    case "refunded":
    case "expired":
    case "no_market":
    case "too_small":
    case "too_large":
    case "error":
      return "failed";
    case "pending_trust":
      return "needs_trustline";
    case "pending_user":
    case "incomplete":
      return "needs_user";
    case "pending_user_transfer_start":
      return "waiting_user_transfer";
    default:
      return "in_progress";
  }
}

/** Plain-English narration for a status, phrased for the given direction. */
export function explainStatus(kind: string, tx: Pick<AnchorTransaction, "status" | "message">): { what: string; why: string } {
  const deposit = kind.startsWith("deposit");
  const msg = tx.message ? ` Anchor says: "${tx.message}"` : "";
  switch (tx.status) {
    case "pending_user_transfer_start":
      return deposit
        ? { what: `The anchor is waiting for your bank transfer.${msg}`, why: "Nothing is paid out until its bank sees the money." }
        : { what: `The anchor is waiting for your on-chain payment.${msg}`, why: "The cash-out starts only after the tokens arrive with the right memo." };
    case "pending_user_transfer_complete":
      return { what: `The anchor has seen your payment and is preparing the payout.${msg}`, why: "It has to confirm funds before releasing the other side." };
    case "pending_external":
      return { what: `The anchor is waiting on an external system (bank or blockchain).${msg}`, why: "Bank rails and confirmations take a moment; nothing is needed from you." };
    case "pending_anchor":
      return { what: `The anchor is processing the order.${msg}`, why: "It is converting the funds and preparing the payout." };
    case "pending_stellar":
      return { what: `The anchor is submitting the Stellar transaction.${msg}`, why: "Once it lands in a ledger the tokens are yours." };
    case "pending_trust":
      return {
        what: `The anchor is HOLDING the deposit because our account has no trustline for the asset yet.${msg}`,
        why: "A Stellar account can only receive an asset after it opts in with a trustline, so the anchor cannot pay until we add one.",
      };
    case "pending_user":
      return { what: `The anchor needs something from us before it can continue.${msg}`, why: "Usually extra identity data or an approval." };
    case "incomplete":
      return { what: `The order is not complete yet.${msg}`, why: "The anchor is still waiting for required input." };
    case "completed":
      return { what: `The order is complete.${msg}`, why: "Both sides of the swap have been paid." };
    case "refunded":
      return { what: `The order was refunded.${msg}`, why: "The anchor could not complete it and returned the funds." };
    case "expired":
      return { what: `The order expired before the payment arrived.${msg}`, why: "Anchors cancel orders that are not funded in time." };
    case "no_market":
      return { what: `The anchor has no market for this conversion right now.${msg}`, why: "It cannot quote the pair at the moment." };
    case "too_small":
    case "too_large":
      return { what: `The amount is ${tx.status === "too_small" ? "below" : "above"} the anchor's limit.${msg}`, why: "Anchors enforce minimum and maximum sizes per transaction." };
    case "error":
      return { what: `The anchor reported an error.${msg}`, why: "Something went wrong on their side; the order will not complete." };
    default:
      return { what: `The order status is "${tx.status}".${msg}`, why: "This is a status this client does not know; it is treated as still in progress." };
  }
}

export class PollTimeoutError extends Error {
  constructor(
    message: string,
    readonly last: AnchorTransaction,
  ) {
    super(message);
    this.name = "PollTimeoutError";
  }
}

export type PollOutcome = "completed" | "failed" | "stopped";

export interface PollOptions {
  intervalMs?: number;
  timeoutMs?: number;
  /** Stop (outcome "stopped") as soon as the transaction reaches one of these statuses. */
  stopAt?: readonly TxStatus[];
  /** Called (once per poll loop) when the anchor reports pending_trust; should fix the trustline. */
  onPendingTrust?: (tx: AnchorTransaction) => Promise<void>;
  onUpdate?: (tx: AnchorTransaction) => void;
}

export interface PollResult {
  tx: AnchorTransaction;
  outcome: PollOutcome;
  /** All distinct statuses seen, in order. */
  history: TxStatus[];
}

/**
 * Polls one transaction until it is final (completed/failed) or hits `stopAt`.
 * Emits one explain record per status CHANGE. Throws PollTimeoutError on timeout.
 * `pending_trust` triggers `onPendingTrust` once; without a handler the poll
 * stops with outcome "stopped" so the caller can decide.
 */
export async function pollTransaction(
  ctx: AnchorContext,
  toml: AnchorToml,
  token: AuthToken,
  id: string,
  opts: PollOptions = {},
): Promise<PollResult> {
  const interval = opts.intervalMs ?? 2000;
  const timeout = opts.timeoutMs ?? 180_000;
  const started = ctx.now().getTime();
  const history: TxStatus[] = [];
  let trustHandled = false;
  for (;;) {
    const tx = await getTransaction(ctx, toml, token, id);
    if (history[history.length - 1] !== tx.status) {
      history.push(tx.status);
      const e = explainStatus(tx.kind, tx);
      ctx.explain.record(`sep6.status.${tx.status}`, `SEP-6 order ${id}: ${e.what}`, e.why);
      opts.onUpdate?.(tx);
    }
    const cls = classifyStatus(tx.status);
    if (cls === "success") return { tx, outcome: "completed", history };
    if (cls === "failed") return { tx, outcome: "failed", history };
    if (opts.stopAt?.includes(tx.status)) return { tx, outcome: "stopped", history };
    if (cls === "needs_trustline") {
      if (!opts.onPendingTrust) return { tx, outcome: "stopped", history };
      if (!trustHandled) {
        trustHandled = true;
        await opts.onPendingTrust(tx);
      }
    } else if (cls === "needs_user" && tx.status === "pending_user") {
      return { tx, outcome: "stopped", history };
    }
    if (ctx.now().getTime() - started >= timeout) {
      throw new PollTimeoutError(`order ${id} is still "${tx.status}" after ${Math.round(timeout / 1000)}s`, tx);
    }
    await ctx.sleep(interval);
  }
}
