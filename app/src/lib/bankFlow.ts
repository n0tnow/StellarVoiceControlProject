/**
 * The on/off-ramp automation (BANK-SIM): the demo bank on one side, an anchor
 * `AnchorSession` on the other.
 *
 * This module is deliberately pure: it holds no Tauri or React import, so the
 * whole loop is testable with fakes under `node:test`. The real wiring (the
 * Tauri bank commands and the shell `AnchorSession`) is injected from
 * `@/lib/anchor.ts`.
 *
 * Two loops exist:
 *
 *  * **deposit** (bank → anchor → wallet): reserve the money in the demo bank,
 *    quote, log in, prepare the account (trustline through the signer/pipeline),
 *    start the SEP-6 deposit, trigger the sandbox bank transfer, poll to
 *    completion, settle the reservation. Any failure refunds the reservation.
 *  * **withdraw** (wallet → anchor → bank): quote, log in, prepare, start the
 *    withdrawal, pay the anchor on-chain (Touch ID + wallet), poll to
 *    completion, then credit the parsed fiat payout into the bank exactly once.
 *
 * In-flight work is persisted (via an injected storage) so an app restart can
 * reconcile it: a reservation is refunded or settled, a payout credited, each at
 * most once.
 */

/** How a ledger entry came to exist. Mirrors the Rust `TxKind`. */
export type BankTxType = "deposit_to_anchor" | "withdrawal_payout" | "topup";
/** Lifecycle of a ledger entry. Mirrors the Rust `TxStatus`. */
export type BankTxStatus = "pending" | "completed" | "refunded" | "failed";

export interface BankTransaction {
  id: string;
  type: BankTxType;
  amountTry: string;
  currency: string;
  status: BankTxStatus;
  anchorTxId?: string;
  reference: string;
  ts: number;
}

export interface BankAccount {
  holderName: string;
  iban: string;
  currency: string;
  balanceTry: string;
  updatedAt: number;
}

/** The demo-bank operations the flows need (implemented by `@/lib/bank.ts`). */
export interface BankApi {
  account(): Promise<BankAccount>;
  history(limit: number): Promise<BankTransaction[]>;
  debit(amountTry: string, reference: string): Promise<BankTransaction>;
  credit(amountTry: string, reference: string, anchorTxId?: string): Promise<BankTransaction>;
  settle(reference: string): Promise<BankTransaction>;
  refund(reference: string): Promise<BankTransaction>;
  /** Optional: point the ledger at the anchor's quoted fiat (e.g. `USD`). */
  setCurrency?(currency: string): Promise<BankAccount>;
}

/** The ISO-4217 code from a SEP-38 fiat asset id (`iso4217:USD` → `USD`). */
export function fiatCodeOf(assetId: string): string | undefined {
  const match = /^iso4217:([A-Z]{2,12})$/.exec(assetId);
  return match?.[1];
}

/** A SEP-38 quote (subset the flows use). */
export interface BankQuote {
  sellAmount: string;
  buyAmount: string;
  sellAsset: string;
  buyAsset: string;
}

export interface BankAnchorTransaction {
  status: string;
  amountOut?: string;
  amountOutAsset?: string;
  stellarTransactionId?: string;
  message?: string;
}

export interface BankPollResult {
  outcome: "completed" | "failed" | "stopped";
  tx: BankAnchorTransaction;
}

/**
 * The `AnchorSession` surface the flows drive. Structural, so tests can pass a
 * fake and the real session satisfies it without an adapter.
 */
export interface BankAnchorSession {
  homeDomain: string;
  quoteDeposit(amountFiat: string): Promise<{ data: BankQuote }>;
  quoteWithdraw(amountAsset: string): Promise<{ data: BankQuote }>;
  login(): Promise<unknown>;
  prepareAccount(): Promise<{ data: { actions: string[] } }>;
  startDeposit(amountFiat: string): Promise<{ data: { id: string; minAmount?: number; maxAmount?: number } }>;
  startWithdraw(amountAsset: string): Promise<{ data: { id: string; minAmount?: number; maxAmount?: number } }>;
  payWithdrawal(amountAsset: string): Promise<{ data: { hash: string; explorerUrl: string } }>;
  simulateBank(id: string, amountFiat: string): Promise<unknown>;
  waitForTransaction(
    id: string,
    opts?: { timeoutMs?: number; intervalMs?: number; onUpdate?: (tx: BankAnchorTransaction) => void },
  ): Promise<{ data: BankPollResult }>;
  transaction(id: string): Promise<{ data: BankAnchorTransaction }>;
}

