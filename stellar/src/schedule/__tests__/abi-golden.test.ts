/**
 * Golden ABI test for the schedule tools.
 *
 * The guard's committed fixture
 * (`../../guard/__tests__/fixtures/polaris_guard.spec.json`) is the contract's
 * own `ScSpecEntry` stream extracted offline from the compiled wasm. We load it
 * with `contract.Spec` (read-only, via `fs` in the TEST only) and require the
 * `create_schedule` / `cancel_schedule` invocation arguments produced by
 * `schedulePayment` / `cancelSchedule` to be byte-for-byte identical (base64
 * XDR) to `spec.funcArgsToScVals(...)`.
 *
 * This is the schedule-tool sibling of the guard client's golden test: the
 * offline fake RPC accepts any simulation payload, so only a spec-derived
 * expectation can catch an argument-encoding drift in the tools.
 *
 * Boundary note: the tool derives `first_run_at` from a four-digit
 * `YYYY-MM-DD` local date, so it can never reach `2^53` seconds. The u64 case
 * below therefore uses the maximum the tool accepts (`9999-12-31 23:59` UTC)
 * together with `runs = 2^32 - 1`, which `parseRuns` accepts.
 */
import { readFileSync } from "node:fs";
import { contract, type xdr } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { cancelSchedule } from "../cancelSchedule.ts";
import { schedulePayment } from "../schedulePayment.ts";
import {
  ADA,
  ASSET_SAC,
  DEFAULT_FIRST_RUN,
  OWNER,
  FakeGuardRpc,
  baseDraft,
  invokedCall,
  makeDeps,
  schedule,
  scriptCancel,
  scriptCreate,
} from "./helpers.ts";

interface Fixture {
  contract: string;
  source: string;
  wasmSha256: string;
  specEntries: string[];
}

const fixture: Fixture = JSON.parse(
  readFileSync(new URL("../../guard/__tests__/fixtures/polaris_guard.spec.json", import.meta.url), "utf8"),
) as Fixture;

const spec = new contract.Spec(fixture.specEntries);

const U32_MAX = 0xffff_ffff;
const MAX_ACCEPTED_FIRST_RUN = BigInt(Date.UTC(9999, 11, 31, 23, 59, 0) / 1000);

const toB64 = (vals: xdr.ScVal[]): string[] => vals.map((v) => v.toXDR("base64"));

function expectSameArgs(fn: string, expected: xdr.ScVal[], actual: xdr.ScVal[]): void {
  expect(actual, `${fn}: argument count`).toHaveLength(expected.length);
  expect(toB64(actual), `${fn}: base64 XDR args`).toEqual(toB64(expected));
}

describe("golden ABI — schedule tools match the compiled contract spec", () => {
  it("one-shot create_schedule: args byte-for-byte equal to spec.funcArgsToScVals", async () => {
    const rpc = new FakeGuardRpc();
    scriptCreate(rpc);
    const res = await schedulePayment(makeDeps(rpc))(baseDraft());

    const expected = spec.funcArgsToScVals("create_schedule", {
      owner: OWNER,
      to: ADA,
      asset: ASSET_SAC,
      amount: 500_000000n,
      first_run_at: BigInt(DEFAULT_FIRST_RUN),
      interval_secs: 0n,
      runs: 1,
    });
    expectSameArgs("create_schedule", expected, invokedCall(res.unsignedXdr).args);
  });

  it("weekly create_schedule (604800, runs 8): args byte-for-byte equal to spec.funcArgsToScVals", async () => {
    const rpc = new FakeGuardRpc();
    scriptCreate(rpc);
    const res = await schedulePayment(makeDeps(rpc))(baseDraft({ repeat: { every: "week" }, runs: 8 }));

    const expected = spec.funcArgsToScVals("create_schedule", {
      owner: OWNER,
      to: ADA,
      asset: ASSET_SAC,
      amount: 500_000000n,
      first_run_at: BigInt(DEFAULT_FIRST_RUN),
      interval_secs: 604_800n,
      runs: 8,
    });
    expectSameArgs("create_schedule", expected, invokedCall(res.unsignedXdr).args);
  });

  it("u64/runs boundary create_schedule: args byte-for-byte equal to spec.funcArgsToScVals", async () => {
    const rpc = new FakeGuardRpc();
    scriptCreate(rpc);
    const res = await schedulePayment(makeDeps(rpc))(
      baseDraft({
        firstRun: { localDate: "9999-12-31", localTime: "23:59", timeZone: "UTC" },
        repeat: { every: "day" },
        runs: U32_MAX,
      }),
    );

    const expected = spec.funcArgsToScVals("create_schedule", {
      owner: OWNER,
      to: ADA,
      asset: ASSET_SAC,
      amount: 500_000000n,
      first_run_at: MAX_ACCEPTED_FIRST_RUN,
      interval_secs: 86_400n,
      runs: U32_MAX,
    });
    expectSameArgs("create_schedule", expected, invokedCall(res.unsignedXdr).args);
  });

  it("cancel_schedule: args byte-for-byte equal to spec.funcArgsToScVals", async () => {
    const rpc = new FakeGuardRpc();
    scriptCancel(rpc, [schedule({ id: 7 })]);
    const res = await cancelSchedule(makeDeps(rpc))({ id: 7 });

    const expected = spec.funcArgsToScVals("cancel_schedule", { owner: OWNER, id: 7 });
    expectSameArgs("cancel_schedule", expected, invokedCall(res.unsignedXdr).args);
  });
});
