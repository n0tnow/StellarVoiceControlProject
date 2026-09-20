/**
 * `@polaris/stellar` P2P namespace (W8): the client for `polaris_p2p_escrow`.
 *
 * Pure builders (unsigned XDR + decoded summary) and simulation-only read
 * helpers. The contract id is always a parameter (D9); nothing here signs,
 * submits, or moves value. The TRY leg is deliberately outside Polaris — the
 * chain only escrows the sold token.
 */
export {
  createP2pClient,
  DEFAULT_OFFER_TTL_SECONDS,
  DEFAULT_TX_TIMEOUT_SECONDS,
} from "./client.ts";
export { KURUS_PER_LIRA, kurusToTry, tryToKurus } from "./amount.ts";
export {
  buildP2pCallSummary,
  decodeOffer,
  isOfferState,
  normalizeOfferState,
  type P2pWriteFunction,
} from "./describe.ts";
export {
  P2pRefusal,
  asP2pRefusal,
  isP2pRefusal,
  p2pErrorMessage,
  type P2pErrorContext,
  type P2pRefusalCode,
} from "./errors.ts";
export { OFFER_STATES } from "./types.ts";
export type {
  Offer,
  OfferState,
  P2pCall,
  P2pClient,
  P2pClientOptions,
  P2pRpcLike,
  P2pSummary,
} from "./types.ts";
