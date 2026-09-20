import assert from "node:assert/strict";
import { test } from "node:test";

import {
  fiatCodeOf,
  memoryBankFlowStorage,
  payoutOf,
  reconcileBankFlows,
  runBankDeposit,
  runBankWithdraw,
  type BankAccount,
  type BankAnchorSession,
  type BankPollResult,
  type BankTransaction,
  type PendingBankFlow,
} from "./bankFlow.ts";

function minor(amount: string): number {
  return Math.round(Number(amount) * 100);
}
function format(value: number): string {
  return (value / 100).toFixed(2);
}

/** A fake demo bank that enforces balance and idempotent-credit rules. */
function fakeBank(initial = 100_000_00) {
  let balance = initial;
  const txs: BankTransaction[] = [];
  const currencies: string[] = [];
  let seq = 1;
  const account = (): BankAccount => ({
    holderName: "Demo",
    iban: "TR330006100519786457841326",
    currency: "TRY",
    balanceTry: format(balance),
    updatedAt: 0,
  });
  return {
    txs,
    currencies,
    get balance() {
      return format(balance);
    },
    async setCurrency(currency: string) {
      currencies.push(currency);
      return account();
    },
    async account() {
      return account();
    },
    async history(limit: number) {
      return [...txs].reverse().slice(0, limit);
    },
    async debit(amountTry: string, reference: string) {
      const amount = minor(amountTry);
      if (balance < amount) throw new Error("the demo bank has insufficient balance");
      balance -= amount;
      const tx: BankTransaction = { id: `bank-${seq++}`, type: "deposit_to_anchor", amountTry: format(amount), currency: "TRY", status: "pending", reference, ts: 0 };
      txs.push(tx);
      return tx;
    },
    async credit(amountTry: string, reference: string, anchorTxId?: string) {
      if (anchorTxId) {
        const existing = txs.find((tx) => tx.anchorTxId === anchorTxId);
        if (existing) return existing;
      }
      balance += minor(amountTry);
      const tx: BankTransaction = { id: `bank-${seq++}`, type: "withdrawal_payout", amountTry: format(minor(amountTry)), currency: "TRY", status: "completed", anchorTxId, reference, ts: 0 };
      txs.push(tx);
      return tx;
    },
    async settle(reference: string) {
      const tx = txs.find((item) => item.reference === reference && item.type === "deposit_to_anchor");
      if (!tx) throw new Error("no reservation");
      tx.status = "completed";
      return tx;
    },
    async refund(reference: string) {
      const refunded = txs.find((item) => item.reference === `refund:${reference}`);
      if (refunded) return refunded;
      const tx = txs.find((item) => item.reference === reference && item.type === "deposit_to_anchor");
      if (!tx) throw new Error("no reservation");
      if (tx.status !== "pending") throw new Error("only a pending reservation can be refunded");
      tx.status = "refunded";
      balance += minor(tx.amountTry);
      const topup: BankTransaction = { id: `bank-${seq++}`, type: "topup", amountTry: format(minor(tx.amountTry)), currency: "TRY", status: "completed", reference: `refund:${reference}`, ts: 0 };
      txs.push(topup);
      return topup;
    },
  };
}

function fakeSession(opts: {
  poll: BankPollResult;
  pollError?: unknown;
  trustline?: boolean;
  onPay?: () => void;
}): BankAnchorSession {
  return {
    homeDomain: "testanchor.stellar.org",
    async quoteDeposit(amount) {
      return { data: { sellAmount: amount, buyAmount: amount, sellAsset: "iso4217:TRY", buyAsset: "stellar:USDC:G" } };
    },
    async quoteWithdraw(amount) {
      return { data: { sellAmount: amount, buyAmount: "20", sellAsset: "stellar:USDC:G", buyAsset: "iso4217:TRY" } };
    },
    async login() {
      return {};
    },
    async prepareAccount() {
      return { data: { actions: opts.trustline ? ["trustline_created"] : [] } };
    },
    async startDeposit() {
      return { data: { id: "order-dep-1", minAmount: 1, maxAmount: 1000 } };
    },
    async startWithdraw() {
      return { data: { id: "order-wd-1", minAmount: 1, maxAmount: 1000 } };
    },
    async payWithdrawal() {
      opts.onPay?.();
      return { data: { hash: "abc123", explorerUrl: "https://example/tx/abc123" } };
    },
    async simulateBank() {
      return {};
    },
    async waitForTransaction() {
      if (opts.pollError) throw opts.pollError;
      return { data: opts.poll };
    },
    async transaction() {
      return { data: opts.poll.tx };
    },
  };
}

test("deposit reserves, completes and settles without refunding", async () => {
  const bank = fakeBank();
  const storage = memoryBankFlowStorage();
  const steps: string[] = [];
  const result = await runBankDeposit(
    { bank, session: fakeSession({ poll: { outcome: "completed", tx: { status: "completed" } } }), storage, sandboxBank: true },
    "500",
    (id, status) => steps.push(`${id}:${status}`),
  );
  assert.equal(result.status, "completed");
  assert.equal(bank.balance, "99500.00");
  assert.equal((await storage.load()).length, 0);
  assert.ok(steps.includes("completed:done"));
  assert.equal(bank.txs[0]?.status, "completed");
});

