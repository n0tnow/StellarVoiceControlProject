import { useState } from "react";

import { Button } from "@/components/ui/button";
import { PanelShell } from "@/panels/PanelShell";
import { BankSection } from "@/panels/anchor/BankSection";
import { useAnchorFlow } from "@/panels/anchor/useAnchorFlow";
import {
  ANCHOR_STEPS,
  SHARED_TREASURY_NOTE,
  validateDepositAmount,
  validateWithdrawAmount,
  type StepStatus,
} from "@/panels/anchor/steps";

/** Colour + WORD for a step state, so the badge never relies on colour alone. */
function statusLabel(status: StepStatus): { text: string; className: string } {
  switch (status) {
    case "done":
      return { text: "done", className: "text-polaris-ok" };
    case "active":
      return { text: "running", className: "text-polaris-accent" };
    case "error":
      return { text: "failed", className: "text-polaris-danger" };
    default:
      return { text: "pending", className: "text-polaris-muted" };
  }
}

/** `GBBD...FLA5` shortening for display. */
function shortKey(key: string): string {
  return key.length > 12 ? `${key.slice(0, 4)}...${key.slice(-4)}` : key;
}

/**
 * Anchor panel (W5b): the SEP-1/10/38/6 deposit and withdraw flow.
 *
 * It shows the discovered endpoints, a SEP-38 quote, the step list with the
 * session's own explain-log lines, and the order/transaction status. Value moves
 * only through the session's signer: the login challenge is wallet-only, every
 * other transaction goes through the Touch ID pipeline. Small amounts only — the
 * mock anchor's treasury is shared.
 */
export function AnchorPanel() {
  const flow = useAnchorFlow();
  const [amount, setAmount] = useState("50");

  const check = flow.direction === "deposit" ? validateDepositAmount(amount) : validateWithdrawAmount(amount);
  const unit = flow.direction === "deposit" ? "TRY" : "USDC";

  return (
    <PanelShell title="Anchor" subtitle="Deposit and withdraw via an anchor (testnet)">
      <div className="space-y-4 text-xs">
        <BankSection />

        <section className="rounded-lg border border-polaris-line bg-polaris-panel/60 px-3 py-2">
          <div className="flex items-center justify-between gap-2">
            <span className="font-semibold text-polaris-text">SEP-1 discovery</span>
            <Button variant="secondary" size="sm" onClick={() => void flow.discover()} disabled={flow.busy}>
              Check anchor
            </Button>
          </div>
          {flow.discovery ? (
            <dl className="mt-2 space-y-0.5 font-mono text-[11px] text-polaris-muted">
              <div>signing key {shortKey(flow.discovery.signingKey)}</div>
              <div className="truncate">auth {flow.discovery.webAuthEndpoint}</div>
              <div className="truncate">transfer {flow.discovery.transferServer}</div>
            </dl>
          ) : (
            <p className="mt-2 text-polaris-muted">Not checked yet.</p>
          )}
        </section>

        <section className="space-y-2 rounded-lg border border-polaris-line bg-polaris-panel/60 px-3 py-2">
          <div className="flex gap-2">
            <Button
              variant={flow.direction === "deposit" ? "default" : "outline"}
              size="sm"
              onClick={() => flow.setDirection("deposit")}
            >
              Deposit TRY
            </Button>
            <Button
              variant={flow.direction === "withdraw" ? "default" : "outline"}
              size="sm"
              onClick={() => flow.setDirection("withdraw")}
            >
              Withdraw USDC
            </Button>
          </div>
          <label className="flex items-center gap-2">
            <span className="text-polaris-muted">Amount ({unit})</span>
            <input
              className="h-8 w-28 rounded-md border border-polaris-line bg-polaris-bg px-2 font-mono text-polaris-text outline-none focus-visible:ring-2 focus-visible:ring-polaris-accent/60"
              value={amount}
              inputMode="decimal"
              onChange={(event) => setAmount(event.target.value)}
            />
          </label>
          {!check.ok ? <p className="text-polaris-warn">{check.message}</p> : null}
          <p className="text-polaris-muted">{SHARED_TREASURY_NOTE}</p>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              disabled={flow.busy || !check.ok}
              onClick={() => void flow.start(check.ok ? check.amount : amount)}
            >
              Start
            </Button>
            <label className="flex items-center gap-1 text-polaris-muted">
              <input
                type="checkbox"
                checked={flow.narrate}
                onChange={(event) => flow.setNarrate(event.target.checked)}
              />
              Speak steps
            </label>
          </div>
          {flow.quoteLines.length > 0 ? (
            <ul className="space-y-0.5 font-mono text-[11px] text-polaris-text">
              {flow.quoteLines.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          ) : null}
        </section>

        <section>
          <h2 className="mb-1 font-semibold text-polaris-text">Steps</h2>
          <ol className="space-y-1">
            {ANCHOR_STEPS.map((step) => {
              const badge = statusLabel(flow.state.steps[step.id]);
              return (
                <li key={step.id} className="flex items-center justify-between gap-2">
                  <span className="text-polaris-text">{step.title}</span>
                  <span className={`font-mono uppercase ${badge.className}`}>{badge.text}</span>
                </li>
              );
            })}
          </ol>
        </section>

        {flow.state.error ? (
          <p className="rounded-lg border border-polaris-danger/50 bg-polaris-danger/10 px-3 py-2 text-polaris-danger">
            {flow.state.error}
          </p>
        ) : null}

        {flow.instruction ? (
          <section className="selectable rounded-lg border border-polaris-line bg-polaris-panel/60 px-3 py-2">
            <div className="text-polaris-muted">Order {flow.orderId ?? "?"}</div>
            <p className="mt-1 break-words text-polaris-text">{flow.instruction}</p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {flow.direction === "deposit" ? (
                <Button variant="secondary" size="sm" disabled={flow.busy} onClick={() => void flow.simulateBank()}>
                  Simulate bank transfer (mock only)
                </Button>
              ) : null}
              <Button size="sm" disabled={flow.busy} onClick={() => void flow.poll()}>
                Check status
              </Button>
            </div>
            {flow.orderStatus ? (
              <p className="mt-1 font-mono text-[11px] text-polaris-muted">status: {flow.orderStatus}</p>
            ) : null}
          </section>
        ) : null}

        {flow.txHash ? (
          <p className="break-all font-mono text-[11px] text-polaris-ok">
            on-chain {shortKey(flow.txHash)}{" "}
            {flow.explorerUrl ? (
              <a className="underline" href={flow.explorerUrl} target="_blank" rel="noreferrer">
                explorer
              </a>
            ) : null}
          </p>
        ) : null}

        <section>
          <h2 className="mb-1 font-semibold text-polaris-text">Explain log</h2>
          {flow.state.log.length === 0 ? (
            <p className="text-polaris-muted">Nothing has run yet.</p>
          ) : (
            <ul className="space-y-1">
              {flow.state.log.map((line, index) => (
                <li key={`${line.step}-${index}`} className="selectable">
                  <span className="font-mono text-[11px] text-polaris-accent">{line.step}</span>
                  <p className="text-polaris-text">{line.what}</p>
                  <p className="text-polaris-muted">{line.why}</p>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </PanelShell>
  );
}
