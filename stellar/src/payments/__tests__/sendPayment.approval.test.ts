import { xdr } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { TESTNET_PASSPHRASE } from "../../anchor/config.ts";
import { chooseGuardedRoute } from "../../guard/route.ts";
import { toRawUnits } from "../../guard/amount.ts";
import { createGuardClient } from "../../guard/client.ts";
import type { GuardRpcLike, Rule } from "../../guard/types.ts";
import {
  ASSET_SAC,
  EXECUTOR,
  FakeGuardRpc,
  GUARD_ID,
  OWNER,
  RULE,
  invokedCall,
  okSim,
  ruleScVal,
  scAddress,
} from "../../guard/__tests__/helpers.ts";
import type { ApprovalProfile } from "../../approval/types.ts";
import type { PaymentDeps } from "../sendPayment.ts";
import { baseIntent, makeDeps, runPayment } from "./helpers.ts";

function guardClient(rpc: FakeGuardRpc) {
  return createGuardClient({
    contractId: GUARD_ID,
    rpc: rpc as unknown as GuardRpcLike,
    networkPassphrase: TESTNET_PASSPHRASE,
    source: OWNER,
  });
}

/** Guarded deps with NO approvalProfile default, so the real default is exercised. */
function guardedDeps(rpc: FakeGuardRpc, over: Partial<PaymentDeps> = {}): PaymentDeps {
  return makeDeps({
    route: "guarded",
    guard: guardClient(rpc),
    guardAssetContracts: { USDC: ASSET_SAC },
    ...over,
  });
}

function script(rpc: FakeGuardRpc, opts: { rule?: Rule | null; executor?: string | null; known?: boolean } = {}): void {
  const executor = opts.executor === undefined ? EXECUTOR : opts.executor;
  rpc.sims = [
    okSim(opts.rule === null ? xdr.ScVal.scvVoid() : ruleScVal(opts.rule ?? RULE)),
    okSim(executor === null ? xdr.ScVal.scvVoid() : scAddress(executor)),
    okSim(xdr.ScVal.scvBool(opts.known ?? false)),
    okSim(xdr.ScVal.scvVoid()),
  ];
}

describe("sendPayment guarded route — approval profile narrows the chain", () => {
  it("defaults to always_ask: a tiny payment that the chain would allow takes pay_owner", async () => {
    const rpc = new FakeGuardRpc();
    script(rpc);
    const res = await runPayment(guardedDeps(rpc), baseIntent); // 10 == auto_approve_limit
    const call = invokedCall(res.unsignedXdr);
    expect(call.name).toBe("pay_owner");
    expect(call.tx.source).toBe(OWNER);
    expect(res.summary.lines).toContain("Approval profile: always_ask");
    expect(res.summary.lines).toContain("Approval card required: yes");
  });

  it("auto_under_limit uses pay_executor for the same tiny payment", async () => {
    const rpc = new FakeGuardRpc();
    script(rpc);
    const res = await runPayment(guardedDeps(rpc, { approvalProfile: { mode: "auto_under_limit" } }), baseIntent);
    const call = invokedCall(res.unsignedXdr);
    expect(call.name).toBe("pay_executor");
    expect(call.tx.source).toBe(EXECUTOR);
    expect(res.summary.lines).toContain("Approval profile: auto_under_limit");
    expect(res.summary.lines).toContain("Approval card required: no");
  });

  it("custom defers to the chain decision", async () => {
    const rpc = new FakeGuardRpc();
    script(rpc);
    const res = await runPayment(guardedDeps(rpc, { approvalProfile: { mode: "custom" } }), baseIntent);
    expect(invokedCall(res.unsignedXdr).name).toBe("pay_executor");
    expect(res.summary.lines).toContain("Approval card required: no");
  });

  it("auto_under_limit still uses pay_owner above the threshold", async () => {
    const rpc = new FakeGuardRpc();
    script(rpc);
    const res = await runPayment(
      guardedDeps(rpc, { approvalProfile: { mode: "auto_under_limit" } }),
      { ...baseIntent, amount: "25" },
    );
    expect(invokedCall(res.unsignedXdr).name).toBe("pay_owner");
    expect(res.summary.lines).toContain("Approval card required: yes");
  });

  it("always_ask uses pay_owner even for an amount inside every chain limit", async () => {
    const rpc = new FakeGuardRpc();
    script(rpc);
    const res = await runPayment(guardedDeps(rpc, { approvalProfile: { mode: "always_ask" } }), {
      ...baseIntent,
      amount: "1",
    });
    expect(invokedCall(res.unsignedXdr).name).toBe("pay_owner");
    expect(res.summary.lines).toContain("Approval card required: yes");
  });

  it("auto_under_limit falls back to pay_owner with no executor", async () => {
    const rpc = new FakeGuardRpc();
    script(rpc, { executor: null });
    const res = await runPayment(guardedDeps(rpc, { approvalProfile: { mode: "auto_under_limit" } }), baseIntent);
    expect(invokedCall(res.unsignedXdr).name).toBe("pay_owner");
  });

  it("auto_under_limit falls back to pay_owner for an unknown recipient under known_recipients_only", async () => {
    const rpc = new FakeGuardRpc();
    script(rpc, { rule: { ...RULE, known_recipients_only: true }, known: false });
    const res = await runPayment(guardedDeps(rpc, { approvalProfile: { mode: "auto_under_limit" } }), baseIntent);
    expect(invokedCall(res.unsignedXdr).name).toBe("pay_owner");
  });

  it("never widens the chain decision across amounts and profiles", async () => {
    const amounts = ["1", "5", "10", "10.0000001", "25", "49"];
    const profiles: Array<ApprovalProfile | undefined> = [
      undefined,
      { mode: "always_ask" },
      { mode: "auto_under_limit" },
      { mode: "custom" },
    ];
    for (const amount of amounts) {
      const chainRoute = chooseGuardedRoute({
        rule: RULE,
        executor: EXECUTOR,
        amountRaw: toRawUnits(amount),
        assetContractId: ASSET_SAC,
        recipientKnown: false,
      }).route;
      for (const approvalProfile of profiles) {
        const rpc = new FakeGuardRpc();
        script(rpc);
        const deps = guardedDeps(rpc, approvalProfile ? { approvalProfile } : {});
        const res = await runPayment(deps, { ...baseIntent, amount });
        const route = invokedCall(res.unsignedXdr).name;
        const alwaysAsk = approvalProfile === undefined || approvalProfile.mode === "always_ask";
        expect(route).toBe(alwaysAsk ? "pay_owner" : chainRoute);
        if (route === "pay_executor") expect(chainRoute).toBe("pay_executor");
      }
    }
  });
});
