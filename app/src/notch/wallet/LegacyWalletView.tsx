/**
 * The W10b wallet body, kept as the fallback for a build without the W13b
 * session engine (feature-detected by `WalletPage`). Unchanged behaviour: the
 * read-only env-owner view when even the wallet engine is absent, otherwise
 * Create / Import onboarding over the account list and balances.
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

export function LegacyWalletView() {
  const accounts = useWalletAccounts();
  const [mode, setMode] = useState<OnboardingMode>("none");
  const active = accounts.status?.active ?? null;

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
          onCreate={() => setMode("create")}
          onImport={() => setMode("import")}
        />
      )}

      {accounts.available !== false ? <RecipientsSection /> : null}
    </div>
  );
}
