import { scValToNative, xdr } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { TESTNET_PASSPHRASE } from "../../anchor/config.ts";
import { createGuardClient } from "../../guard/client.ts";
import { shortKey } from "../../guard/describe.ts";
import type { GuardRpcLike, Rule } from "../../guard/types.ts";
import {
  ASSET_SAC,
  EXECUTOR,
  FakeGuardRpc,
  GUARD_ID,
  GUARD_ID_2,
  OWNER,
  PAYEE,
  RULE,
  errSim,
  invokedCall,
  okSim,
  ruleScVal,
  scAddress,
} from "../../guard/__tests__/helpers.ts";
import type { PaymentDeps } from "../sendPayment.ts";
import { baseIntent, makeDeps, refusalOf, runPayment } from "./helpers.ts";

const XLM_SAC = GUARD_ID_2;

function guardClient(rpc: FakeGuardRpc) {
  return createGuardClient({
    contractId: GUARD_ID,
    rpc: rpc as unknown as GuardRpcLike,
    networkPassphrase: TESTNET_PASSPHRASE,
    source: OWNER,
  });
}

function guardedDeps(rpc: FakeGuardRpc, over: Partial<PaymentDeps> = {}): PaymentDeps {
  return makeDeps({
    route: "guarded",
    guard: guardClient(rpc),
    guardAssetContracts: { USDC: ASSET_SAC },
    // Preserve this file's chain-routing expectations: the app default is now
    // `always_ask` (D10), so these fixtures opt into `auto_under_limit` to keep
    // exercising `chooseGuardedRoute` itself. The new default is covered in
    // sendPayment.approval.test.ts.
    approvalProfile: { mode: "auto_under_limit" },
    ...over,
  });
}

/** Script the guard reads (rule, executor, known) plus a write success. */
function script(rpc: FakeGuardRpc, opts: { rule?: Rule | null; executor?: string | null; known?: boolean } = {}): void {
  const executor = opts.executor === undefined ? EXECUTOR : opts.executor;
  rpc.sims = [
    okSim(opts.rule === null ? xdr.ScVal.scvVoid() : ruleScVal(opts.rule ?? RULE)),
    okSim(executor === null ? xdr.ScVal.scvVoid() : scAddress(executor)),
    okSim(xdr.ScVal.scvBool(opts.known ?? false)),
    okSim(xdr.ScVal.scvVoid()),
  ];
}

describe("sendPayment guarded route — happy paths", () => {
  it("routes a small payment through pay_executor and decodes the summary from the XDR", async () => {
    const rpc = new FakeGuardRpc();
    script(rpc);
    const res = await runPayment(guardedDeps(rpc), baseIntent); // amount "10" == auto_approve_limit

    const call = invokedCall(res.unsignedXdr);
    expect(call.name).toBe("pay_executor");
    expect(call.contractId).toBe(GUARD_ID);
    expect(call.tx.source).toBe(EXECUTOR);
    expect(call.tx.signatures).toHaveLength(0);
    expect(call.args.map((a) => scValToNative(a))).toEqual([EXECUTOR, OWNER, PAYEE, ASSET_SAC, 100_000000n]);

    expect(res.summary.title).toBe(
      `Guarded payment via polaris_guard (${shortKey(GUARD_ID)}) — route: pay_executor`,
    );
    expect(res.summary.lines[0]).toBe("Route: pay_executor (executor signs)");
    expect(res.summary.lines).toContain("Pay 10 USDC");
    expect(res.summary.lines).toContain(`Asset (SAC): ${ASSET_SAC}`);
    expect(res.summary.lines).toContain(`To ada (${PAYEE})`);
    expect(res.summary.lines).toContain(`Network: ${TESTNET_PASSPHRASE}`);
    expect(res.summary.lines.some((l) => l.startsWith("Fee:"))).toBe(true);
    expect(res.summary.estimatedFee).toMatch(/XLM$/);
  });

  it("routes a large payment through pay_owner (owner signs)", async () => {
    const rpc = new FakeGuardRpc();
    script(rpc);
    const res = await runPayment(guardedDeps(rpc), { ...baseIntent, amount: "25" });

    const call = invokedCall(res.unsignedXdr);
    expect(call.name).toBe("pay_owner");
    expect(call.tx.source).toBe(OWNER);
    expect(call.args.map((a) => scValToNative(a))).toEqual([OWNER, PAYEE, ASSET_SAC, 250_000000n]);
    expect(res.summary.title).toContain("route: pay_owner");
    expect(res.summary.lines[0]).toBe("Route: pay_owner (owner signs)");
  });

  it("uses pay_owner when no executor is registered", async () => {
    const rpc = new FakeGuardRpc();
    script(rpc, { executor: null });
    const res = await runPayment(guardedDeps(rpc), baseIntent);
    expect(invokedCall(res.unsignedXdr).name).toBe("pay_owner");
  });

  it("uses pay_executor for a known recipient under known_recipients_only", async () => {
    const rpc = new FakeGuardRpc();
    script(rpc, { rule: { ...RULE, known_recipients_only: true }, known: true });
    const res = await runPayment(guardedDeps(rpc), baseIntent);
    expect(invokedCall(res.unsignedXdr).name).toBe("pay_executor");
  });

  it("uses pay_owner for an unknown recipient under known_recipients_only", async () => {
    const rpc = new FakeGuardRpc();
    script(rpc, { rule: { ...RULE, known_recipients_only: true }, known: false });
    const res = await runPayment(guardedDeps(rpc), baseIntent);
    expect(invokedCall(res.unsignedXdr).name).toBe("pay_owner");
  });

  it("allows a guarded XLM payment when its SAC id is supplied", async () => {
    const rpc = new FakeGuardRpc();
    script(rpc, { rule: { ...RULE, allowed_assets: [XLM_SAC] } });
    const deps = guardedDeps(rpc, { guardAssetContracts: { USDC: ASSET_SAC, XLM: XLM_SAC } });
    const res = await runPayment(deps, { ...baseIntent, asset: "XLM" });
    const call = invokedCall(res.unsignedXdr);
    expect(call.name).toBe("pay_executor");
    expect(call.args.map((a) => scValToNative(a))[3]).toBe(XLM_SAC);
    expect(res.summary.lines).toContain("Pay 10 XLM");
  });
});

