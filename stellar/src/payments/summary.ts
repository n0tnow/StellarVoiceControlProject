/**
 * Approval-card summary DECODED from the unsigned XDR (round trip), never from
 * the intent text, so the card renders what will really be signed.
 *
 * Browser-safe: hex is produced by a local `toHex` helper; the `Buffer` global
 * (used by `anchor/describe.ts`) is deliberately NOT used here (slice §G.2/H.3).
 */
import { Transaction, TransactionBuilder } from "@stellar/stellar-sdk";
import type { ChainToolResult } from "@polaris/interfaces";

export interface PaymentSummaryInput {
  unsignedXdr: string;
  networkPassphrase: string;
  /** Resolved alias name shown to the user. */
  alias: string;
  explorerBase?: string;
}

export interface BuiltPaymentSummary {
  summary: ChainToolResult["summary"];
  /** hex sha256 of the transaction signature base (`tx.hash()`) — the Touch ID payload. */
  payloadHash: string;
}

const DEFAULT_EXPLORER_BASE = "https://stellar.expert/explorer/testnet";

/** Lowercase hex of arbitrary bytes without the Node `Buffer` global. */
export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

/** Human display of an XDR-canonical amount: trailing zeros trimmed ("10.0000000" -> "10"). */
export function formatAmount(amount: string): string {
  if (!amount.includes(".")) return amount;
  return amount.replace(/0+$/, "").replace(/\.$/, "");
}

/** Exact stroops -> XLM with at most 7 decimals and no trailing zeros (100 -> "0.00001"). */
export function stroopsToXlm(stroops: string): string {
  const n = BigInt(stroops);
  const whole = n / 10_000_000n;
  const frac = (n % 10_000_000n).toString().padStart(7, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

function shortKey(address: string): string {
  return address.length > 8 ? `${address.slice(0, 4)}…${address.slice(-4)}` : address;
}

/** Hex sha256 of the signature base of an unsigned (or signed) envelope. */
export function payloadHashOf(unsignedXdr: string, networkPassphrase: string): string {
  return toHex(TransactionBuilder.fromXDR(unsignedXdr, networkPassphrase).hash());
}

export function buildPaymentSummary(input: PaymentSummaryInput): BuiltPaymentSummary {
  const tx = TransactionBuilder.fromXDR(input.unsignedXdr, input.networkPassphrase);
  if (!(tx instanceof Transaction)) throw new Error("fee-bump envelopes are not supported for payments");
  const op = tx.operations[0];
  if (!op || op.type !== "payment") throw new Error("the built transaction is not a payment");

  const native = op.asset.isNative();
  const code = native ? "XLM" : op.asset.code;
  const displayAmount = formatAmount(op.amount);
  const assetLine = native
    ? `Pay ${displayAmount} ${code} (native)`
    : `Pay ${displayAmount} ${code} (issuer ${shortKey(op.asset.issuer ?? "")})`;
  const payloadHash = toHex(tx.hash());
  const fee = `${stroopsToXlm(tx.fee)} XLM`;

  const summary: ChainToolResult["summary"] = {
    title: `Send ${displayAmount} ${code} to ${input.alias}`,
    lines: [
      assetLine,
      `To ${input.alias} (${op.destination})`,
      `Network: ${input.networkPassphrase}`,
      `Fee: ${fee}`,
    ],
    explorerUrl: `${input.explorerBase ?? DEFAULT_EXPLORER_BASE}/tx/${payloadHash}`,
    estimatedFee: fee,
  };
  return { summary, payloadHash };
}
