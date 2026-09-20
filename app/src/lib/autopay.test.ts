import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildAutoPayPlan,
  batchViewFromPlan,
  decideAutoPayRoute,
  mapAutoPayError,
  type AutoPayContext,
  type AutoPayRouteState,
} from "./autopay.ts";

/** Public testnet keys / native SAC (never secrets). */
const EXECUTOR = "GB3HO3WGM273M2OZLE5DVRN5WNCNSART6H6SAHP4CXGK34MMGNNDYLX5";
const OWNER = "GARXWVNCJ22U2OR23LAB5Z5RWI2XFIJZA2R3TRPFUKKY65JQZZOEWWCO";
const NATIVE_SAC = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const RAW_1 = 1_0000000n;
const RAW_5 = 5_0000000n;
const RAW_10 = 10_0000000n;
const RAW_20 = 20_0000000n;
const RAW_100 = 100_0000000n;

function missingExecutor(): AutoPayContext {
  return { executor: { exists: false, address: null, funded: null }, defaultAsset: "XLM" };
}

test("auto plan: defaults, order and read-back (executor last = arming)", () => {
  const plan = buildAutoPayPlan(
    { mode: "auto_under_limit", asset: "XLM", autoApproveLimit: "10" },
    { ...missingExecutor(), contacts: [{ alias: "ali", address: OWNER }] },
  );
  assert.equal(plan.mode, "auto_under_limit");
  assert.deepEqual(
    plan.steps.map((step) => step.kind),
    ["executor_create", "fund_executor", "approve", "set_rule", "set_executor", "set_alias"],
  );
  assert.equal(plan.steps.at(-1)!.kind, "set_alias");
  const arming = plan.steps.filter((step) => step.arming);
  assert.deepEqual(arming.map((step) => step.kind), ["set_executor"]);
  // Defaults: per-tx = 2x, daily = 10x, known recipients on by default.
  assert.deepEqual(plan.limits, {
    threshold: "10",
    perTx: "20",
    daily: "100",
    asset: "XLM",
    knownRecipientsOnly: true,
  });
  assert.equal(
    plan.readBack,
    "Auto-approve up to 10 XLM per payment, 100 a day, saved contacts only. Approve on the card.",
  );
});

test("auto plan: an existing funded executor adds no create/fund step", () => {
  const plan = buildAutoPayPlan(
    { mode: "auto_under_limit", asset: "XLM", autoApproveLimit: "10", perTxLimit: "15", dailyLimit: "40" },
    { executor: { exists: true, address: EXECUTOR, funded: true }, defaultAsset: "XLM" },
  );
  assert.deepEqual(plan.steps.map((step) => step.kind), ["approve", "set_rule", "set_executor"]);
  assert.equal(plan.limits.perTx, "15");
  assert.equal(plan.limits.daily, "40");
});

test("auto plan: explicitly off known-recipients-only syncs no aliases", () => {
  const plan = buildAutoPayPlan(
    { mode: "auto_under_limit", asset: "XLM", autoApproveLimit: "10", knownRecipientsOnly: false },
    { ...missingExecutor(), contacts: [{ alias: "ali", address: OWNER }] },
  );
  assert.equal(plan.limits.knownRecipientsOnly, false);
  assert.equal(plan.steps.some((step) => step.kind === "set_alias"), false);
});

test("always-ask plan is the disable path, executor first", () => {
  const plan = buildAutoPayPlan(
    { mode: "always_ask" },
    { executor: { exists: true, address: EXECUTOR, funded: true }, defaultAsset: "XLM" },
  );
  assert.deepEqual(plan.steps.map((step) => step.kind), ["revoke_executor"]);
  assert.equal(plan.readBack, "Stop automatic payments. Every payment will need your approval.");
});

test("auto plan refuses a missing threshold", () => {
  assert.throws(
    () => buildAutoPayPlan({ mode: "auto_under_limit", asset: "XLM" }, missingExecutor()),
    /auto-approve limit/,
  );
});

