/**
 * SEP-6: programmatic deposit / withdraw. Plain HTTP — the wallet builds its own
 * UI; no anchor-hosted page is involved (see README).
 *
 *   deposit  (off-chain TRY -> on-chain USDC): anchor returns bank instructions;
 *            when the bank transfer arrives the anchor pays USDC on Stellar.
 *   withdraw (on-chain USDC -> off-chain TRY): anchor returns an account + memo;
 *            WE pay USDC to that account with that memo, then the anchor pays TRY.
 *
 * Everything the anchor sends is untrusted: identifiers are charset-checked, text
 * is sanitised and capped, destinations/memos are validated before they can reach
 * a transaction.
 */
import { Account, Asset, BASE_FEE, Memo, Operation, StrKey, TransactionBuilder } from "@stellar/stellar-sdk";
import { DEFAULT_HOME_DOMAIN } from "./config.ts";
import { AnchorHttpError, requestJson } from "./http.ts";
import { shortKey } from "./explain.ts";
import { getCustomer, KycRequiredError } from "./sep12.ts";
import { safeHttpsUrl, safeId, sanitizeAnchorText, type AnchorOwnedLink } from "./text.ts";
import type {
  AnchorAsset,
  AnchorContext,
  AnchorToml,
  AnchorTransaction,
  AuthToken,
  DepositInstructions,
  TxStatus,
  WithdrawInstructions,
  WithdrawMemo,
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
}

function parseAssetInfoMap(v: unknown): Record<string, Sep6AssetInfo> {
  const out: Record<string, Sep6AssetInfo> = {};
  if (!v || typeof v !== "object") return out;
  for (const [code, info] of Object.entries(v as Record<string, Record<string, unknown>>)) {
    if (!/^[A-Za-z0-9]{1,12}$/.test(code) || !info || typeof info !== "object") continue;
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
  const info: Sep6Info = { deposit: parseAssetInfoMap(raw.deposit), withdraw: parseAssetInfoMap(raw.withdraw) };
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
  const body = e.body as { fields?: unknown; status?: string };
  if (t === "non_interactive_customer_info_needed") {
    const fields = cleanFieldNames(body.fields);
    return new KycRequiredError(`the anchor needs more customer information: ${fields.join(", ")}`, "NEEDS_INFO", fields);
  }
  if (t === "customer_info_status") {
    const st = sanitizeAnchorText(body.status, 30) ?? "PROCESSING";
    return new KycRequiredError(`the anchor is still reviewing our customer information (${st})`, st, []);
  }
  return undefined;
}

/** Field names (KYC / info updates) are echoed to the user: strict charset, capped count. */
export function cleanFieldNames(v: unknown): string[] {
  const names = Array.isArray(v) ? v : v && typeof v === "object" ? Object.keys(v) : [];
  return names.filter((f): f is string => typeof f === "string" && /^[A-Za-z0-9_]{1,40}$/.test(f)).slice(0, 20);
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

const KEY = /^[A-Za-z0-9_]{1,40}$/;

function cleanInstructions(v: unknown): DepositInstructions["instructions"] | undefined {
  if (!v || typeof v !== "object") return undefined;
  const out: Record<string, { value: string; description?: string }> = {};
  for (const [k, item] of Object.entries(v as Record<string, unknown>).slice(0, 20)) {
    if (!KEY.test(k) || !item || typeof item !== "object") continue;
    const value = sanitizeAnchorText((item as { value?: unknown }).value, 120);
    if (!value) continue;
    const entry: { value: string; description?: string } = { value };
    const description = sanitizeAnchorText((item as { description?: unknown }).description, 150);
    if (description) entry.description = description;
    out[k] = entry;
  }
  return Object.keys(out).length > 0 ? out : undefined;
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
  const out: DepositInstructions = { id: safeId(raw.id, "deposit order id") };
  const how = sanitizeAnchorText(raw.how, 300);
  if (how) out.how = how;
  const instructions = cleanInstructions(raw.instructions);
  if (instructions) out.instructions = instructions;
  const min = num(raw.min_amount);
  if (min !== undefined) out.minAmount = min;
  const max = num(raw.max_amount);
  if (max !== undefined) out.maxAmount = max;
  const fee = num(raw.fee_percent);
  if (fee !== undefined) out.feePercent = fee;
  const eta = num(raw.eta);
  if (eta !== undefined) out.eta = eta;

  const said =
    out.how ??
    (out.instructions
      ? Object.entries(out.instructions)
          .map(([k, v]) => `${k}: ${v.value}`)
          .join("; ")
      : undefined);
  ctx.explain.record(
    "sep6.deposit",
    `SEP-6: asked the anchor to turn ${p.amount} ${p.fiatCode ?? "of your local currency"} into ${p.assetCode} on ${shortKey(p.account)}. ` +
      `It created order ${out.id}` +
      (said ? " and gave payment instructions for the bank transfer (shown as the anchor's own words)." : " but sent no payment instructions."),
    "The order is the anchor's promise: once its bank receives your transfer, it pays the tokens straight to your Stellar account.",
    { anchorSaid: said },
  );
  return out;
}

const MAX_SAFE_ID_MEMO = 18446744073709551615n; // 2^64 - 1, the largest MEMO_ID

/**
 * Wraps a bare JSON number under a "memo" key in quotes BEFORE parsing, so a large id
 * memo (> 2^53) reaches us as an exact string instead of a rounded double.
 */
export function quoteNumericMemo(text: string): string {
  return text.replace(/(?<!\\)("memo"\s*:\s*)(-?\d+)(?=\s*[,}\]])/g, '$1"$2"');
}

