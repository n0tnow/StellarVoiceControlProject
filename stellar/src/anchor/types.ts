/**
 * Shared types for the anchor client (SEP-1 / 10 / 12 / 38 / 6).
 *
 * Signing is INJECTED: this package never holds a private key. The Rust /
 * Touch-ID signer (built by another team) implements `Signer`; tests use
 * `EnvSigner` (POLARIS_TEST_SECRET).
 */
import type { ExplainLog } from "./explain.ts";

/** Injected signing capability. */
export interface Signer {
  /** The Stellar `G...` public key this signer signs for. */
  publicKey(): Promise<string>;
  /**
   * Sign a transaction envelope (base64 XDR) and return the signed envelope
   * (base64 XDR). `networkPassphrase` is provided so the implementation can
   * compute the right signature payload; a fixed-network signer may ignore it.
   * Implementations may show an approval UI (Touch ID) and reject.
   */
  signTransaction(xdr: string, opts?: { networkPassphrase?: string }): Promise<string>;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Everything a step function needs; built once by the session. */
export interface AnchorContext {
  fetch: FetchLike;
  explain: ExplainLog;
  horizonUrl: string;
  friendbotUrl: string;
  networkPassphrase: string;
  /** Injected for tests; defaults to a real timer. */
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
  /** Per-request timeout in ms. */
  requestTimeoutMs: number;
}

/** Parsed SEP-1 stellar.toml — only the fields we use. */
export interface AnchorToml {
  homeDomain: string;
  networkPassphrase: string;
  /** SEP-10 server signing key (G...). */
  signingKey: string;
  webAuthEndpoint: string;
  transferServer: string;
  kycServer?: string;
  quoteServer?: string;
  currencies: TomlCurrency[];
}

export interface TomlCurrency {
  code: string;
  issuer?: string;
  status?: string;
  /** e.g. "TRY" — the fiat/off-chain asset this token is anchored to. */
  anchorAsset?: string;
  anchorAssetType?: string;
}

export interface AnchorAsset {
  code: string;
  issuer: string;
}

/** SEP-38 style identifiers, e.g. `iso4217:TRY`, `stellar:USDC:G...`. */
export function stellarAssetId(a: AnchorAsset): string {
  return `stellar:${a.code}:${a.issuer}`;
}
export function fiatAssetId(code: string): string {
  return `iso4217:${code}`;
}

export interface AuthToken {
  jwt: string;
  account: string;
  /** JWT `exp`, or undefined if it could not be decoded. */
  expiresAt?: Date;
}

/** A SEP-38 indicative price. Amounts are decimal strings, never floats. */
export interface Quote {
  sellAsset: string;
  buyAsset: string;
  sellAmount: string;
  buyAmount: string;
  /** Sell units per 1 buy unit, including fees (SEP-38 `total_price`). */
  totalPrice: string;
  /** Price before fees (SEP-38 `price`). */
  price: string;
  feeTotal?: string;
  feeAsset?: string;
  /** Firm quote id (only when a firm quote was requested). */
  id?: string;
}

export type TxStatus =
  | "incomplete"
  | "pending_user_transfer_start"
  | "pending_user_transfer_complete"
  | "pending_external"
  | "pending_anchor"
  | "pending_stellar"
  | "pending_trust"
  | "pending_user"
  | "completed"
  | "refunded"
  | "expired"
  | "no_market"
  | "too_small"
  | "too_large"
  | "error"
  // Some anchors add statuses; keep the client forward compatible.
  | (string & {});

/** SEP-6 transaction record (subset we read; unknown fields are kept in `raw`). */
export interface AnchorTransaction {
  id: string;
  kind: string;
  status: TxStatus;
  message?: string;
  moreInfoUrl?: string;
  amountIn?: string;
  amountInAsset?: string;
  amountOut?: string;
  amountOutAsset?: string;
  amountFee?: string;
  amountFeeAsset?: string;
  stellarTransactionId?: string;
  externalTransactionId?: string;
  /** Withdrawals: where to send the on-chain payment. */
  withdrawAnchorAccount?: string;
  withdrawMemo?: string;
  withdrawMemoType?: string;
  startedAt?: string;
  completedAt?: string | null;
  raw: Record<string, unknown>;
}

export interface DepositInstructions {
  id: string;
  /** Human text from the anchor (`how`). */
  how?: string;
  /** Raw SEP-6 `instructions` map (value/description per field). */
  instructions?: Record<string, { value: string; description?: string }>;
  minAmount?: number;
  maxAmount?: number;
  feePercent?: number;
  eta?: number;
  raw: Record<string, unknown>;
}

export interface WithdrawInstructions {
  id: string;
  /** Stellar account to pay. */
  accountId: string;
  memo?: string;
  memoType?: string;
  minAmount?: number;
  maxAmount?: number;
  feePercent?: number;
  eta?: number;
  raw: Record<string, unknown>;
}

/** Result of one step: its data plus the narration it produced. */
export interface StepResult<T> {
  data: T;
  explain: import("./explain.ts").ExplainRecord[];
}
