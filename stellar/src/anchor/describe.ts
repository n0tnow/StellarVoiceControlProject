/**
 * Approval-card text decoded FROM the XDR (never from LLM prose). Assets are shown
 * with their ISSUER, not just the code: "USDC" alone cannot tell the real token
 * from a look-alike, and the issuer comes from an anchor-controlled toml.
 */
import { Transaction, TransactionBuilder } from "@stellar/stellar-sdk";
import { explorerAccountUrl } from "./horizon.ts";
import type { AnchorAsset } from "./types.ts";

type Op = Transaction["operations"][number];

function assetLabel(a: { code?: string; issuer?: string; isNative?: () => boolean } | undefined): string {
  if (!a) return "unknown asset";
  if (typeof a.isNative === "function" && a.isNative()) return "XLM (native)";
  return `${a.code ?? "?"}:${a.issuer ?? "?"}`;
}

function describeOperation(op: Op, txSource: string): string {
  const src = op.source && op.source !== txSource ? ` [operation source: ${op.source}]` : "";
  switch (op.type) {
    case "changeTrust": {
      const line = op.line as { code?: string; issuer?: string; isNative?: () => boolean } | undefined;
      const what = line && "code" in line ? assetLabel(line) : "a liquidity pool share";
      return `Trust asset ${what} (opt in to hold it)${src}`;
    }
    case "payment":
      return `Pay ${op.amount} ${assetLabel(op.asset)} to ${op.destination}${src}`;
    case "manageData":
      return `Login proof entry "${op.name}" (authentication only; this transaction is never submitted to the network)${src}`;
    default:
      return `Operation: ${op.type}${src}`;
  }
}

/** Human-readable lines for every operation, the memo and the fee, all read from the XDR. */
export function describeXdr(xdr: string, networkPassphrase: string): { lines: string[]; feeXlm: string; source: string } {
  const tx = TransactionBuilder.fromXDR(xdr, networkPassphrase);
  if (!(tx instanceof Transaction)) throw new Error("fee-bump envelopes are not supported here");
  const lines = tx.operations.map((op) => describeOperation(op, tx.source));
  if (tx.memo.type !== "none") {
    const v = tx.memo.value;
    lines.push(`Memo (${tx.memo.type}): ${v instanceof Uint8Array ? Buffer.from(v).toString("hex") : String(v)}`);
  }
  return { lines, feeXlm: (Number(tx.fee) / 1e7).toFixed(7), source: tx.source };
}

/** Throws unless both envelopes describe the exact same transaction body (same hash). */
export function assertSameTransaction(expectedXdr: string, actualXdr: string, networkPassphrase: string): void {
  const a = TransactionBuilder.fromXDR(expectedXdr, networkPassphrase);
  const b = TransactionBuilder.fromXDR(actualXdr, networkPassphrase);
  if (Buffer.from(a.hash()).toString("hex") !== Buffer.from(b.hash()).toString("hex")) {
    throw new Error("the signer returned a different transaction than the one we asked it to sign");
  }
  if (b.signatures.length === 0) throw new Error("the signer returned an unsigned transaction");
}

/** Shape of `ChainToolResult["summary"]` in docs/interfaces.md (structural copy; interfaces/ is not edited here). */
export interface ApprovalSummary {
  title: string;
  lines: string[];
  explorerUrl?: string;
  estimatedFee: string;
}

/** Approval card for the payment that funds a withdrawal, decoded from its unsigned XDR. */
export function withdrawalSummary(input: {
  xdr: string;
  networkPassphrase: string;
  orderId: string;
  homeDomain: string;
  asset: AnchorAsset;
  destination: string;
  amount: string;
}): ApprovalSummary {
  const d = describeXdr(input.xdr, input.networkPassphrase);
  return {
    title: `Pay ${input.amount} ${input.asset.code} to ${input.homeDomain} to cash out`,
    lines: [
      `Withdrawal order ${input.orderId} at ${input.homeDomain}`,
      `From ${d.source}`,
      ...d.lines,
      `Asset issuer: ${input.asset.issuer}`,
      "The anchor pays out local currency after it receives this payment. Approve only if you asked to cash out.",
    ],
    explorerUrl: explorerAccountUrl(input.destination, input.networkPassphrase),
    estimatedFee: `${d.feeXlm} XLM`,
  };
}
