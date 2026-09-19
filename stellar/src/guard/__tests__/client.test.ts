import { xdr } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { toHex } from "../describe.ts";
import type { GuardClient } from "../types.ts";
import {
  ASSET_SAC,
  EXECUTOR,
  FakeGuardRpc,
  GUARD_ID,
  GUARD_ID_2,
  OWNER,
  PAYEE,
  RULE,
  SCHEDULE,
  errSim,
  invokedCall,
  makeClient,
  okSim,
  ruleScVal,
  scAddress,
  scheduleScVal,
} from "./helpers.ts";

function writeRpc(): FakeGuardRpc {
  const rpc = new FakeGuardRpc();
  rpc.sims = [okSim(xdr.ScVal.scvVoid())];
  return rpc;
}

describe("guard client — writes build the exact v0.1 invocation", () => {
  it("setRule -> set_rule(owner, rule), signed by the owner", async () => {
    const rpc = writeRpc();
    const res = await makeClient(rpc).setRule(OWNER, RULE);
    const call = invokedCall(res.unsignedXdr);
    expect(call.name).toBe("set_rule");
    expect(call.args[0]?.type).toBe("scvAddress");
    expect(call.args[1]?.type).toBe("scvMap");
    const ruleArg = call.args[1];
    if (ruleArg?.type !== "scvMap") throw new Error(`set_rule rule arg is ${ruleArg?.type}, not scvMap`);
    const entries = ruleArg.map ?? [];
    const byKey = new Map<string, xdr.ScVal>(
      entries.map((e) => {
        if (e.key.type !== "scvSymbol") throw new Error(`non-symbol Rule key: ${e.key.type}`);
        return [e.key.sym.toString(), e.val] as const;
      }),
    );
    expect([...byKey.keys()].sort()).toEqual([
      "allowed_assets",
      "auto_approve_limit",
      "daily_limit",
      "known_recipients_only",
      "per_tx_limit",
    ]);
    for (const entry of entries) expect(entry.key.type).toBe("scvSymbol");
    for (const limit of ["auto_approve_limit", "per_tx_limit", "daily_limit"]) {
      expect(byKey.get(limit)?.type).toBe("scvI128");
    }
    const assets = byKey.get("allowed_assets");
    if (assets?.type !== "scvVec") throw new Error(`allowed_assets is ${assets?.type}, not scvVec`);
    expect((assets.vec ?? []).map((a) => a.type)).toEqual(["scvAddress"]);
    expect(byKey.get("known_recipients_only")?.type).toBe("scvBool");
    expect(call.tx.source).toBe(OWNER);
    expect(call.args[1] && invokedCall(res.unsignedXdr).tx.signatures).toHaveLength(0);
    expect(res.payloadHash).toBe(toHex(call.tx.hash()));
    expect(res.summary.title).toBe("polaris_guard: set_rule");
  });

  it("setExecutor -> set_executor(owner, executor)", async () => {
    const call = invokedCall((await makeClient(writeRpc()).setExecutor(OWNER, EXECUTOR)).unsignedXdr);
    expect(call.name).toBe("set_executor");
    expect(call.args.map((a) => a.type)).toEqual(["scvAddress", "scvAddress"]);
    expect(call.tx.source).toBe(OWNER);
  });

  it("revokeExecutor -> revoke_executor(owner)", async () => {
    const call = invokedCall((await makeClient(writeRpc()).revokeExecutor(OWNER)).unsignedXdr);
    expect(call.name).toBe("revoke_executor");
    expect(call.args).toHaveLength(1);
  });

  it("setAlias -> set_alias(owner, alias, address)", async () => {
    const call = invokedCall((await makeClient(writeRpc()).setAlias(OWNER, "ada", PAYEE)).unsignedXdr);
    expect(call.name).toBe("set_alias");
    expect(call.args.map((a) => a.type)).toEqual(["scvAddress", "scvString", "scvAddress"]);
  });

  it("removeAlias -> remove_alias(owner, alias)", async () => {
    const call = invokedCall((await makeClient(writeRpc()).removeAlias(OWNER, "ada")).unsignedXdr);
    expect(call.name).toBe("remove_alias");
    expect(call.args.map((a) => a.type)).toEqual(["scvAddress", "scvString"]);
  });

  it("payOwner -> pay_owner(owner, to, asset, amount)", async () => {
    const call = invokedCall((await makeClient(writeRpc()).payOwner(OWNER, PAYEE, ASSET_SAC, 10_000000n)).unsignedXdr);
    expect(call.name).toBe("pay_owner");
    expect(call.args.map((a) => a.type)).toEqual(["scvAddress", "scvAddress", "scvAddress", "scvI128"]);
    expect(call.tx.source).toBe(OWNER);
  });

  it("payExecutor -> pay_executor(executor, owner, to, asset, amount), signed by the executor", async () => {
    const call = invokedCall(
      (await makeClient(writeRpc()).payExecutor(EXECUTOR, OWNER, PAYEE, ASSET_SAC, 3_000000n)).unsignedXdr,
    );
    expect(call.name).toBe("pay_executor");
    expect(call.args.map((a) => a.type)).toEqual([
      "scvAddress",
      "scvAddress",
      "scvAddress",
      "scvAddress",
      "scvI128",
    ]);
    expect(call.tx.source).toBe(EXECUTOR);
    expect(call.tx.source).not.toBe(OWNER);
  });

  it("createSchedule -> create_schedule(owner, to, asset, amount, first_run_at, interval_secs, runs)", async () => {
    const call = invokedCall(
      (
        await makeClient(writeRpc()).createSchedule(OWNER, PAYEE, ASSET_SAC, 7_000000n, 1_789_822_495n, 30n, 2)
      ).unsignedXdr,
    );
    expect(call.name).toBe("create_schedule");
    expect(call.args.map((a) => a.type)).toEqual([
      "scvAddress",
      "scvAddress",
      "scvAddress",
      "scvI128",
      "scvU64",
      "scvU64",
      "scvU32",
    ]);
    expect(call.tx.source).toBe(OWNER);
  });

  it("cancelSchedule -> cancel_schedule(owner, id)", async () => {
    const call = invokedCall((await makeClient(writeRpc()).cancelSchedule(OWNER, 7)).unsignedXdr);
    expect(call.name).toBe("cancel_schedule");
    expect(call.args.map((a) => a.type)).toEqual(["scvAddress", "scvU32"]);
  });

  it("never signs and returns a decoded summary + payload hash", async () => {
    const res = await makeClient(writeRpc()).payOwner(OWNER, PAYEE, ASSET_SAC, 1n);
    const call = invokedCall(res.unsignedXdr);
    expect(call.tx.signatures).toHaveLength(0);
    expect(res.payloadHash).toMatch(/^[0-9a-f]{64}$/);
    expect(res.summary.lines.some((l) => l.includes("Network:"))).toBe(true);
    expect(res.summary.estimatedFee).toMatch(/XLM$/);
  });

  it("surfaces a write simulation failure as the mapped guard error", async () => {
    const rpc = new FakeGuardRpc();
    rpc.sims = [errSim("HostError: Error(Contract, #103)\n\nEvent log")];
    await expect(makeClient(rpc).payOwner(OWNER, PAYEE, ASSET_SAC, 10n)).rejects.toMatchObject({
      name: "OverPerTxLimit",
      code: 103,
    });
  });

  it("parameterises the contract id: two ids produce different, correctly targeted XDR", async () => {
    const rpcA = writeRpc();
    const rpcB = writeRpc();
    const a = makeClient(rpcA, { contractId: GUARD_ID });
    const b = makeClient(rpcB, { contractId: GUARD_ID_2 });
    const [ra, rb] = await Promise.all([a.revokeExecutor(OWNER), b.revokeExecutor(OWNER)]);
    expect(ra.unsignedXdr).not.toBe(rb.unsignedXdr);
    expect(invokedCall(ra.unsignedXdr).contractId).toBe(GUARD_ID);
    expect(invokedCall(rb.unsignedXdr).contractId).toBe(GUARD_ID_2);
  });

  it("refuses to build without a contract id", () => {
    expect(() => makeClient(writeRpc(), { contractId: "" })).toThrow(/contractId/);
  });
});

