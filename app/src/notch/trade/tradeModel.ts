/**
 * Pure view model for the notch Trade page (task W15c).
 *
 * All of the page's decisions live here — the segmented modes, the compact
 * three-step list folded from the bank engine's seven steps, and the amount /
 * offer validation — so they run under `node:test` without a DOM or Tauri. The
 * components only render this state; the value-moving work itself stays in
 * `@/lib/bankAnchor` and `@/lib/p2p`.
 */
import type { BankStepId, BankStepStatus } from "../../lib/bankFlow.ts";
import { BANK_STEPS } from "../../lib/bankFlow.ts";
import { formatStellarAmount, type HorizonAccountDetail } from "../../lib/walletAssets.ts";

/* ------------------------------------------------------------------ *
 * Modes
 * ------------------------------------------------------------------ */

/** The three segments the top control offers; `deposit` is the default. */
export type TradeMode = "deposit" | "withdraw" | "p2p";

export const TRADE_MODES: readonly { id: TradeMode; label: string }[] = [
  { id: "deposit", label: "Deposit" },
  { id: "withdraw", label: "Withdraw" },
  { id: "p2p", label: "P2P" },
];

export const DEFAULT_TRADE_MODE: TradeMode = "deposit";

/** The anchor directions; the P2P segment has its own view. */
export type TradeDirection = "deposit" | "withdraw";

/* ------------------------------------------------------------------ *
 * Compact step list
 * ------------------------------------------------------------------ */

/** The three phases the user sees, in order. */
export type TradePhaseId = "source" | "anchor" | "destination";

export interface TradePhase {
  id: TradePhaseId;
  /** Short sentence-case label, direction-specific. */
  title: string;
  /** The engine steps folded into this phase. */
  steps: readonly BankStepId[];
}

/**
 * Maps the bank engine's seven steps onto the three phases the owner asked for.
 * A deposit reserves the bank first (`quote` runs after the debit), a withdraw
 * pays on-chain at `bank_transfer` and the bank is credited only at `completed`.
 */
const PHASES: Record<TradeDirection, readonly TradePhase[]> = {
  deposit: [
    { id: "source", title: "Bank debited", steps: ["quote", "login", "kyc"] },
    { id: "anchor", title: "Anchor received", steps: ["trustline", "bank_transfer", "waiting"] },
    { id: "destination", title: "Wallet credited", steps: ["completed"] },
  ],
  withdraw: [
    { id: "source", title: "Wallet debited", steps: ["quote", "login", "kyc", "bank_transfer"] },
    { id: "anchor", title: "Anchor received", steps: ["waiting"] },
    { id: "destination", title: "Bank credited", steps: ["completed"] },
  ],
};

export function tradePhases(direction: TradeDirection): readonly TradePhase[] {
  return PHASES[direction];
}

/** Every engine step, all pending — the state shown before a run starts. */
export function freshBankSteps(): Record<BankStepId, BankStepStatus> {
  const steps = {} as Record<BankStepId, BankStepStatus>;
  for (const step of BANK_STEPS) steps[step.id] = "pending";
  return steps;
}

/**
 * Folds the phase's engine steps into one badge: any failure wins, then "done"
 * only once every member step is done, then "running" while any is in flight.
 */
export function phaseStatus(
  phase: TradePhase,
  steps: Record<BankStepId, BankStepStatus>,
): BankStepStatus {
  const values = phase.steps.map((id) => steps[id]);
  if (values.includes("error")) return "error";
  if (values.every((status) => status === "done")) return "done";
  if (values.some((status) => status === "active" || status === "done")) return "active";
  return "pending";
}

/* ------------------------------------------------------------------ *
 * Amounts & balances
 * ------------------------------------------------------------------ */

export type AmountCheck = { ok: true; amount: string } | { ok: false; message: string };

/**
 * Validates a deposit/withdraw amount. A positive decimal, capped by the
 * anchor's advertised maximum when known. The demo bank's own 50-unit floor is
 * deliberately not applied here: the Trade page uses a small default (10) so
 * one tap completes a demo loop.
 */
export function validateTradeAmount(raw: string, max?: number): AmountCheck {
  const amount = raw.trim();
  if (!/^\d+(?:\.\d+)?$/.test(amount) || !/[1-9]/.test(amount)) {
    return { ok: false, message: "Enter an amount." };
  }
  if (max !== undefined && Number(amount) > max) {
    return { ok: false, message: `The anchor's maximum is ${max}.` };
  }
  return { ok: true, amount };
}

/** The held balance of `asset`, formatted, or `"0"` when the account lacks it. */
export function walletBalanceLabel(detail: HorizonAccountDetail | null, asset: string): string {
  const line = detail?.balances.find((balance) => balance.code === asset);
  return formatStellarAmount(line?.balance ?? "0");
}

/** `"Bank 100,000.00 USD · Wallet 0 SRT"`, with `—` for an unread side. */
export function tradeBalanceLine(input: {
  bankBalance: string | null;
  bankCurrency: string | null;
  walletBalance: string | null;
  walletAsset: string;
}): string {
  const bank =
    input.bankBalance && input.bankCurrency
      ? `${input.bankBalance} ${input.bankCurrency}`
      : "—";
  const wallet = input.walletBalance ? `${input.walletBalance} ${input.walletAsset}` : "—";
  return `Bank ${bank} · Wallet ${wallet}`;
}

/* ------------------------------------------------------------------ *
 * P2P create-offer form
 * ------------------------------------------------------------------ */

export type OfferInputCheck = { ok: true } | { ok: false; message: string };

/** Validates the sell form: a positive token amount and a positive TRY price. */
export function validateOfferInputs(amount: string, priceTry: string): OfferInputCheck {
  const tokens = amount.trim();
  const price = priceTry.trim();
  if (!/^\d+(?:\.\d{1,7})?$/.test(tokens) || !/[1-9]/.test(tokens)) {
    return { ok: false, message: "Enter the USDC amount." };
  }
  if (!/^\d+(?:\.\d{1,2})?$/.test(price) || !/[1-9]/.test(price)) {
    return { ok: false, message: "Enter the price in TRY." };
  }
  return { ok: true };
}
