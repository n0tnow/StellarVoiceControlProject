/**
 * SEP-38: price quotes. GET /price works without authentication and gives an
 * INDICATIVE rate ("what would 500 TRY buy right now?"). Amounts are decimal
 * strings — never floats.
 */
import { requestJson } from "./http.ts";
import { sanitizeAnchorText } from "./text.ts";
import type { AnchorContext, AnchorToml, Quote } from "./types.ts";

interface PriceResponse {
  total_price?: string;
  price?: string;
  sell_amount?: string;
  buy_amount?: string;
  fee?: { total?: string; asset?: string };
}

/** Quote amounts are anchor-authored: digits and at most one dot, bounded like SEP-6 amounts. */
const QUOTE_AMOUNT = /^\d{1,20}(\.\d{1,10})?$/;
/** Same shape as the asset ids this client requests (`iso4217:TRY`, `stellar:USDC:G...`); C... covers SACs. */
const QUOTE_ASSET = /^(iso4217:[A-Z0-9]{2,12}|stellar:[A-Za-z0-9]{1,12}:(G|C)[A-Z2-7]{55}|stellar:native)$/;

/** Validates an anchor-provided amount; anything else aborts the quote instead of being echoed. */
function quoteAmount(value: unknown, what: string): string {
  if (typeof value !== "string" || !QUOTE_AMOUNT.test(value)) {
    throw new QuoteError(`anchor returned an unusable ${what}`);
  }
  return value;
}

/** Anchors echo arbitrary strings for display-only fields; keep only strict asset ids. */
function quoteAssetId(value: unknown, what: string): string | undefined {
  if (typeof value !== "string") return undefined;
  if (!QUOTE_ASSET.test(value)) {
    throw new QuoteError(`anchor returned an unusable ${what}`);
  }
  return value;
}

export class QuoteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuoteError";
  }
}

export interface PriceRequest {
  sellAsset: string;
  buyAsset: string;
  /** Exactly one of sellAmount / buyAmount. */
  sellAmount?: string;
  buyAmount?: string;
  /** SEP-38 delivery method, e.g. "bank_account". */
  deliveryMethod?: string;
}

export async function getPrice(ctx: AnchorContext, toml: AnchorToml, req: PriceRequest, label: string): Promise<Quote> {
  if (!toml.quoteServer) throw new QuoteError(`${toml.homeDomain} publishes no ANCHOR_QUOTE_SERVER (SEP-38)`);
  if ((req.sellAmount === undefined) === (req.buyAmount === undefined)) {
    throw new QuoteError("give exactly one of sellAmount or buyAmount");
  }
  const query: Record<string, string> = {
    sell_asset: req.sellAsset,
    buy_asset: req.buyAsset,
    context: "sep6",
  };
  if (req.sellAmount !== undefined) query.sell_amount = req.sellAmount;
  if (req.buyAmount !== undefined) query.buy_amount = req.buyAmount;
  if (req.deliveryMethod) {
    query[req.sellAsset.startsWith("iso4217:") ? "sell_delivery_method" : "buy_delivery_method"] = req.deliveryMethod;
  }
  const res = await requestJson<PriceResponse>(ctx, `${toml.quoteServer}/price`, { query });
  if (res.sell_amount === undefined || res.buy_amount === undefined || res.total_price === undefined || res.price === undefined) {
    throw new QuoteError("anchor returned an incomplete price");
  }
  const quote: Quote = {
    sellAsset: req.sellAsset,
    buyAsset: req.buyAsset,
    sellAmount: quoteAmount(res.sell_amount, "sell_amount"),
    buyAmount: quoteAmount(res.buy_amount, "buy_amount"),
    totalPrice: quoteAmount(res.total_price, "total_price"),
    price: quoteAmount(res.price, "price"),
  };
  const feeTotal = res.fee?.total === undefined ? undefined : quoteAmount(res.fee.total, "fee.total");
  const feeAsset = res.fee?.asset === undefined ? undefined : quoteAssetId(res.fee.asset, "fee.asset");
  if (feeTotal) quote.feeTotal = feeTotal;
  if (feeAsset) quote.feeAsset = feeAsset;
  // Belt and braces: every value echoed below has been validated, and is sanitised
  // again here so nothing anchor-authored can carry controls/newlines into speech.
  const said = (v: string): string => sanitizeAnchorText(v, 64) ?? "?";
  const labelText = sanitizeAnchorText(label, 160) ?? "quote";
  const sell = displayAsset(quote.sellAsset);
  const buy = displayAsset(quote.buyAsset);
  const fee = quote.feeTotal ? ` The anchor's fee is ${said(quote.feeTotal)} ${displayAsset(quote.feeAsset ?? quote.sellAsset)}.` : "";
  ctx.explain.record(
    "sep38.price",
    `SEP-38: ${labelText} ${said(quote.sellAmount)} ${sell} would become about ${said(quote.buyAmount)} ${buy} ` +
      `(roughly 1 ${sell} = ${unitRate(quote)} ${buy}, fees included).${fee}`,
    "A quote lets you see what you would get before you commit; the final amount is confirmed when the anchor processes the transfer.",
  );
  return quote;
}

/** `iso4217:TRY` -> `TRY`, `stellar:USDC:G...` -> `USDC` (speakable). */
export function displayAsset(id: string): string {
  const parts = id.split(":");
  return parts[0] === "stellar" ? (parts[1] ?? id) : (parts[1] ?? id);
}

/** How many buy units 1 sell unit fetches, for speech; display only, never used for money maths. */
function unitRate(q: Pick<Quote, "sellAmount" | "buyAmount">): string {
  const r = Number(q.buyAmount) / Number(q.sellAmount);
  if (!Number.isFinite(r)) return "?";
  return r >= 1 ? r.toFixed(2) : r.toPrecision(3);
}