test("a stalled deposit refunds the reservation and surfaces the anchor message", async () => {
  const bank = fakeBank();
  const storage = memoryBankFlowStorage();
  const pollError = Object.assign(new Error("order order-dep-1 is still \"pending_anchor\" after 30s"), {
    last: { status: "pending_anchor", message: "we are still processing your deposit" },
  });
  const result = await runBankDeposit(
    { bank, session: fakeSession({ poll: { outcome: "stopped", tx: { status: "pending_anchor" } }, pollError }), storage },
    "500",
  );
  assert.equal(result.status, "failed");
  assert.equal(result.refunded, true);
  assert.match(result.detail, /still processing/);
  assert.equal(bank.balance, "100000.00");
  assert.equal((await storage.load()).length, 0);
});

test("an insufficient balance fails before any anchor call", async () => {
  const bank = fakeBank(100_00);
  const storage = memoryBankFlowStorage();
  const result = await runBankDeposit(
    { bank, session: fakeSession({ poll: { outcome: "completed", tx: { status: "completed" } } }), storage },
    "500",
  );
  assert.equal(result.status, "failed");
  assert.equal(result.refunded, false);
  assert.equal(bank.balance, "100.00");
  assert.equal((await storage.load()).length, 0);
});

test("withdraw pays on-chain, credits the payout once and clears the pending flow", async () => {
  const bank = fakeBank();
  const storage = memoryBankFlowStorage();
  let payments = 0;
  const result = await runBankWithdraw(
    {
      bank,
      session: fakeSession({
        poll: { outcome: "completed", tx: { status: "completed", amountOut: "20", stellarTransactionId: "deadbeef" } },
        onPay: () => {
          payments++;
        },
      }),
      storage,
    },
    "20",
  );
  assert.equal(result.status, "completed");
  assert.equal(result.credited, true);
  assert.equal(payments, 1);
  assert.equal(bank.balance, "100020.00");
  assert.equal((await storage.load()).length, 0);
  assert.equal(bank.txs.length, 1);
});

test("duplicate payout credits are applied once", async () => {
  const bank = fakeBank();
  await bank.credit("25", "wd-1", "anchor-hash");
  await bank.credit("25", "wd-1", "anchor-hash");
  assert.equal(bank.balance, "100025.00");
  assert.equal(bank.txs.length, 1);
});

test("restart reconciliation refunds a lost deposit reservation", async () => {
  const bank = fakeBank();
  bank.debit("300", "dep-lost");
  const pending: PendingBankFlow = { reference: "dep-lost", kind: "deposit", amount: "300", startedAt: 0, phase: "reserved" };
  const storage = memoryBankFlowStorage([pending]);
  const results = await reconcileBankFlows({
    bank,
    session: fakeSession({ poll: { outcome: "completed", tx: { status: "completed" } } }),
    storage,
  });
  assert.equal(results.length, 1);
  assert.equal(results[0]?.refunded, true);
  assert.equal(bank.balance, "100000.00");
  assert.equal((await storage.load()).length, 0);
});

test("restart reconciliation settles a completed deposit and credits a completed withdrawal once", async () => {
  const bank = fakeBank();
  bank.debit("500", "dep-done");
  const deposit: PendingBankFlow = { reference: "dep-done", kind: "deposit", amount: "500", startedAt: 0, anchorTxId: "order-dep-1", phase: "anchor_order" };
  const withdrawal: PendingBankFlow = { reference: "wd-done", kind: "withdraw", amount: "10", startedAt: 0, anchorTxId: "order-wd-1", phase: "paid" };
  const storage = memoryBankFlowStorage([deposit, withdrawal]);
  const session = fakeSession({ poll: { outcome: "completed", tx: { status: "completed", amountOut: "10", stellarTransactionId: "feedface" } } });

  const first = await reconcileBankFlows({ bank, session, storage });
  assert.equal(first.length, 2);
  // Deposit money stays out (settled: 100000 - 500), withdrawal payout +10.
  assert.equal(bank.balance, "99510.00");
  assert.equal((await storage.load()).length, 0);

  // Running again changes nothing (the pending list is empty).
  const second = await reconcileBankFlows({ bank, session, storage });
  assert.equal(second.length, 0);
  assert.equal(bank.balance, "99510.00");
});

test("payoutOf prefers the anchor's reported amount and falls back", () => {
  assert.equal(payoutOf({ status: "completed", amountOut: "12.5" }, "9"), "12.5");
  assert.equal(payoutOf({ status: "completed" }, "9"), "9");
  assert.equal(payoutOf({ status: "completed", amountOut: "0" }, "9"), "9");
});

test("fiatCodeOf reads only a SEP-38 fiat asset id", () => {
  assert.equal(fiatCodeOf("iso4217:USD"), "USD");
  assert.equal(fiatCodeOf("iso4217:TRY"), "TRY");
  assert.equal(fiatCodeOf("stellar:USDC:GABC"), undefined);
  assert.equal(fiatCodeOf("iso4217:usd"), undefined);
});

test("the deposit syncs the ledger currency to the anchor's quoted fiat", async () => {
  const bank = fakeBank();
  // quoteDeposit in the fake reports `iso4217:TRY`; assert the sync fired.
  await runBankDeposit(
    { bank, session: fakeSession({ poll: { outcome: "completed", tx: { status: "completed" } } }), storage: memoryBankFlowStorage() },
    "500",
  );
  assert.deepEqual(bank.currencies, ["TRY"]);
});
