/**
 * The real wiring of the bank↔anchor loop (BANK-SIM).
 *
 * `bankFlow.ts` owns the pure automation; this module binds it to the shell's
 * real seams: the Tauri demo bank (`@/lib/bank`), the shell `AnchorSession`
 * (`@/lib/anchor`, whose signer routes the SEP-10 challenge wallet-only and
 * every value-moving step through the Touch ID pipeline) and the anchor scenario
 * selected by `POLARIS_ANCHOR_HOME_DOMAIN`.
 *
 * The anchor home domain is read through the Rust `bank_anchor_config` command
 * (the webview cannot read arbitrary env); it defaults to the SDF test anchor.
 */
import { anchor } from "@polaris/stellar";
import type { Intent } from "@polaris/interfaces";

import { createAnchorSession } from "@/lib/anchor";
import { bankApi, getBankAnchorConfig } from "@/lib/bank";
import {
  browserBankFlowStorage,
  reconcileBankFlows as reconcileFlows,
  runBankDeposit,
  runBankWithdraw,
  type BankAnchorSession,
  type BankFlowDeps,
  type BankFlowResult,
  type BankFlowStorage,
  type BankStepReporter,
} from "@/lib/bankFlow";
import type { SubmittedOutcome } from "@/lib/signing";

/** Adapts the shell `AnchorSession` to the flows' structural interface. */
export function toBankSession(session: anchor.AnchorSession): BankAnchorSession {
  return {
    homeDomain: session.homeDomain,
    quoteDeposit: (amount) => session.quoteDeposit(amount),
    quoteWithdraw: (amount) => session.quoteWithdraw(amount),
    login: () => session.login(),
    prepareAccount: () => session.prepareAccount(),
    startDeposit: (amount) => session.startDeposit(amount),
    startWithdraw: (amount) => session.startWithdraw(amount),
    payWithdrawal: (amount) => session.payWithdrawal(amount),
    simulateBank: (id, amount) => session.simulateBank(id, amount),
    waitForTransaction: async (id, opts) => {
      const result = await session.waitForTransaction(id, {
        ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
        ...(opts?.intervalMs !== undefined ? { intervalMs: opts.intervalMs } : {}),
        ...(opts?.onUpdate ? { onUpdate: (tx) => opts.onUpdate?.(tx) } : {}),
      });
      return { data: { outcome: result.data.outcome, tx: result.data.tx } };
    },
    transaction: async (id) => {
      const result = await session.transaction(id);
      return { data: result.data };
    },
  };
}

/** Test/injection seams for the bank flows. Production passes none. */
export interface BankWiringOptions {
  session?: anchor.AnchorSession;
  bank?: BankFlowDeps["bank"];
  storage?: BankFlowStorage;
  sandboxBank?: boolean;
  shouldCancel?: () => boolean;
}

let sessionOverride: anchor.AnchorSession | undefined;
let fallback: anchor.AnchorSession | undefined;

/** Installs a session for the bank flows (tests only). */
export function configureBankSession(session: anchor.AnchorSession | undefined): void {
  sessionOverride = session;
}

/**
 * The session the bank flows drive: the shell-configured one when a voice turn
 * already installed it, else a fresh one on the selected home domain.
 */
function configuredSession(homeDomain: string): anchor.AnchorSession {
  try {
    return anchor.getAnchorSession();
  } catch {
    fallback ??= createAnchorSession({ homeDomain });
    return fallback;
  }
}

/** Builds the flow deps from the real seams and any overrides. */
export async function resolveBankDeps(options: BankWiringOptions = {}): Promise<BankFlowDeps> {
  const config = await getBankAnchorConfig();
  const session = options.session ?? sessionOverride ?? configuredSession(config.homeDomain);
  return {
    bank: options.bank ?? bankApi,
    session: toBankSession(session),
    storage: options.storage ?? browserBankFlowStorage(),
    sandboxBank: options.sandboxBank ?? config.sandboxBank,
    ...(options.shouldCancel ? { shouldCancel: options.shouldCancel } : {}),
  };
}

/** Bank → anchor → wallet, with the reservation refunded on any failure. */
export async function bankDeposit(
  amountFiat: string,
  options: BankWiringOptions = {},
  report?: BankStepReporter,
): Promise<BankFlowResult> {
  return runBankDeposit(await resolveBankDeps(options), amountFiat, report);
}

/** Wallet → anchor → bank, crediting the parsed payout once. */
export async function bankWithdraw(
  amountAsset: string,
  options: BankWiringOptions = {},
  report?: BankStepReporter,
): Promise<BankFlowResult> {
  return runBankWithdraw(await resolveBankDeps(options), amountAsset, report);
}

