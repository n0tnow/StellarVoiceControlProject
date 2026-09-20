import { useCallback, useEffect, useRef, useState } from "react";

import type { Intent } from "@polaris/interfaces";
import type { Offer, P2pCall } from "@polaris/stellar";

import { Button } from "@/components/ui/button";
import { PanelShell } from "@/panels/PanelShell";
import { OfferForm } from "@/panels/p2p/OfferForm";
import { OfferSection } from "@/panels/p2p/OfferSection";
import { buildP2pActionCall, createP2pOfferCall, getP2pContext, type P2pTradeAction } from "@/lib/p2p";
import { actionLabel, offerView, type P2pAction } from "@/lib/p2pView";
import { useTxRun } from "@/lib/useTxRun";

type Notice = { kind: "ok" | "error"; message: string; url?: string } | null;

const TRADE_ACTIONS: readonly P2pAction[] = ["accept", "confirm", "cancel", "reclaim"];

/** `list_open` clamps `limit` to its `MAX_PAGE` (20); pages advance by the window. */
const P2P_PAGE_SIZE = 20;
const FIRST_PAGE_START = 1n;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The intent recorded with the approval card for a panel trade action. */
function actionIntent(action: P2pTradeAction, offer: Offer): Intent {
  const offerId = Number(offer.id);
  const base = { asset: "USDC", amount: "0", offerId, source: "p2p-panel" } as const;
  switch (action) {
    case "accept":
      return { kind: "p2p_accept", ...base };
    case "confirm":
      return { kind: "p2p_confirm", ...base };
    case "cancel":
      return { kind: "p2p_cancel", ...base };
    case "reclaim":
      return { kind: "p2p_reclaim", ...base };
  }
}