describe("sendPayment guarded route — refusals", () => {
  it("refuses with guard_rule_missing when the owner has no rule", async () => {
    const rpc = new FakeGuardRpc();
    script(rpc, { rule: null });
    const err = await refusalOf(() => runPayment(guardedDeps(rpc), baseIntent));
    expect(err.code).toBe("guard_rule_missing");
    expect(rpc.simulated).toHaveLength(1);
  });

  it("refuses above per_tx_limit with guard_limit_exceeded carrying OverPerTxLimit", async () => {
    const rpc = new FakeGuardRpc();
    script(rpc);
    const err = await refusalOf(() => runPayment(guardedDeps(rpc), { ...baseIntent, amount: "60" }));
    expect(err.code).toBe("guard_limit_exceeded");
    expect(err.guardErrorName).toBe("OverPerTxLimit");
    expect(rpc.simulated).toHaveLength(3); // no write was built
  });

  it("refuses a disallowed asset with guard_asset_not_allowed carrying AssetNotAllowed", async () => {
    const rpc = new FakeGuardRpc();
    script(rpc, { rule: { ...RULE, allowed_assets: [XLM_SAC] } });
    const err = await refusalOf(() => runPayment(guardedDeps(rpc), baseIntent));
    expect(err.code).toBe("guard_asset_not_allowed");
    expect(err.guardErrorName).toBe("AssetNotAllowed");
  });

  it("refuses a guarded XLM payment with no SAC id as unsupported_asset", async () => {
    const rpc = new FakeGuardRpc();
    script(rpc);
    const err = await refusalOf(() => runPayment(guardedDeps(rpc), { ...baseIntent, asset: "XLM" }));
    expect(err.code).toBe("unsupported_asset");
    expect(rpc.simulated).toHaveLength(0);
  });

  it("refuses an unknown alias before touching the guard", async () => {
    const rpc = new FakeGuardRpc();
    const err = await refusalOf(() => runPayment(guardedDeps(rpc), { ...baseIntent, recipient: "nobody" }));
    expect(err.code).toBe("unknown_recipient");
    expect(rpc.simulated).toHaveLength(0);
  });

  it("refuses guarded without a configured client", async () => {
    const err = await refusalOf(() => runPayment(makeDeps({ route: "guarded" }), baseIntent));
    expect(err.code).toBe("guarded_route_not_available");
  });

  it("maps an unmapped guard simulation failure to guard_client_error", async () => {
    const rpc = new FakeGuardRpc();
    rpc.sims = [errSim("HostError: Error(Contract, #999)\n\nEvent log")];
    const err = await refusalOf(() => runPayment(guardedDeps(rpc), baseIntent));
    expect(err.code).toBe("guard_client_error");
    expect(err.guardErrorName).toBe("ContractError#999");
  });

  it("maps a NotConfigured simulation failure to guard_rule_missing", async () => {
    const rpc = new FakeGuardRpc();
    rpc.sims = [errSim("HostError: Error(Contract, #100)")];
    const err = await refusalOf(() => runPayment(guardedDeps(rpc), baseIntent));
    expect(err.code).toBe("guard_rule_missing");
  });
});

describe("sendPayment guarded route — direct path is untouched", () => {
  it("ignores guard dependencies on the direct route", async () => {
    const rpc = new FakeGuardRpc(); // no simulations scripted
    const deps = makeDeps({ route: "direct", guard: guardClient(rpc), guardAssetContracts: { USDC: ASSET_SAC } });
    const res = await runPayment(deps, baseIntent);
    expect(rpc.simulated).toHaveLength(0);
    expect(res.summary.title).toBe("Send 10 USDC to ada");
    expect(res.unsignedXdr).toMatch(/^[A-Za-z0-9+/=]+$/);
  });

  it("still refuses the guarded route when the client is missing (existing behaviour)", async () => {
    const err = await refusalOf(() => runPayment(makeDeps({ route: "guarded" }), baseIntent));
    expect(err.code).toBe("guarded_route_not_available");
  });
});
