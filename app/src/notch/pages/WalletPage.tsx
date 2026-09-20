/**
 * Wallet page — wallet login (create/import), accounts, balances and recipients.
 *
 * Three surfaces in one column, chosen by the wallet engine's state:
 *
 * - **no wallet connected** → the Connect screen (Create / Import);
 * - **a wallet is active** → the account list plus the read-only balances view
 *   for the selected account;
 * - **no wallet engine in this build** (feature-detected) → the legacy read-only
 *   env-owner view, so the panel still works against an older shell.
 *
 * The onboarding flows (`CreateWallet` / `ImportWallet`) and the recipient book
 * (`RecipientsSection`) live under `app/src/notch/wallet/`; the read-only body is
 * the NW1 `WalletReadView`. The engine emits `wallet_changed` after every
 * mutation, which `useWalletAccounts` turns into a reload.
 */
import { useState } from "react";

import { walletEngine } from "@/lib/wallet";
import { AccountList } from "@/notch/wallet/AccountList";
import { ConnectScreen } from "@/notch/wallet/ConnectScreen";
import { CreateWallet } from "@/notch/wallet/CreateWallet";
import { ImportWallet } from "@/notch/wallet/ImportWallet";
import { RecipientsSection } from "@/notch/wallet/RecipientsSection";
import { WalletReadView } from "@/notch/wallet/WalletReadView";
import { useWalletAccounts } from "@/notch/wallet/useWalletAccounts";

type OnboardingMode = "none" | "create" | "import";

export function WalletPage() {
  const accounts = useWalletAccounts();
  const [mode, setMode] = useState<OnboardingMode>("none");
  const active = accounts.status?.active ?? null;

  // Every mutation already emits `wallet_changed`; this reload just makes the
  // transition immediate instead of waiting for the event round trip.
  const afterChange = (): void => {
    setMode("none");
    void accounts.reload();
  };

  const run = (action: Promise<unknown>): void => {
    void action
      .then(() => accounts.reload())
      .catch((failure: unknown) => console.warn("wallet page action failed", failure));
  };

  return (
    <div className="page-stack">
      {accounts.available === false ? (
        <>
          <p className="wallet-key-label">
            Wallet engine not in this build — showing the read-only wallet.
          </p>
          <WalletReadView />
        </>
      ) : active !== null ? (
        <>
          <AccountList
            entries={accounts.entries}
            activeAddress={active.address}
            store={accounts.status?.store}
            onSelect={(address) => run(walletEngine.select(address))}
            onRename={(address, label) => run(walletEngine.rename(address, label))}
            onRemove={(address) => run(walletEngine.remove(address))}
          />
          <WalletReadView ownerAddressOverride={active.address} />
        </>
      ) : mode === "create" ? (
        <CreateWallet onDone={afterChange} onCancel={() => setMode("none")} />
      ) : mode === "import" ? (
        <ImportWallet onDone={afterChange} onCancel={() => setMode("none")} />
      ) : (
        <ConnectScreen
          loading={accounts.loading}
          error={accounts.error}
          store={accounts.status?.store}
          onCreate={() => setMode("create")}
          onImport={() => setMode("import")}
        />
      )}

      {accounts.available !== false ? <RecipientsSection /> : null}
    </div>
  );
}
