/**
 * Decode a built P2P invocation back out of its XDR and turn a decoded contract
 * `Offer` into the typed shape.
 *
 * The approval card must render what will really be signed, so every summary is
 * produced from the transaction XDR — contract id, function name and argument
 * values — never from the caller's intent text. Titles and extra lines the
 * caller supplies are display labels only.
 */
import { Transaction, TransactionBuilder } from "@stellar/stellar-sdk";

import type { ChainToolResult } from "@polaris/interfaces";
import { decodeInvocation, shortKey, stroopsToXlm, toHex } from "../guard/describe.ts";
import { P2pRefusal } from "./errors.ts";
import { OFFER_STATES, type Offer, type OfferState } from "./types.ts";

const DEFAULT_EXPLORER_BASE = "https://stellar.expert/explorer/testnet";

/** The write functions this client builds; used to assert the decoded call. */
export type P2pWriteFunction = "create_offer" | "accept" | "confirm_fiat" | "cancel" | "reclaim";

export interface BuildP2pSummaryInput {
  unsignedXdr: string;
  networkPassphrase: string;
  /** Contract id the client was built with; asserted against the decoded op. */
  contractId: string;
  /** The function the XDR is expected to call; a mismatch is a bug, not a warning. */
  functionName: P2pWriteFunction;
  /** Human-readable title for the approval card. */
  title: string;
  /** Extra display lines (amount, price, parties), shown above the decoded args. */
  context?: string[];
  explorerBase?: string;
}

/** Human summary + transaction hash for one unsigned write. */
export function buildP2pCallSummary(input: BuildP2pSummaryInput): {
  summary: ChainToolResult["summary"];
  payloadHash: string;
} {
  const tx = TransactionBuilder.fromXDR(input.unsignedXdr, input.networkPassphrase);
  if (!(tx instanceof Transaction)) throw new Error("fee-bump envelopes are not supported for P2P calls");
  const invocation = decodeInvocation(input.unsignedXdr, input.networkPassphrase);
  if (invocation.contractId !== input.contractId) {
    throw new Error(
      `P2P summary mismatch: XDR targets ${invocation.contractId}, client is ${input.contractId}`,
    );
  }
  if (invocation.functionName !== input.functionName) {
    throw new Error(
      `P2P summary mismatch: XDR calls ${invocation.functionName}, expected ${input.functionName}`,
    );
  }
  const args = invocation.args.map((arg) => (typeof arg === "bigint" ? arg.toString() : arg));
  const payloadHash = toHex(tx.hash());
  const fee = `${stroopsToXlm(tx.fee)} XLM`;
  const summary: ChainToolResult["summary"] = {
    title: input.title,
    lines: [
      ...(input.context ?? []),
      `Contract: ${shortKey(input.contractId)} — ${input.functionName}`,
      `Args: ${args.map(describeArg).join(", ")}`,
      `Network: ${input.networkPassphrase}`,
      `Fee: ${fee}`,
      "Note: the TRY payment happens outside Autonomy; confirm only after you received it.",
    ],
    explorerUrl: `${input.explorerBase ?? DEFAULT_EXPLORER_BASE}/tx/${payloadHash}`,
    estimatedFee: fee,
  };
  return { summary, payloadHash };
}

function describeArg(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "bigint" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value === null || value === undefined) return String(value);
  if (Array.isArray(value)) return `[${value.map(describeArg).join(", ")}]`;
  if (typeof value === "object") {
    return `{ ${Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => `${k}: ${describeArg(v)}`)
      .join(", ")} }`;
  }
  return String(value);
}

/** True when `value` is one of the contract's offer states (bare symbol form). */
export function isOfferState(value: unknown): value is OfferState {
  return typeof value === "string" && (OFFER_STATES as readonly string[]).includes(value);
}

/**
 * Normalise the contract's `OfferState`. Soroban encodes a `#[contracttype]`
 * enum as a one-element vector (`scvVec([scvSymbol(name)])`), which
 * `scValToNative` maps to `[name]`; a decoded bare `name` is also accepted for
 * older/other SDK paths. Anything else is a schema drift and is rejected.
 */
export function normalizeOfferState(value: unknown): OfferState {
  if (isOfferState(value)) return value;
  if (Array.isArray(value) && value.length === 1 && isOfferState(value[0])) return value[0];
  throw new P2pRefusal(
    "simulation_failed",
    `get_offer returned an unknown state: ${JSON.stringify(value)}`,
  );
}

/**
 * Normalise a `scValToNative` result into an `Offer`. Throws a typed refusal
 * when a required field is missing, so a malformed contract read fails loudly
 * instead of producing a half-built row.
 */
export function decodeOffer(value: unknown): Offer {
  if (typeof value !== "object" || value === null) {
    throw new P2pRefusal("simulation_failed", "get_offer returned a non-struct value");
  }
  const raw = value as Record<string, unknown>;
  const asBigInt = (field: unknown, name: string): bigint => {
    if (typeof field === "bigint") return field;
    if (typeof field === "number" && Number.isInteger(field)) return BigInt(field);
    throw new P2pRefusal("simulation_failed", `get_offer field ${name} is not an integer`);
  };
  const asAddress = (field: unknown, name: string): string => {
    if (typeof field !== "string" || field.length === 0) {
      throw new P2pRefusal("simulation_failed", `get_offer field ${name} is not an address`);
    }
    return field;
  };
  const buyer = raw.buyer;
  return {
    id: asBigInt(raw.id, "id"),
    seller: asAddress(raw.seller, "seller"),
    token: asAddress(raw.token, "token"),
    amount: asBigInt(raw.amount, "amount"),
    price_try_kurus: asBigInt(raw.price_try_kurus, "price_try_kurus"),
    created_at: asBigInt(raw.created_at, "created_at"),
    expires_at: asBigInt(raw.expires_at, "expires_at"),
    // `Option<Address>` decodes to `null` (void) or the address string.
    buyer: buyer === null || buyer === undefined ? null : asAddress(buyer, "buyer"),
    accepted_at: asBigInt(raw.accepted_at, "accepted_at"),
    pay_deadline: asBigInt(raw.pay_deadline, "pay_deadline"),
    state: normalizeOfferState(raw.state),
  };
}