function baseState(overrides: Partial<AutoPayRouteState> = {}): AutoPayRouteState {
  return {
    armed: true,
    assetContractId: NATIVE_SAC,
    allowedAssets: [NATIVE_SAC],
    autoApproveLimitRaw: RAW_10,
    perTxLimitRaw: RAW_20,
    dailyLimitRaw: RAW_100,
    spentTodayRaw: 0n,
    knownRecipientsOnly: true,
    ...overrides,
  };
}

const KNOWN = { assetContractId: NATIVE_SAC, recipientKnown: true };

test("routing: a small payment to a known contact is auto", () => {
  const decision = decideAutoPayRoute(baseState(), { ...KNOWN, amountRaw: RAW_5 });
  assert.equal(decision.route, "auto");
});

test("routing: every limit breach falls back to the owner path", () => {
  assert.equal(decideAutoPayRoute(baseState(), { ...KNOWN, amountRaw: 0n }).route, "owner");
  assert.equal(
    decideAutoPayRoute(baseState({ armed: false }), { ...KNOWN, amountRaw: RAW_1 }).route,
    "owner",
  );
  assert.equal(
    decideAutoPayRoute(baseState(), { ...KNOWN, assetContractId: OWNER, amountRaw: RAW_1 }).route,
    "owner",
  );
  // 15 XLM is above the 10 XLM auto limit but below the 20 XLM per-tx limit.
  assert.equal(
    decideAutoPayRoute(baseState(), { ...KNOWN, amountRaw: 15_0000000n }).route,
    "owner",
  );
  // 25 XLM is above the per-transaction limit.
  assert.equal(
    decideAutoPayRoute(baseState(), { ...KNOWN, amountRaw: 25_0000000n }).route,
    "owner",
  );
  assert.equal(
    decideAutoPayRoute(baseState(), { ...KNOWN, amountRaw: RAW_5, recipientKnown: false }).route,
    "owner",
  );
  assert.equal(
    decideAutoPayRoute(baseState({ spentTodayRaw: RAW_100 }), { ...KNOWN, amountRaw: RAW_1 }).route,
    "owner",
  );
});

test("routing: the daily cap counts what was already spent today", () => {
  const state = baseState({ spentTodayRaw: 95_0000000n });
  assert.equal(decideAutoPayRoute(state, { ...KNOWN, amountRaw: 6_0000000n }).route, "owner");
  assert.equal(decideAutoPayRoute(state, { ...KNOWN, amountRaw: RAW_5 }).route, "auto");
});

test("routing: the app hard cap can only narrow the chain mandate", () => {
  const decision = decideAutoPayRoute(baseState(), { ...KNOWN, amountRaw: RAW_5 }, RAW_1);
  assert.equal(decision.route, "owner");
});

test("error mapping names the code and the contract error name", () => {
  assert.match(mapAutoPayError({ code: 105 }), /auto-approve limit/);
  assert.match(mapAutoPayError({ name: "OverPerTxLimit" }), /per-payment limit/);
  assert.match(mapAutoPayError({ name: "NoExecutor" }), /Automatic payments are off/);
  assert.match(mapAutoPayError({ name: "InsufficientAllowance" }), /allowance/);
  assert.match(mapAutoPayError({ name: "SomethingElse" }), /needs your approval/);
});

test("batch view numbers the steps and calls out the arming step", () => {
  const plan = buildAutoPayPlan(
    { mode: "auto_under_limit", asset: "XLM", autoApproveLimit: "10" },
    missingExecutor(),
  );
  const view = batchViewFromPlan(plan);
  assert.equal(view.total, 5);
  assert.deepEqual(view.items.map((item) => item.index), [1, 2, 3, 4, 5]);
  assert.equal(view.items.find((item) => item.arming)?.title, "Register the agent key (arms auto-pay)");
  assert.equal(view.approveLabel, "Approve with Touch ID");
});