/* ------------------------------------------------------------------ *
 * Steps
 * ------------------------------------------------------------------ */

export type BankStepId =
  | "quote"
  | "login"
  | "kyc"
  | "trustline"
  | "bank_transfer"
  | "waiting"
  | "completed";

export type BankStepStatus = "pending" | "active" | "done" | "error";

export interface BankStep {
  id: BankStepId;
  title: string;
}

/** The ordered steps both directions share. */
export const BANK_STEPS: readonly BankStep[] = [
  { id: "quote", title: "Quote (SEP-38)" },
  { id: "login", title: "Sign in (SEP-10)" },
  { id: "kyc", title: "Customer + order (SEP-12/6)" },
  { id: "trustline", title: "Prepare wallet (trustline)" },
  { id: "bank_transfer", title: "Bank transfer to the anchor" },
  { id: "waiting", title: "Waiting for the anchor" },
  { id: "completed", title: "Completed" },
];

export type BankStepReporter = (id: BankStepId, status: BankStepStatus, detail?: string) => void;

/* ------------------------------------------------------------------ *
 * Persistence
 * ------------------------------------------------------------------ */

export interface PendingBankFlow {
  reference: string;
  kind: "deposit" | "withdraw";
  amount: string;
  startedAt: number;
  anchorTxId?: string;
  phase: "reserved" | "anchor_order" | "paid";
}

export interface BankFlowStorage {
  load(): Promise<PendingBankFlow[]>;
  save(flows: PendingBankFlow[]): Promise<void>;
}

/** In-memory storage for tests and the fallback when no browser storage exists. */
export function memoryBankFlowStorage(initial: PendingBankFlow[] = []): BankFlowStorage {
  let flows = [...initial];
  return {
    async load() {
      return [...flows];
    },
    async save(next) {
      flows = [...next];
    },
  };
}

/** `localStorage`-backed storage; a no-op in-memory fallback outside a browser. */
export function browserBankFlowStorage(key = "polaris.bank.flows"): BankFlowStorage {
  if (typeof localStorage === "undefined") return memoryBankFlowStorage();
  return {
    async load() {
      try {
        const raw = localStorage.getItem(key);
        const parsed = raw ? (JSON.parse(raw) as unknown) : [];
        return Array.isArray(parsed) ? (parsed as PendingBankFlow[]) : [];
      } catch {
        return [];
      }
    },
    async save(flows) {
      try {
        localStorage.setItem(key, JSON.stringify(flows));
      } catch {
        // A full/unavailable store must not break the money path.
      }
    },
  };
}

/* ------------------------------------------------------------------ *
 * Deps + results
 * ------------------------------------------------------------------ */

export interface BankFlowDeps {
  bank: BankApi;
  session: BankAnchorSession;
  storage?: BankFlowStorage;
  /** Trigger the anchor's sandbox bank transfer (test anchors have no real bank). */
  sandboxBank?: boolean;
  now?: () => number;
  /** Unique-enough reference generator; injected for deterministic tests. */
  id?: () => string;
  pollOptions?: { timeoutMs?: number; intervalMs?: number };
  /** Returns true when the user cancelled; checked before each money movement. */
  shouldCancel?: () => boolean;
}

export interface BankFlowResult {
  status: "completed" | "failed" | "cancelled";
  kind: "deposit" | "withdraw";
  amount: string;
  reference: string;
  anchorTxId?: string;
  txHash?: string;
  currency: string;
  detail: string;
  refunded?: boolean;
  credited?: boolean;
}

/** SEP-6 statuses that mean the order will never complete. */
const FAILED_STATUSES = new Set([
  "refunded",
  "expired",
  "no_market",
  "too_small",
  "too_large",
  "error",
]);

function messageOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split("\n")[0]?.trim() || "The anchor step failed.";
}

/** Best-effort anchor status text from a thrown poll error (which carries `last`). */
function anchorSaidOf(error: unknown): string | undefined {
  const last = (error as { last?: BankAnchorTransaction } | undefined)?.last;
  return last?.message;
}

