/**
 * The webview's demo-bank seam (BANK-SIM).
 *
 * Thin typed wrappers over the Rust `bank_*` commands plus the `bank_changed`
 * event subscription. The ledger itself lives in Rust (`app/src-tauri/src/bank.rs`);
 * this file holds no state and no secret.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type {
  BankAccount,
  BankApi,
  BankTransaction,
  BankTxType,
  BankTxStatus,
} from "./bankFlow.ts";

export type { BankAccount, BankTransaction, BankTxType, BankTxStatus };

/** The active anchor scenario the shell is configured for. */
export interface BankAnchorConfig {
  homeDomain: string;
  sandboxBank: boolean;
}

/** Reads the demo bank account snapshot. */
export function getBankAccount(): Promise<BankAccount> {
  return invoke<BankAccount>("bank_account");
}

/** Newest-first ledger history. */
export function getBankHistory(limit = 50): Promise<BankTransaction[]> {
  return invoke<BankTransaction[]>("bank_history", { limit });
}

/** Reserves an amount (fails when the balance is short). */
export function bankDebit(amountTry: string, reference: string): Promise<BankTransaction> {
  return invoke<BankTransaction>("bank_debit", { amountTry, reference });
}

/** Credits a payout, idempotent per `anchorTxId`. */
export function bankCredit(
  amountTry: string,
  reference: string,
  anchorTxId?: string,
): Promise<BankTransaction> {
  return invoke<BankTransaction>("bank_credit", { amountTry, reference, anchorTxId });
}

/** Marks a pending deposit reservation completed. */
export function bankSettle(reference: string): Promise<BankTransaction> {
  return invoke<BankTransaction>("bank_settle", { reference });
}

/** Reverses a pending deposit reservation (idempotent by reference). */
export function bankRefund(reference: string): Promise<BankTransaction> {
  return invoke<BankTransaction>("bank_refund", { reference });
}

/** Resets the demo ledger (demo helper; no Touch ID). */
export function bankReset(): Promise<BankAccount> {
  return invoke<BankAccount>("bank_reset");
}

/** Points the ledger at the anchor's quoted fiat (e.g. `USD`). */
export function bankSetCurrency(currency: string): Promise<BankAccount> {
  return invoke<BankAccount>("bank_set_currency", { currency });
}

/**
 * The active anchor scenario. Feature-detected: a build without the command
 * falls back to the SDF test anchor with the sandbox transfer enabled.
 */
export async function getBankAnchorConfig(): Promise<BankAnchorConfig> {
  try {
    return await invoke<BankAnchorConfig>("bank_anchor_config");
  } catch {
    return { homeDomain: "testanchor.stellar.org", sandboxBank: true };
  }
}

/** Subscribes to a fresh account snapshot after every ledger mutation. */
export function subscribeBankChanged(onChange: (account: BankAccount) => void): Promise<UnlistenFn> {
  return listen<BankAccount>("bank_changed", (event) => onChange(event.payload));
}

/** The real `BankApi` for the flow engine. */
export const bankApi: BankApi = {
  account: getBankAccount,
  history: getBankHistory,
  debit: bankDebit,
  credit: bankCredit,
  settle: bankSettle,
  refund: bankRefund,
  setCurrency: bankSetCurrency,
};