describe("guard client — reads decode contract values", () => {
  function readRpc(retval: xdr.ScVal): FakeGuardRpc {
    const rpc = new FakeGuardRpc();
    rpc.sims = [okSim(retval)];
    return rpc;
  }

  it("getRule decodes a Rule struct", async () => {
    const rule = await makeClient(readRpc(ruleScVal(RULE))).getRule(OWNER);
    expect(rule).toEqual(RULE);
  });

  it("getRule returns null for None (void)", async () => {
    expect(await makeClient(readRpc(xdr.ScVal.scvVoid())).getRule(OWNER)).toBeNull();
  });

  it("getExecutor decodes an address", async () => {
    expect(await makeClient(readRpc(scAddress(EXECUTOR))).getExecutor(OWNER)).toBe(EXECUTOR);
  });

  it("getExecutor returns null for None", async () => {
    expect(await makeClient(readRpc(xdr.ScVal.scvVoid())).getExecutor(OWNER)).toBeNull();
  });

  it("getAlias decodes an address", async () => {
    expect(await makeClient(readRpc(scAddress(PAYEE))).getAlias(OWNER, "ada")).toBe(PAYEE);
  });

  it("getAlias returns null for None", async () => {
    expect(await makeClient(readRpc(xdr.ScVal.scvVoid())).getAlias(OWNER, "nobody")).toBeNull();
  });

  it("isKnownRecipient decodes a boolean", async () => {
    expect(await makeClient(readRpc(xdr.ScVal.scvBool(true))).isKnownRecipient(OWNER, PAYEE)).toBe(true);
    expect(await makeClient(readRpc(xdr.ScVal.scvBool(false))).isKnownRecipient(OWNER, PAYEE)).toBe(false);
  });

  it("spentToday decodes an i128 as bigint", async () => {
    const rpc = readRpc(xdr.ScVal.scvI128(new xdr.Int128Parts({ hi: 0n, lo: 350_000000n })));
    const value = await makeClient(rpc).spentToday(OWNER);
    expect(value).toBe(350_000000n);
    expect(typeof value).toBe("bigint");
  });

  it("getSchedule decodes a Schedule", async () => {
    const schedule = await makeClient(readRpc(scheduleScVal(SCHEDULE))).getSchedule(7);
    expect(schedule).toEqual(SCHEDULE);
  });

  it("getSchedule returns null for None", async () => {
    expect(await makeClient(readRpc(xdr.ScVal.scvVoid())).getSchedule(7)).toBeNull();
  });

  it("listSchedules decodes a Vec<Schedule>", async () => {
    const vec = xdr.ScVal.scvVec([scheduleScVal(SCHEDULE)]);
    const list = await makeClient(readRpc(vec)).listSchedules(OWNER);
    expect(list).toEqual([SCHEDULE]);
  });

  it("listSchedules decodes an empty Vec to []", async () => {
    expect(await makeClient(readRpc(xdr.ScVal.scvVec([]))).listSchedules(OWNER)).toEqual([]);
  });

  it("nextScheduleId decodes a u32", async () => {
    const rpc = readRpc(xdr.ScVal.scvU32(5));
    expect(await makeClient(rpc).nextScheduleId()).toBe(5);
  });

  it("simulates reads from the configured source and never signs or submits", async () => {
    const rpc = readRpc(scAddress(EXECUTOR));
    await makeClient(rpc, { source: EXECUTOR }).getExecutor(OWNER);
    expect(rpc.simulated).toHaveLength(1);
    expect(rpc.simulated[0]?.source).toBe(EXECUTOR);
    expect(rpc.simulated[0]?.signatures).toHaveLength(0);
  });

  it("surfaces a read simulation failure as the mapped error", async () => {
    const rpc = new FakeGuardRpc();
    rpc.sims = [errSim("HostError: Error(Contract, #100)")];
    await expect(makeClient(rpc).getRule(OWNER)).rejects.toMatchObject({ name: "NotConfigured", code: 100 });
  });
});

describe("guard client — helper surface", () => {
  it("exposes the contract id it was built with", () => {
    const client: GuardClient = makeClient(writeRpc(), { contractId: GUARD_ID_2 });
    expect(client.contractId).toBe(GUARD_ID_2);
  });
});
