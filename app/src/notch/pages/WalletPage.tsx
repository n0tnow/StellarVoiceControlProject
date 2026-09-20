/**
 * Wallet page — balances, identity, quick stats and recent activity.
 *
 * Mock balances (XLM + USDC), the truncated public key with a copy button,
 * a month-to-date spend-vs-budget strip (budget = the guard's monthly rule
 * budget) and a mini transaction list. All data comes from
 * `@/lib/mockData`.
 */
import { useState } from "react";
import { ArrowDownLeft, ArrowUpRight, Check, Copy } from "lucide-react";

import {
  MOCK_WALLET,
  formatTimestamp,
  truncateKey,
} from "@/lib/mockData";

/** How long the copy button shows its confirmation before reverting. */
const COPIED_MS = 1500;

function spendPercent(spend: string, budget: string): number {
  const spent = Number(spend.replace(/[$,]/g, ""));
  const limit = Number(budget.replace(/[$,]/g, ""));
  if (!Number.isFinite(spent) || !Number.isFinite(limit) || limit <= 0) return 0;
  return Math.min(100, Math.round((spent / limit) * 100));
}

export function WalletPage() {
  const [copied, setCopied] = useState(false);

  const copyKey = (): void => {
    // Clipboard access is best-effort (the overlay window may not be focused);
    // the visual confirmation still plays so the affordance is honest.
    void navigator.clipboard?.writeText(MOCK_WALLET.publicKey).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), COPIED_MS);
  };

  const percent = spendPercent(MOCK_WALLET.monthlySpendUsd, MOCK_WALLET.monthlyBudgetUsd);

  return (
    <div className="page-stack">
      <div className="wallet-balances">
        {MOCK_WALLET.assets.map((asset) => (
          <div key={asset.code} className="wallet-asset">
            <span className="wallet-asset-code">{asset.code}</span>
            <span className="wallet-asset-balance">{asset.balance}</span>
            <span className="wallet-asset-usd">{asset.usdValue}</span>
          </div>
        ))}
      </div>

      <div className="wallet-key">
        <span className="wallet-key-label">Public key</span>
        <code className="wallet-key-value selectable">
          {truncateKey(MOCK_WALLET.publicKey, 8, 8)}
        </code>
        <button
          type="button"
          className="page-icon-button"
          onClick={copyKey}
          aria-label={copied ? "Copied" : "Copy public key"}
        >
          {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
        </button>
      </div>

      <div className="wallet-budget">
        <div className="wallet-budget-copy">
          <span>Spent this month</span>
          <span>
            {MOCK_WALLET.monthlySpendUsd} of {MOCK_WALLET.monthlyBudgetUsd}
          </span>
        </div>
        <div
          className="wallet-budget-bar"
          role="progressbar"
          aria-valuenow={percent}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Monthly spend vs budget"
        >
          <span style={{ width: `${percent}%` }} />
        </div>
      </div>

      <ul className="page-list wallet-tx-list" aria-label="Recent transactions">
        {MOCK_WALLET.transactions.map((tx) => (
          <li key={tx.id} className="wallet-tx">
            <span className={`wallet-tx-direction is-${tx.direction}`}>
              {tx.direction === "in" ? (
                <ArrowDownLeft aria-hidden="true" />
              ) : (
                <ArrowUpRight aria-hidden="true" />
              )}
            </span>
            <span className="wallet-tx-main">
              <span className="wallet-tx-summary">{tx.summary}</span>
              <span className="wallet-tx-time">{formatTimestamp(tx.timestamp)}</span>
            </span>
            <span className={`wallet-tx-amount is-${tx.status}`}>{tx.amount}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
