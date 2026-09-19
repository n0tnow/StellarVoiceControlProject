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
import {
  buildDisableAutoPay,
  buildEnableAutoPay,
  buildTightenRule,
  LEDGER_SECONDS,
  type DisableAutoPayDeps,
  type EnableAutoPayDeps,
} from "../enableAutoPay.ts";
import type { ApprovalError } from "../types.ts";
import { DRAFT, FIXED_NOW, guardClient, rpcLike, TESTNET, writeRpc } from "./fixtures.ts";

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

describe("buildEnableAutoPay — three steps, safe order", () => {
  it("returns set_executor, set_rule, approve in the documented order", async () => {
    const rpc = writeRpc();
    const res = await buildEnableAutoPay(enableDeps(rpc), DRAFT);
    expect(res.order).toEqual(["set_executor", "set_rule", "approve"]);
    expect(res.steps.map((s) => s.kind)).toEqual(["set_executor", "set_rule", "approve"]);
    expect(res.summary.confirmation).toBe("card_and_touch_id");
    for (const step of res.steps) expect(step.payloadHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("step 1 decodes to set_executor(owner, executor) sourced by the owner", async () => {
    const res = await buildEnableAutoPay(enableDeps(writeRpc()), DRAFT);
    const call = invokedCall(res.steps[0].unsignedXdr);
    expect(call.name).toBe("set_executor");
    expect(call.contractId).toBe(GUARD_ID);
    expect(call.tx.source).toBe(OWNER);
    expect(call.args.map((a) => scValToNative(a))).toEqual([OWNER, EXECUTOR]);
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

  it("step 3 decodes to SAC approve(from, spender=guard id, amount, live_until_ledger)", async () => {
    const res = await buildEnableAutoPay(enableDeps(writeRpc()), DRAFT);
    const call = invokedCall(res.steps[2].unsignedXdr);
    expect(call.name).toBe("approve");
    expect(call.contractId).toBe(ASSET_SAC);
    expect(call.tx.source).toBe(OWNER);
    expect(call.args.map((a) => scValToNative(a))).toEqual([OWNER, GUARD_ID, 7_000_000000n, 519_400]);
  });

  it("computes live_until_ledger as current + days * 17280", async () => {
    const rpc = writeRpc();
    rpc.latestLedger = 5000;
    const draft = { ...DRAFT, allowanceDays: 7 };
    const res = await buildEnableAutoPay(enableDeps(rpc), draft);
    const args = invokedCall(res.steps[2].unsignedXdr).args.map((a) => scValToNative(a));
    expect(args[3]).toBe(5000 + 7 * 17_280);
  });

  it("summary actions are decoded from each XDR, not copied from the draft", async () => {
    const res = await buildEnableAutoPay(enableDeps(writeRpc()), DRAFT);
    expect(res.summary.actions.map((a) => a.kind)).toEqual(["set_executor", "set_rule", "approve"]);
    expect(res.summary.actions[0]?.lines.join(" ")).toContain("Function: set_executor");
    expect(res.summary.actions[1]?.lines.join(" ")).toContain("auto_approve_limit: 250000000");
    expect(res.summary.actions[2]?.lines.join(" ")).toContain("Function: approve");
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
    expect(res.step.kind).toBe("set_rule");
    const call = invokedCall(res.step.unsignedXdr);
    expect(call.name).toBe("set_rule");
    expect(scValToNative(call.args[1]!)).toEqual(next);
  });

  it("flags a loosening with card_and_touch_id", async () => {
    const next = { ...RULE, auto_approve_limit: RULE.auto_approve_limit + 1n };
    const res = await buildTightenRule({ owner: OWNER, guard: guardClient(writeRpc()), current: RULE }, next);
    expect(res.classification).toBe("loosening");
    expect(res.confirmation).toBe("card_and_touch_id");
  });

  it("flags a missing current rule as new_rule", async () => {
    const res = await buildTightenRule({ owner: OWNER, guard: guardClient(writeRpc()) }, RULE);
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

  it("surfaces a guard simulation failure from the first write", async () => {
    const rpc = new FakeGuardRpc();
    rpc.sims = [{ _parsed: true, id: "1", latestLedger: 100, events: [], error: "HostError: Error(Contract, #102)" }];
    await expect(buildEnableAutoPay(enableDeps(rpc), DRAFT)).rejects.toMatchObject({
      name: "InvalidRule",
      code: 102,
    });
  });
});
