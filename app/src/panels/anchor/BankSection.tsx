/**
 * The Anchor panel's demo-bank card (BANK-SIM): account, deposit/withdraw forms,
 * the live step list and the ledger history. Presentation only — the logic lives
 * in `useBank.ts` and `@/lib/bankFlow.ts`.
 */
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { BANK_DEFAULT_MAX, BANK_DEPOSIT_MIN, BANK_WITHDRAW_MIN, validateBankAmount } from "@/lib/bankAnchor";
import { BANK_STEPS, type BankFlowResult, type BankStepStatus, type BankTransaction } from "@/lib/bankFlow";
import { useBank } from "@/panels/anchor/useBank";

function stepBadge(status: BankStepStatus): { text: string; className: string } {
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

function statusChip(status: BankTransaction["status"]): string {
  switch (status) {
    case "completed":
      return "text-polaris-ok";
    case "refunded":
      return "text-polaris-warn";
    case "failed":
      return "text-polaris-danger";
    default:
      return "text-polaris-muted";
  }
}

function resultLine(result: BankFlowResult): string {
  const head =
    result.status === "completed"
      ? result.kind === "deposit"
        ? "Deposit completed"
        : "Withdrawal completed"
      : result.status === "cancelled"
        ? "Cancelled"
        : "Failed";
  const extra = result.refunded ? " (reservation refunded)" : result.credited ? " (bank credited)" : "";
  return `${head}${extra}: ${result.detail}`;
}

async function copyText(value: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    // Clipboard may be unavailable; the value stays visible for manual copy.
  }
}

export function BankSection() {
  const bank = useBank();
  const [direction, setDirection] = useState<"deposit" | "withdraw">("deposit");
  const [amount, setAmount] = useState("50");

  const max = (direction === "deposit" ? bank.depositMax : bank.withdrawMax) ?? BANK_DEFAULT_MAX;
  const check = validateBankAmount(amount, direction, max);
  const fiat = bank.account?.currency ?? "fiat";
  const unit = direction === "deposit" ? fiat : bank.assetCode;

  return (
    <section className="space-y-2 rounded-lg border border-polaris-line bg-polaris-panel/60 px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <span className="font-semibold text-polaris-text">Demo bank</span>
        <span className="rounded bg-polaris-accent/15 px-1.5 py-0.5 font-mono text-[10px] uppercase text-polaris-accent">
          simulated
        </span>
      </div>

      {bank.account ? (
        <dl className="space-y-0.5 text-[11px]">
          <div className="flex justify-between gap-2">
            <dt className="text-polaris-muted">Holder</dt>
            <dd className="text-polaris-text">{bank.account.holderName}</dd>
          </div>
          <div className="flex items-center justify-between gap-2">
            <dt className="text-polaris-muted">IBAN</dt>
            <dd className="flex items-center gap-1 font-mono text-polaris-text">
              {bank.account.iban}
              <button
                className="text-polaris-accent underline"
                onClick={() => void copyText(bank.account?.iban ?? "")}
              >
                copy
              </button>
            </dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-polaris-muted">Balance</dt>
            <dd className="font-mono text-polaris-text">
              {bank.account.balanceTry} {bank.account.currency}
            </dd>
          </div>
        </dl>
      ) : (
        <p className="text-polaris-muted">Loading the demo ledger…</p>
      )}

      <p className="font-mono text-[11px] text-polaris-muted">anchor: {bank.scenarioLabel}</p>
      {bank.payoutWarning ? (
        <p className="text-polaris-warn">Payouts look stalled: {bank.payoutWarning}</p>
      ) : null}

      <div className="flex gap-2">
        <Button
          variant={direction === "deposit" ? "default" : "outline"}
          size="sm"
          onClick={() => setDirection("deposit")}
        >
          Deposit from bank
        </Button>
        <Button
          variant={direction === "withdraw" ? "default" : "outline"}
          size="sm"
          onClick={() => setDirection("withdraw")}
        >
          Withdraw to bank
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
      {!check.ok ? (
        <p className="text-polaris-warn">{check.message}</p>
      ) : (
        <p className="text-polaris-muted">
          Min {direction === "deposit" ? BANK_DEPOSIT_MIN : BANK_WITHDRAW_MIN} {unit}; the anchor's own limits apply.
        </p>
      )}

      <div className="flex items-center gap-2">
        <Button
          size="sm"
          disabled={bank.busy || !check.ok}
          onClick={() => void (direction === "deposit" ? bank.deposit(check.ok ? check.amount : amount) : bank.withdraw(check.ok ? check.amount : amount))}
        >
          {bank.busy ? "Working…" : direction === "deposit" ? "Deposit from bank" : "Withdraw to bank"}
        </Button>
        {bank.busy ? (
          <Button variant="outline" size="sm" onClick={() => bank.cancel()}>
            Cancel
          </Button>
        ) : null}
        <Button variant="secondary" size="sm" disabled={bank.busy} onClick={() => void bank.reset()}>
          Reset demo bank
        </Button>
      </div>

      <ol className="space-y-0.5 text-[11px]">
        {BANK_STEPS.map((step) => {
          const badge = stepBadge(bank.steps[step.id]);
          return (
            <li key={step.id} className="flex items-center justify-between gap-2">
              <span className="text-polaris-text">{step.title}</span>
              <span className={`font-mono uppercase ${badge.className}`}>{badge.text}</span>
            </li>
          );
        })}
      </ol>

      {bank.lastResult ? (
        <p className="break-words text-[11px] text-polaris-text">{resultLine(bank.lastResult)}</p>
      ) : null}
      {bank.error ? <p className="break-words text-[11px] text-polaris-danger">{bank.error}</p> : null}

      <div>
        <h3 className="mb-1 font-semibold text-polaris-text">Bank history</h3>
        {bank.history.length === 0 ? (
          <p className="text-polaris-muted">No bank transactions yet.</p>
        ) : (
          <ul className="space-y-1 text-[11px]">
            {bank.history.slice(0, 8).map((tx) => (
              <li key={tx.id} className="flex items-center justify-between gap-2">
                <span className="truncate font-mono text-polaris-muted">{tx.reference}</span>
                <span className="font-mono text-polaris-text">
                  {tx.amountTry} {tx.currency}
                </span>
                <span className={`font-mono uppercase ${statusChip(tx.status)}`}>{tx.status}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
