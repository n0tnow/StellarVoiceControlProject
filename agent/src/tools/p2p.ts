/**
 * P2P escrow intent tools (W8).
 *
 * Like `send_payment`, these are **not executable** during the agent turn: the
 * model proposes arguments, this module validates them locally and returns the
 * shared `Intent`. The chain half (unsigned XDR + summary, then the Touch ID
 * gate) runs later through the execution seam. Nothing here touches a chain.
 *
 * Three intents:
 *   - "sell 100 USDC for 3400 TRY"          -> `p2p_offer`
 *   - "take offer 3" / "3 numaralı ilanı al" -> `p2p_accept`
 *   - "confirm payment received on offer 3"  -> `p2p_confirm`
 *
 * Validation is strict because the model is the untrusted party: a guessed
 * price or a non-integer offer id becomes a clarification (`AgentError` kind
 * `input`), never a value-moving intent.
 */
import type { Intent } from "@polaris/interfaces";
import { DEFAULT_ASSET, describeSupportedAssets, normalizeAsset } from "../assets.ts";
import { AgentError } from "../errors.ts";
import { parseAmount } from "./payment.ts";
import type { AgentTool, ToolContext } from "./registry.ts";

/** Positive TRY decimal, at most 2 fraction digits (matching the chain lane). */
const TRY = /^\d{1,12}(\.\d{1,2})?$/;

function bad(tool: string, message: string): never {
  throw new AgentError("input", `${tool} arguments rejected: ${message}`);
}

/** Normalises a TRY price to a positive decimal string, rejecting anything else. */
export function parseTryPrice(tool: string, value: unknown): string {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) bad(tool, "priceTry is not a finite number");
    value = String(value);
  }
  if (typeof value !== "string") bad(tool, "priceTry must be a string or a number");
  const price = value.trim();
  if (!TRY.test(price) || !/[1-9]/.test(price)) {
    bad(tool, `priceTry is not a positive TRY amount: "${price}"`);
  }
  return price;
}

/** Normalises an offer id to a non-negative integer, rejecting anything else. */
export function parseOfferId(tool: string, value: unknown): number {
  const asNumber =
    typeof value === "string" && /^\d+$/.test(value.trim())
      ? Number(value.trim())
      : typeof value === "number"
        ? value
        : Number.NaN;
  if (!Number.isInteger(asNumber) || asNumber < 0) {
    bad(tool, `offerId must be a non-negative integer, got ${JSON.stringify(value)}`);
  }
  return asNumber;
}

/** Resolves the sold asset against the supported list, or asks back. */
function requireAsset(tool: string, value: unknown): string {
  const asset = normalizeAsset(value);
  if (asset === undefined) {
    bad(tool, `asset "${String(value)}" is not supported; supported assets are: ${describeSupportedAssets()}`);
  }
  return asset;
}

export interface P2pOfferInput {
  amount?: unknown;
  asset?: unknown;
  priceTry?: unknown;
}

/** Validates a P2P offer request into an `Intent`. */
export function parseP2pOffer(input: unknown, ctx: ToolContext): Intent {
  if (typeof input !== "object" || input === null) bad("p2p_offer", "arguments were not an object");
  const raw = input as P2pOfferInput;
  const amount = parseAmount(raw.amount);
  const asset = requireAsset("p2p_offer", raw.asset);
  const priceTry = parseTryPrice("p2p_offer", raw.priceTry);
  return { kind: "p2p_offer", asset, amount, priceTry, source: ctx.transcript };
}

export interface P2pOfferIdInput {
  offerId?: unknown;
}

/** Validates an accept request into an `Intent`. */
export function parseP2pAccept(input: unknown, ctx: ToolContext): Intent {
  if (typeof input !== "object" || input === null) bad("p2p_accept", "arguments were not an object");
  const offerId = parseOfferId("p2p_accept", (input as P2pOfferIdInput).offerId);
  return { kind: "p2p_accept", asset: DEFAULT_ASSET, amount: "0", offerId, source: ctx.transcript };
}

/** Validates a confirm-fiat request into an `Intent`. */
export function parseP2pConfirm(input: unknown, ctx: ToolContext): Intent {
  if (typeof input !== "object" || input === null) bad("p2p_confirm", "arguments were not an object");
  const offerId = parseOfferId("p2p_confirm", (input as P2pOfferIdInput).offerId);
  return { kind: "p2p_confirm", asset: DEFAULT_ASSET, amount: "0", offerId, source: ctx.transcript };
}

const LANGUAGE_PROPERTY = {
  type: "string",
  description:
    'The language the user spoke, as a BCP-47 base code ("tr" or "en"). Used to pick the reply voice; never spoken.',
};

export const p2pOfferTool: AgentTool<P2pOfferInput, Intent> = {
  name: "p2p_offer",
  description:
    "Sell tokens peer-to-peer for TRY. The seller locks the tokens on-chain and asks for TRY paid off-chain; Autonomy never moves the TRY.",
  inputSchema: {
    type: "object",
    properties: {
      amount: { type: "string", description: 'Positive decimal token amount as a string, e.g. "100".' },
      asset: {
        type: "string",
        description: `Asset code to sell; only ${describeSupportedAssets()} are supported.`,
      },
      priceTry: { type: "string", description: 'Asking price in TRY as a decimal string, e.g. "3400".' },
      language: LANGUAGE_PROPERTY,
    },
    required: ["amount", "asset", "priceTry"],
    additionalProperties: false,
  },
  requiresApproval: true,
  toIntent: parseP2pOffer,
  async run(input: P2pOfferInput, ctx: ToolContext): Promise<Intent> {
    return parseP2pOffer(input, ctx);
  },
};

export const p2pAcceptTool: AgentTool<P2pOfferIdInput, Intent> = {
  name: "p2p_accept",
  description:
    "Take an open P2P offer by id. The buyer must then pay the TRY off-chain to the seller before the deadline.",
  inputSchema: {
    type: "object",
    properties: {
      offerId: { type: "integer", description: "The on-chain offer id to accept." },
      language: LANGUAGE_PROPERTY,
    },
    required: ["offerId"],
    additionalProperties: false,
  },
  requiresApproval: true,
  toIntent: parseP2pAccept,
  async run(input: P2pOfferIdInput, ctx: ToolContext): Promise<Intent> {
    return parseP2pAccept(input, ctx);
  },
};

export const p2pConfirmTool: AgentTool<P2pOfferIdInput, Intent> = {
  name: "p2p_confirm",
  description:
    "Seller confirms the off-chain TRY payment for an offer, releasing the locked tokens to the buyer. Use only after the TRY was really received.",
  inputSchema: {
    type: "object",
    properties: {
      offerId: { type: "integer", description: "The on-chain offer id to confirm." },
      language: LANGUAGE_PROPERTY,
    },
    required: ["offerId"],
    additionalProperties: false,
  },
  requiresApproval: true,
  toIntent: parseP2pConfirm,
  async run(input: P2pOfferIdInput, ctx: ToolContext): Promise<Intent> {
    return parseP2pConfirm(input, ctx);
  },
};
