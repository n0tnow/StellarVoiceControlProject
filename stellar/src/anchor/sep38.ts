/**
 * SEP-38: price quotes. GET /price works without authentication and gives an
 * INDICATIVE rate ("what would 500 TRY buy right now?"). Amounts are decimal
 * strings — never floats.
 */
import { requestJson } from "./http.ts";
import type { AnchorContext, AnchorToml, Quote } from "./types.ts";

interface PriceResponse {
  total_price?: string;
  price?: string;
  sell_amount?: string;
  buy_amount?: string;
  fee?: { total?: string; asset?: string };
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
  if (!res.sell_amount || !res.buy_amount || !res.total_price || !res.price) {
    throw new QuoteError("anchor returned an incomplete price");
  }
  const quote: Quote = {
    sellAsset: req.sellAsset,
    buyAsset: req.buyAsset,
    sellAmount: res.sell_amount,
    buyAmount: res.buy_amount,
    totalPrice: res.total_price,
    price: res.price,
  };
  if (res.fee?.total) quote.feeTotal = res.fee.total;
  if (res.fee?.asset) quote.feeAsset = res.fee.asset;
  const sell = displayAsset(quote.sellAsset);
  const buy = displayAsset(quote.buyAsset);
  const fee = quote.feeTotal ? ` The anchor's fee is ${quote.feeTotal} ${displayAsset(quote.feeAsset ?? quote.sellAsset)}.` : "";
  ctx.explain.record(
    "sep38.price",
    `SEP-38: ${label} ${quote.sellAmount} ${sell} would become about ${quote.buyAmount} ${buy} ` +
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
