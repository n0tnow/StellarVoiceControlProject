import { Networks, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { I128_MAX } from "../amount.ts";
import {
  ALLOWANCE_WINDOW_DAYS,
  LEDGERS_PER_DAY,
  allowanceExpiryLedger,
  buildApproveAllowance,
  formatAllowance,
  getAllowance,
} from "../allowance.ts";
import { GuardClientError } from "../errors.ts";
import type { GuardRpcLike } from "../types.ts";
import { ASSET_SAC, EXECUTOR, FakeGuardRpc, GUARD_ID, OWNER, errSim, invokedCall, okSim } from "./helpers.ts";

const PASS = Networks.TESTNET;

function rpcOf(fake: FakeGuardRpc): GuardRpcLike {
  return fake as unknown as GuardRpcLike;
}

describe("allowanceExpiryLedger", () => {
  it("adds ~30 days of ledgers (17,280/day)", () => {
    expect(allowanceExpiryLedger(1000)).toBe(1000 + 30 * 17_280);
    expect(LEDGERS_PER_DAY).toBe(17_280);
    expect(ALLOWANCE_WINDOW_DAYS).toBe(30);
  });

  it("honours a custom window", () => {
    expect(allowanceExpiryLedger(500, 1)).toBe(500 + 17_280);
  });

  it("rejects a negative or non-integer ledger", () => {
    expect(() => allowanceExpiryLedger(-1)).toThrow(GuardClientError);
    expect(() => allowanceExpiryLedger(1.5)).toThrow(GuardClientError);
  });

  it("rejects a non-positive window", () => {
    expect(() => allowanceExpiryLedger(1000, 0)).toThrow(GuardClientError);
    expect(() => allowanceExpiryLedger(1000, -3)).toThrow(GuardClientError);
  });
});

describe("buildApproveAllowance", () => {
  it("builds approve(from, spender, amount, live_until_ledger) on the asset SAC", async () => {
    const rpc = new FakeGuardRpc();
    rpc.latestLedger = 1000;
    rpc.sims = [okSim(xdr.ScVal.scvVoid())];

    const result = await buildApproveAllowance(rpcOf(rpc), {
      assetContractId: ASSET_SAC,
      from: OWNER,
      spender: GUARD_ID,
      amount: 1_000_000000n,
      networkPassphrase: PASS,
    });

    const call = invokedCall(result.unsignedXdr);
    expect(call.contractId).toBe(ASSET_SAC);
    expect(call.name).toBe("approve");
    expect(call.args[0]?.type).toBe("scvAddress");
    expect(call.args[1]?.type).toBe("scvAddress");
    expect(call.args[2]?.type).toBe("scvI128");
    expect(call.args[3]?.type).toBe("scvU32");
    expect(call.tx.source).toBe(OWNER);
    expect(call.tx.signatures).toHaveLength(0);
    expect(result.liveUntilLedger).toBe(1000 + 30 * 17_280);
    expect(result.currentLedger).toBe(1000);
  });

  it("only simulates — never signs or submits", async () => {
    const rpc = new FakeGuardRpc();
    rpc.sims = [okSim(xdr.ScVal.scvVoid())];
    await buildApproveAllowance(rpcOf(rpc), {
      assetContractId: ASSET_SAC,
      from: OWNER,
      spender: GUARD_ID,
      amount: 5_000000n,
      networkPassphrase: PASS,
    });
    expect(rpc.simulated).toHaveLength(1);
    expect(rpc.getAccountCalls).toBe(1);
  });

  it("returns a payload hash equal to the transaction hash", async () => {
    const rpc = new FakeGuardRpc();
    rpc.sims = [okSim(xdr.ScVal.scvVoid())];
    const result = await buildApproveAllowance(rpcOf(rpc), {
      assetContractId: ASSET_SAC,
      from: OWNER,
      spender: GUARD_ID,
      amount: 5_000000n,
      networkPassphrase: PASS,
    });
    expect(result.payloadHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.summary.title).toBe("polaris_guard: approve");
  });

  it.each([
    ["zero", 0n],
    ["negative", -1n],
    ["over i128", I128_MAX + 1n],
  ])("refuses a %s amount before any RPC call", async (_label, amount) => {
    const rpc = new FakeGuardRpc();
    rpc.sims = [okSim(xdr.ScVal.scvVoid())];
    let error: unknown;
    try {
      await buildApproveAllowance(rpcOf(rpc), {
        assetContractId: ASSET_SAC,
        from: OWNER,
        spender: GUARD_ID,
        amount,
        networkPassphrase: PASS,
      });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(GuardClientError);
    expect((error as GuardClientError).name).toBe("InvalidAmount");
    expect(rpc.simulated).toHaveLength(0);
    expect(rpc.getAccountCalls).toBe(0);
  });

  it("surfaces a simulation failure as a mapped guard error", async () => {
    const rpc = new FakeGuardRpc();
    rpc.sims = [errSim("HostError: Error(Contract, #116)\n\nEvent log")];
    await expect(
      buildApproveAllowance(rpcOf(rpc), {
        assetContractId: ASSET_SAC,
        from: OWNER,
        spender: GUARD_ID,
        amount: 5_000000n,
        networkPassphrase: PASS,
      }),
    ).rejects.toMatchObject({ name: "InsufficientAllowance", code: 116 });
  });
});

describe("getAllowance", () => {
  it("decodes the current allowance as a bigint", async () => {
    const rpc = new FakeGuardRpc();
    rpc.sims = [okSim(nativeToScVal(12_3456789n, { type: "i128" }))];
    const value = await getAllowance(rpcOf(rpc), {
      assetContractId: ASSET_SAC,
      from: OWNER,
      spender: GUARD_ID,
      networkPassphrase: PASS,
    });
    expect(value).toBe(12_3456789n);
    const call = invokedCall(rpc.simulated[0]!.toXDR());
    expect(call.name).toBe("allowance");
    expect(call.contractId).toBe(ASSET_SAC);
    expect(call.args.map((a) => a.type)).toEqual(["scvAddress", "scvAddress"]);
  });

  it("surfaces a read failure as a mapped token error", async () => {
    const rpc = new FakeGuardRpc();
    rpc.sims = [errSim("HostError: Error(Contract, #9)")];
    await expect(
      getAllowance(rpcOf(rpc), {
        assetContractId: ASSET_SAC,
        from: OWNER,
        spender: GUARD_ID,
        networkPassphrase: PASS,
      }),
    ).rejects.toMatchObject({ name: "SacAllowanceError", kind: "allowance_missing" });
  });
});

describe("formatAllowance", () => {
  it("renders raw units as a decimal", () => {
    expect(formatAllowance(1_000_000000n)).toBe("100");
    expect(formatAllowance(105000000n)).toBe("10.5");
  });

  it("is unrelated to the executor address (spender is the guard)", () => {
    expect(EXECUTOR).not.toBe(GUARD_ID);
  });
});
