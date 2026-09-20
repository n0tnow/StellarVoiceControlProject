/**
 * `sell_asset` / `buy_asset` — the sell/buy voice layer (voice-dialog).
 *
 * These do not invent new chain actions: they map a spoken sell/buy onto the
 * **existing** executors, so the chain lane is unchanged:
 *
 *   sell + anchor -> `withdraw`   (USDC -> TRY via SEP-6; only USDC is supported)
 *   sell + p2p    -> `p2p_offer`  (needs a TRY price; asks for it)
 *   buy  + anchor -> `deposit`    (TRY -> USDC)
 *   buy  + p2p    -> opens the P2P offers, then `p2p_accept` once an id is named
 *
 * A missing route is one short question ("Via the bank (anchor) or
 * peer-to-peer?"), remembered as a pending clarification. A missing P2P price is
 * the same mechanism. Nothing is claimed to have happened before the shell
 * confirms, and nothing here touches a chain.
 */
import type { Intent, NavigationRequest } from "@polaris/interfaces";

import { DEFAULT_ASSET, describeSupportedAssets, normalizeAsset } from "../assets.ts";
import type { PendingClarificationDraft } from "../dialog.ts";
import { AgentError } from "../errors.ts";
import { languageBase } from "../language.ts";
import type { AgentTool, ToolContext } from "./registry.ts";

type Route = "anchor" | "p2p";

const DECIMAL = /^\d+(?:\.\d+)?$/;

function bad(tool: string, message: string, pending?: PendingClarificationDraft): never {
  throw new AgentError("input", `${tool} arguments rejected: ${message}`, pending);
}

/** Canonicalises a spoken route, or `undefined` when it was not given. */
export function normalizeRoute(value: unknown): Route | undefined {
  if (typeof value !== "string") return undefined;
  const folded = value.trim().toLowerCase().replace(/[-\s]+/g, "");
  if (["anchor", "bank", "banka", "bankadan", "sep6", "fiat"].includes(folded)) return "anchor";
  if (["p2p", "peertopeer", "peer", "escrow", "ilan"].includes(folded)) return "p2p";
  return undefined;
}

/** An asset code the user named; never defaults, so a nameless asset asks back. */
function requireAsset(tool: string, value: unknown): string {
  if (value === undefined || value === null || String(value).trim().length === 0) {
    bad(tool, "asset is missing; ask which asset the user means");
  }
  const asset = normalizeAsset(value);
  if (asset === undefined) {
    bad(tool, `asset "${String(value)}" is not supported; supported assets are: ${describeSupportedAssets()}`);
  }
  return asset;
}

/** A positive decimal token amount, or the literal `"all"` ("sat all my USDC"). */
function parseTokenAmount(tool: string, value: unknown): string {
  if (typeof value === "string" && value.trim().toLowerCase() === "all") return "all";
  const asString = typeof value === "number" ? String(value) : value;
  if (typeof asString !== "string") bad(tool, "amount must be a decimal string or \"all\"");
  const amount = asString.trim();
  if (!DECIMAL.test(amount) || !/[1-9]/.test(amount)) {
    bad(tool, `amount is not a positive decimal: "${amount}"`);
  }
  return amount;
}

/** The same positive decimal rule as the P2P tool's TRY price. */
const TRY = /^\d{1,12}(\.\d{1,2})?$/;

function parseTry(tool: string, value: unknown): string {
  const asString = typeof value === "number" ? String(value) : value;
  if (typeof asString !== "string") bad(tool, "priceTry must be a decimal string");
  const price = asString.trim();
  if (!TRY.test(price) || !/[1-9]/.test(price)) {
    bad(tool, `priceTry is not a positive TRY amount: "${price}"`);
  }
  return price;
}

export interface SellAssetInput {
  asset?: unknown;
  amount?: unknown;
  route?: unknown;
  priceTry?: unknown;
  language?: unknown;
}

/** Validates a spoken sell into the matching existing intent. */
export function parseSellAsset(input: unknown, ctx: ToolContext): Intent {
  if (typeof input !== "object" || input === null) bad("sell_asset", "arguments were not an object");
  const raw = input as SellAssetInput;
  const asset = requireAsset("sell_asset", raw.asset);
  const amount = parseTokenAmount("sell_asset", raw.amount);
  const route = normalizeRoute(raw.route);
  if (!route) {
    bad("sell_asset", "route is missing", {
      kind: "sell",
      filledSlots: { asset, amount },
      missing: ["route"],
      question: "sell_route",
    });
  }
  if (route === "anchor") {
    if (asset !== DEFAULT_ASSET) {
      bad(
        "sell_asset",
        `selling ${asset} through the bank is not supported; only ${DEFAULT_ASSET} can be ` +
          `cashed out — offer a peer-to-peer sale instead`,
      );
    }
    return { kind: "withdraw", asset, amount, route: "anchor", source: ctx.transcript };
  }
  const priceTry = raw.priceTry === undefined || raw.priceTry === null ? undefined : parseTry("sell_asset", raw.priceTry);
  if (!priceTry) {
    bad("sell_asset", "a TRY price is required for a peer-to-peer sale", {
      kind: "sell",
      filledSlots: { asset, amount, route },
      missing: ["priceTry"],
      question: "sell_price",
    });
  }
  return { kind: "p2p_offer", asset, amount, priceTry, route: "p2p", source: ctx.transcript };
}

