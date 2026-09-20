/**
 * The unlocked Wallet dashboard (task W13b).
 *
 * A real wallet's essentials in the notch width: network badge + funded chip,
 * the account label, the public key (copy / explorer / Receive QR), the assets
 * with their reserve note, collapsed account details, the last ten operations,
 * account switching, Send, and Log out with the auto-lock setting.
 *
 * All reads are read-only; the only value-moving path is `SendForm`, which runs
 * the same `executeApprovedIntent` pipeline a spoken send uses. Balances and the
 * reserve are formatted from strings (no float) by `walletAssets.ts`.
 */
import { useState } from "react";
import { ArrowDownLeft, ArrowUpRight, Check, ChevronDown, Copy, ExternalLink, LogOut, QrCode as QrIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { DEFAULT_EXPLORER_BASE, explorerAccountUrl } from "@/lib/history";
import { formatTimestamp } from "@/lib/mockData";
import { AUTO_LOCK_OPTIONS } from "@/lib/walletSession";
import { deriveAssetRows } from "@/lib/walletAssets";
import type { WalletEntry } from "@/lib/wallet";
import { useWalletData } from "@/notch/data/useWalletData";
import committedAliases from "../../../../stellar/config/aliases.json";

import { AccountList } from "./AccountList";
import { CreateWallet } from "./CreateWallet";
import { ImportWallet } from "./ImportWallet";
import { QrCode } from "./QrCode";
import { RecipientsSection } from "./RecipientsSection";
import { SendForm } from "./SendForm";
import { ACTIONS, CARD, ERROR, FIELD, HINT } from "./styles";

const COPIED_MS = 1500;

export interface WalletDashboardProps {
  entries: readonly WalletEntry[];
  activeAddress: string | null;
  autoLockMinutes: number;
  onSelectAccount: (address: string) => void;
  onRenameAccount: (address: string, label: string) => void;
  onRemoveAccount: (address: string) => void;
  onReloadAccounts: () => void;
  onLock: () => void;
  onSetAutoLock: (minutes: number) => void;
}

type AddMode = "none" | "create" | "import";

export function WalletDashboard({
  entries,
  activeAddress,
  autoLockMinutes,
  onSelectAccount,
  onRenameAccount,
  onRemoveAccount,
  onReloadAccounts,
  onLock,
  onSetAutoLock,
}: WalletDashboardProps) {
  const wallet = useWalletData(committedAliases, activeAddress);
  const [mode, setMode] = useState<AddMode>("none");
  const [showReceive, setShowReceive] = useState(false);
  const [showDetail, setShowDetail] = useState(false);
  const [copied, setCopied] = useState(false);

  const active = entries.find((entry) => entry.address === activeAddress) ?? null;
  const owner = wallet.ownerAddress;
  const assetRows = wallet.accountDetail
    ? deriveAssetRows(wallet.accountDetail)
    : wallet.assets.map((asset) => ({
        key: asset.code,
        code: asset.code,
        issuer: null,
        balance: asset.balance,
        note: asset.note,
        native: asset.note === "native",
      }));
  const funded = wallet.status === "ready";

  const copyKey = (text: string): void => {
    void navigator.clipboard?.writeText(text).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), COPIED_MS);
  };

  if (mode === "create" || mode === "import") {
    const Flow = mode === "create" ? CreateWallet : ImportWallet;
    return (
      <Flow
        onDone={() => {
          setMode("none");
          onReloadAccounts();
        }}
        onCancel={() => setMode("none")}
      />
    );
  }

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold">{active?.label || "Account"}</span>
        <span
          className="rounded-full bg-white/10 px-2 py-0.5 text-[11px] text-[var(--color-notch-muted)]"
          title={wallet.networkPassphrase || undefined}
        >
          {wallet.network}
        </span>
        <span
          className={`rounded-full px-2 py-0.5 text-[11px] ${
            funded
              ? "bg-[var(--color-polaris-ok)]/15 text-[var(--color-polaris-ok)]"
              : "bg-[var(--color-polaris-warn)]/15 text-[var(--color-polaris-warn)]"
          }`}
        >
          {funded ? "Funded" : "Not funded"}
        </span>
        <button
          type="button"
          className="page-icon-button ml-auto"
          onClick={onLock}
          aria-label="Log out"
          title="Log out"
        >
          <LogOut aria-hidden="true" />
        </button>
      </div>

      {wallet.status === "unfunded" && wallet.friendbotUrl ? (
        <a className="wallet-key" href={wallet.friendbotUrl} target="_blank" rel="noreferrer">
          <span className="wallet-key-label">Not funded on testnet — fund with Friendbot</span>
          <ExternalLink aria-hidden="true" />
        </a>
      ) : null}

      {owner ? (
        <div className="wallet-key">
          <span className="wallet-key-label">Public key</span>
          <code className="wallet-key-value selectable" title={owner}>
            {owner}
          </code>
          <button
            type="button"
            className="page-icon-button"
            onClick={() => copyKey(owner)}
            aria-label={copied ? "Copied" : "Copy public key"}
          >
            {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
          </button>
          <a
            className="page-icon-button"
            href={explorerAccountUrl(DEFAULT_EXPLORER_BASE, owner)}
            target="_blank"
            rel="noreferrer"
            aria-label="Open account in explorer"
          >
            <ExternalLink aria-hidden="true" />
          </a>
          <button
            type="button"
            className="page-icon-button"
            onClick={() => setShowReceive((value) => !value)}
            aria-label="Show receive QR"
            aria-pressed={showReceive}
          >
            <QrIcon aria-hidden="true" />
          </button>
        </div>
      ) : null}

      {showReceive && owner ? (
        <section className={CARD}>
          <div className="flex items-start gap-3">
            <QrCode value={owner} />
            <div className="min-w-0 flex-1 space-y-1">
              <p className={HINT}>Scan to receive XLM or an asset on testnet.</p>
              <code className="wallet-key-value selectable break-all whitespace-normal">{owner}</code>
            </div>
          </div>
        </section>
      ) : null}

      {wallet.status === "loading" ? <p className={HINT}>Reading balances from Horizon…</p> : null}
      {wallet.status === "offline" ? <p className={ERROR}>{wallet.message}</p> : null}

      {assetRows.length > 0 ? (
        <div className="wallet-balances">
          {assetRows.map((row) => (
            <div key={row.key} className="wallet-asset">
              <span className="wallet-asset-code">
                {row.code}
                {row.issuer ? ` · ${row.issuer}` : ""}
              </span>
              <span className="wallet-asset-balance">{row.balance}</span>
              <span className="wallet-asset-usd">{row.note}</span>
            </div>
          ))}
        </div>
      ) : null}

      {wallet.accountDetail ? (
        <div className={CARD}>
          <button
            type="button"
            className="flex w-full items-center gap-2 text-left text-[11px] text-[var(--color-notch-muted)]"
            onClick={() => setShowDetail((value) => !value)}
            aria-expanded={showDetail}
          >
            <ChevronDown
              aria-hidden="true"
              className={`h-3.5 w-3.5 transition-transform${showDetail ? " rotate-180" : ""}`}
            />
            Account details
          </button>
          {showDetail ? (
            <dl className="space-y-1 text-[11px] text-[var(--color-notch-muted)]">
              <div className="flex justify-between gap-2">
                <dt>Sequence</dt>
                <dd className="selectable">{wallet.accountDetail.sequence}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt>Subentries</dt>
                <dd>{wallet.accountDetail.subentryCount}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt>Sponsoring / sponsored</dt>
                <dd>
                  {wallet.accountDetail.numSponsoring} / {wallet.accountDetail.numSponsored}
                </dd>
              </div>
            </dl>
          ) : null}
        </div>
      ) : null}

      <SendForm assets={assetRows.map((row) => row.code)} onSent={wallet.refresh} />

      {wallet.activity.length > 0 ? (
        <ul className="page-list wallet-tx-list" aria-label="Recent activity">
          {wallet.activity.map((tx) => (
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
              {tx.explorerUrl ? (
                <a className="wallet-tx-amount" href={tx.explorerUrl} target="_blank" rel="noreferrer">
                  {tx.amount}
                </a>
              ) : (
                <span className={`wallet-tx-amount is-${tx.status}`}>{tx.amount}</span>
              )}
            </li>
          ))}
        </ul>
      ) : wallet.status === "ready" ? (
        <p className={HINT}>No recent activity.</p>
      ) : null}

      <section className={CARD}>
        <h3 className="text-xs font-semibold">Accounts</h3>
        <AccountList
          entries={entries}
          activeAddress={activeAddress}
          onSelect={onSelectAccount}
          onRename={onRenameAccount}
          onRemove={onRemoveAccount}
        />
        <div className={ACTIONS}>
          <Button size="sm" variant="secondary" onClick={() => setMode("create")}>
            Create account
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setMode("import")}>
            Import
          </Button>
        </div>
      </section>

      <label className="flex items-center gap-2 text-[11px] text-[var(--color-notch-muted)]">
        Auto-lock
        <select
          className={FIELD}
          value={autoLockMinutes}
          onChange={(event) => onSetAutoLock(Number(event.target.value))}
        >
          {AUTO_LOCK_OPTIONS.map((option) => (
            <option key={option.minutes} value={option.minutes}>
              {option.label}
            </option>
          ))}
        </select>
      </label>

      <RecipientsSection />
    </>
  );
}