/**
 * Validates the memo the anchor wants on our payment. Returns exactly what will
 * go on chain. Throws on anything ambiguous instead of guessing (a wrong memo can
 * strand the money on the anchor's side).
 */
export function parseWithdrawMemo(memo: unknown, memoType: unknown): WithdrawMemo | undefined {
  const hasMemo = !(memo === undefined || memo === null || memo === "");
  if (!hasMemo && (memoType === undefined || memoType === null || memoType === "")) return undefined;
  if (!hasMemo) throw new Error("the anchor named a memo type but sent no memo");
  if (memoType !== "text" && memoType !== "id" && memoType !== "hash") {
    throw new Error("the anchor sent a memo with an unsupported memo type");
  }
  let value: string;
  if (typeof memo === "number") {
    if (!Number.isSafeInteger(memo)) throw new Error("the anchor sent an id memo that is too large to be represented safely");
    value = String(memo);
  } else if (typeof memo === "string") {
    value = memo;
  } else {
    throw new Error("the anchor sent a memo of an unexpected type");
  }
  if (memoType === "text") {
    if (new TextEncoder().encode(value).byteLength > 28) throw new Error("the anchor's text memo is longer than 28 bytes");
    return { type: "text", value };
  }
  if (memoType === "id") {
    if (!/^[0-9]{1,20}$/.test(value) || BigInt(value) > MAX_SAFE_ID_MEMO) throw new Error("the anchor's id memo is not a valid 64-bit number");
    return { type: "id", value: BigInt(value).toString() };
  }
  // hash: SEP-6 anchors send base64; 64 hex characters are also accepted.
  if (/^[0-9a-fA-F]{64}$/.test(value)) return { type: "hash", value: value.toLowerCase() };
  if (/^[A-Za-z0-9+/]{43}=$/.test(value)) {
    const bytes = Buffer.from(value, "base64");
    if (bytes.length === 32) return { type: "hash", value: bytes.toString("hex") };
  }
  throw new Error("the anchor's hash memo is not a 32-byte base64 or hex value");
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
      preParse: quoteNumericMemo,
    });
  } catch (e) {
    if (e instanceof AnchorHttpError) {
      const kyc = toKycError(e);
      if (kyc) throw kyc;
    }
    throw e;
  }
  const out: WithdrawInstructions = { id: safeId(raw.id, "withdrawal order id") };
  const accountId = raw.account_id;
  // The anchor may DEFER the payout account until per-transaction KYC is done
  // (the SDF test anchor returns only `{id}` at first). When it IS present it must
  // be a plain G... account: a muxed M... address would route the payment to an
  // identity we cannot show the user, and other strings are not addresses at all.
  if (accountId !== undefined && accountId !== null && accountId !== "") {
    if (typeof accountId !== "string" || !StrKey.isValidEd25519PublicKey(accountId)) {
      throw new Error("the anchor did not give a valid plain Stellar account (G...) to pay for the withdrawal");
    }
    if (accountId === p.account) throw new Error("the anchor asked us to pay our own account");
    out.accountId = accountId;
    const memo = parseWithdrawMemo(raw.memo, raw.memo_type);
    if (memo) out.memo = memo;
  }
  const min = num(raw.min_amount);
  if (min !== undefined) out.minAmount = min;
  const max = num(raw.max_amount);
  if (max !== undefined) out.maxAmount = max;
  const fee = num(raw.fee_percent);
  if (fee !== undefined) out.feePercent = fee;
  const eta = num(raw.eta);
  if (eta !== undefined) out.eta = eta;
  // The memo value still goes on chain exactly as the anchor sent it; only the echo is sanitised.
  const memoEcho = out.memo ? sanitizeAnchorText(out.memo.value, 28) ?? "?" : undefined;
  const payTo = out.accountId
    ? ` and told us to pay ${shortKey(out.accountId)}` +
      `${out.memo ? ` with ${out.memo.type} memo ${out.memo.type === "hash" ? shortKey(out.memo.value) : memoEcho}` : ", with no memo"}`
    : "; it will give us the payout account once the order's KYC is complete";
  ctx.explain.record(
    "sep6.withdraw",
    `SEP-6: asked the anchor to cash out ${p.amount} ${p.assetCode}. It created order ${out.id}${payTo}.`,
    "The memo is a reference number: it is how the anchor matches our on-chain payment to this order, so it must be included exactly.",
  );
  return out;
}

