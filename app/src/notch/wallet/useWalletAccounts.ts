/**
 * Wallet-engine state for the Wallet page (task W10b).
 *
 * Owns the feature-detect (`available()`), the account list/status read and the
 * `wallet_changed` refresh. Every mutation goes through `walletEngine`; the
 * engine emits `wallet_changed`, which reloads here, so the UI and the engine
 * never disagree about which accounts exist.
 */
import { useCallback, useEffect, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import {
  WALLET_CHANGED_EVENT,
  walletEngine,
  type WalletEntry,
  type WalletStatus,
} from "@/lib/wallet";

export interface WalletAccountsState {
  loading: boolean;
  /** `null` until the first probe; `false` means "not in this build". */
  available: boolean | null;
  status: WalletStatus | null;
  entries: WalletEntry[];
  error: string | null;
  reload: () => Promise<void>;
}

export function useWalletAccounts(): WalletAccountsState {
  const [loading, setLoading] = useState(true);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [status, setStatus] = useState<WalletStatus | null>(null);
  const [entries, setEntries] = useState<WalletEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const ok = await walletEngine.available();
      setAvailable(ok);
      if (!ok) {
        setStatus(null);
        setEntries([]);
        setError(null);
        return;
      }
      const [nextStatus, nextEntries] = await Promise.all([
        walletEngine.status(),
        walletEngine.list(),
      ]);
      setStatus(nextStatus);
      setEntries(nextEntries);
      setError(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    let disposed = false;
    let unlisten: UnlistenFn | undefined;
    void listen(WALLET_CHANGED_EVENT, () => {
      void load();
    })
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch((failure: unknown) => {
        console.warn("wallet page could not subscribe to wallet_changed", failure);
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [load]);

  return { loading, available, status, entries, error, reload: load };
}
