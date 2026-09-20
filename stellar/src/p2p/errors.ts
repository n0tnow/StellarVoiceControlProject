/**
 * Typed, machine-readable errors for the P2P client.
 *
 * The escrow's contract error discriminants (`200..211`) are public ABI, and the
 * token/SAC block (`1..15`) is shared with the guard. A simulation failure is
 * surfaced as a `P2pRefusal` carrying the raw host message (kept for a Details
 * toggle); `p2pErrorMessage` turns that into one plain sentence for every place
 * the app shows a failure, so a raw `HostError: Error(Contract, #13)` is never
 * shown to the user. Callers must match on `code`, never on `message`.
 */
import { classifyContractText } from "../keeper/errors.ts";

export type P2pRefusalCode =
  | "not_configured"
  | "invalid_intent"
  | "invalid_price"
  | "simulation_failed";

/** A typed P2P failure. `details` is advisory context. */
export class P2pRefusal extends Error {
  readonly code: P2pRefusalCode;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(code: P2pRefusalCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "P2pRefusal";
    this.code = code;
    this.details = details;
  }
}

export function isP2pRefusal(value: unknown): value is P2pRefusal {
  return value instanceof P2pRefusal;
}

/** Wraps any thrown value as a typed refusal (transport failures included). */
export function asP2pRefusal(error: unknown): P2pRefusal {
  if (isP2pRefusal(error)) return error;
  return new P2pRefusal(
    "simulation_failed",
    error instanceof Error ? error.message : String(error),
  );
}

/** Context for a plain-language message; the asset name leads token messages. */
export interface P2pErrorContext {
  /** Asset code involved in the trade (e.g. `"USDC"`). */
  asset?: string;
}

const DEFAULT_ASSET = "this asset";

/** The escrow's own range (`200..211`) -> a sentence a non-developer can act on. */
const ESCROW_MESSAGES: Readonly<Record<number, string>> = {
  200: "That offer no longer exists.",
  201: "The amount must be greater than zero.",
  202: "The price must be greater than zero.",
  203: "The offer lifetime must be between 60 seconds and 7 days.",
  204: "That offer is no longer open, so this action is not allowed.",
  205: "That offer has expired.",
  206: "You cannot take your own offer.",
  207: "That offer has not been accepted yet.",
  208: "Only the offer's seller can do that.",
  209: "It is too early to reclaim this offer.",
  210: "This offer cannot be reclaimed.",
  211: "The trade amounts are out of range; try a smaller amount.",
};

/** SAC/token codes (`2..15`, shared with the guard) -> a plain sentence. */
const TOKEN_MESSAGES: Readonly<Record<number, (asset: string) => string>> = {
  4: (a) => `Your wallet is not allowed to move ${a}.`,
  5: (a) => `The ${a} authorization failed.`,
  6: () => "An account involved in the trade does not exist.",
  7: () => "That address cannot hold this kind of asset.",
  8: (a) => `The ${a} amount cannot be negative.`,
  9: (a) => `The ${a} allowance is missing or too small.`,
  10: (a) => `Not enough ${a} in your wallet.`,
  11: (a) => `The ${a} issuer has deauthorized your wallet.`,
  12: () => "The trade amounts are out of range.",
  13: (a) => `Your wallet has no ${a} trustline yet.`,
  14: () => "Your wallet needs a little more XLM to hold this asset.",
  15: () => "Your wallet has too many trustlines to add another.",
};

const HOST_ERROR_RE = /HostError|Error\(Contract,/;

function firstLine(text: string): string {
  return (text.split(/\r?\n/, 1)[0] ?? text).trim();
}

/**
 * Turns any P2P failure into one plain sentence. Raw host text is never
 * returned: a simulation failure is classified against the escrow's 200+ block
 * and the token/SAC block, and an unrecognised host error becomes a calm
 * fallback. Config and price refusals already carry an instructive message and
 * are returned as-is.
 */
export function p2pErrorMessage(error: unknown, context: P2pErrorContext = {}): string {
  const raw = error instanceof Error ? error.message : String(error);
  if (isP2pRefusal(error) && (error.code === "not_configured" || error.code === "invalid_price")) {
    return raw;
  }
  const asset = context.asset ?? DEFAULT_ASSET;
  const { code } = classifyContractText(raw);
  if (code !== undefined) {
    if (code >= 200) return ESCROW_MESSAGES[code] ?? "The escrow rejected this trade.";
    const token = TOKEN_MESSAGES[code];
    if (token) return token(asset);
  }
  if (HOST_ERROR_RE.test(raw)) {
    return `The network refused this trade. Check that your wallet holds ${asset}, then try again.`;
  }
  return firstLine(raw);
}