async function withPending(
  storage: BankFlowStorage,
  flow: PendingBankFlow,
): Promise<void> {
  const flows = await storage.load();
  const next = flows.filter((item) => item.reference !== flow.reference);
  next.push(flow);
  await storage.save(next);
}

async function patchPending(
  storage: BankFlowStorage,
  reference: string,
  patch: Partial<PendingBankFlow>,
): Promise<void> {
  const flows = await storage.load();
  const next = flows.map((item) => (item.reference === reference ? { ...item, ...patch } : item));
  await storage.save(next);
}

async function dropPending(storage: BankFlowStorage, reference: string): Promise<void> {
  const flows = await storage.load();
  await storage.save(flows.filter((item) => item.reference !== reference));
}

/** Best-effort: keep the demo ledger's unit on the anchor's quoted fiat. */
async function syncCurrency(bank: BankApi, assetId: string): Promise<void> {
  const code = fiatCodeOf(assetId);
  if (!code || !bank.setCurrency) return;
  try {
    await bank.setCurrency(code);
  } catch {
    // A currency sync failure must never block the money path.
  }
}

function checkLimits(amount: string, order: { minAmount?: number; maxAmount?: number }): void {
  const value = Number(amount);
  if (!Number.isFinite(value)) throw new Error(`"${amount}" is not a valid amount`);
  if (order.minAmount !== undefined && value < order.minAmount) {
    throw new Error(`the anchor's minimum is ${order.minAmount}`);
  }
  if (order.maxAmount !== undefined && value > order.maxAmount) {
    throw new Error(`the anchor's maximum is ${order.maxAmount}`);
  }
}

/** The withdrawal payout, in the anchor's fiat, from a completed order. */
export function payoutOf(tx: BankAnchorTransaction, fallback: string): string | undefined {
  if (tx.amountOut && /^\d+(?:\.\d+)?$/.test(tx.amountOut) && Number(tx.amountOut) > 0) {
    return tx.amountOut;
  }
  return fallback;
}

/* ------------------------------------------------------------------ *
 * Deposit: bank → anchor → wallet
 * ------------------------------------------------------------------ */

export async function runBankDeposit(
  deps: BankFlowDeps,
  amountFiat: string,
  report?: BankStepReporter,
): Promise<BankFlowResult> {
  const storage = deps.storage ?? memoryBankFlowStorage();
  const now = deps.now ?? (() => Date.now());
  const id = deps.id ?? (() => `bank-dep-${now()}-${Math.random().toString(36).slice(2, 8)}`);
  const session = deps.session;
  const reference = id();
  const account = await deps.bank.account();
  const base: BankFlowResult = {
    status: "failed",
    kind: "deposit",
    amount: amountFiat,
    reference,
    currency: account.currency,
    detail: "",
  };

  report?.("quote", "active");
  let anchorTxId: string | undefined;
  try {
    // 1. Reserve the money first (the spec's order), then quote.
    const debit = await deps.bank.debit(amountFiat, reference);
    await withPending(storage, {
      reference,
      kind: "deposit",
      amount: amountFiat,
      startedAt: now(),
      phase: "reserved",
    });
    const currency = debit.currency;

    const quote = await session.quoteDeposit(amountFiat);
    await syncCurrency(deps.bank, quote.data.sellAsset);
    report?.("quote", "done", `${quote.data.sellAmount} → ${quote.data.buyAmount}`);

    if (deps.shouldCancel?.()) {
      await deps.bank.refund(reference);
      await dropPending(storage, reference);
      return { ...base, status: "cancelled", currency, detail: "Cancelled before the anchor order; the reservation was refunded.", refunded: true };
    }

    report?.("login", "active");
    await session.login();
    report?.("login", "done");

    report?.("trustline", "active");
    const pre = await session.prepareAccount();
    if (pre.data.actions.includes("trustline_created")) report?.("trustline", "done");
    else report?.("trustline", "done", "already trusted");

    report?.("kyc", "active");
    const order = await session.startDeposit(amountFiat);
    checkLimits(amountFiat, order.data);
    anchorTxId = order.data.id;
    await patchPending(storage, reference, { anchorTxId, phase: "anchor_order" });
    report?.("kyc", "done");

    if (deps.sandboxBank !== false) {
      report?.("bank_transfer", "active");
      await session.simulateBank(order.data.id, amountFiat);
      report?.("bank_transfer", "done");
    }

    report?.("waiting", "active");
    const poll = await session.waitForTransaction(order.data.id, {
      ...deps.pollOptions,
      onUpdate: (tx) => report?.("waiting", "active", tx.status),
    });
    if (poll.data.outcome !== "completed") {
      throw Object.assign(new Error(`the anchor ended the order as "${poll.data.tx.status}"`), { last: poll.data.tx });
    }
    await deps.bank.settle(reference);
    await dropPending(storage, reference);
    report?.("completed", "done");
    return { ...base, status: "completed", currency, anchorTxId, detail: "Deposit completed; the tokens are in your wallet.", refunded: false };
  } catch (error) {
    // Never leave money in flight silently: refund the reservation, once.
    let refunded = false;
    try {
      await deps.bank.refund(reference);
      refunded = true;
    } catch {
      // A settled/refunded reservation refuses a second refund; that is fine.
    }
    await dropPending(storage, reference);
    const said = anchorSaidOf(error);
    report?.(refunded ? "bank_transfer" : "quote", "error", messageOf(error));
    return {
      ...base,
      status: "failed",
      anchorTxId,
      detail: said ? `${messageOf(error)} — the anchor said: ${said}` : messageOf(error),
      refunded,
    };
  }
}

