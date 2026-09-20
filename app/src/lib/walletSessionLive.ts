/**
 * The Tauri binding for the wallet session (task W13b).
 *
 * `walletSession.ts` stays Tauri-free so its store and selectors run under
 * `node:test`; this module is the only place that binds the default engine to
 * Tauri's real `invoke` and subscribes the store to `wallet_session_changed`.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { POLARIS_EVENT_NAME } from "@polaris/interfaces";

import {
  createWalletSessionEngine,
  createWalletSessionStore,
  normalizeWalletSession,
  type WalletSessionEngine,
  type WalletSessionStore,
} from "./walletSession.ts";

/**
 * The `polaris-event` payload tag Rust emits on every session transition; the
 * payload is the `WalletSession` snapshot plus this tag.
 */
export const WALLET_SESSION_CHANGED_EVENT = "wallet_session_changed";

/** The app's single session engine, bound to Tauri's `invoke`. */
export const walletSessionEngine: WalletSessionEngine = createWalletSessionEngine((command, args) =>
  invoke(command, args),
);

/** The app's single session store (one event subscription for the webview). */
export const walletSessionStore: WalletSessionStore = createWalletSessionStore(
  walletSessionEngine,
  async (handler) => {
    const unlisten = await listen<unknown>(POLARIS_EVENT_NAME, (event) => {
      const payload = event.payload as { type?: unknown } | null;
      if (!payload || payload.type !== WALLET_SESSION_CHANGED_EVENT) return;
      const session = normalizeWalletSession(payload);
      if (session) handler(session);
    });
    return () => unlisten();
  },
);
