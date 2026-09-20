/**
 * The unlocked Wallet dashboard (task W15b — "everything inside the notch").
 *
 * A deliberately small surface: account header with a lock button, one balance
 * hero (with an in-app "Fund account" action when unfunded), the address with
 * copy and an inline QR, the two-input Send card, contacts, and a compact
 * accounts section. All reads are read-only; the only value-moving path is
 * `SendForm`, which runs the same `executeApprovedIntent` pipeline a spoken send
 * uses. Balances are formatted from strings (no float) by `walletAssets.ts`.
 */
import { useState } from "react";
import { Check, Copy, LogOut, QrCode as QrIcon, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { WalletEntry } from "@/lib/wallet";
import { deriveAssetRows, requestFriendbotFund } from "@/lib/walletAssets";
import { useWalletData } from "@/notch/data/useWalletData";
import { ExplorerLink } from "@/notch/ExplorerLink";
import { shortAddress } from "@/lib/address";
import committedAliases from "../../../../stellar/config/aliases.json";

import { AccountsSection, type AddAccountMode } from "./AccountsSection";
import { AddAsset } from "./AddAsset";
import { CreateWallet } from "./CreateWallet";
import { ImportWallet } from "./ImportWallet";
import { QrCode } from "./QrCode";
import { RecipientsSection } from "./RecipientsSection";
import { SendForm } from "./SendForm";
import { CARD, ERROR, HINT } from "./styles";

const COPIED_MS = 1500;

export interface WalletDashboardProps {
  entries: readonly WalletEntry[];
  activeAddress: string | null;
  store?: string | null;
  onSelectAccount: (address: string) => void;
  onRenameAccount: (address: string, label: string) => void;
  onRemoveAccount: (address: string) => void;
  onReloadAccounts: () => void;
  onLock: () => void;
}

type AddMode = "none" | "create" | "import";
type FundState = { kind: "idle" } | { kind: "funding" } | { kind: "failed"; label: string };

export function WalletDashboard({
  entries,
  activeAddress,
  store,
  onSelectAccount,
  onRenameAccount,
  onRemoveAccount,
  onReloadAccounts,
  onLock,
}: WalletDashboardProps) {
  const wallet = useWalletData(committedAliases, activeAddress);
  const [mode, setMode] = useState<AddMode>("none");
  const [showQr, setShowQr] = useState(false);
  const [copied, setCopied] = useState(false);
  const [fund, setFund] = useState<FundState>({ kind: "idle" });

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
  const native = assetRows.find((row) => row.native) ?? null;
  const otherAssets = assetRows.filter((row) => !row.native);
  const funded = wallet.status === "ready";

  const copyKey = (text: string): void => {
    void navigator.clipboard?.writeText(text).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), COPIED_MS);
  };

  const fundAccount = async (): Promise<void> => {
    if (!owner) return;
    setFund({ kind: "funding" });
    const result = await requestFriendbotFund(owner);
    if (result.status === "ok") {
      setFund({ kind: "idle" });
      wallet.refresh();
    } else {
      setFund({ kind: "failed", label: result.message });
    }
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

  const openAdd = (next: AddAccountMode): void => setMode(next);

  return (
    <>
      <div className="flex items-center gap-2">
        <span className="text-sm font-semibold">{active?.label || "Account"}</span>
        <span className="rounded-full bg-white/10 px-2 py-0.5 text-[11px] text-[var(--color-notch-muted)]">
          {wallet.network}
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

      <section className={CARD}>
        {wallet.status === "loading" ? <p className={HINT}>Reading balances…</p> : null}
        {wallet.status === "unconfigured" ? <p className={HINT}>{wallet.message}</p> : null}
        {wallet.status === "offline" ? (
          <div className="flex items-center gap-2">
            <p className={ERROR}>{wallet.message}</p>
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
        {wallet.status === "unfunded" ? (
          <div className="space-y-2">
            <p className={HINT}>This account has no testnet funds yet.</p>
            <Button size="sm" disabled={fund.kind === "funding"} onClick={() => void fundAccount()}>
              {fund.kind === "funding" ? "Funding…" : "Fund account"}
            </Button>
            {fund.kind === "failed" ? <p className={ERROR}>{fund.label}</p> : null}
          </div>
        ) : null}
        {funded ? (
          <div className="space-y-1">
            <span className="wallet-key-label">Balance</span>
            <div className="text-3xl font-semibold tabular-nums">
              {native?.balance ?? "0"}
              <span className="ml-1 text-base font-normal text-[var(--color-notch-muted)]">XLM</span>
            </div>
            {otherAssets.length > 0 ? (
              <div className="flex flex-wrap gap-1">
                {otherAssets.map((row) => (
                  <span
                    key={row.key}
                    className="rounded-full bg-white/10 px-2 py-0.5 text-[11px] text-[var(--color-notch-muted)]"
                  >
                    {row.balance} {row.code}
                  </span>
                ))}
              </div>
            ) : null}
            <AddAsset detail={wallet.accountDetail} address={owner} onAdded={wallet.refresh} />
          </div>
        ) : null}
      </section>

      {owner ? (
        <>
          <div className="wallet-key">
            <span className="wallet-key-label">Address</span>
            <code className="wallet-key-value selectable" title={owner}>
              {shortAddress(owner)}
            </code>
            <button
              type="button"
              className="page-icon-button"
              onClick={() => copyKey(owner)}
              aria-label={copied ? "Copied" : "Copy address"}
            >
              {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
            </button>
            <button
              type="button"
              className="page-icon-button"
              onClick={() => setShowQr((value) => !value)}
              aria-label="Show receive QR"
              aria-pressed={showQr}
            >
              <QrIcon aria-hidden="true" />
            </button>
            <ExplorerLink target={owner} kind="account" iconOnly />
          </div>
          {showQr ? (
            <div className="flex items-start gap-3">
              <QrCode value={owner} />
              <p className={HINT}>Scan to receive on testnet.</p>
            </div>
          ) : null}
        </>
      ) : null}

      {funded ? <SendForm assets={assetRows.map((row) => row.code)} onSent={wallet.refresh} /> : null}

      <RecipientsSection />

      <AccountsSection
        entries={entries}
        activeAddress={activeAddress}
        store={store}
        onSelect={onSelectAccount}
        onRename={onRenameAccount}
        onRemove={onRemoveAccount}
        onAdd={openAdd}
      />
    </>
  );
}
