/**
 * The W13b wallet experience: login gate → Wallet dashboard.
 *
 * The Rust session is the only authority on what is possible; this view picks
 * the screen from it — Connect (no wallet), Unlock (locked), Dashboard
 * (unlocked). The legacy W10b body is used only when the session engine is
 * absent from the build (feature-detected in `WalletPage`).
 */
import { useState } from "react";

import { walletEngine } from "@/lib/wallet";
import { walletScreenFor, WalletSessionError } from "@/lib/walletSession";
import { ConnectScreen } from "@/notch/wallet/ConnectScreen";
import { CreateWallet } from "@/notch/wallet/CreateWallet";
import { ImportWallet } from "@/notch/wallet/ImportWallet";
import { UnlockScreen } from "@/notch/wallet/UnlockScreen";
import { WalletDashboard } from "@/notch/wallet/WalletDashboard";
import { useWalletAccounts } from "@/notch/wallet/useWalletAccounts";
import { useWalletSession, useWalletSessionActions } from "@/notch/wallet/useWalletSession";

type OnboardingMode = "none" | "create" | "import";

/** One actionable line for a failed Touch ID unlock. */
function unlockError(failure: unknown): string {
  const kind = failure instanceof WalletSessionError ? failure.kind : "unknown";
  if (kind === "cancelled") return "Touch ID was cancelled.";
  if (kind === "unauthorized") return "Touch ID was not recognized.";
  return failure instanceof Error ? failure.message : String(failure);
}

export function SessionWalletView() {
  const { session } = useWalletSession();
  const { unlock, lock, refresh } = useWalletSessionActions();
  const accounts = useWalletAccounts();
  const [mode, setMode] = useState<OnboardingMode>("none");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const activeAddress = session?.active?.address ?? accounts.status?.active?.address ?? null;
  const screen = walletScreenFor(session);

  const reload = (): void => {
    void accounts.reload();
    void refresh();
  };

  const afterChange = (): void => {
    setMode("none");
    reload();
  };

  const run = (action: Promise<unknown>): void => {
    void action
      .then(() => accounts.reload())
      .catch((failure: unknown) => console.warn("wallet page action failed", failure));
  };

  const onUnlock = async (address?: string): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await unlock(address);
      await accounts.reload();
    } catch (failure) {
      setError(unlockError(failure));
    } finally {
      setBusy(false);
    }
  };

  if (screen === "loading") {
    return <p className="wallet-key-label">Reading wallet session…</p>;
  }

  if (screen === "connect") {
    if (mode === "create") {
      return <CreateWallet onDone={afterChange} onCancel={() => setMode("none")} />;
    }
    if (mode === "import") {
      return <ImportWallet onDone={afterChange} onCancel={() => setMode("none")} />;
    }
    return (
      <div className="page-stack">
        <ConnectScreen
          loading={accounts.loading}
          error={accounts.error}
          onCreate={() => setMode("create")}
          onImport={() => setMode("import")}
        />
      </div>
    );
  }

  if (screen === "unlock") {
    return (
      <div className="page-stack">
        <UnlockScreen
          entries={accounts.entries}
          activeAddress={activeAddress}
          busy={busy}
          error={error}
          onUnlock={(address) => void onUnlock(address)}
        />
      </div>
    );
  }

  return (
    <div className="page-stack">
      <WalletDashboard
        entries={accounts.entries}
        activeAddress={activeAddress}
        store={accounts.status?.store}
        onSelectAccount={(address) => run(walletEngine.select(address))}
        onRenameAccount={(address, label) => run(walletEngine.rename(address, label))}
        onRemoveAccount={(address) => run(walletEngine.remove(address))}
        onReloadAccounts={reload}
        onLock={() => run(lock())}
      />
    </div>
  );
}
