import { scValToNative, xdr } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import {
  ASSET_SAC,
  EXECUTOR,
  GUARD_ID,
  OWNER,
  RULE,
  FakeGuardRpc,
  invokedCall,
  okSim,
} from "../../guard/__tests__/helpers.ts";
import type { Rule } from "../../guard/types.ts";
import {
  ARMING_STEP_NOTE,
  buildBaselineSetup,
  buildDisableAutoPay,
  buildEnableAutoPay,
  buildTightenRule,
  LEDGER_SECONDS,
  type ApprovalStepKind,
  type DisableAutoPayDeps,
  type EnableAutoPayDeps,
} from "../enableAutoPay.ts";
import type { ApprovalError, BaselineSetupInput } from "../types.ts";
import {
  BASELINE_ALLOWANCE,
  BASELINE_DAYS,
  BASELINE_RULE,
  DRAFT,
  FIXED_NOW,
  USDC_SAC,
  guardClient,
  rpcLike,
  TESTNET,
  writeRpc,
} from "./fixtures.ts";

function enableDeps(rpc: FakeGuardRpc, over: Partial<EnableAutoPayDeps> = {}): EnableAutoPayDeps {
  return {
    owner: OWNER,
    guard: guardClient(rpc),
    rpc: rpcLike(rpc),
    networkPassphrase: TESTNET,
    now: () => new Date(FIXED_NOW),
    timeZone: "UTC",
    ...over,
  };
}

function disableDeps(rpc: FakeGuardRpc, over: Partial<DisableAutoPayDeps> = {}): DisableAutoPayDeps {
  return {
    owner: OWNER,
    guard: guardClient(rpc),
    rpc: rpcLike(rpc),
    networkPassphrase: TESTNET,
    assetContractId: ASSET_SAC,
    ...over,
  };
}

/**
 * A tiny pure model of the on-chain state `pay_executor` depends on. Used to
 * prove that no prefix of the enable sequence can auto-pay.
 *
 * The contract's `pay_executor` has more gates than are modelled here. The
 * following are deliberately NOT modelled because they are constant and
 * satisfied across this whole sequence, so they cannot open a prefix window:
 *
 *   • a rule exists            — the Always-ask baseline publishes one first.
 *   • the asset is allowed     — the baseline and the draft list the same SAC.
 *   • `per_tx_limit` / `daily_limit` — both are >= `auto_approve_limit` by
 *                                validation, so `amount <= auto_approve_limit`
 *                                already implies them.
 *   • `known_recipients_only`  — an alias-book gate independent of the arming
 *                                steps; constant (and not a prefix variable).
 *
 * The varying gates that DO decide the prefix property are the three fields
 * below; modelling exactly those keeps the proof honest without pretending the
 * model is the contract.
 */
interface ChainState {
  executorRegistered: boolean;
  autoApproveLimit: bigint;
  allowance: bigint;
}

function canPayExecutor(state: ChainState, amount: bigint): boolean {
  return (
    state.executorRegistered &&
    state.autoApproveLimit > 0n &&
    amount > 0n &&
    amount <= state.autoApproveLimit &&
    amount <= state.allowance
  );
}

/** Apply one enable step to the state model, keyed by the step's kind. */
function applyStep(state: ChainState, kind: ApprovalStepKind): ChainState {
  switch (kind) {
    case "approve":
      return { ...state, allowance: DRAFT.allowanceRaw };
    case "set_rule":
      return { ...state, autoApproveLimit: DRAFT.thresholdRaw };
    case "set_executor":
      return { ...state, executorRegistered: true };
    default:
      return state;
  }
}

/** Raw `scvSymbol`-keyed map of a decoded struct ScVal. */
function symbolMap(scv: xdr.ScVal | undefined): Map<string, xdr.ScVal> {
  if (scv?.type !== "scvMap") throw new Error(`expected scvMap, got ${scv?.type}`);
  const out = new Map<string, xdr.ScVal>();
  for (const entry of scv.map ?? []) {
    if (entry.key.type !== "scvSymbol") throw new Error(`non-symbol key: ${entry.key.type}`);
    out.set(entry.key.sym.toString(), entry.val);
  }
  return out;
}