/**
 * Builds the on-chain payment that funds a withdrawal (unsigned XDR). Pure and
 * unit-tested; the validated memo type is honoured (text | id | hash-as-hex).
 */
export function buildWithdrawPayment(input: {
  sourceAccount: string;
  sequence: string;
  networkPassphrase: string;
  asset: AnchorAsset;
  amount: string;
  destination: string;
  memo?: WithdrawMemo | undefined;
  fee?: string;
  timeoutSeconds?: number;
}): string {
  if (!StrKey.isValidEd25519PublicKey(input.destination)) {
    throw new Error("withdrawal destination must be a plain G... account");
  }
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
  if (input.memo) {
    if (input.memo.type === "text") b.addMemo(Memo.text(input.memo.value));
    else if (input.memo.type === "id") b.addMemo(Memo.id(input.memo.value));
    else b.addMemo(Memo.hash(input.memo.value));
  }
  b.setTimeout(input.timeoutSeconds ?? 300);
  return b.build().toXDR();
}

// ---------- transactions ----------

const DECIMAL = /^[0-9]{1,20}(\.[0-9]{1,10})?$/;
const ASSET_ID = /^(iso4217:[A-Z0-9]{2,12}|stellar:[A-Za-z0-9]{1,12}:G[A-Z2-7]{55}|stellar:native)$/;

/** Normalises an anchor transaction record; text fields are sanitised, amounts and ids validated. */
export function parseTransaction(raw: Record<string, unknown>): AnchorTransaction {
  const str = (k: string): string | undefined => (typeof raw[k] === "string" ? (raw[k] as string) : undefined);
  const amount = (k: string): string | undefined => {
    const v = str(k);
    return v && DECIMAL.test(v) ? v : undefined;
  };
  const asset = (k: string): string | undefined => {
    const v = str(k);
    return v && ASSET_ID.test(v) ? v : undefined;
  };
  const tx: AnchorTransaction = {
    id: safeId(raw.id, "order id"),
    kind: (str("kind") ?? "").replace(/[^a-z_-]/g, "").slice(0, 30),
    status: (str("status") ?? "error").replace(/[^a-z_]/g, "").slice(0, 60) || "error",
  };
  const set = <K extends keyof AnchorTransaction>(k: K, v: AnchorTransaction[K] | undefined): void => {
    if (v !== undefined) tx[k] = v;
  };
  set("message", sanitizeAnchorText(raw.message));
  set("moreInfoUrl", safeHttpsUrl(raw.more_info_url));
  set("amountIn", amount("amount_in"));
  set("amountInAsset", asset("amount_in_asset"));
  set("amountOut", amount("amount_out"));
  set("amountOutAsset", asset("amount_out_asset"));
  set("amountFee", amount("amount_fee"));
  set("amountFeeAsset", asset("amount_fee_asset"));
  const hash = str("stellar_transaction_id");
  set("stellarTransactionId", hash && /^[0-9a-f]{64}$/i.test(hash) ? hash.toLowerCase() : undefined);
  const ext = str("external_transaction_id");
  set("externalTransactionId", ext && /^[A-Za-z0-9_.:-]{1,80}$/.test(ext) ? ext : undefined);
  const wa = str("withdraw_anchor_account");
  set("withdrawAnchorAccount", wa && StrKey.isValidEd25519PublicKey(wa) ? wa : undefined);
  set("withdrawMemo", sanitizeAnchorText(str("withdraw_memo"), 64));
  const wmt = str("withdraw_memo_type");
  set("withdrawMemoType", wmt === "text" || wmt === "id" || wmt === "hash" ? wmt : undefined);
  set("startedAt", sanitizeAnchorText(raw.started_at, 40));
  if (raw.completed_at === null) tx.completedAt = null;
  else set("completedAt", sanitizeAnchorText(raw.completed_at, 40));
  const req = cleanFieldNames(raw.required_info_updates);
  if (req.length > 0) tx.requiredInfoUpdates = req;
  set("requiredInfoMessage", sanitizeAnchorText(raw.required_info_message));
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
  const out: AnchorTransaction[] = [];
  for (const t of (res.transactions ?? []).slice(0, 100)) {
    try {
      out.push(parseTransaction(t));
    } catch {
      // A record with an unusable id is dropped rather than shown.
    }
  }
  return out;
}

