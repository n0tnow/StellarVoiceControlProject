/**
 * Trade page — anchor deposit/withdraw and P2P, inside the notch (task W15c).
 *
 * A three-way segmented control (Deposit · Withdraw · P2P) picks the body.
 * Deposit/Withdraw drive the automated bank↔anchor loop; P2P lists the open
 * escrow offers. The wallet session gates the page: while locked it shows the
 * shared LoginGate and never reads the chain. Nothing here signs or holds a key.
 */
import { useState } from "react";

import { AnchorTrade } from "../trade/AnchorTrade";
import { P2pTrade } from "../trade/P2pTrade";
import { DEFAULT_TRADE_MODE, TRADE_MODES, type TradeMode } from "../trade/tradeModel";
import { LoginGate } from "../wallet/LoginGate";
import { useWalletLocked } from "../wallet/useWalletSession";

export function TradePage() {
  const locked = useWalletLocked();
  if (locked) return <LoginGate />;
  return <TradeBody />;
}

function TradeBody() {
  const [mode, setMode] = useState<TradeMode>(DEFAULT_TRADE_MODE);

  return (
    <div className="page-stack">
      <div role="tablist" aria-label="Trade mode" className="flex gap-0.5 rounded-lg bg-white/5 p-0.5">
        {TRADE_MODES.map(({ id, label }) => {
          const active = id === mode;
          return (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={active}
              className={`flex-1 rounded-md px-2 py-1 text-xs ${
                active ? "bg-notch-accent text-black" : "text-notch-muted hover:text-notch-text"
              }`}
              onClick={() => setMode(id)}
            >
              {label}
            </button>
          );
        })}
      </div>
      {mode === "p2p" ? <P2pTrade /> : <AnchorTrade key={mode} direction={mode} />}
    </div>
  );
}
