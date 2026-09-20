/**
 * P2P body for the notch Trade page (task W15c).
 *
 * It lists the open escrow offers and lets the owner take one or create one.
 * Every on-chain action is built by `@polaris/stellar` (`@/lib/p2p`) and pushed
 * through the shared tx pipeline (`useTxRun`), so this view never signs and
 * holds no key. The TRY leg is off-chain and is never moved here.
 */
import { useCallback, useEffect, useState } from "react";
import type { Intent } from "@polaris/interfaces";
import { p2p, type Offer, type P2pCall } from "@polaris/stellar";

import { Button } from "@/components/ui/button";
import {
  buildP2pActionCall,
  checkOfferBalance,
  createP2pOfferCall,
  getP2pContext,
  heldP2pAssets,
  p2pAssetCodeByToken,
  preflightOffer,
} from "@/lib/p2p";
import { actionLabel, offerView, shortAddress, type OfferView } from "@/lib/p2pView";
import { runAddTrustline } from "@/lib/trustline";
import { useTxRun } from "@/lib/useTxRun";
import { fetchAccountDetail, type HorizonAccountDetail } from "@/lib/walletAssets";
import { ExplorerLink } from "@/notch/ExplorerLink";

import { validateOfferInputs } from "./tradeModel";

/** The fallback token shown before the wallet's held assets are known. */
const DEFAULT_SELL_ASSET = "XLM";
/** `list_open` clamps the page size to 20. */
const PAGE_SIZE = 20;

const INPUT =
  "mt-1 w-full rounded-md border border-polaris-line bg-black/20 px-2 py-1 font-mono text-xs text-polaris-text outline-none focus:border-polaris-accent";

interface Row {
  offer: Offer;
  view: OfferView;
}

/** `addAsset` is the code to offer an "Add <asset>" action for a missing trustline. */
type Notice = { kind: "ok" | "error"; message: string; addAsset?: string } | null;