// ---------- status state machine ----------

export const FINAL_STATUSES: readonly string[] = ["completed", "refunded", "expired", "no_market", "too_small", "too_large", "error"];

export type StatusClass =
  | "in_progress"
  | "needs_trustline"
  | "needs_user"
  | "needs_info"
  | "waiting_user_transfer"
  | "success"
  | "failed";

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
    case "pending_customer_info_update":
    case "pending_transaction_info_update":
      return "needs_info";
    case "pending_user":
      return "needs_user";
    case "incomplete":
      // SEP-6 "incomplete" means the anchor is still missing information and the
      // order has not started; the SDF test anchor briefly reports it before
      // moving to pending_customer_info_update. Keep polling instead of stopping.
      return "in_progress";
    case "pending_user_transfer_start":
      return "waiting_user_transfer";
    default:
      return "in_progress";
  }
}

/**
 * Plain-English narration for a status. The anchor's own message is NOT part of
 * the text (it is untrusted); callers pass it as `anchorSaid`.
 */
export function explainStatus(kind: string, tx: Pick<AnchorTransaction, "status">): { what: string; why: string } {
  const deposit = kind.startsWith("deposit");
  switch (tx.status) {
    case "pending_user_transfer_start":
      return deposit
        ? { what: "The anchor is waiting for your bank transfer.", why: "Nothing is paid out until its bank sees the money." }
        : { what: "The anchor is waiting for your on-chain payment.", why: "The cash-out starts only after the tokens arrive with the right memo." };
    case "pending_user_transfer_complete":
      return { what: "The anchor has seen your payment and is preparing the payout.", why: "It has to confirm funds before releasing the other side." };
    case "pending_external":
      return { what: "The anchor is waiting on an external system (bank or blockchain).", why: "Bank rails and confirmations take a moment; nothing is needed from you." };
    case "pending_anchor":
      return { what: "The anchor is processing the order.", why: "It is converting the funds and preparing the payout." };
    case "pending_stellar":
      return { what: "The anchor is submitting the Stellar transaction.", why: "Once it lands in a ledger the tokens are yours." };
    case "pending_trust":
      return {
        what: "The anchor is HOLDING the deposit because our account has no trustline for the asset yet.",
        why: "A Stellar account can only receive an asset after it opts in with a trustline, so the anchor cannot pay until we add one.",
      };
    case "pending_customer_info_update":
      return {
        what: "The anchor needs more customer (KYC) information before it can continue.",
        why: "Anchors are regulated and may ask for more identity data; the order is paused until it is provided.",
      };
    case "pending_transaction_info_update":
      return {
        what: "The anchor says some details of this order need to be corrected.",
        why: "The information sent with the order was incomplete or wrong, so the anchor cannot process it yet.",
      };
    case "pending_user":
      return { what: "The anchor needs something from us before it can continue.", why: "Usually extra identity data or an approval." };
    case "incomplete":
      return { what: "The order is not complete yet.", why: "The anchor is still waiting for required input." };
    case "completed":
      return { what: "The order is complete.", why: "Both sides of the swap have been paid." };
    case "refunded":
      return { what: "The order was refunded.", why: "The anchor could not complete it and returned the funds." };
    case "expired":
      return { what: "The order expired before the payment arrived.", why: "Anchors cancel orders that are not funded in time." };
    case "no_market":
      return { what: "The anchor has no market for this conversion right now.", why: "It cannot quote the pair at the moment." };
    case "too_small":
    case "too_large":
      return { what: `The amount is ${tx.status === "too_small" ? "below" : "above"} the anchor's limit.`, why: "Anchors enforce minimum and maximum sizes per transaction." };
    case "error":
      return { what: "The anchor reported an error.", why: "Something went wrong on their side; the order will not complete." };
    default:
      return { what: "The order is in a status this client does not recognise; it is treated as still in progress.", why: "New statuses can appear as anchors evolve." };
  }
}

