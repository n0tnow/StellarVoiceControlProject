/**
 * Deposit / Withdraw body for the notch Trade page (task W15c).
 *
 * One amount field and one primary button drive the automated bank↔anchor loop
 * from `@/lib/bankAnchor`; the seven engine steps are folded into the three
 * rows the owner asked for. A small text button cancels an in-flight run.
 * Nothing here signs or holds a key — the automation owns the money path.
 */
import { useState } from "react";
import { Check, CircleAlert, LoaderCircle, Minus } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { BankStepStatus } from "@/lib/bankFlow";
import { ExplorerLink } from "@/notch/ExplorerLink";

import { phaseStatus, tradeBalanceLine, tradePhases, validateTradeAmount, type TradeDirection } from "./tradeModel";
import { useAnchorTrade } from "./useAnchorTrade";

const INPUT =
  "h-8 w-24 rounded-md border border-polaris-line bg-black/20 px-2 font-mono text-xs text-polaris-text outline-none focus:border-polaris-accent";

const STATUS_WORD: Record<BankStepStatus, string> = {
  pending: "—",
  active: "running",
  done: "done",
  error: "failed",
};

function PhaseIcon({ status }: { status: BankStepStatus }) {
  if (status === "done") return <Check className="page-status is-success" aria-hidden="true" />;
  if (status === "active") return <LoaderCircle className="page-status is-pending" aria-hidden="true" />;
  if (status === "error") return <CircleAlert className="page-status is-failed" aria-hidden="true" />;
  return <Minus className="page-status text-notch-muted" aria-hidden="true" />;
}

export function AnchorTrade({ direction }: { direction: TradeDirection }) {
  const flow = useAnchorTrade(direction);
  const [amount, setAmount] = useState("10");
  const check = validateTradeAmount(amount, flow.max);
  const phases = tradePhases(direction);
  const unit = direction === "deposit" ? (flow.bankCurrency ?? "fiat") : flow.walletAsset;

  const submit = (): void => {
    if (flow.busy || !check.ok) return;
    void flow.run(check.amount);
  };

  return (
    <div className="page-stack">
      <p className="text-[11px] text-notch-muted">
        {tradeBalanceLine({
          bankBalance: flow.bankBalance,
          bankCurrency: flow.bankCurrency,
          walletBalance: flow.walletBalance,
          walletAsset: flow.walletAsset,
        })}
      </p>

      {flow.anchorHomeDomain ? (
        <p className="text-[10px] text-notch-muted">via {flow.anchorHomeDomain}</p>
      ) : null}

      <div className="flex items-center gap-2">
        <label className="flex items-center gap-2 text-[11px] text-notch-muted">
          <span>Amount ({unit})</span>
          <input
            className={INPUT}
            value={amount}
            inputMode="decimal"
            aria-label={`Amount in ${unit}`}
            onChange={(event) => setAmount(event.target.value)}
          />
        </label>
        <Button size="sm" disabled={flow.busy || !check.ok} onClick={submit}>
          {flow.busy ? "Working…" : direction === "deposit" ? "Deposit" : "Withdraw"}
        </Button>
        {flow.busy ? (
          <Button variant="ghost" size="sm" onClick={flow.cancel}>
            Cancel
          </Button>
        ) : null}
      </div>

      {!check.ok ? <p className="text-[11px] text-polaris-warn">{check.message}</p> : null}

      <ul className="page-list">
        {phases.map((phase) => {
          const status = phaseStatus(phase, flow.steps);
          return (
            <li key={phase.id} className="flex items-center gap-2 text-xs text-notch-text">
              <PhaseIcon status={status} />
              <span className="flex-1">{phase.title}</span>
              <span className="font-mono text-[10px] uppercase text-notch-muted">{STATUS_WORD[status]}</span>
            </li>
          );
        })}
      </ul>

      {flow.result?.status === "completed" ? (
        <p className="text-[11px] text-polaris-ok">
          {flow.result.detail}
          {flow.result.txHash ? (
            <>
              {" "}
              <ExplorerLink target={flow.result.txHash} kind="tx" />
            </>
          ) : null}
        </p>
      ) : null}

      {flow.error ? (
        <div className="text-[11px] text-polaris-danger">
          <p>
            {flow.error}{" "}
            <button type="button" className="underline" disabled={flow.busy || !check.ok} onClick={submit}>
              Retry
            </button>
          </p>
          {flow.errorDetails && flow.errorDetails.length > 0 ? (
            <details className="mt-1 text-notch-muted">
              <summary className="cursor-pointer">Details</summary>
              <ul className="mt-1 list-disc pl-4">
                {flow.errorDetails.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
