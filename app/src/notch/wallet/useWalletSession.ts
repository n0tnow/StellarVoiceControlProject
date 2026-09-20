/**
 * React binding for the wallet session store (task W13b).
 *
 * `useSyncExternalStore` keeps every consumer on the same snapshot, so the
 * shell trigger, the page gate and the Wallet page cannot disagree. `start()`
 * is idempotent, so mounting this hook in several components still opens one
 * `wallet_session` read and one `wallet_session_changed` subscription.
 */
import { useCallback, useEffect, useSyncExternalStore } from "react";

import { walletSessionStore } from "@/lib/walletSessionLive";
import { shouldGateForSession, type WalletSessionSnapshot } from "@/lib/walletSession";

export function useWalletSession(): WalletSessionSnapshot {
  const snapshot = useSyncExternalStore(
    walletSessionStore.subscribe,
    walletSessionStore.getSnapshot,
    walletSessionStore.getSnapshot,
  );
  useEffect(() => {
    void walletSessionStore.start();
  }, []);
  return snapshot;
}

/**
 * Whether the non-wallet pages must show "Log in to use this". A build without
 * the session engine (or an unread session) is never gated; Rust stays the
 * fail-closed authority.
 */
export function useWalletLocked(): boolean {
  const { session, available } = useWalletSession();
  if (available === false) return false;
  return shouldGateForSession(session);
}

/** The mutations the Wallet page runs; each one updates the shared store. */
export function useWalletSessionActions() {
  return {
    unlock: useCallback((address?: string) => walletSessionStore.unlock(address), []),
    lock: useCallback(() => walletSessionStore.lock(), []),
    setAutoLock: useCallback((minutes: number) => walletSessionStore.setAutoLock(minutes), []),
    refresh: useCallback(() => walletSessionStore.refresh(), []),
  };
}

