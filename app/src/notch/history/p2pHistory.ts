/**
 * P2P offers → History rows (HISTORY-UI).
 *
 * Read-only and best-effort: it lists the contract's open offers and keeps only
 * the ones the active wallet is a party to. A missing wallet/config or an RPC
 * failure resolves to `[]` — the History page still renders from the other
 * sources instead of showing an error for an optional lane.
 */
import { getP2pContext } from "../../lib/p2p.ts";
import { actionHint, offerView } from "../../lib/p2pView.ts";
import type { HistoryRow } from "./model.ts";
import { p2pToHistoryRow } from "./model.ts";

/** How many open offers a single read walks. */
const OFFER_LIMIT = 50;

/** The pinned asset codes the registry can resolve. */
const KNOWN_CODES = ["XLM", "USDC", "PGUSD"] as const;

/** Maps a SAC contract id → asset code for the pinned testnet registry. */
async function tokenCodes(networkPassphrase: string): Promise<Map<string, string>> {
  const { defaultAssetRegistry, toSdkAsset } = await import("@polaris/stellar");
  const registry = defaultAssetRegistry();
  const codes = new Map<string, string>();
  for (const code of KNOWN_CODES) {
    const spec = registry.get(code);
    if (!spec) continue;
    try {
      codes.set(toSdkAsset(spec).contractId(networkPassphrase), spec.code);
    } catch {
      // A spec that cannot derive a contract id is simply not displayable.
    }
  }
  return codes;
}

/** The active wallet's open P2P offers as History rows. */
export async function loadP2pRows(
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<HistoryRow[]> {
  try {
    const { client, owner, networkPassphrase } = await getP2pContext();
    const offers = await client.listOpen(0n, OFFER_LIMIT);
    const codes = await tokenCodes(networkPassphrase);
    const rows: HistoryRow[] = [];
    for (const offer of offers) {
      if (offer.seller !== owner && offer.buyer !== owner) continue;
      const view = offerView(offer, owner, nowSeconds);
      const action = view.actions[0] ?? "none";
      rows.push(
        p2pToHistoryRow({
          offerId: offer.id.toString(),
          seller: offer.seller,
          buyer: offer.buyer,
          amount: view.amount,
          asset: codes.get(offer.token) ?? "token",
          priceTry: view.priceTry,
          state: offer.state,
          createdAtMs: Number(offer.created_at) * 1000,
          role: view.role,
          nextAction: action,
          nextActionHint: actionHint(action, offer.state),
          explorerUrl: null,
        }),
      );
    }
    return rows;
  } catch {
    return [];
  }
}