/** Reconciles in-flight flows after an app restart. */
export async function reconcileBankFlows(
  options: BankWiringOptions = {},
  report?: BankStepReporter,
): Promise<BankFlowResult[]> {
  return reconcileFlows(await resolveBankDeps(options), report);
}

/** The active anchor scenario (SDF test anchor by default). */
export async function bankAnchorScenario(): Promise<anchor.AnchorScenario> {
  const config = await getBankAnchorConfig();
  try {
    return anchor.describeAnchorScenario(config.homeDomain);
  } catch {
    return anchor.describeAnchorScenario(config.homeDomain, { custom: true });
  }
}

export interface BankLimits {
  assetCode: string;
  depositMax?: number;
  withdrawMax?: number;
}

/**
 * The anchor's advertised limits for our asset, from SEP-6 `/info`. Best-effort:
 * a failure just means the panel keeps its conservative default cap.
 */
export async function readBankLimits(): Promise<BankLimits> {
  const config = await getBankAnchorConfig();
  const session = configuredSession(config.homeDomain);
  const info = (await session.info()).data;
  const deposit = info.deposit[session.assetCode];
  const withdraw = info.withdraw[session.assetCode];
  return {
    assetCode: session.assetCode,
    ...(deposit?.maxAmount !== undefined ? { depositMax: deposit.maxAmount } : {}),
    ...(withdraw?.maxAmount !== undefined ? { withdrawMax: withdraw.maxAmount } : {}),
  };
}

/**
 * The existing TR-mock payout-health read (advisory, read-only). `null` for any
 * other scenario, or when the read fails.
 */
export async function readBankPayoutHealth(): Promise<anchor.PayoutHealthResult | null> {
  const scenario = await bankAnchorScenario();
  if (scenario.id !== "tr-mock") return null;
  try {
    const config = await getBankAnchorConfig();
    return await anchor.readPayoutHealth(configuredSession(config.homeDomain).ctx, {
      homeDomain: config.homeDomain,
    });
  } catch {
    return null;
  }
}

/**
 * The voice path: drives the bank automation for a deposit/withdraw intent and
 * maps the result to the shell's `SubmittedOutcome`. Never throws.
 */
export async function runBankIntent(
  intent: Intent,
  options: BankWiringOptions = {},
): Promise<SubmittedOutcome> {
  if (intent.kind !== "deposit" && intent.kind !== "withdraw") {
    return {
      status: "unsupported",
      intent,
      label: "Not supported",
      detail: `the bank flow needs a deposit/withdraw intent, got "${intent.kind}"`,
    };
  }
  try {
    const result =
      intent.kind === "deposit"
        ? await bankDeposit(intent.amount, options)
        : await bankWithdraw(intent.amount, options);
    if (result.status === "completed") {
      return {
        status: "executed",
        intent,
        ...(result.txHash ? { txHash: result.txHash } : {}),
        label: intent.kind === "deposit" ? "Deposit completed" : "Withdrawal completed",
        detail: result.detail,
      };
    }
    return {
      status: "failed",
      intent,
      label: result.status === "cancelled" ? "Cancelled" : "Bank flow failed",
      detail: result.detail,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { status: "failed", intent, label: "Bank flow failed", detail };
  }
}

/* ------------------------------------------------------------------ *
 * Amount validation (pure; used by the panel)
 * ------------------------------------------------------------------ */

/**
 * The minimums the product fixes (a small demo deposit, a whole-token withdraw).
 * The maximum comes from the anchor's `/info` when known.
 */
export const BANK_DEPOSIT_MIN = 50;
export const BANK_WITHDRAW_MIN = 1;
export const BANK_DEFAULT_MAX = 10_000;

export type BankAmountCheck =
  | { ok: true; amount: string }
  | { ok: false; message: string };

/** Validates a bank-flow amount for `kind`, honouring the anchor's max when known. */
export function validateBankAmount(
  raw: string,
  kind: "deposit" | "withdraw",
  max = BANK_DEFAULT_MAX,
): BankAmountCheck {
  const amount = raw.trim();
  if (!/^\d+(?:\.\d+)?$/.test(amount) || !/[1-9]/.test(amount)) {
    return { ok: false, message: "Enter a positive number." };
  }
  const value = Number(amount);
  const min = kind === "deposit" ? BANK_DEPOSIT_MIN : BANK_WITHDRAW_MIN;
  const unit = kind === "deposit" ? "fiat" : "tokens";
  if (value < min) return { ok: false, message: `Minimum is ${min} ${unit}.` };
  if (value > max) return { ok: false, message: `The anchor's maximum is ${max} ${unit}.` };
  return { ok: true, amount };
}