describe("buildEnableAutoPay — three steps, arming order (executor last)", () => {
  it("returns approve, set_rule, set_executor in the documented order", async () => {
    const rpc = writeRpc();
    const res = await buildEnableAutoPay(enableDeps(rpc), DRAFT);
    expect(res.order).toEqual(["approve", "set_rule", "set_executor"]);
    expect(res.steps.map((s) => s.kind)).toEqual(["approve", "set_rule", "set_executor"]);
    expect(res.summary.confirmation).toBe("card_and_touch_id");
    for (const step of res.steps) expect(step.payloadHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("step 1 decodes to SAC approve(from, spender=guard id, amount, live_until_ledger)", async () => {
    const res = await buildEnableAutoPay(enableDeps(writeRpc()), DRAFT);
    const call = invokedCall(res.steps[0].unsignedXdr);
    expect(call.name).toBe("approve");
    expect(call.contractId).toBe(ASSET_SAC);
    expect(call.tx.source).toBe(OWNER);
    expect(call.args.map((a) => scValToNative(a))).toEqual([OWNER, GUARD_ID, 7_000_000000n, 519_400]);
  });

  it("step 2 decodes to set_rule(owner, rule) with the draft limits", async () => {
    const res = await buildEnableAutoPay(enableDeps(writeRpc()), DRAFT);
    const call = invokedCall(res.steps[1].unsignedXdr);
    expect(call.name).toBe("set_rule");
    expect(call.tx.source).toBe(OWNER);
    expect(scValToNative(call.args[0]!)).toBe(OWNER);
    expect(scValToNative(call.args[1]!)).toEqual({
      auto_approve_limit: 250_000000n,
      per_tx_limit: 500_000000n,
      daily_limit: 1_000_000000n,
      allowed_assets: [ASSET_SAC],
      known_recipients_only: true,
    });
  });

  it("step 2 set_rule argument has the RAW contract types (scvI128/scvAddress/symbol keys)", async () => {
    // B1: a `scValToNative` round-trip cannot distinguish scvU64 from scvI128 or
    // scvString from scvAddress, so it was green against the known ABI bug. This
    // asserts the exact ScVal types the contract spec requires.
    const res = await buildEnableAutoPay(enableDeps(writeRpc()), DRAFT);
    const ruleArg = invokedCall(res.steps[1].unsignedXdr).args[1];
    const byKey = symbolMap(ruleArg);
    expect([...byKey.keys()].sort()).toEqual([
      "allowed_assets",
      "auto_approve_limit",
      "daily_limit",
      "known_recipients_only",
      "per_tx_limit",
    ]);
    for (const limit of ["auto_approve_limit", "per_tx_limit", "daily_limit"]) {
      expect(byKey.get(limit)?.type).toBe("scvI128");
    }
    const assets = byKey.get("allowed_assets");
    if (assets?.type !== "scvVec") throw new Error(`allowed_assets is ${assets?.type}, not scvVec`);
    expect((assets.vec ?? []).map((a) => a.type)).toEqual(["scvAddress"]);
    expect(byKey.get("known_recipients_only")?.type).toBe("scvBool");
  });

  it("step 3 decodes to set_executor(owner, executor) sourced by the owner", async () => {
    const res = await buildEnableAutoPay(enableDeps(writeRpc()), DRAFT);
    const call = invokedCall(res.steps[2].unsignedXdr);
    expect(call.name).toBe("set_executor");
    expect(call.contractId).toBe(GUARD_ID);
    expect(call.tx.source).toBe(OWNER);
    expect(call.args.map((a) => scValToNative(a))).toEqual([OWNER, EXECUTOR]);
  });

  it("computes live_until_ledger as current + days * 17280", async () => {
    const rpc = writeRpc();
    rpc.latestLedger = 5000;
    const draft = { ...DRAFT, allowanceDays: 7 };
    const res = await buildEnableAutoPay(enableDeps(rpc), draft);
    const args = invokedCall(res.steps[0].unsignedXdr).args.map((a) => scValToNative(a));
    expect(args[3]).toBe(5000 + 7 * 17_280);
  });

  it("summary actions are decoded from each XDR, not copied from the draft", async () => {
    const res = await buildEnableAutoPay(enableDeps(writeRpc()), DRAFT);
    expect(res.summary.actions.map((a) => a.kind)).toEqual(["approve", "set_rule", "set_executor"]);
    expect(res.summary.actions[0]?.lines.join(" ")).toContain("Function: approve");
    expect(res.summary.actions[1]?.lines.join(" ")).toContain("auto_approve_limit: 250000000");
    expect(res.summary.actions[2]?.lines.join(" ")).toContain("Function: set_executor");
  });

  it("calls out step 3 (set_executor) as the arming step, first note and flagged action", async () => {
    const res = await buildEnableAutoPay(enableDeps(writeRpc()), DRAFT);
    expect(res.summary.notes[0]).toBe(ARMING_STEP_NOTE);
    expect(res.summary.notes[0]).toContain("arms unattended payments");
    expect(res.summary.actions.filter((a) => a.arming === true).map((a) => a.kind)).toEqual([
      "set_executor",
    ]);
    expect(res.summary.actions.map((a) => a.arming)).toEqual([undefined, undefined, true]);
  });

  it("states that schedules need the allowance to cover their total", async () => {
    const res = await buildEnableAutoPay(enableDeps(writeRpc()), DRAFT);
    expect(res.summary.notes.join(" ")).toContain("Schedules need the allowance to cover their total");
  });

  it("decodes thresholdRaw/dailyLimitRaw back from the signed set_rule XDR", async () => {
    const res = await buildEnableAutoPay(enableDeps(writeRpc()), DRAFT);
    const decoded = scValToNative(invokedCall(res.steps[1].unsignedXdr).args[1]!) as {
      auto_approve_limit: bigint;
      daily_limit: bigint;
    };
    expect(res.summary.exposure?.thresholdRaw).toBe(decoded.auto_approve_limit);
    expect(res.summary.exposure?.dailyLimitRaw).toBe(decoded.daily_limit);
  });

  it("exposure reports the raw limits and the ledger-derived expiry", async () => {
    const res = await buildEnableAutoPay(enableDeps(writeRpc()), DRAFT);
    expect(res.summary.exposure).toEqual({
      thresholdRaw: 250_000000n,
      dailyLimitRaw: 1_000_000000n,
      allowanceRaw: 7_000_000000n,
      allowanceExpiresLocal: "2026-10-19 12:00",
      allowanceExpiresUtc: "2026-10-19T12:00:00.000Z",
    });
  });

  it("renders the local expiry in the requested time zone", async () => {
    const res = await buildEnableAutoPay(enableDeps(writeRpc(), { timeZone: "America/New_York" }), DRAFT);
    expect(res.summary.exposure?.allowanceExpiresLocal).toBe("2026-10-19 08:00");
    expect(LEDGER_SECONDS).toBe(5);
  });

  it("validates the draft before building anything", async () => {
    const rpc = new FakeGuardRpc();
    rpc.sims = [okSim(xdr.ScVal.scvVoid())];
    await expect(
      buildEnableAutoPay(enableDeps(rpc), { ...DRAFT, executor: "nope" }),
    ).rejects.toMatchObject({ name: "ApprovalError", code: "invalid_executor" });
    expect(rpc.simulated).toHaveLength(0);
  });

  it("no prefix of the sequence can let pay_executor succeed; only the full sequence does", async () => {
    const res = await buildEnableAutoPay(enableDeps(writeRpc()), DRAFT);
    // Start from the Always-ask baseline: no executor, threshold 0, but the
    // mandatory allowance already exists.
    let state: ChainState = { executorRegistered: false, autoApproveLimit: 0n, allowance: 700_000000n };

    for (let executed = 0; executed < res.steps.length; executed += 1) {
      expect(canPayExecutor(state, DRAFT.thresholdRaw)).toBe(false);
      state = applyStep(state, res.steps[executed]!.kind);
    }
    expect(state).toEqual({
      executorRegistered: true,
      autoApproveLimit: DRAFT.thresholdRaw,
      allowance: DRAFT.allowanceRaw,
    });
    expect(canPayExecutor(state, DRAFT.thresholdRaw)).toBe(true);
  });
});

describe("buildEnableAutoPay — allowance change visibility", () => {
  it("shows the old -> new allowance and warns when it shrinks", async () => {
    const res = await buildEnableAutoPay(
      enableDeps(writeRpc(), { currentAllowanceRaw: 900_0000000n }),
      DRAFT,
    );
    expect(res.summary.notes).toContain("Allowance: 900 -> 700");
    expect(res.summary.notes.join(" ")).toContain("WARNING");
    expect(res.summary.notes.join(" ")).toContain("may break scheduled payments");
  });

  it("shows the old -> new allowance without a warning when it grows", async () => {
    const res = await buildEnableAutoPay(
      enableDeps(writeRpc(), { currentAllowanceRaw: 500_0000000n }),
      DRAFT,
    );
    expect(res.summary.notes).toContain("Allowance: 500 -> 700");
    expect(res.summary.notes.join(" ")).not.toContain("WARNING");
  });

  it("omits the allowance delta when the current allowance is unknown", async () => {
    const res = await buildEnableAutoPay(enableDeps(writeRpc()), DRAFT);
    expect(res.summary.notes.join(" ")).not.toContain("Allowance:");
  });
});

describe("buildEnableAutoPay — already-armed refusal (NB1)", () => {
  it("refuses an armed account with a typed already_armed and builds nothing", async () => {
    const rpc = writeRpc();
    await expect(
      buildEnableAutoPay(enableDeps(rpc, { current: { rule: RULE, executor: EXECUTOR } }), DRAFT),
    ).rejects.toMatchObject({ name: "ApprovalError", code: "already_armed" });
    expect(rpc.simulated).toHaveLength(0);
  });

  it("points the refusal message at the tighten and disable flows", async () => {
    const err = (await buildEnableAutoPay(
      enableDeps(writeRpc(), { current: { rule: RULE, executor: EXECUTOR } }),
      DRAFT,
    ).catch((e) => e)) as ApprovalError;
    expect(err.message).toContain("tighten");
    expect(err.message).toContain("disable");
  });

  it("allows an executor with auto_approve_limit == 0 (partially armed)", async () => {
    const res = await buildEnableAutoPay(
      enableDeps(writeRpc(), {
        current: { rule: { ...RULE, auto_approve_limit: 0n }, executor: EXECUTOR },
      }),
      DRAFT,
    );
    expect(res.order).toEqual(["approve", "set_rule", "set_executor"]);
  });

  it("allows a positive limit with no executor (partially armed)", async () => {
    const res = await buildEnableAutoPay(enableDeps(writeRpc(), { current: { rule: RULE } }), DRAFT);
    expect(res.order).toEqual(["approve", "set_rule", "set_executor"]);
  });

  it("is unchanged when current is omitted (caller guarantees a not-armed baseline)", async () => {
    const res = await buildEnableAutoPay(enableDeps(writeRpc()), DRAFT);
    expect(res.steps.map((s) => s.kind)).toEqual(["approve", "set_rule", "set_executor"]);
  });
});

describe("buildBaselineSetup — Always-ask baseline (allowance + rule, no executor)", () => {
  const input = (over: Partial<BaselineSetupInput> = {}): BaselineSetupInput => ({
    rule: BASELINE_RULE,
    allowanceRaw: BASELINE_ALLOWANCE,
    allowanceDays: BASELINE_DAYS,
    assetContractId: USDC_SAC,
    ...over,
  });
  const ruleWith = (over: Partial<Rule>): Rule => ({ ...BASELINE_RULE, ...over });

  async function expectCode(over: Partial<BaselineSetupInput>, code: string): Promise<void> {
    await expect(buildBaselineSetup(enableDeps(new FakeGuardRpc()), input(over))).rejects.toMatchObject({
      name: "ApprovalError",
      code,
    });
  }

  it("returns exactly [approve, set_rule] with card_and_touch_id and no executor step", async () => {
    const res = await buildBaselineSetup(enableDeps(writeRpc()), input());
    expect(res.order).toEqual(["approve", "set_rule"]);
    expect(res.steps.map((s) => s.kind)).toEqual(["approve", "set_rule"]);
    expect(res.steps.map((s) => s.kind)).not.toContain("set_executor");
    expect(res.summary.confirmation).toBe("card_and_touch_id");
    expect(res.summary.notes).toContain("Always ask: every payment will need your approval.");
  });

  it("decodes step 1 as approve on the real USDC SAC for the full allowance", async () => {
    const res = await buildBaselineSetup(enableDeps(writeRpc()), input());
    const call = invokedCall(res.steps[0]!.unsignedXdr);
    expect(call.name).toBe("approve");
    expect(call.contractId).toBe(USDC_SAC);
    expect(call.tx.source).toBe(OWNER);
    expect(call.args.map((a) => scValToNative(a))).toEqual([
      OWNER,
      GUARD_ID,
      BASELINE_ALLOWANCE,
      519_400,
    ]);
  });

  it("decodes step 2 as set_rule(owner, rule) with raw contract types", async () => {
    const res = await buildBaselineSetup(enableDeps(writeRpc()), input());
    const call = invokedCall(res.steps[1]!.unsignedXdr);
    expect(call.name).toBe("set_rule");
    expect(call.tx.source).toBe(OWNER);
    expect(scValToNative(call.args[1]!)).toEqual(BASELINE_RULE);
    const byKey = symbolMap(call.args[1]);
    expect(byKey.get("auto_approve_limit")?.type).toBe("scvI128");
    const assets = byKey.get("allowed_assets");
    if (assets?.type !== "scvVec") throw new Error(`allowed_assets is ${assets?.type}, not scvVec`);
    expect((assets.vec ?? []).map((a) => a.type)).toEqual(["scvAddress"]);
  });

  it("reports the baseline exposure from the XDRs", async () => {
    const res = await buildBaselineSetup(enableDeps(writeRpc()), input());
    expect(res.summary.exposure).toEqual({
      thresholdRaw: 0n,
      dailyLimitRaw: 1_000_000000n,
      allowanceRaw: BASELINE_ALLOWANCE,
      allowanceExpiresLocal: "2026-10-19 12:00",
      allowanceExpiresUtc: "2026-10-19T12:00:00.000Z",
    });
  });

  it("decodes the exposure limits back from the signed set_rule XDR", async () => {
    const res = await buildBaselineSetup(enableDeps(writeRpc()), input());
    const decoded = scValToNative(invokedCall(res.steps[1]!.unsignedXdr).args[1]!) as {
      auto_approve_limit: bigint;
      daily_limit: bigint;
    };
    expect(res.summary.exposure?.thresholdRaw).toBe(decoded.auto_approve_limit);
    expect(res.summary.exposure?.dailyLimitRaw).toBe(decoded.daily_limit);
  });

  it("has no arming action or arming note (the baseline registers no executor)", async () => {
    const res = await buildBaselineSetup(enableDeps(writeRpc()), input());
    expect(res.summary.actions.every((a) => a.arming !== true)).toBe(true);
    expect(res.summary.notes.join(" ")).not.toContain("arms unattended payments");
  });

  it("accepts auto_approve_limit == 0 (the Always-ask value)", async () => {
    await expect(
      buildBaselineSetup(enableDeps(writeRpc()), input({ rule: ruleWith({ auto_approve_limit: 0n }) })),
    ).resolves.toBeDefined();
  });

  it("shows the old -> new allowance delta and the shrink warning", async () => {
    const res = await buildBaselineSetup(
      enableDeps(writeRpc(), { currentAllowanceRaw: 900_0000000n }),
      input(),
    );
    expect(res.summary.notes).toContain("Allowance: 900 -> 700");
    expect(res.summary.notes.join(" ")).toContain("WARNING");
  });

  it("does not warn when the allowance grows", async () => {
    const res = await buildBaselineSetup(
      enableDeps(writeRpc(), { currentAllowanceRaw: 500_0000000n }),
      input(),
    );
    expect(res.summary.notes).toContain("Allowance: 500 -> 700");
    expect(res.summary.notes.join(" ")).not.toContain("WARNING");
  });

  it("rejects every invalid rule/allowance field with a typed code", async () => {
    await expectCode({ rule: ruleWith({ per_tx_limit: 0n, auto_approve_limit: 0n }) }, "non_positive_limit");
    await expectCode({ rule: ruleWith({ daily_limit: 0n }) }, "non_positive_limit");
    await expectCode({ rule: ruleWith({ auto_approve_limit: -1n }) }, "threshold_negative");
    await expectCode({ rule: ruleWith({ auto_approve_limit: 600_000000n }) }, "limit_order");
    await expectCode({ rule: ruleWith({ per_tx_limit: 2_000_000000n }) }, "limit_order");
    await expectCode({ rule: ruleWith({ allowed_assets: [USDC_SAC, USDC_SAC] }) }, "too_many_assets");
    await expectCode({ rule: ruleWith({ allowed_assets: [] }) }, "no_assets");
    await expectCode({ rule: ruleWith({ allowed_assets: ["not-a-contract-id"] }) }, "invalid_asset");
    await expectCode({ allowanceRaw: 0n }, "non_positive_limit");
    await expectCode({ allowanceRaw: 50_000000n }, "allowance_too_small");
    await expectCode({ allowanceDays: 0 }, "invalid_allowance_days");
    await expectCode({ allowanceDays: 91 }, "invalid_allowance_days");
    await expectCode({ allowanceDays: 1.5 }, "invalid_allowance_days");
    await expectCode({ assetContractId: "not-a-contract-id" }, "invalid_asset");
    // NB4: a valid C... that is not rule.allowed_assets[0] must be refused.
    await expectCode({ assetContractId: ASSET_SAC }, "invalid_asset");
  });

  it("'Always ask' state model: no executor means no auto-pay, even with a live allowance", async () => {
    const res = await buildBaselineSetup(enableDeps(writeRpc()), input());
    const state: ChainState = {
      executorRegistered: res.steps.some((s) => s.kind === "set_executor"),
      autoApproveLimit: BASELINE_RULE.auto_approve_limit,
      allowance: BASELINE_ALLOWANCE,
    };
    expect(state.executorRegistered).toBe(false);
    expect(canPayExecutor(state, 1n)).toBe(false);
  });

  it("validates before building anything", async () => {
    const rpc = new FakeGuardRpc();
    await expect(
      buildBaselineSetup(enableDeps(rpc), input({ rule: ruleWith({ allowed_assets: ["nope"] }) })),
    ).rejects.toMatchObject({ name: "ApprovalError", code: "invalid_asset" });
    expect(rpc.simulated).toHaveLength(0);
  });
});

describe("buildDisableAutoPay — revoke executor, optional allowance revoke", () => {
  it("without allowance revoke returns a single revoke_executor step", async () => {
    const res = await buildDisableAutoPay(disableDeps(writeRpc()), { revokeAllowance: false });
    expect(res.steps.map((s) => s.kind)).toEqual(["revoke_executor"]);
    expect(res.order).toEqual(["revoke_executor"]);
    expect(res.confirmation).toBe("light");
    expect(res.summary.confirmation).toBe("light");
    const call = invokedCall(res.steps[0]!.unsignedXdr);
    expect(call.name).toBe("revoke_executor");
    expect(call.args.map((a) => scValToNative(a))).toEqual([OWNER]);
  });

  it("with allowance revoke adds an approve(0) step after the revoke", async () => {
    const res = await buildDisableAutoPay(disableDeps(writeRpc()), { revokeAllowance: true });
    expect(res.steps.map((s) => s.kind)).toEqual(["revoke_executor", "approve"]);
    expect(res.order).toEqual(["revoke_executor", "approve"]);
    const call = invokedCall(res.steps[1]!.unsignedXdr);
    expect(call.name).toBe("approve");
    expect(call.contractId).toBe(ASSET_SAC);
    expect(call.tx.source).toBe(OWNER);
    expect(call.args.map((a) => scValToNative(a))).toEqual([OWNER, GUARD_ID, 0n, 519_400]);
  });

  it("uses the configured allowance window for the revoke live_until", async () => {
    const rpc = writeRpc();
    rpc.latestLedger = 2000;
    const res = await buildDisableAutoPay(disableDeps(rpc, { days: 7 }), { revokeAllowance: true });
    const args = invokedCall(res.steps[1]!.unsignedXdr).args.map((a) => scValToNative(a));
    expect(args[3]).toBe(2000 + 7 * 17_280);
  });

  it("states the two disable caveats, the kill-switch one only when revoking", async () => {
    const revoking = await buildDisableAutoPay(disableDeps(writeRpc()), { revokeAllowance: true });
    const revokingNotes = revoking.summary.notes.join(" ");
    expect(revokingNotes).toContain("Revoking the executor does not stop schedules that already exist");
    expect(revokingNotes).toContain("Revoking the allowance disables ALL guard payments");

    const executorOnly = await buildDisableAutoPay(disableDeps(writeRpc()), { revokeAllowance: false });
    const executorNotes = executorOnly.summary.notes.join(" ");
    expect(executorNotes).toContain("Revoking the executor does not stop schedules that already exist");
    expect(executorNotes).not.toContain("disables ALL guard payments");
  });

  it("refuses to revoke the allowance without an asset contract id", async () => {
    const deps = disableDeps(writeRpc(), { assetContractId: undefined });
    await expect(buildDisableAutoPay(deps, { revokeAllowance: true })).rejects.toMatchObject({
      code: "missing_asset",
    });
  });
});

describe("buildTightenRule — classification-driven confirmation", () => {
  it("returns a single set_rule step with a light confirmation on tightening", async () => {
    const rpc = writeRpc();
    const next = { ...RULE, daily_limit: RULE.daily_limit - 1n };
    const res = await buildTightenRule({ owner: OWNER, guard: guardClient(rpc), current: RULE }, next);
    expect(res.classification).toBe("tightening");
    expect(res.confirmation).toBe("light");
    expect(res.steps.map((s) => s.kind)).toEqual(["set_rule"]);
    const call = invokedCall(res.steps[0]!.unsignedXdr);
    expect(call.name).toBe("set_rule");
    expect(scValToNative(call.args[1]!)).toEqual(next);
  });

  it("builds nothing and returns confirmation none for an identical rule", async () => {
    const rpc = writeRpc();
    const res = await buildTightenRule({ owner: OWNER, guard: guardClient(rpc), current: RULE }, { ...RULE });
    expect(res).toEqual({ steps: [], classification: "same", confirmation: "none" });
    expect(rpc.simulated).toHaveLength(0);
  });

  it("refuses a loosening by default with use_enable_flow and builds nothing", async () => {
    const rpc = writeRpc();
    const next = { ...RULE, auto_approve_limit: RULE.auto_approve_limit + 1n };
    await expect(
      buildTightenRule({ owner: OWNER, guard: guardClient(rpc), current: RULE }, next),
    ).rejects.toMatchObject({ name: "ApprovalError", code: "use_enable_flow" });
    expect(rpc.simulated).toHaveLength(0);
  });

  it("refuses a missing current rule (new_rule) by default", async () => {
    await expect(
      buildTightenRule({ owner: OWNER, guard: guardClient(writeRpc()) }, RULE),
    ).rejects.toMatchObject({ name: "ApprovalError", code: "use_enable_flow" });
  });

  it("builds a loosening only with the explicit opt-out, still card_and_touch_id", async () => {
    const rpc = writeRpc();
    const next = { ...RULE, auto_approve_limit: RULE.auto_approve_limit + 1n };
    const res = await buildTightenRule(
      { owner: OWNER, guard: guardClient(rpc), current: RULE },
      next,
      { allowLoosening: true },
    );
    expect(res.classification).toBe("loosening");
    expect(res.confirmation).toBe("card_and_touch_id");
    expect(invokedCall(res.steps[0]!.unsignedXdr).name).toBe("set_rule");
  });

  it("builds a new_rule only with the explicit opt-out, still card_and_touch_id", async () => {
    const res = await buildTightenRule(
      { owner: OWNER, guard: guardClient(writeRpc()) },
      RULE,
      { allowLoosening: true },
    );
    expect(res.classification).toBe("new_rule");
    expect(res.confirmation).toBe("card_and_touch_id");
  });
});

describe("approval builder error surface", () => {
  it("exposes a typed ApprovalError", async () => {
    try {
      await buildEnableAutoPay(enableDeps(writeRpc()), { ...DRAFT, allowanceRaw: 0n });
      throw new Error("expected a throw");
    } catch (e) {
      const err = e as ApprovalError;
      expect(err.name).toBe("ApprovalError");
      expect(err.code).toBe("non_positive_limit");
    }
  });

  it("surfaces a guard simulation failure from the first write (now approve)", async () => {
    const rpc = new FakeGuardRpc();
    rpc.sims = [{ _parsed: true, id: "1", latestLedger: 100, events: [], error: "HostError: Error(Contract, #102)" }];
    await expect(buildEnableAutoPay(enableDeps(rpc), DRAFT)).rejects.toMatchObject({
      name: "InvalidRule",
      code: 102,
    });
  });
});
