/**
 * The assets Polaris can move — defined in ONE place (step A13).
 *
 * The model used to invent them: asked to "send 400 dollar", it returned
 * `asset: "USD"`, which the demo does not support. Nothing had told it which
 * assets exist. The system prompt now states the list from here, and
 * `parseSendPayment` rejects anything outside it, so a guess becomes a
 * clarification the user hears instead of a bogus intent that reaches the
 * approval seam (`docs/architecture.md` §6: the LLM proposes, we dispose).
 *
 * There is deliberately **no second list**: the prompt and the validator both
 * read `SUPPORTED_ASSETS`, so adding an asset here (and its spoken words in
 * `ASSET_SYNONYMS`) makes every layer follow.
 *
 * The list holds the two assets a Stellar account can actually move today:
 * the Circle testnet stablecoin the anchor path produces (`USDC`, the demo
 * asset) and the network's native asset (`XLM`). The owner's guard contract
 * allowlists its own subset per user; this is the agent-side ceiling, not a
 * promise that every intent is authorised on-chain.
 */

/** The asset a payment defaults to when the user names none. */
export const DEFAULT_ASSET = "USDC";

/** Every asset Polaris supports. The prompt and the validator both read this. */
export const SUPPORTED_ASSETS: readonly string[] = [DEFAULT_ASSET, "XLM"];

/**
 * Words that mean a supported asset but are not its code, lower-cased for
 * matching. A dollar is the stablecoin: the only dollar-pegged asset we move
 * is `DEFAULT_ASSET`, so "dollar"/"dolar"/"$"/"USD" all canonicalise to it.
 */
export const ASSET_SYNONYMS: Readonly<Record<string, string>> = {
  dollar: DEFAULT_ASSET,
  dollars: DEFAULT_ASSET,
  usd: DEFAULT_ASSET,
  dolar: DEFAULT_ASSET,
  "$": DEFAULT_ASSET,
};

/**
 * Canonicalises a model-supplied asset: a supported code, one of the colloquial
 * words, or `undefined` when the asset is genuinely unsupported.
 *
 * A blank value is the user's omission (the prompt tells the model to omit the
 * field) and canonicalises to `DEFAULT_ASSET`; `undefined` is the *only*
 * rejected outcome, so callers must treat it as a clarification.
 */
export function normalizeAsset(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return DEFAULT_ASSET;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return DEFAULT_ASSET;
  }
  const upper = trimmed.toUpperCase();
  const supported = SUPPORTED_ASSETS.find((asset) => asset.toUpperCase() === upper);
  if (supported) {
    return supported;
  }
  return ASSET_SYNONYMS[trimmed.toLowerCase()];
}

/** The asset codes as a readable list, e.g. `USDC` or `USDC and XLM`. */
export function describeSupportedAssets(): string {
  return joinWords(SUPPORTED_ASSETS);
}

/** The colloquial money words as a readable list, e.g. `dollar, dolar, $`. */
export function describeAssetSynonyms(): string {
  return joinWords(Object.keys(ASSET_SYNONYMS));
}

function joinWords(words: readonly string[]): string {
  if (words.length <= 1) {
    return words[0] ?? "";
  }
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}