/* ------------------------------------------------------------------ *
 * Withdraw: wallet → anchor → bank
 * ------------------------------------------------------------------ */

export async function runBankWithdraw(
  deps: BankFlowDeps,
  amountAsset: string,
  report?: BankStepReporter,
): Promise<BankFlowResult> {
  const storage = deps.storage ?? memoryBankFlowStorage();
  const now = deps.now ?? (() => Date.now());
  const id = deps.id ?? (() => `bank-wd-${now()}-${Math.random().toString(36).slice(2, 8)}`);
  const session = deps.session;
  const reference = id();
  const account = await deps.bank.account();
  const base: BankFlowResult = {
    status: "failed",
    kind: "withdraw",
    amount: amountAsset,
    reference,
    currency: account.currency,
    detail: "",
  };

  report?.("quote", "active");
  let anchorTxId: string | undefined;
  let paid = false;
  try {
    await withPending(storage, {
      reference,
      kind: "withdraw",
      amount: amountAsset,
      startedAt: now(),
      phase: "reserved",
    });

    const quote = await session.quoteWithdraw(amountAsset);
    await syncCurrency(deps.bank, quote.data.buyAsset);
    report?.("quote", "done", `${quote.data.sellAmount} → ${quote.data.buyAmount}`);

    report?.("login", "active");
    await session.login();
    report?.("login", "done");

    report?.("trustline", "active");
    await session.prepareAccount();
    report?.("trustline", "done");

    report?.("kyc", "active");
    const order = await session.startWithdraw(amountAsset);
    checkLimits(amountAsset, order.data);
    anchorTxId = order.data.id;
    await patchPending(storage, reference, { anchorTxId, phase: "anchor_order" });
    report?.("kyc", "done");

    if (deps.shouldCancel?.()) {
      await dropPending(storage, reference);
      return { ...base, status: "cancelled", anchorTxId, detail: "Cancelled before anything left your wallet." };
    }

    // This is the value-moving step: Touch ID + wallet through the pipeline.
    report?.("bank_transfer", "active", "approve the on-chain payment");
    const payment = await session.payWithdrawal(amountAsset);
    paid = true;
    await patchPending(storage, reference, { phase: "paid" });
    report?.("bank_transfer", "done");

    report?.("waiting", "active");
    const poll = await session.waitForTransaction(order.data.id, {
      ...deps.pollOptions,
      onUpdate: (tx) => report?.("waiting", "active", tx.status),
    });
    if (poll.data.outcome !== "completed") {
      throw Object.assign(new Error(`the anchor ended the order as "${poll.data.tx.status}"`), { last: poll.data.tx });
    }
    const payout = payoutOf(poll.data.tx, quote.data.buyAmount);
    if (!payout) throw new Error("the anchor did not report a payout amount");
    const anchorId = poll.data.tx.stellarTransactionId ?? order.data.id;
    await deps.bank.credit(payout, reference, anchorId);
    await dropPending(storage, reference);
    report?.("completed", "done");
    return {
      ...base,
      status: "completed",
      anchorTxId,
      txHash: payment.data.hash,
      detail: `Withdrawal completed; ${payout} ${base.currency} was credited to your bank.`,
      credited: true,
    };
  } catch (error) {
    const said = anchorSaidOf(error);
    if (!paid) await dropPending(storage, reference);
    report?.(paid ? "waiting" : "bank_transfer", "error", messageOf(error));
    return {
      ...base,
      status: "failed",
      anchorTxId,
      detail: said ? `${messageOf(error)} — the anchor said: ${said}` : messageOf(error),
    };
  }
}

