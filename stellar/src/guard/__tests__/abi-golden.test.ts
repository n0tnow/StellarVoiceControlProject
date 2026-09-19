/**
 * Golden ABI test.
 *
 * The fixture `fixtures/polaris_guard.spec.json` is the contract's own
 * `ScSpecEntry` stream, base64-extracted offline from the compiled wasm
 * (`wasmSha256` pins the exact binary). For every method the client wraps we
 * re-derive the canonical argument encoding with `Spec.funcArgsToScVals` and
 * require the client's produced invocation arguments to be byte-for-byte
 * identical. This is the only test that can catch an ABI-encoding drift: the
 * offline fake RPC accepts any simulation payload, and a real host would only
 * reject the wrong `ScVal` at submission time.
 *
 * The spec function list is asserted against the client's surface, so a new
 * contract function fails this test until it is wrapped or explicitly listed
 * as not wrapped.
 */
import { readFileSync } from "node:fs";
import { contract, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import type { Operation } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import type { GuardClient } from "../types.ts";
import {
  ASSET_SAC,
  EXECUTOR,
  FakeGuardRpc,
  OWNER,
  PAYEE,
  RULE,
  SCHEDULE,
  makeClient,
  okSim,
  ruleScVal,
  scheduleScVal,
  scAddress,
} from "./helpers.ts";

interface Fixture {
  contract: string;
  source: string;
  wasmSha256: string;
  specEntries: string[];
}

const fixture: Fixture = JSON.parse(
  readFileSync(new URL("./fixtures/polaris_guard.spec.json", import.meta.url), "utf8"),
) as Fixture;

if (fixture.wasmSha256 !== "c4f65e6542bb5d7e512d4417c1b71b20d7210ca7e665992b4e3cc27f04be98e6") {
  throw new Error(`unexpected polaris_guard.wasm sha256: ${fixture.wasmSha256}`);
}

const spec = new contract.Spec(fixture.specEntries);

const i128 = (n: bigint): xdr.ScVal => nativeToScVal(n, { type: "i128" });

const RETVALS: Record<string, xdr.ScVal> = {
  get_rule: ruleScVal(RULE),
  get_executor: scAddress(EXECUTOR),
  get_alias: scAddress(PAYEE),
  is_known_recipient: xdr.ScVal.scvBool(true),
  spent_today: i128(350_000000n),
  get_schedule: scheduleScVal(SCHEDULE),
  list_schedules: xdr.ScVal.scvVec([scheduleScVal(SCHEDULE)]),
  next_schedule_id: xdr.ScVal.scvU32(5),
};

interface Case {
  fn: string;
  specArgs: Record<string, unknown>;
  retval: xdr.ScVal;
  call: (client: GuardClient) => Promise<unknown>;
}

const CASES: Case[] = [
  {
    fn: "set_rule",
    specArgs: { owner: OWNER, rule: RULE },
    retval: xdr.ScVal.scvVoid(),
    call: (c) => c.setRule(OWNER, RULE),
  },
  {
    fn: "get_rule",
    specArgs: { owner: OWNER },
    retval: RETVALS.get_rule!,
    call: (c) => c.getRule(OWNER),
  },
  {
    fn: "set_executor",
    specArgs: { owner: OWNER, executor: EXECUTOR },
    retval: xdr.ScVal.scvVoid(),
    call: (c) => c.setExecutor(OWNER, EXECUTOR),
  },
  {
    fn: "revoke_executor",
    specArgs: { owner: OWNER },
    retval: xdr.ScVal.scvVoid(),
    call: (c) => c.revokeExecutor(OWNER),
  },
  {
    fn: "get_executor",
    specArgs: { owner: OWNER },
    retval: RETVALS.get_executor!,
    call: (c) => c.getExecutor(OWNER),
  },
  {
    fn: "set_alias",
    specArgs: { owner: OWNER, alias: "ada", address: PAYEE },
    retval: xdr.ScVal.scvVoid(),
    call: (c) => c.setAlias(OWNER, "ada", PAYEE),
  },
  {
    fn: "remove_alias",
    specArgs: { owner: OWNER, alias: "ada" },
    retval: xdr.ScVal.scvVoid(),
    call: (c) => c.removeAlias(OWNER, "ada"),
  },
  {
    fn: "get_alias",
    specArgs: { owner: OWNER, alias: "ada" },
    retval: RETVALS.get_alias!,
    call: (c) => c.getAlias(OWNER, "ada"),
  },
  {
    fn: "is_known_recipient",
    specArgs: { owner: OWNER, to: PAYEE },
    retval: RETVALS.is_known_recipient!,
    call: (c) => c.isKnownRecipient(OWNER, PAYEE),
  },
  {
    fn: "pay_owner",
    specArgs: { owner: OWNER, to: PAYEE, asset: ASSET_SAC, amount: 10_000000n },
    retval: xdr.ScVal.scvVoid(),
    call: (c) => c.payOwner(OWNER, PAYEE, ASSET_SAC, 10_000000n),
  },
  {
    fn: "pay_executor",
    specArgs: { executor: EXECUTOR, owner: OWNER, to: PAYEE, asset: ASSET_SAC, amount: 3_000000n },
    retval: xdr.ScVal.scvVoid(),
    call: (c) => c.payExecutor(EXECUTOR, OWNER, PAYEE, ASSET_SAC, 3_000000n),
  },
  {
    fn: "spent_today",
    specArgs: { owner: OWNER },
    retval: RETVALS.spent_today!,
    call: (c) => c.spentToday(OWNER),
  },
  {
    fn: "create_schedule",
    specArgs: {
      owner: OWNER,
      to: PAYEE,
      asset: ASSET_SAC,
      amount: 7_000000n,
      first_run_at: 1_789_822_495n,
      interval_secs: 30n,
      runs: 2,
    },
    retval: xdr.ScVal.scvVoid(),
    call: (c) => c.createSchedule(OWNER, PAYEE, ASSET_SAC, 7_000000n, 1_789_822_495n, 30n, 2),
  },
  {
    fn: "cancel_schedule",
    specArgs: { owner: OWNER, id: 7 },
    retval: xdr.ScVal.scvVoid(),
    call: (c) => c.cancelSchedule(OWNER, 7),
  },
  {
    fn: "get_schedule",
    specArgs: { id: 7 },
    retval: RETVALS.get_schedule!,
    call: (c) => c.getSchedule(7),
  },
  {
    fn: "list_schedules",
    specArgs: { owner: OWNER },
    retval: RETVALS.list_schedules!,
    call: (c) => c.listSchedules(OWNER),
  },
  {
    fn: "next_schedule_id",
    specArgs: {},
    retval: RETVALS.next_schedule_id!,
    call: (c) => c.nextScheduleId(),
  },
];

/** Functions the client deliberately does not wrap (keeper-only surface). */
const NOT_WRAPPED = ["execute_schedule", "list_due"] as const;

function b64(vals: xdr.ScVal[]): string[] {
  return vals.map((v) => v.toXDR("base64"));
}

function captureArgs(tx: unknown): xdr.ScVal[] {
  const op = (tx as { operations: Operation[] }).operations[0] as Operation.InvokeHostFunction;
  if (!op || op.func.type !== "hostFunctionTypeInvokeContract") {
    throw new Error("captured transaction is not an invoke-contract call");
  }
  return op.func.invokeContract.args;
}

function describeScVal(scv: xdr.ScVal): string {
  return `${scv.type}:${scv.toXDR("base64")}`;
}

function expectSameArgs(fn: string, expected: xdr.ScVal[], actual: xdr.ScVal[]): void {
  const exp = b64(expected);
  const act = b64(actual);
  if (exp.length !== act.length || exp.some((v, i) => v !== act[i])) {
    const lines = Array.from({ length: Math.max(exp.length, act.length) }, (_, i) => {
      const e = expected[i] ? describeScVal(expected[i]!) : "<missing>";
      const a = actual[i] ? describeScVal(actual[i]!) : "<missing>";
      return `  arg[${i}] ${e === a ? "==" : "!="}\n    spec:   ${e}\n    client: ${a}`;
    });
    throw new Error(`${fn}: client argument encoding differs from the contract spec\n${lines.join("\n")}`);
  }
}

describe("golden ABI — client encoding matches the compiled contract spec", () => {
  it("the fixture pins the real wasm and contains the expected function list", () => {
    expect(fixture.contract).toBe("polaris_guard");
    const specFns = spec
      .funcs()
      .map((f) => f.name.toString())
      .sort();
    expect(specFns).toEqual([...CASES.map((c) => c.fn), ...NOT_WRAPPED].sort());
  });

  for (const testCase of CASES) {
    it(`${testCase.fn}: args byte-for-byte equal to spec.funcArgsToScVals`, async () => {
      const rpc = new FakeGuardRpc();
      rpc.sims = [okSim(testCase.retval)];
      try {
        await testCase.call(makeClient(rpc));
      } catch {
        // A read may throw while decoding its scripted retval; the transaction
        // is captured before that, which is all this test needs.
      }
      const built = rpc.simulated.at(-1);
      expect(built).toBeDefined();
      const actual = captureArgs(built);
      const expected = spec.funcArgsToScVals(testCase.fn, testCase.specArgs);

      const func = spec.getFunc(testCase.fn);
      expect(actual).toHaveLength(func.inputs.length);
      expect(expected).toHaveLength(func.inputs.length);
      expectSameArgs(testCase.fn, expected, actual);
    });
  }

  it("Rule: client decoder output equals the spec decode of the canonical struct", async () => {
    const ruleType = spec.getFunc("set_rule").inputs[1]!.type;
    const canonical = spec.funcArgsToScVals("set_rule", { owner: OWNER, rule: RULE })[1]!;
    expect(canonical.toXDR("base64")).toBe(ruleScVal(RULE).toXDR("base64"));
    expect(spec.scValToNative(canonical, ruleType)).toEqual(RULE);

    const rpc = new FakeGuardRpc();
    rpc.sims = [okSim(canonical)];
    const decodedByClient = await makeClient(rpc).getRule(OWNER);
    expect(decodedByClient).toEqual(spec.scValToNative(canonical, ruleType));
    expect(decodedByClient).toEqual(RULE);
  });

  it("Schedule: client decoder output equals the spec decode of the canonical struct", async () => {
    const rawOutput = spec.getFunc("get_schedule").outputs[0]!;
    if (rawOutput.type !== "scSpecTypeOption" || !rawOutput.value) {
      throw new Error(`get_schedule output is ${rawOutput.type}, not an option`);
    }
    const scheduleType = rawOutput.value.valueType;
    const canonical = spec.nativeToScVal(SCHEDULE, scheduleType);
    expect(canonical.toXDR("base64")).toBe(scheduleScVal(SCHEDULE).toXDR("base64"));
    expect(spec.scValToNative(canonical, scheduleType)).toEqual(SCHEDULE);

    const rpc = new FakeGuardRpc();
    rpc.sims = [okSim(canonical)];
    const decodedByClient = await makeClient(rpc).getSchedule(7);
    expect(decodedByClient).toEqual(spec.scValToNative(canonical, scheduleType));
    expect(decodedByClient).toEqual(SCHEDULE);
  });
});