export interface BuyAssetInput {
  asset?: unknown;
  amount?: unknown;
  route?: unknown;
  offerId?: unknown;
  language?: unknown;
}

/** True when a P2P accept names the offer to take. */
function hasOfferId(value: unknown): boolean {
  return typeof value === "number" || (typeof value === "string" && /^\d+$/.test(value.trim()));
}

/** Validates a spoken buy into a deposit or an accept of a named offer. */
export function parseBuyAsset(input: unknown, ctx: ToolContext): Intent {
  if (typeof input !== "object" || input === null) bad("buy_asset", "arguments were not an object");
  const raw = input as BuyAssetInput;
  const route = normalizeRoute(raw.route);
  const amount = raw.amount === undefined || raw.amount === null ? undefined : parseTokenAmount("buy_asset", raw.amount);
  if (!route) {
    bad("buy_asset", "route is missing", {
      kind: "buy",
      ...(amount ? { filledSlots: { amount } } : { filledSlots: {} }),
      missing: ["route"],
      question: "sell_route",
    });
  }
  if (route === "p2p") {
    if (!hasOfferId(raw.offerId)) {
      // Handled by `toNavigationFor`: opens the offers list before anything signs.
      bad("buy_asset", "no offer id was named; open the offers list instead");
    }
    const offerId = typeof raw.offerId === "number" ? raw.offerId : Number(String(raw.offerId).trim());
    if (!Number.isInteger(offerId) || offerId < 0) bad("buy_asset", "offerId must be a non-negative integer");
    return { kind: "p2p_accept", asset: DEFAULT_ASSET, amount: "0", offerId, route: "p2p", source: ctx.transcript };
  }
  if (!amount) bad("buy_asset", "amount is required");
  return { kind: "deposit", asset: "TRY", amount, route: "anchor", source: ctx.transcript };
}

function navigation(address: string | undefined): NavigationRequest {
  const base = languageBase(address);
  return {
    target: "p2p",
    spoken: base === "tr" ? "P2P ilanlarını açıyorum." : "Opening P2P offers.",
    ...(base ? { language: base } : {}),
  };
}

export const sellAssetTool: AgentTool<SellAssetInput, Intent> = {
  name: "sell_asset",
  description:
    "Sell a token: through the bank (anchor, USDC to TRY) or peer-to-peer (locks tokens on-chain and asks for TRY off-chain). Produces the matching withdraw/p2p_offer proposal.",
  inputSchema: {
    type: "object",
    properties: {
      asset: {
        type: "string",
        description: `Asset to sell; only ${describeSupportedAssets()} are supported.`,
      },
      amount: {
        type: "string",
        description: 'Positive decimal token amount as a string, or "all".',
      },
      route: {
        type: "string",
        enum: ["anchor", "p2p"],
        description:
          'How to sell: "anchor" = via the bank, "p2p" = peer-to-peer. Omit it and ask "Via the bank (anchor) or peer-to-peer?" when the user did not say.',
      },
      priceTry: {
        type: "string",
        description: 'P2P only: the asking price in TRY as a decimal string, e.g. "3400".',
      },
      language: { type: "string", description: 'The language the user spoke ("tr" or "en").' },
    },
    required: ["asset", "amount"],
    additionalProperties: false,
  },
  requiresApproval: true,
  toIntent: parseSellAsset,
  async run(input: SellAssetInput, ctx: ToolContext): Promise<Intent> {
    return parseSellAsset(input, ctx);
  },
};

export const buyAssetTool: AgentTool<BuyAssetInput, Intent> = {
  name: "buy_asset",
  description:
    "Buy a token: through the bank (anchor, TRY to USDC) or peer-to-peer (opens the offers; taking one of them later needs its offer number). Produces a deposit/p2p_accept proposal, or opens the P2P offers list.",
  inputSchema: {
    type: "object",
    properties: {
      asset: {
        type: "string",
        description: `Asset to buy; only ${describeSupportedAssets()} are supported.`,
      },
      amount: {
        type: "string",
        description: 'Positive decimal amount as a string ("50"). For the bank route it is the TRY amount.',
      },
      route: {
        type: "string",
        enum: ["anchor", "p2p"],
        description:
          'How to buy: "anchor" = via the bank, "p2p" = peer-to-peer. Omit it and ask the route question when the user did not say.',
      },
      offerId: {
        type: "integer",
        description: "P2P only: the offer number the user named to take.",
      },
      language: { type: "string", description: 'The language the user spoke ("tr" or "en").' },
    },
    required: [],
    additionalProperties: false,
  },
  requiresApproval: true,
  toIntent: parseBuyAsset,
  toNavigationFor(input: BuyAssetInput): NavigationRequest | undefined {
    const route = normalizeRoute(input?.route);
    if (route === "p2p" && !hasOfferId(input?.offerId)) {
      return navigation(typeof input?.language === "string" ? input.language : undefined);
    }
    return undefined;
  },
  async run(input: BuyAssetInput, ctx: ToolContext): Promise<Intent> {
    return parseBuyAsset(input, ctx);
  },
};