/** Deduplicates offers by id, ordered by id. */
function dedupe(offers: Offer[]): Offer[] {
  const byId = new Map<string, Offer>();
  for (const offer of offers) byId.set(offer.id.toString(), offer);
  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * P2P escrow panel (W8).
 *
 * Lists open offers, lets the owner create one, and offers exactly one next
 * action per state (Accept / Confirm payment received / Cancel / Reclaim).
 * Every on-chain action is built by `@polaris/stellar` and pushed through the
 * shared tx pipeline (`useTxRun`) — this window never signs and holds no key.
 * The TRY leg is off-chain and is never moved here.
 */
export function P2pPanel() {
  const [offers, setOffers] = useState<Offer[]>([]);
  const [tracked, setTracked] = useState<Offer[]>([]);
  const [trackId, setTrackId] = useState("");
  const [owner, setOwner] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const pageStartRef = useRef(FIRST_PAGE_START);
  const { run } = useTxRun();

  const load = useCallback(async (reset: boolean) => {
    setBusy(true);
    try {
      const ctx = await getP2pContext();
      setOwner(ctx.owner);
      const start = reset ? FIRST_PAGE_START : pageStartRef.current;
      const [next, page] = await Promise.all([
        ctx.client.nextOfferId(),
        ctx.client.listOpen(start, P2P_PAGE_SIZE),
      ]);
      const nextStart = start + BigInt(P2P_PAGE_SIZE);
      pageStartRef.current = nextStart;
      setHasMore(nextStart < next);
      setOffers((prev) => dedupe(reset ? page : [...prev, ...page]));
      setNotice(null);
    } catch (error) {
      setNotice({ kind: "error", message: messageOf(error) });
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load(true);
  }, [load]);

  const runCall = useCallback(
    async (callPromise: Promise<P2pCall>, intent: Intent, label: string) => {
      setBusy(true);
      try {
        const call = await callPromise;
        const [outcome] = await run([
          { result: { unsignedXdr: call.unsignedXdr, summary: call.summary }, intent, label },
        ]);
        if (outcome?.status === "submitted") {
          // Refresh first (it clears any stale error), then announce success.
          await load(true);
          setNotice({ kind: "ok", message: `${label} submitted.`, url: outcome.explorerUrl });
        } else {
          setNotice({ kind: "error", message: outcome?.detail ?? "the transaction was not submitted" });
        }
      } catch (error) {
        setNotice({ kind: "error", message: messageOf(error) });
      } finally {
        setBusy(false);
      }
    },
    [run, load],
  );

  const onCreate = (amount: string, priceTry: string) => {
    const intent: Intent = { kind: "p2p_offer", asset: "USDC", amount, priceTry, source: "p2p-panel" };
    void runCall(
      createP2pOfferCall("USDC", amount, priceTry),
      intent,
      `Create offer ${amount} USDC / ${priceTry} TRY`,
    );
  };

  const onAction = (offer: Offer, action: P2pAction) => {
    if (!TRADE_ACTIONS.includes(action)) return;
    const trade = action as P2pTradeAction;
    void runCall(
      buildP2pActionCall(trade, offer),
      actionIntent(trade, offer),
      `${actionLabel(action)} offer #${offer.id}`,
    );
  };

  const onTrack = async () => {
    const id = Number(trackId);
    if (!Number.isInteger(id) || id < 0) {
      setNotice({ kind: "error", message: "Enter a whole offer id." });
      return;
    }
    setBusy(true);
    try {
      const ctx = await getP2pContext();
      setOwner(ctx.owner);
      const offer = await ctx.client.getOffer(BigInt(id));
      if (!offer) {
        setNotice({ kind: "error", message: `Offer #${id} was not found.` });
      } else {
        setTracked((prev) => [...prev.filter((entry) => entry.id !== offer.id), offer]);
        setNotice(null);
      }
    } catch (error) {
      setNotice({ kind: "error", message: messageOf(error) });
    } finally {
      setBusy(false);
    }
  };

  const nowSeconds = Math.floor(Date.now() / 1000);
  const rows = dedupe([...offers, ...tracked]).map((offer) => ({
    offer,
    view: offerView(offer, owner, nowSeconds),
  }));
  const mine = rows.filter((row) => row.view.role !== "other");
  const others = rows.filter((row) => row.view.role === "other");

  return (
    <PanelShell title="P2P" subtitle="Peer-to-peer escrow (testnet)">
      <div className="space-y-3">
        <p className="rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-xs leading-5 text-amber-200">
          The TRY payment happens outside Polaris; confirm only after you received it. Polaris never
          moves the TRY and there is no arbiter.
        </p>

        {notice ? (
          <p
            className={`rounded-lg border px-3 py-2 text-xs leading-5 ${
              notice.kind === "ok"
                ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-200"
                : "border-polaris-danger/40 bg-polaris-danger/10 text-polaris-danger"
            }`}
          >
            {notice.message}
            {notice.url ? (
              <>
                {" "}
                <a className="underline" href={notice.url} target="_blank" rel="noreferrer">
                  View on explorer
                </a>
              </>
            ) : null}
          </p>
        ) : null}

        <OfferForm busy={busy} onCreate={onCreate} />

        <div className="flex items-center justify-between gap-2">
          <h2 className="text-xs font-semibold text-polaris-text">Offers</h2>
          <Button variant="ghost" size="sm" sound={false} disabled={busy} onClick={() => void load(true)}>
            {busy ? "Working…" : "Refresh"}
          </Button>
        </div>

        {rows.length === 0 ? (
          <p className="text-xs text-polaris-muted">
            {notice?.kind === "error" ? "Offers are unavailable." : "No open offers right now."}
          </p>
        ) : null}

        <OfferSection title="My offers & trades" rows={mine} busy={busy} onAction={onAction} />
        <OfferSection title="Open offers from others" rows={others} busy={busy} onAction={onAction} />

        {hasMore ? (
          <Button variant="secondary" size="sm" sound={false} disabled={busy} onClick={() => void load(false)}>
            Load more offers
          </Button>
        ) : null}

        <div className="rounded-lg border border-polaris-line bg-polaris-panel/40 p-3">
          <p className="text-[11px] text-polaris-muted">Track an offer by id (for accepted or settled trades)</p>
          <div className="mt-2 flex items-center gap-2">
            <input
              className="w-28 rounded-md border border-polaris-line bg-black/30 px-2 py-1.5 text-xs text-polaris-text outline-none focus-visible:ring-2 focus-visible:ring-polaris-accent/60"
              value={trackId}
              onChange={(event) => setTrackId(event.target.value)}
              placeholder="3"
              inputMode="numeric"
            />
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => void onTrack()}>
              Track
            </Button>
          </div>
        </div>
      </div>
    </PanelShell>
  );
}