export class PollTimeoutError extends Error {
  readonly last: AnchorTransaction;

  constructor(message: string, last: AnchorTransaction) {
    super(message);
    this.name = "PollTimeoutError";
    this.last = last;
  }
}

/**
 * Extra, sanitised hint appended to a poll timeout when the domain is the TR mock
 * anchor (whose deposit payout worker stalled on 2026-09-20). Static text only:
 * the timeout path never fetches anything automatically.
 */
export const TR_MOCK_PAYOUT_HINT =
  "The TR mock anchor accepted the order but has not paid out; run " +
  "`npm run anchor:check -w @polaris/stellar -- --live --payout-check` and, for a demo, the labelled non-TR scenario " +
  "`--home-domain testanchor.stellar.org`.";

// ---------- timeout text: anchor-owned links, quoting and length cap ----------

/** Fixed hard cap for the composed `PollTimeoutError.message`. */
export const MAX_POLL_TIMEOUT_MESSAGE = 600;

/** True for IPv4/IPv6 literals (defence in depth; toml hosts are checked upstream too). */
function looksLikeIpLiteral(host: string): boolean {
  return host.includes(":") || host.startsWith("[") || /^[0-9.]+$/.test(host) || /^0x[0-9a-f]+$/i.test(host);
}

/** Hosts the anchor itself declares: its home domain plus its toml endpoint hosts (EXACT match). */
function anchorDeclaredHosts(toml: AnchorToml): Set<string> {
  const hosts = new Set<string>();
  const add = (value: string | undefined): void => {
    if (!value) return;
    try {
      const u = new URL(value.includes("://") ? value : `https://${value}`);
      if (u.protocol === "https:" && !u.username && !u.password && !u.port && !looksLikeIpLiteral(u.hostname)) {
        hosts.add(u.hostname.toLowerCase());
      }
    } catch {
      // Not a usable host; ignore it rather than allowing anything.
    }
  };
  add(toml.homeDomain);
  add(toml.transferServer);
  add(toml.webAuthEndpoint);
  return hosts;
}

/**
 * `more_info_url` is anchor-authored: accept it only when it is https, has no
 * credentials/port, is short enough, and its host EXACTLY matches a host the
 * anchor itself declares (its home domain or a `TRANSFER_SERVER` /
 * `WEB_AUTH_ENDPOINT` host). Everything else is dropped. Never auto-fetched.
 */
export function anchorOwnedLink(value: unknown, toml: AnchorToml, max = 300): AnchorOwnedLink | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > max) return undefined;
  if (/[\u0000-\u001f\u007f]/.test(value)) return undefined;
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return undefined;
  }
  if (u.protocol !== "https:" || u.username || u.password || u.port) return undefined;
  if (looksLikeIpLiteral(u.hostname)) return undefined;
  if (!anchorDeclaredHosts(toml).has(u.hostname.toLowerCase())) return undefined;
  return u.toString() as AnchorOwnedLink;
}

