/**
 * Decode a built guard invocation back out of its XDR.
 *
 * The approval card must render what will really be signed, so every summary
 * is produced from the transaction XDR — contract id, function name and
 * argument values — never from the caller's intent text.
 *
 * Browser-safe: hex comes from a local `toHex`; no `Buffer`, no `node:`.
 */
import { Address, Transaction, TransactionBuilder, scValToNative } from "@stellar/stellar-sdk";
import type { Operation } from "@stellar/stellar-sdk";
import type { GuardSummary } from "./types.ts";
import { fromRawUnits } from "./amount.ts";

const DEFAULT_EXPLORER_BASE = "https://stellar.expert/explorer/testnet";

export interface DecodedInvocation {
  contractId: string;
  functionName: string;
  /** Decoded argument values, in ABI order. */
  args: unknown[];
}

/** Lowercase hex of arbitrary bytes without the Node `Buffer` global. */
export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

/** Exact stroops -> XLM, no trailing zeros (100 -> "0.00001"). */
export function stroopsToXlm(stroops: string): string {
  const n = BigInt(stroops);
  const whole = n / 10_000_000n;
  const frac = (n % 10_000_000n).toString().padStart(7, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

/** `G...`/`C...` -> `GABC…WXYZ` for cards and logs. */
export function shortKey(address: string): string {
  return address.length > 8 ? `${address.slice(0, 4)}…${address.slice(-4)}` : address;
}

function decodeTx(unsignedXdr: string, networkPassphrase: string): Transaction {
  const tx = TransactionBuilder.fromXDR(unsignedXdr, networkPassphrase);
  if (!(tx instanceof Transaction)) throw new Error("fee-bump envelopes are not supported for guard calls");
  return tx;
}

/** Contract id + function name + decoded args of the (single) invocation. */
export function decodeInvocation(unsignedXdr: string, networkPassphrase: string): DecodedInvocation {
  const tx = decodeTx(unsignedXdr, networkPassphrase);
  const op = tx.operations[0] as Operation.InvokeHostFunction | undefined;
  if (!op || op.type !== "invokeHostFunction") throw new Error("the built transaction is not a contract invocation");
  const invoke = op.func;
  if (invoke.type !== "hostFunctionTypeInvokeContract") {
    throw new Error(`the built transaction is not an invoke-contract call (${String(invoke.type)})`);
  }
  return {
    contractId: Address.fromScAddress(invoke.invokeContract.contractAddress).toString(),
    functionName: invoke.invokeContract.functionName.toString(),
    args: invoke.invokeContract.args.map((arg) => scValToNative(arg)),
  };
}

/** Render a decoded argument for a one-line summary (bigints keep their exact value). */
function describeValue(value: unknown): string {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return `[${value.map(describeValue).join(", ")}]`;
  if (value === null || value === undefined) return String(value);
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).map(
      ([k, v]) => `${k}: ${describeValue(v)}`,
    );
    return `{ ${entries.join(", ")} }`;
  }
  return String(value);
}

export interface BuiltGuardSummary {
  summary: GuardSummary;
  payloadHash: string;
}

/** Generic summary for any guard write: decoded function, args, network, fee. */
export function buildGuardCallSummary(input: {
  unsignedXdr: string;
  networkPassphrase: string;
  explorerBase?: string;
}): BuiltGuardSummary {
  const tx = decodeTx(input.unsignedXdr, input.networkPassphrase);
  const invocation = decodeInvocation(input.unsignedXdr, input.networkPassphrase);
  const payloadHash = toHex(tx.hash());
  const fee = `${stroopsToXlm(tx.fee)} XLM`;
  const summary: GuardSummary = {
    title: `polaris_guard: ${invocation.functionName}`,
    lines: [
      `Contract: ${shortKey(invocation.contractId)}`,
      `Args: ${invocation.args.map(describeValue).join(", ")}`,
      `Network: ${input.networkPassphrase}`,
      `Fee: ${fee}`,
    ],
    explorerUrl: `${input.explorerBase ?? DEFAULT_EXPLORER_BASE}/tx/${payloadHash}`,
    estimatedFee: fee,
  };
  return { summary, payloadHash };
}

export interface GuardedPaymentSummaryInput {
  unsignedXdr: string;
  networkPassphrase: string;
  /** Contract id the client was built with; asserted against the decoded op. */
  contractId: string;
  route: "pay_executor" | "pay_owner";
  /** Resolved alias name. */
  alias: string;
  /** Human asset code ("USDC") for display; the SAC id is decoded from the XDR. */
  assetCode: string;
  explorerBase?: string;
}

/**
 * Summary for a guarded `sendPayment`. Function name, recipient, asset SAC and
 * amount are all read from the XDR; the alias and asset code are display-only
 * labels supplied by the caller after alias/asset resolution.
 */
export function buildGuardedPaymentSummary(input: GuardedPaymentSummaryInput): BuiltGuardSummary {
  const tx = decodeTx(input.unsignedXdr, input.networkPassphrase);
  const invocation = decodeInvocation(input.unsignedXdr, input.networkPassphrase);
  if (invocation.contractId !== input.contractId) {
    throw new Error(
      `guarded summary mismatch: XDR targets ${invocation.contractId}, client is ${input.contractId}`,
    );
  }
  if (invocation.functionName !== input.route) {
    throw new Error(`guarded summary mismatch: XDR calls ${invocation.functionName}, route is ${input.route}`);
  }
  const args = invocation.args;
  // pay_executor(executor, owner, to, asset, amount) | pay_owner(owner, to, asset, amount)
  const offset = input.route === "pay_executor" ? 1 : 0;
  const to = String(args[offset + 1]);
  const asset = String(args[offset + 2]);
  const amountRaw = args[offset + 3];
  if (typeof amountRaw !== "bigint") throw new Error("guarded summary: amount argument is not an i128");
  const amount = fromRawUnits(amountRaw);
  const signer = input.route === "pay_executor" ? "executor" : "owner";
  const payloadHash = toHex(tx.hash());
  const fee = `${stroopsToXlm(tx.fee)} XLM`;
  const summary: GuardSummary = {
    title: `Guarded payment via polaris_guard (${shortKey(input.contractId)}) — route: ${input.route}`,
    lines: [
      `Route: ${input.route} (${signer} signs)`,
      `Pay ${amount} ${input.assetCode}`,
      `Asset (SAC): ${asset}`,
      `To ${input.alias} (${to})`,
      `Network: ${input.networkPassphrase}`,
      `Fee: ${fee}`,
    ],
    explorerUrl: `${input.explorerBase ?? DEFAULT_EXPLORER_BASE}/tx/${payloadHash}`,
    estimatedFee: fee,
  };
  return { summary, payloadHash };
}