export function P2pTrade() {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [submittedHash, setSubmittedHash] = useState<string | null>(null);
  const [showSell, setShowSell] = useState(false);
  const [amount, setAmount] = useState("");
  const [price, setPrice] = useState("");
  const [asset, setAsset] = useState(DEFAULT_SELL_ASSET);
  const [heldAssets, setHeldAssets] = useState<string[]>([DEFAULT_SELL_ASSET]);
  const [detail, setDetail] = useState<HorizonAccountDetail | null>(null);
  const [codeByToken, setCodeByToken] = useState<Record<string, string>>({});
  const { run } = useTxRun();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const ctx = await getP2pContext();
      const [page, account, codes] = await Promise.all([
        ctx.client.listOpen(1n, PAGE_SIZE),
        fetchAccountDetail(ctx.horizonUrl, ctx.owner),
        p2pAssetCodeByToken(ctx.networkPassphrase),
      ]);
      const byId = new Map<string, Offer>();
      for (const offer of page) byId.set(offer.id.toString(), offer);
      const now = Math.floor(Date.now() / 1000);
      setRows([...byId.values()].map((offer) => ({ offer, view: offerView(offer, ctx.owner, now) })));
      setCodeByToken(codes);
      const held = account.status === "ok" ? heldP2pAssets(account.detail) : [DEFAULT_SELL_ASSET];
      setDetail(account.status === "ok" ? account.detail : null);
      setHeldAssets(held);
      setAsset((current) => (held.includes(current) ? current : (held[0] ?? DEFAULT_SELL_ASSET)));
      setNotice(null);
    } catch (error) {
      setRows([]);
      setNotice({ kind: "error", message: p2p.p2pErrorMessage(error) });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** The code escrowed by an offer, or a short token id when it is not pinned. */
  const tokenLabel = (token: string): string => codeByToken[token] ?? shortAddress(token);

  const runCall = useCallback(
    async (
      callPromise: Promise<P2pCall>,
      intent: Intent,
      label: string,
      assetCode: string,
    ): Promise<boolean> => {
      setBusy(true);
      setSubmittedHash(null);
      try {
        const call = await callPromise;
        const [outcome] = await run([
          { result: { unsignedXdr: call.unsignedXdr, summary: call.summary }, intent, label },
        ]);
        if (outcome?.status === "submitted") {
          await load();
          setSubmittedHash(outcome.txHash);
          setNotice({ kind: "ok", message: `${label} submitted.` });
          return true;
        }
        setNotice({ kind: "error", message: outcome?.detail ?? "The transaction was not submitted." });
        return false;
      } catch (error) {
        setNotice({ kind: "error", message: p2p.p2pErrorMessage(error, { asset: assetCode }) });
        return false;
      } finally {
        setBusy(false);
      }
    },
    [run, load],
  );

  /** Adds a missing trustline through the shared approval pipeline, then reloads. */
  const addTrustline = useCallback(
    async (code: string): Promise<void> => {
      setBusy(true);
      setSubmittedHash(null);
      try {
        const outcome = await runAddTrustline(code);
        if (outcome.status === "submitted") {
          setNotice({ kind: "ok", message: `${code} added to your wallet.` });
          setSubmittedHash(outcome.txHash);
          await load();
        } else {
          setNotice({ kind: "error", message: outcome.detail });
        }
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  const onAccept = (offer: Offer): void => {
    const intent: Intent = {
      kind: "p2p_accept",
      asset: tokenLabel(offer.token),
      amount: "0",
      offerId: Number(offer.id),
      source: "trade-page",
    };
    void runCall(
      buildP2pActionCall("accept", offer),
      intent,
      `Accept offer #${offer.id}`,
      tokenLabel(offer.token),
    );
  };

  const check = validateOfferInputs(amount, price);
  /** The validation label, with the selected asset (the model defaults to USDC). */
  const inputMessage = check.ok ? "" : check.message.replace("USDC", asset);

  const onSell = async (): Promise<void> => {
    if (!check.ok || busy) return;
    const tokens = amount.trim();
    const priceTry = price.trim();
    setBusy(true);
    setSubmittedHash(null);
    try {
      // Preflight the seller's balance/trustline, so a doomed tx never reaches
      // the approval card. Fail-closed: an unreadable balance blocks the offer.
      const pre = detail
        ? await checkOfferBalance(detail, asset, tokens)
        : await preflightOffer(asset, tokens);
      if (!pre.ok) {
        // A missing trustline is the one refusal the user can fix in place.
        const addAsset = /trustline yet/i.test(pre.message) ? pre.asset : undefined;
        setNotice({ kind: "error", message: pre.message, ...(addAsset ? { addAsset } : {}) });
        return;
      }
      const intent: Intent = {
        kind: "p2p_offer",
        asset: pre.asset,
        amount: tokens,
        priceTry,
        source: "trade-page",
      };
      const ok = await runCall(
        createP2pOfferCall(pre.asset, tokens, priceTry),
        intent,
        `Sell ${tokens} ${pre.asset}`,
        pre.asset,
      );
      if (ok) {
        setShowSell(false);
        setAmount("");
        setPrice("");
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page-stack">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] text-notch-muted">Open offers from others</span>
        <div className="flex items-center gap-3">
          <button
            type="button"
            className="text-[11px] text-notch-accent underline"
            aria-expanded={showSell}
            onClick={() => setShowSell((value) => !value)}
          >
            Sell
          </button>
          <button
            type="button"
            className="text-[11px] text-notch-muted underline"
            disabled={loading || busy}
            onClick={() => void load()}
          >
            Refresh
          </button>
        </div>
      </div>

      {showSell ? (
        <form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            void onSell();
          }}
        >
          <div className="flex flex-wrap items-start gap-2">
            <label className="w-24 text-[11px] text-notch-muted">
              Asset
              {heldAssets.length > 1 ? (
                <select
                  className={INPUT}
                  value={asset}
                  onChange={(event) => setAsset(event.target.value)}
                >
                  {heldAssets.map((code) => (
                    <option key={code} value={code}>
                      {code}
                    </option>
                  ))}
                </select>
              ) : (
                <span className={`${INPUT} block text-notch-text`}>{asset}</span>
              )}
            </label>
            <label className="flex-1 text-[11px] text-notch-muted">
              Amount ({asset})
              <input
                className={INPUT}
                value={amount}
                placeholder="100"
                inputMode="decimal"
                onChange={(event) => setAmount(event.target.value)}
              />
            </label>
            <label className="flex-1 text-[11px] text-notch-muted">
              Price (TRY)
              <input
                className={INPUT}
                value={price}
                placeholder="3400"
                inputMode="decimal"
                onChange={(event) => setPrice(event.target.value)}
              />
            </label>
          </div>
          <div className="flex items-center gap-2">
            <Button type="submit" size="sm" disabled={!check.ok || busy}>
              Create offer
            </Button>
            {!check.ok ? <span className="text-[11px] text-polaris-warn">{inputMessage}</span> : null}
          </div>
        </form>
      ) : null}

      {notice ? (
        <p className={`text-[11px] ${notice.kind === "ok" ? "text-polaris-ok" : "text-polaris-danger"}`}>
          {notice.message}
          {notice.kind === "ok" && submittedHash ? (
            <>
              {" "}
              <ExplorerLink target={submittedHash} kind="tx" />
            </>
          ) : null}
          {notice.kind === "error" && notice.addAsset ? (
            <>
              {" "}
              <button
                type="button"
                className="text-[11px] text-notch-accent underline"
                disabled={busy}
                onClick={() => void addTrustline(notice.addAsset as string)}
              >
                Add {notice.addAsset}
              </button>
            </>
          ) : null}
        </p>
      ) : null}

      {loading ? (
        <p className="text-[11px] text-notch-muted">Loading offers…</p>
      ) : rows.length === 0 ? (
        notice?.kind === "error" ? null : <p className="text-[11px] text-notch-muted">No open offers right now.</p>
      ) : (
        <ul className="page-list">
          {rows.map((row) => (
            <li
              key={row.view.id.toString()}
              className="flex items-center justify-between gap-2 text-xs text-notch-text"
            >
              <span className="min-w-0">
                <span className="block truncate">
                  {row.view.amount} {tokenLabel(row.offer.token)} · {row.view.priceTry} TRY
                </span>
                <span className="block text-[10px] text-notch-muted">
                  seller {row.view.sellerLabel}
                  {row.view.role !== "other" ? " · yours" : ""}
                </span>
              </span>
              {row.view.actions.includes("accept") ? (
                <Button size="sm" disabled={busy} onClick={() => onAccept(row.offer)}>
                  {actionLabel("accept")}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
