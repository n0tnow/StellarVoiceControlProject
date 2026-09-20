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
import type { Offer, P2pCall } from "@polaris/stellar";

import { Button } from "@/components/ui/button";
import { buildP2pActionCall, createP2pOfferCall, getP2pContext } from "@/lib/p2p";
import { actionLabel, offerView, type OfferView } from "@/lib/p2pView";
import { useTxRun } from "@/lib/useTxRun";
import { ExplorerLink } from "@/notch/ExplorerLink";

import { validateOfferInputs } from "./tradeModel";

/** The token sold on the P2P rail (mirrors the P2P panel). */
const SELL_ASSET = "USDC";
/** `list_open` clamps the page size to 20. */
const PAGE_SIZE = 20;

const INPUT =
  "mt-1 w-full rounded-md border border-polaris-line bg-black/20 px-2 py-1 font-mono text-xs text-polaris-text outline-none focus:border-polaris-accent";

interface Row {
  offer: Offer;
  view: OfferView;
}

type Notice = { kind: "ok" | "error"; message: string } | null;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function P2pTrade() {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [submittedHash, setSubmittedHash] = useState<string | null>(null);
  const [showSell, setShowSell] = useState(false);
  const [amount, setAmount] = useState("");
  const [price, setPrice] = useState("");
  const { run } = useTxRun();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const ctx = await getP2pContext();
      const page = await ctx.client.listOpen(1n, PAGE_SIZE);
      const byId = new Map<string, Offer>();
      for (const offer of page) byId.set(offer.id.toString(), offer);
      const now = Math.floor(Date.now() / 1000);
      setRows([...byId.values()].map((offer) => ({ offer, view: offerView(offer, ctx.owner, now) })));
      setNotice(null);
    } catch (error) {
      setRows([]);
      setNotice({ kind: "error", message: messageOf(error) });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const runCall = useCallback(
    async (callPromise: Promise<P2pCall>, intent: Intent, label: string): Promise<boolean> => {
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
        setNotice({ kind: "error", message: messageOf(error) });
        return false;
      } finally {
        setBusy(false);
      }
    },
    [run, load],
  );

  const onAccept = (offer: Offer): void => {
    const intent: Intent = {
      kind: "p2p_accept",
      asset: SELL_ASSET,
      amount: "0",
      offerId: Number(offer.id),
      source: "trade-page",
    };
    void runCall(buildP2pActionCall("accept", offer), intent, `Accept offer #${offer.id}`);
  };

  const check = validateOfferInputs(amount, price);

  const onSell = async (): Promise<void> => {
    if (!check.ok || busy) return;
    const tokens = amount.trim();
    const priceTry = price.trim();
    const intent: Intent = {
      kind: "p2p_offer",
      asset: SELL_ASSET,
      amount: tokens,
      priceTry,
      source: "trade-page",
    };
    const ok = await runCall(
      createP2pOfferCall(SELL_ASSET, tokens, priceTry),
      intent,
      `Sell ${tokens} ${SELL_ASSET}`,
    );
    if (ok) {
      setShowSell(false);
      setAmount("");
      setPrice("");
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
          <div className="flex items-start gap-2">
            <label className="flex-1 text-[11px] text-notch-muted">
              Amount ({SELL_ASSET})
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
            {!check.ok ? <span className="text-[11px] text-polaris-warn">{check.message}</span> : null}
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
                  {row.view.amount} {SELL_ASSET} · {row.view.priceTry} TRY
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
