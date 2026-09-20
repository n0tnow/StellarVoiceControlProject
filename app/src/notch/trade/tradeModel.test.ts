import assert from "node:assert/strict";
import { test } from "node:test";

import type { BankStepId, BankStepStatus } from "../../lib/bankFlow.ts";
import {
  freshBankSteps,
  phaseStatus,
  tradeBalanceLine,
  tradePhases,
  validateOfferInputs,
  validateTradeAmount,
  walletBalanceLabel,
} from "./tradeModel.ts";

function steps(overrides: Partial<Record<BankStepId, BankStepStatus>> = {}): Record<BankStepId, BankStepStatus> {
  return { ...freshBankSteps(), ...overrides };
}

test("a fresh run starts every engine step pending", () => {
  assert.deepEqual(new Set(Object.values(freshBankSteps())), new Set(["pending"]));
});

test("deposit phases fold the engine steps into three rows", () => {
  const phases = tradePhases("deposit");
  assert.deepEqual(
    phases.map((phase) => phase.title),
    ["Bank debited", "Anchor received", "Wallet credited"],
  );
});

test("withdraw phases reverse the ends", () => {
  const phases = tradePhases("withdraw");
  assert.deepEqual(
    phases.map((phase) => phase.title),
    ["Wallet debited", "Anchor received", "Bank credited"],
  );
});

test("a phase is done only once all its steps are done", () => {
  const phase = tradePhases("deposit")[0]!;
  assert.equal(phaseStatus(phase, steps({ quote: "done", login: "done", kyc: "active" })), "active");
  assert.equal(phaseStatus(phase, steps({ quote: "done", login: "done", kyc: "done" })), "done");
});

test("an error in any member step marks the whole phase failed", () => {
  const phase = tradePhases("withdraw")[1]!;
  assert.equal(phaseStatus(phase, steps({ waiting: "error" })), "error");
});

test("a phase with no reported step stays pending", () => {
  const phase = tradePhases("withdraw")[2]!;
  assert.equal(phaseStatus(phase, steps()), "pending");
});

test("validateTradeAmount accepts a positive decimal and honours the cap", () => {
  assert.deepEqual(validateTradeAmount("10"), { ok: true, amount: "10" });
  assert.deepEqual(validateTradeAmount(" 2.5 "), { ok: true, amount: "2.5" });
  assert.equal(validateTradeAmount("0").ok, false);
  assert.equal(validateTradeAmount("abc").ok, false);
  assert.equal(validateTradeAmount("101", 100).ok, false);
});

test("walletBalanceLabel formats the held balance, defaulting to zero", () => {
  const detail = {
    sequence: "0",
    subentryCount: 1,
    numSponsoring: 0,
    numSponsored: 0,
    balances: [
      { assetType: "native", code: "XLM", issuer: null, balance: "12.5000000", native: true, limit: null },
      { assetType: "credit_alphanum4", code: "SRT", issuer: "GABC", balance: "0.0000000", native: false, limit: "922337203685.4775807" },
    ],
  };
  assert.equal(walletBalanceLabel(detail, "XLM"), "12.5");
  assert.equal(walletBalanceLabel(detail, "SRT"), "0");
  assert.equal(walletBalanceLabel(detail, "USDC"), "0");
  assert.equal(walletBalanceLabel(null, "XLM"), "0");
});

test("tradeBalanceLine names both sides and marks the unknown one", () => {
  assert.equal(
    tradeBalanceLine({ bankBalance: "100,000.00", bankCurrency: "USD", walletBalance: "0", walletAsset: "SRT" }),
    "Bank 100,000.00 USD · Wallet 0 SRT",
  );
  assert.equal(
    tradeBalanceLine({ bankBalance: null, bankCurrency: null, walletBalance: null, walletAsset: "SRT" }),
    "Bank — · Wallet —",
  );
});

test("validateOfferInputs checks the token amount and TRY price", () => {
  assert.equal(validateOfferInputs("100", "3400").ok, true);
  assert.equal(validateOfferInputs("0", "3400").ok, false);
  assert.equal(validateOfferInputs("100", "0").ok, false);
  assert.equal(validateOfferInputs("100.12345678", "3400").ok, false);
});
