import assert from "node:assert/strict";
import { test } from "node:test";

import {
  contactsSynced,
  normalizeForm,
  ruleIntent,
  ruleSummary,
  rulesFormFromState,
  rulesView,
} from "./rulesModel.ts";
import type { SecurityState } from "@/lib/guardState";

const OWNER = "GARXWVNCJ22U2OR23LAB5Z5RWI2XFIJZA2R3TRPFUKKY65JQZZOEWWCO";
const EXECUTOR = "GB3HO3WGM273M2OZLE5DVRN5WNCNSART6H6SAHP4CXGK34MMGNNDYLX5";
const NATIVE_SAC = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

function state(overrides: Partial<SecurityState> = {}): SecurityState {
  const rule = {
    auto_approve_limit: 10_0000000n,
    per_tx_limit: 20_0000000n,
    daily_limit: 100_0000000n,
    allowed_assets: [NATIVE_SAC],
    known_recipients_only: true,
  };
  return {
    owner: OWNER,
    guardContractId: NATIVE_SAC,
    rpcUrl: "https://soroban-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    assetSymbol: "XLM",
    assetContractId: NATIVE_SAC,
    rule,
    executor: EXECUTOR,
    spentTodayRaw: 3_0000000n,
    allowanceRaw: 700_0000000n,
    aliases: [],
    ...overrides,
  };
}

test("rulesFormFromState maps an armed rule and a baseline", () => {
  assert.deepEqual(rulesFormFromState(state()), {
    mode: "auto_under_limit",
    threshold: "10",
    perTx: "20",
    daily: "100",
    knownRecipientsOnly: true,
  });
  const baseline = rulesFormFromState(state({ rule: null, executor: null }));
  assert.equal(baseline.mode, "always_ask");
});

test("ruleIntent builds the spoken rule payload", () => {
  const auto = ruleIntent(
    { mode: "auto_under_limit", threshold: "10", perTx: "20", daily: "100", knownRecipientsOnly: true },
    "XLM",
    "rules page",
  );
  assert.equal(auto.rule?.mode, "auto_under_limit");
  assert.equal(auto.rule?.autoApproveLimit, "10");
  assert.equal(auto.rule?.dailyLimit, "100");
  assert.equal(auto.amount, "10");

  const off = ruleIntent(
    { mode: "always_ask", threshold: "10", perTx: "20", daily: "100", knownRecipientsOnly: true },
    "XLM",
    "rules page",
  );
  assert.deepEqual(off.rule, { mode: "always_ask" });
});

test("normalizeForm turns a blank or zero threshold into always_ask", () => {
  const base = { mode: "auto_under_limit", threshold: "", perTx: "20", daily: "100", knownRecipientsOnly: true } as const;
  assert.equal(normalizeForm({ ...base, threshold: "" }).mode, "always_ask");
  assert.equal(normalizeForm({ ...base, threshold: "0" }).mode, "always_ask");
  assert.equal(normalizeForm({ ...base, threshold: "  " }).mode, "always_ask");
  assert.equal(normalizeForm({ ...base, threshold: "10" }).mode, "auto_under_limit");
});

test("ruleSummary speaks the live rule in plain language", () => {
  assert.equal(ruleSummary(state(), "XLM"), "Payments under 10 XLM are sent without asking. Everything else needs Touch ID.");
  assert.match(ruleSummary(state({ rule: null, executor: null }), "XLM"), /No spending rule yet/);
  assert.match(
    ruleSummary(state({ rule: { ...state().rule!, auto_approve_limit: 0n } }), "XLM"),
    /Every payment needs your Touch ID/,
  );
});

test("contactsSynced counts matching alias+address on-chain entries", () => {
  const withAlias = state({
    aliases: [{ alias: "ada", onChain: OWNER, status: "ok" }],
  });
  const result = contactsSynced(withAlias, [
    { alias: "ada", address: OWNER },
    { alias: "bob", address: EXECUTOR },
  ]);
  assert.deepEqual(result, { synced: 1, total: 2 });
});

test("rulesView labels the armed status and spent-today", () => {
  const lines = rulesView(state(), [], true);
  const value = (label: string) => lines.find((line) => line.label === label)?.value;
  assert.equal(value("Status"), "Auto under limit");
  assert.equal(value("Auto limit"), "10 XLM");
  assert.equal(value("Spent today"), "3 of 100 XLM");
  assert.match(value("Executor")!, /funded/);

  const off = rulesView(state({ rule: null, executor: null }), [], null);
  assert.equal(off.find((line) => line.label === "Status")?.value, "Always ask");
});