/* ------------------------------------------------------------------ *
 * Restart reconciliation
 * ------------------------------------------------------------------ */

/**
 * Reconciles in-flight flows after a restart. Each item is resolved exactly
 * once: a deposit reservation is settled or refunded, a withdrawal payout is
 * credited (idempotent by anchor tx id). Anything still in progress is kept for
 * the next start.
 */
export async function reconcileBankFlows(
  deps: BankFlowDeps,
  report?: BankStepReporter,
): Promise<BankFlowResult[]> {
  const storage = deps.storage ?? memoryBankFlowStorage();
  const pending = await storage.load();
  const results: BankFlowResult[] = [];
  for (const flow of pending) {
    try {
      if (flow.kind === "deposit") {
        if (!flow.anchorTxId) {
          await deps.bank.refund(flow.reference);
          await dropPending(storage, flow.reference);
          results.push({
            status: "failed",
            kind: "deposit",
            amount: flow.amount,
            reference: flow.reference,
            currency: "",
            detail: "The interrupted deposit never reached the anchor; the reservation was refunded.",
            refunded: true,
          });
          continue;
        }
        const { data } = await deps.session.transaction(flow.anchorTxId);
        if (data.status === "completed") {
          await deps.bank.settle(flow.reference);
          await dropPending(storage, flow.reference);
          results.push({ status: "completed", kind: "deposit", amount: flow.amount, reference: flow.reference, anchorTxId: flow.anchorTxId, currency: "", detail: "Recovered: the deposit completed while the app was closed." });
        } else if (FAILED_STATUSES.has(data.status)) {
          await deps.bank.refund(flow.reference);
          await dropPending(storage, flow.reference);
          results.push({ status: "failed", kind: "deposit", amount: flow.amount, reference: flow.reference, anchorTxId: flow.anchorTxId, currency: "", detail: `Recovered: the anchor ended the order as "${data.status}"; the reservation was refunded.`, refunded: true });
        }
        // Otherwise keep it pending for the next start.
      } else {
        if (!flow.anchorTxId) {
          await dropPending(storage, flow.reference);
          results.push({ status: "failed", kind: "withdraw", amount: flow.amount, reference: flow.reference, currency: "", detail: "The interrupted withdrawal never reached the anchor; nothing left your wallet." });
          continue;
        }
        const { data } = await deps.session.transaction(flow.anchorTxId);
        if (data.status === "completed") {
          const payout = payoutOf(data, "");
          if (!payout) continue; // keep pending: cannot credit an unknown amount
          await deps.bank.credit(payout, flow.reference, data.stellarTransactionId ?? flow.anchorTxId);
          await dropPending(storage, flow.reference);
          results.push({ status: "completed", kind: "withdraw", amount: flow.amount, reference: flow.reference, anchorTxId: flow.anchorTxId, currency: "", detail: `Recovered: the withdrawal paid out ${payout}; the bank was credited once.`, credited: true });
        } else if (FAILED_STATUSES.has(data.status)) {
          await dropPending(storage, flow.reference);
          results.push({ status: "failed", kind: "withdraw", amount: flow.amount, reference: flow.reference, anchorTxId: flow.anchorTxId, currency: "", detail: `Recovered: the anchor ended the order as "${data.status}".` });
        }
      }
    } catch (error) {
      // A transient read failure must not lose the pending item; retry next start.
      report?.("waiting", "error", messageOf(error));
    }
  }
  return results;
}
