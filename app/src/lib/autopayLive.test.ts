import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createAutoPayCommands,
  isAutoPaySupported,
  runAutoPaySetup,
  type AutoPaySetupDeps,
} from "./autopayLive.ts";
import type { AutoPayPlan } from "./autopay.ts";
import type { TxRunStep } from "./txPipeline.ts";

const OWNER = "GARXWVNCJ22U2OR23LAB5Z5RWI2XFIJZA2R3TRPFUKKY65JQZZOEWWCO";

function plan(): AutoPayPlan {
  return {
    mode: "auto_under_limit",
    limits: { threshold: "10", perTx: "20", daily: "100", asset: "XLM", knownRecipientsOnly: true },
    steps: [],
    readBack: "read back",
    requiresApproval: true,
  };
}

function step(label: string, xdr: string): TxRunStep {
  return {
    result: {
      unsignedXdr: xdr,
      summary: { title: label, lines: [], estimatedFee: "0.00001 XLM" },
    },
    intent: { kind: "guard_policy", asset: "XLM", amount: "0" },
    label,
  };
}

test("createAutoPayCommands names each Rust command and passes its arguments", async () => {
  const calls: { command: string; args?: Record<string, unknown> }[] = [];
  const invoke = async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
    calls.push(args === undefined ? { command } : { command, args });
    if (command === "executor_status") return { exists: true, address: OWNER, funded: true } as T;
    if (command === "executor_create") return { address: OWNER } as T;
    if (command === "executor_sign_pay") return { ok: true, signedXdr: "SS", txHash: "hh" } as T;
    if (command === "approval_begin_batch") return { batchId: "b1", ids: ["i1"] } as T;
    return { authorized: ["i1"] } as T;
  };

  const commands = createAutoPayCommands(invoke);
  assert.deepEqual(await commands.executorStatus(), { exists: true, address: OWNER, funded: true });
  assert.deepEqual(await commands.executorCreate(), { address: OWNER });
  assert.deepEqual(await commands.executorSignPay("XX"), { ok: true, signedXdr: "SS", txHash: "hh" });
  assert.deepEqual(await commands.approvalBeginBatch("t", []), { batchId: "b1", ids: ["i1"] });
  assert.deepEqual(await commands.approvalAuthorizeBatch("b1"), { authorized: ["i1"] });

  assert.deepEqual(
    calls.map((call) => call.command),
    [
      "executor_status",
      "executor_create",
      "executor_sign_pay",
      "approval_begin_batch",
      "approval_authorize_batch",
    ],
  );
  assert.deepEqual(calls[2]!.args, { xdr: "XX" });
  assert.deepEqual(calls[4]!.args, { batchId: "b1" });
});

test("isAutoPaySupported feature-detects a missing command", async () => {
  const present = async <T>(): Promise<T> => ({ exists: false, address: null, funded: null }) as T;
  assert.equal(await isAutoPaySupported(present), true);

  const missing = async <T>(): Promise<T> => {
    throw new Error("Command executor_status not found");
  };
  assert.equal(await isAutoPaySupported(missing), false);

  const broken = async <T>(): Promise<T> => {
    throw new Error("network request failed");
  };
  await assert.rejects(() => isAutoPaySupported(broken), /network request failed/);
});

function deps(overrides: Partial<AutoPaySetupDeps> = {}): AutoPaySetupDeps {
  return {
    commands: createAutoPayCommands(async <T>(command: string): Promise<T> => {
      if (command === "executor_status") return { exists: false, address: null, funded: null } as T;
      if (command === "executor_create") return { address: OWNER } as T;
      if (command === "approval_begin_batch") return { batchId: "b1", ids: ["i1", "i2"] } as T;
      return { authorized: ["i1", "i2"] } as T;
    }),
    digest: (xdr) => `h:${xdr}`,
    buildPlan: async () => ({ plan: plan(), steps: [step("step 1", "AAA"), step("step 2", "BBB")] }),
    signAndSubmitItem: async (_id, s) => ({
      status: "submitted",
      txHash: `hash-${s.result.unsignedXdr}`,
      explorerUrl: "https://example/tx/x",
      atMs: 1,
    }),
    ...overrides,
  };
}

test("runAutoPaySetup creates the executor, gets one batch approval and submits every step", async () => {
  const created: string[] = [];
  const order: string[] = [];
  const d = deps({
    buildPlan: async () => {
      order.push("buildPlan");
      return { plan: plan(), steps: [step("step 1", "AAA"), step("step 2", "BBB")] };
    },
    signAndSubmitItem: async (id) => {
      order.push(`sign:${id}`);
      return { status: "submitted", txHash: "h", explorerUrl: "u", atMs: 1 };
    },
  });
  d.commands.executorCreate = async () => {
    created.push("create");
    return { address: OWNER };
  };

  const outcome = await runAutoPaySetup({ mode: "auto_under_limit", asset: "XLM", autoApproveLimit: "10" }, d);
  assert.equal(outcome.status, "submitted");
  assert.deepEqual(created, ["create"]);
  assert.deepEqual(order, ["buildPlan", "sign:i1", "sign:i2"]);
  assert.equal(outcome.label, "Done — payments under 10 XLM to saved contacts go through automatically.");
});

test("runAutoPaySetup stops and reports a denied batch", async () => {
  const d = deps({
    commands: createAutoPayCommands(async <T>(command: string): Promise<T> => {
      if (command === "executor_status") return { exists: true, address: OWNER, funded: true } as T;
      if (command === "approval_begin_batch") return { batchId: "b1", ids: ["i1"] } as T;
      return { authorized: [] } as T;
    }),
  });
  const outcome = await runAutoPaySetup({ mode: "auto_under_limit", asset: "XLM", autoApproveLimit: "10" }, d);
  assert.equal(outcome.status, "denied");
  assert.equal(outcome.outcomes[0]!.status, "denied");
});

test("runAutoPaySetup reports unsupported when the commands are absent", async () => {
  const d = deps({
    commands: createAutoPayCommands(async <T>(): Promise<T> => {
      throw new Error("Command executor_status not found");
    }),
  });
  const outcome = await runAutoPaySetup({ mode: "auto_under_limit", asset: "XLM", autoApproveLimit: "10" }, d);
  assert.equal(outcome.status, "unsupported");
});