/** Wraps an untrusted anchor message in quotes, escaping backslashes and embedded double quotes. */
export function quoteAnchorText(text: string): string {
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Composes the timeout error text and caps it at `MAX_POLL_TIMEOUT_MESSAGE`. When
 * the (validated) link would push it over the cap, the link is left out of the
 * message — it stays available in the `sep6.timeout` explain record.
 */
export function composeTimeoutMessage(base: string, said: string, linkText: string, hint: string): string {
  const withLink = `${base}${said}${linkText}${hint}`;
  if (withLink.length <= MAX_POLL_TIMEOUT_MESSAGE) return withLink;
  const withoutLink = `${base}${said}${hint}`;
  if (withoutLink.length <= MAX_POLL_TIMEOUT_MESSAGE) return withoutLink;
  return `${withoutLink.slice(0, MAX_POLL_TIMEOUT_MESSAGE - 1)}…`;
}

/** Repeated network/5xx failures while polling; carries the last state we knew. */
export class PollInterruptedError extends Error {
  readonly last: AnchorTransaction;

  constructor(message: string, last: AnchorTransaction) {
    super(message);
    this.name = "PollInterruptedError";
    this.last = last;
  }
}

/**
 * The anchor paused the order until we supply information (SEP-6
 * `pending_customer_info_update` / `pending_transaction_info_update`). Follow-up:
 * SEP-12 `PUT /customer` for customer info (fields via `GET /customer?transaction_id=`),
 * or the SEP-6 transaction-update endpoint for order info.
 */
export class TransactionInfoRequiredError extends Error {
  readonly status: TxStatus;
  readonly transactionId: string;
  readonly missingFields: string[];
  readonly tx: AnchorTransaction;

  constructor(message: string, tx: AnchorTransaction, missingFields: string[]) {
    super(message);
    this.name = "TransactionInfoRequiredError";
    this.status = tx.status;
    this.transactionId = tx.id;
    this.missingFields = missingFields;
    this.tx = tx;
  }
}

export type PollOutcome = "completed" | "failed" | "stopped";

/** How many times a poll hands a `pending_customer_info_update` to the KYC hook before giving up. */
export const MAX_CUSTOMER_INFO_ATTEMPTS = 6;

export interface PollOptions {
  intervalMs?: number;
  timeoutMs?: number;
  /** Stop (outcome "stopped") as soon as the transaction reaches one of these statuses. */
  stopAt?: readonly TxStatus[];
  /** Called (once per poll loop) when the anchor reports pending_trust; should fix the trustline. */
  onPendingTrust?: (tx: AnchorTransaction) => Promise<void>;
  /**
   * Called when the anchor pauses the order for per-transaction KYC
   * (`pending_customer_info_update`); should submit the SEP-12 fields, after which
   * polling resumes. The order's status can lag, so it is called a few bounded
   * times. Without it the poll stops with `TransactionInfoRequiredError`.
   */
  onCustomerInfoRequired?: (tx: AnchorTransaction) => Promise<void>;
  onUpdate?: (tx: AnchorTransaction) => void;
  /** Consecutive transient failures tolerated before giving up (default 3). */
  maxTransientFailures?: number;
}

export interface PollResult {
  tx: AnchorTransaction;
  outcome: PollOutcome;
  /** All distinct statuses seen, in order. */
  history: TxStatus[];
}

function isTransient(e: unknown): boolean {
  if (e instanceof AnchorHttpError) return e.status >= 500 || e.status === 429;
  // fetch() rejections (network down, timeout, connection reset) are not HTTP errors.
  return e instanceof TypeError || (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError"));
}

/**
 * Polls one transaction until it is final (completed/failed), hits `stopAt`, or
 * the anchor needs input from us. Emits one explain record per status CHANGE.
 *
 *  - `pending_trust`: `onPendingTrust` runs once; without a handler the poll stops.
 *  - `pending_customer_info_update`: `onCustomerInfoRequired` runs (SEP-12
 *    per-transaction KYC, a few bounded times as the status can lag), then polling
 *    resumes; without a handler it throws `TransactionInfoRequiredError`.
 *  - `pending_transaction_info_update`: throws `TransactionInfoRequiredError`.
 *  - `pending_user`: stops with outcome "stopped" (we cannot supply what it wants).
 *  - a few consecutive network/5xx errors are retried; then `PollInterruptedError`.
 *  - throws `PollTimeoutError` on timeout.
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
  const maxFailures = opts.maxTransientFailures ?? 3;
  const started = ctx.now().getTime();
  const history: TxStatus[] = [];
  let trustHandled = false;
  let customerInfoAttempts = 0;
  let failures = 0;
  let last: AnchorTransaction | undefined;
  for (;;) {
    let tx: AnchorTransaction;
    try {
      tx = await getTransaction(ctx, toml, token, id);
      failures = 0;
    } catch (e) {
      if (!isTransient(e)) throw e;
      failures++;
      ctx.explain.record(
        "sep6.retry",
        `Could not reach the anchor to check order ${id} (attempt ${failures} of ${maxFailures}); trying again shortly.`,
        "A brief network hiccup does not change what already happened on chain, so we keep checking instead of giving up.",
      );
      if (failures >= maxFailures) {
        if (last) throw new PollInterruptedError(`lost contact with the anchor while checking order ${id}; last known status "${last.status}"`, last);
        throw e;
      }
      await ctx.sleep(interval);
      continue;
    }
    last = tx;
    if (history[history.length - 1] !== tx.status) {
      history.push(tx.status);
      const e = explainStatus(tx.kind, tx);
      ctx.explain.record(`sep6.status.${tx.status}`, `SEP-6 order ${id}: ${e.what}`, e.why, { anchorSaid: tx.message });
      opts.onUpdate?.(tx);
    }
    const cls = classifyStatus(tx.status);
    if (cls === "success") return { tx, outcome: "completed", history };
    if (cls === "failed") return { tx, outcome: "failed", history };
    if (opts.stopAt?.includes(tx.status)) return { tx, outcome: "stopped", history };
    if (cls === "needs_info") {
      // Per-transaction KYC: hand it to the caller (it submits SEP-12 with the
      // order's `transaction_id`), then keep polling. The transaction status can
      // lag the customer record, so allow a few bounded attempts.
      if (tx.status === "pending_customer_info_update" && opts.onCustomerInfoRequired && customerInfoAttempts < MAX_CUSTOMER_INFO_ATTEMPTS) {
        customerInfoAttempts++;
        await opts.onCustomerInfoRequired(tx);
        await ctx.sleep(interval);
        continue;
      }
      let fields = tx.requiredInfoUpdates ?? [];
      if (tx.status === "pending_customer_info_update" && toml.kycServer) {
        try {
          fields = (await getCustomer(ctx, toml, token, { transactionId: id })).missingFields;
        } catch {
          // fall back to whatever the transaction record listed
        }
      }
      const what = tx.status === "pending_customer_info_update" ? "customer (KYC) information" : "corrected order details";
      ctx.explain.record(
        "sep6.info_required",
        `Order ${id} is paused: the anchor needs ${what}${fields.length ? ` — missing: ${fields.join(", ")}` : ""}. We stopped waiting.`,
        "Polling more will not help; the order only moves on once that information is submitted (customer data through SEP-12).",
        { anchorSaid: tx.requiredInfoMessage },
      );
      throw new TransactionInfoRequiredError(`order ${id} is waiting for ${what}${fields.length ? `: ${fields.join(", ")}` : ""}`, tx, fields);
    }
    if (cls === "needs_trustline") {
      if (!opts.onPendingTrust) return { tx, outcome: "stopped", history };
      if (!trustHandled) {
        trustHandled = true;
        await opts.onPendingTrust(tx);
      }
    } else if (cls === "needs_user") {
      return { tx, outcome: "stopped", history };
    }
    if (ctx.now().getTime() - started >= timeout) {
      const seconds = Math.round(timeout / 1000);
      const said = tx.message ? `; the anchor last said: ${quoteAnchorText(tx.message)}` : "";
      // B1: the anchor's `more_info_url` is shown only when it is on the anchor's own host(s).
      const safeLink = anchorOwnedLink(tx.moreInfoUrl, toml);
      const withheld = !safeLink && Boolean(tx.moreInfoUrl);
      const linkText = safeLink
        ? ` (order details: ${safeLink})`
        : withheld
          ? " (link withheld: not on the anchor's host)"
          : "";
      const hint = toml.homeDomain === DEFAULT_HOME_DOMAIN ? ` ${TR_MOCK_PAYOUT_HINT}` : "";
      ctx.explain.record(
        "sep6.timeout",
        `SEP-6 order ${id} is still "${tx.status}" after ${seconds}s, so we stopped waiting.` +
          (tx.message ? " The anchor's own status message is attached." : "") +
          (withheld ? " The anchor's order link was not shown (link withheld: not on the anchor's host)." : "") +
          hint,
        "The order never reached a final state. A status like \"pending_anchor\" that does not move usually means a problem on the anchor's side, not with your account; the safe next step is to check the order later instead of paying again.",
        { anchorSaid: tx.message, link: safeLink },
      );
      const base = `order ${id} is still "${tx.status}" after ${seconds}s`;
      throw new PollTimeoutError(composeTimeoutMessage(base, said, linkText, hint), tx);
    }
    await ctx.sleep(interval);
  }
}
