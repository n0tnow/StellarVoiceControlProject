/**
 * The Wallet-page navigation bridge and the async half of the onboarding gate
 * (task W10b).
 *
 * The pure gate decision lives in `turnFlow.ts`; this module only *observes* the
 * wallet engine and *announces* a page request. The page controller lives inside
 * the shell (`useNotchPage`), so a module-level DOM event is the smallest seam
 * that lets `App` ask the shell to show Wallet without threading a new prop
 * through `ShellSurface`.
 */
import type { Intent } from "@polaris/interfaces";

import { decideWalletGate, isValueMovingIntent, type WalletGateDecision } from "./turnFlow.ts";
import { walletEngine } from "./wallet.ts";

/** Custom event name emitted on `window` to ask the shell to show the Wallet page. */
export const WALLET_PAGE_REQUEST_EVENT = "polaris:open-wallet";

/** Asks the shell to switch to the Wallet page. Safe outside a DOM (no-op). */
export function requestWalletPage(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(WALLET_PAGE_REQUEST_EVENT));
}

/** Subscribes to Wallet-page requests; returns the unsubscribe function. */
export function onWalletPageRequest(handler: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const listener = (): void => handler();
  window.addEventListener(WALLET_PAGE_REQUEST_EVENT, listener);
  return () => window.removeEventListener(WALLET_PAGE_REQUEST_EVENT, listener);
}

/**
 * Resolves the gate for one turn by reading the live wallet status.
 *
 * A wallet engine that is missing from this build (or a failed status read) does
 * **not** block: the chain tool's own owner check remains the fail-closed gate,
 * and an absent engine must not make every payment impossible.
 */
export async function decideWalletGateForTurn(intent: Intent): Promise<WalletGateDecision> {
  if (!isValueMovingIntent(intent)) {
    return { block: false, sentence: "", page: null };
  }
  try {
    const status = await walletEngine.status();
    return decideWalletGate(intent, status.active !== null);
  } catch {
    return { block: false, sentence: "", page: null };
  }
}
