/**
 * The webview's client for the in-app wallet (step W10).
 *
 * The default signer is the embedded wallet: the user creates a 24-word wallet
 * or imports an `S…` seed / recovery phrase, and Rust stores the seed in the
 * macOS Keychain. This module is the one place the webview names the wallet
 * commands, so the wire contract stays in one file. Every wrapper is a thin
 * `invoke`; a rejected command is a typed `WalletCommandError` (`{ kind, message }`).
 *
 * Secrets only ever travel webview → Rust over IPC: `walletImport` /
 * `walletImportPreview` pass the phrase or secret as an argument and never log
 * it, store it in the URL/localStorage, or emit it in an event. `wallet_create`
 * is the one command that returns a recovery phrase, once, for the user to save.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  WalletAccount,
  WalletAddressOutcome,
  WalletCommandError,
  WalletCreateOutcome,
  WalletErrorKind,
  WalletStatus,
} from "@polaris/interfaces";

import type { InvokeFn } from "./approval.ts";

export type {
  WalletAccount,
  WalletAddressOutcome,
  WalletCommandError,
  WalletCreateOutcome,
  WalletErrorKind,
  WalletStatus,
};

/** Injectable seam so the wrappers are unit-testable without Tauri. */
export interface WalletDeps {
  invoke: InvokeFn;
}

const defaultDeps: WalletDeps = { invoke };

/** The event Rust emits whenever the active wallet changes. */
export const WALLET_CHANGED_EVENT = "wallet_changed";

/** `wallet_status`: signer, active account, count and store label. Never prompts. */
export function walletStatus(deps: WalletDeps = defaultDeps): Promise<WalletStatus> {
  return deps.invoke<WalletStatus>("wallet_status");
}

/** `wallet_list`: every account's non-secret metadata. */
export function walletList(deps: WalletDeps = defaultDeps): Promise<WalletAccount[]> {
  return deps.invoke<WalletAccount[]>("wallet_list");
}

/** `wallet_create`: generate a wallet; returns the recovery phrase once. Touch ID. */
export function walletCreate(
  label?: string,
  deps: WalletDeps = defaultDeps,
): Promise<WalletCreateOutcome> {
  return deps.invoke<WalletCreateOutcome>("wallet_create", { label });
}

/** `wallet_import_preview`: derive the address only; stores nothing. */
export function walletImportPreview(
  secretOrPhrase: string,
  index?: number,
  deps: WalletDeps = defaultDeps,
): Promise<WalletAddressOutcome> {
  return deps.invoke<WalletAddressOutcome>("wallet_import_preview", { secretOrPhrase, index });
}

/** `wallet_import`: validate and store a secret/phrase. Touch ID. */
export function walletImport(
  secretOrPhrase: string,
  options: { index?: number; label?: string } = {},
  deps: WalletDeps = defaultDeps,
): Promise<WalletAddressOutcome> {
  return deps.invoke<WalletAddressOutcome>("wallet_import", {
    secretOrPhrase,
    index: options.index,
    label: options.label,
  });
}

/** `wallet_select`: make an existing account active. */
export function walletSelect(
  address: string,
  deps: WalletDeps = defaultDeps,
): Promise<WalletAddressOutcome> {
  return deps.invoke<WalletAddressOutcome>("wallet_select", { address });
}

/** `wallet_rename`: change an account's display label. */
export function walletRename(
  address: string,
  label: string,
  deps: WalletDeps = defaultDeps,
): Promise<WalletAddressOutcome> {
  return deps.invoke<WalletAddressOutcome>("wallet_rename", { address, label });
}

/** `wallet_remove`: delete an account. Touch ID. */
export function walletRemove(
  address: string,
  deps: WalletDeps = defaultDeps,
): Promise<WalletAddressOutcome> {
  return deps.invoke<WalletAddressOutcome>("wallet_remove", { address });
}

/**
 * Subscribes to `wallet_changed`, which Rust emits whenever the active wallet
 * changes, so a wallet screen can refresh.
 */
export async function onWalletChanged(
  handler: (status: WalletStatus) => void,
): Promise<UnlistenFn> {
  return listen<WalletStatus>(WALLET_CHANGED_EVENT, (event) => handler(event.payload));
}

/** True when a rejection is the wallet commands' typed `{ kind, message }` shape. */
export function isWalletCommandError(value: unknown): value is WalletCommandError {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<WalletCommandError>;
  return typeof candidate.kind === "string" && typeof candidate.message === "string";
}

/** The typed kind of a rejection, or `"unknown"` when it is not a wallet error. */
export function walletErrorKind(error: unknown): WalletErrorKind | "unknown" {
  if (isWalletCommandError(error)) return error.kind;
  if (typeof error === "object" && error !== null) {
    const candidate = error as Partial<WalletCommandError>;
    if (typeof candidate.kind === "string") return candidate.kind as WalletErrorKind;
  }
  return "unknown";
}
