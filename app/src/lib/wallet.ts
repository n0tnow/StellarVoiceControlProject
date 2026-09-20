/**
 * The webview's single wallet module (steps W10 + W10b).
 *
 * W10 — the in-app wallet's command client. The default signer is the embedded
 * wallet: the user creates a 24-word wallet or imports an `S…` seed / recovery
 * phrase, and Rust stores the seed in the macOS Keychain. Every wrapper is a thin
 * `invoke`; a rejected command is a typed `WalletCommandError` (`{ kind, message }`).
 *
 * W10b — the same wire commands exposed to the notch UI through one
 * feature-detected `walletEngine`. Its injectable factory lives in
 * `walletEngine.ts`; this file is the only place that binds it to Tauri's real
 * `invoke`, so the pure modules and their tests never import Tauri.
 *
 * The wire contract has a single source of truth: the command names and their
 * types live in `@polaris/interfaces` and in this file.
 *
 * Secrets only ever travel webview → Rust over IPC: `walletImport` /
 * `walletImportPreview` pass the phrase or secret as an argument and never log
 * it, store it in the URL/localStorage, or emit it in an event. `wallet_create`
 * is the one command that returns a recovery phrase, once, for the user to save.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  type ApprovalBatchAuthorized,
  type ApprovalBatchBegin,
  type ApprovalRequestInput,
  type ExecutorAddress,
  type ExecutorSignOutcome,
  type ExecutorStatus,
  type WalletAccount,
  type WalletAddressOutcome,
  type WalletCommandError,
  type WalletCreateOutcome,
  type WalletErrorKind,
  type WalletStatus,
} from "@polaris/interfaces";

import type { InvokeFn } from "./approval.ts";
import { createWalletEngine } from "./walletEngine.ts";

export type {
  WalletAccount,
  WalletAddressOutcome,
  WalletCommandError,
  WalletCreateOutcome,
  WalletErrorKind,
  WalletSession,
  WalletSessionState,
  WalletStatus,
  // Step W11a: the autopay executor and the one-Touch-ID approval batch.
  ApprovalBatchAuthorized,
  ApprovalBatchBegin,
  ApprovalBatchSnapshot,
  ApprovalBatchStep,
  ApprovalRequestInput,
  ExecutorAddress,
  ExecutorSignCode,
  ExecutorSignOutcome,
  ExecutorStatus,
} from "@polaris/interfaces";
export {
  WalletEngineError,
  createWalletEngine,
  isMissingCommandError,
  toWalletEngineError,
} from "./walletEngine.ts";
export type {
  ImportInput,
  WalletEngine,
  WalletFailureKind,
  WalletInvokeFn,
} from "./walletEngine.ts";

/** The W10b names are aliases of the canonical `@polaris/interfaces` types. */
export type WalletEntry = WalletAccount;
export type WalletActive = NonNullable<WalletStatus["active"]>;
export type WalletCreateResult = WalletCreateOutcome;
export type WalletImportPreview = WalletAddressOutcome;

/** The app's single wallet-engine instance (W10b). */
export const walletEngine = createWalletEngine((command, args) => invoke(command, args));

/** Injectable seam so the W10 wrappers are unit-testable without Tauri. */
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

/* ------------------------------------------------------------------ *
 * Wallet session (step W13a: login / logout / auto-lock)
 *
 * The session command client and its pure store live in `walletSession.ts`
 * (bound to Tauri by `walletSessionLive.ts`); the `WalletSession` type is
 * re-exported above from `@polaris/interfaces`, the single definition.
 * ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ *
 * Autopay executor + approval batch (step W11a)
 *
 * Thin `invoke` wrappers only. `executor_create` shows Touch ID;
 * `executor_sign_pay` never does, but Rust refuses unless the transaction is
 * exactly the guard's `pay_executor` call for this wallet's executor.
 * ------------------------------------------------------------------ */

/** `executor_status`: whether the active owner has an executor key. Never prompts. */
export function executorStatus(deps: WalletDeps = defaultDeps): Promise<ExecutorStatus> {
  return deps.invoke<ExecutorStatus>("executor_status");
}

/** `executor_create`: Touch-ID-gated creation of the executor key. */
export function executorCreate(deps: WalletDeps = defaultDeps): Promise<ExecutorAddress> {
  return deps.invoke<ExecutorAddress>("executor_create");
}

/**
 * `executor_sign_pay`: signs one `pay_executor` call without Touch ID. The
 * union's `code` says why a refusal happened.
 */
export function executorSignPay(
  xdr: string,
  deps: WalletDeps = defaultDeps,
): Promise<ExecutorSignOutcome> {
  return deps.invoke<ExecutorSignOutcome>("executor_sign_pay", { xdr });
}

/**
 * `approval_begin_batch`: registers several requests under one batch id. The
 * caller builds each item exactly as for `approval_begin`.
 */
export function approvalBeginBatch(
  title: string,
  items: ApprovalRequestInput[],
  deps: WalletDeps = defaultDeps,
): Promise<ApprovalBatchBegin> {
  return deps.invoke<ApprovalBatchBegin>("approval_begin_batch", { title, items });
}

/** `approval_authorize_batch`: ONE Touch ID authorises every step. */
export function approvalAuthorizeBatch(
  batchId: string,
  deps: WalletDeps = defaultDeps,
): Promise<ApprovalBatchAuthorized> {
  return deps.invoke<ApprovalBatchAuthorized>("approval_authorize_batch", { batchId });
}
