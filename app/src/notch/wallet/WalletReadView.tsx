/**
 * The read-only wallet body (moved from `WalletPage`, task W10b).
 *
 * This is the NW1 surface unchanged: network, balances, owner key with copy and
 * explorer links, the alias book and recent payments. It now renders either the
 * selected wallet engine account (`ownerAddressOverride`) or, when the wallet
 * engine is absent, the legacy env owner. No key, no signing, no value movement.
 */
import { useState } from "react";
import { ArrowDownLeft, ArrowUpRight, Check, Copy, ExternalLink, RefreshCw } from "lucide-react";
import { formatTimestamp, truncateKey } from "@/lib/mockData";
import { useWalletData } from "@/notch/data/useWalletData";
import { ExplorerLink } from "@/notch/ExplorerLink";
import committedAliases from "../../../../stellar/config/aliases.json";

/** How long the copy button shows its confirmation before reverting. */
const COPIED_MS = 1500;

export interface WalletReadViewProps {
  /** The active wallet-engine account; falls back to the env owner when omitted. */
  ownerAddressOverride?: string | null;
}

export function WalletReadView({ ownerAddressOverride }: WalletReadViewProps = {}) {
  const wallet = useWalletData(committedAliases, ownerAddressOverride);
  const [copied, setCopied] = useState(false);

  const copyKey = (text: string): void => {
    // Clipboard access is best-effort (the overlay window may not be focused);
    // the visual confirmation still plays so the affordance is honest.
    void navigator.clipboard?.writeText(text).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), COPIED_MS);
  };

  const ownerAddress = wallet.ownerAddress;
  const latest = wallet.latestTransaction;
  const showTransactions = wallet.status === "ready";

  return (
    <>
      <div className="wallet-key">
        <span className="wallet-key-label">Network</span>
        <span className="wallet-key-value">{wallet.network}</span>
        <button
          type="button"
          className="page-icon-button"
          onClick={wallet.refresh}
          disabled={wallet.refreshing}
          aria-label="Refresh wallet"
        >
          <RefreshCw aria-hidden="true" />
        </button>
      </div>

      {wallet.status === "loading" || wallet.status === "unconfigured" ? (
        <p className="wallet-key-label">{wallet.message}</p>
      ) : null}

      {wallet.status === "offline" ? (
        <div className="wallet-key">
          <span className="wallet-key-label">{wallet.message}</span>
          <button
            type="button"
            className="page-icon-button"
            onClick={wallet.refresh}
            disabled={wallet.refreshing}
            aria-label="Retry"
          >
            <RefreshCw aria-hidden="true" />
          </button>
        </div>
      ) : null}

      {wallet.status === "unfunded" && wallet.friendbotUrl ? (
        <a className="wallet-key" href={wallet.friendbotUrl} target="_blank" rel="noreferrer">
          <span className="wallet-key-label">
            Not funded on testnet — fund it with Friendbot
          </span>
          <ExternalLink aria-hidden="true" />
        </a>
      ) : null}

      {ownerAddress ? (
        <div className="wallet-key">
          <span className="wallet-key-label">Public key</span>
          <code className="wallet-key-value selectable" title={ownerAddress}>
            {truncateKey(ownerAddress, 8, 8)}
          </code>
          <button
            type="button"
            className="page-icon-button"
            onClick={() => copyKey(ownerAddress)}
            aria-label={copied ? "Copied" : "Copy public key"}
          >
            {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
          </button>
          {wallet.explorerUrl ? <ExplorerLink target={ownerAddress} kind="account" iconOnly /> : null}
        </div>
      ) : null}

      {latest ? (
        <div className="wallet-key">
          <span className="wallet-key-label">Latest transaction</span>
          <code className="wallet-key-value selectable" title={latest.hash}>
            {truncateKey(latest.hash, 8, 8)}
          </code>
          <ExplorerLink target={latest.hash} kind="tx" iconOnly />
        </div>
      ) : null}

      {wallet.assets.length > 0 ? (
        <div className="wallet-balances">
          {wallet.assets.map((asset) => (
            <div key={asset.code} className="wallet-asset">
              <span className="wallet-asset-code">{asset.code}</span>
              <span className="wallet-asset-balance">{asset.balance}</span>
              <span className="wallet-asset-usd">{asset.note}</span>
            </div>
          ))}
        </div>
      ) : null}

      {wallet.aliases.length > 0 ? (
        <ul className="page-list" aria-label="Alias book">
          {wallet.aliases.map((alias) => (
            <li key={alias.name} className="wallet-key">
              <span className="wallet-key-label">{alias.name}</span>
              <code className="wallet-key-value selectable" title={alias.address}>
                {truncateKey(alias.address, 8, 8)}
              </code>
            </li>
          ))}
        </ul>
      ) : null}

      {showTransactions ? (
        <>
          {wallet.message ? <p className="wallet-key-label">{wallet.message}</p> : null}
          <ul className="page-list wallet-tx-list" aria-label="Recent transactions">
            {wallet.transactions.map((tx) => (
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
                {tx.txHash !== null ? (
                  <ExplorerLink target={tx.txHash} kind="tx" iconOnly />
                ) : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </>
  );
}
