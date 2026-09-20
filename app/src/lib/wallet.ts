/**
 * The app's single wallet-engine instance (task W10b).
 *
 * The engine's contract and its injectable factory live in `walletEngine.ts`;
 * this file is the only place that binds it to Tauri's real `invoke`, so the
 * pure modules and their tests never import Tauri.
 */
import { invoke } from "@tauri-apps/api/core";

import { createWalletEngine } from "./walletEngine.ts";

export const walletEngine = createWalletEngine((command, args) => invoke(command, args));

/** Rust broadcasts this when the wallet set or the active wallet changes. */
export const WALLET_CHANGED_EVENT = "wallet_changed";

export {
  WalletEngineError,
  createWalletEngine,
  isMissingCommandError,
  toWalletEngineError,
} from "./walletEngine.ts";
export type {
  ImportInput,
  WalletActive,
  WalletCreateResult,
  WalletEngine,
  WalletEntry,
  WalletErrorKind,
  WalletImportPreview,
  WalletStatus,
} from "./walletEngine.ts";
