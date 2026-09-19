import { scValToNative } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { cancelSchedule } from "../cancelSchedule.ts";
import { ScheduleAmbiguous } from "../errors.ts";
import {
  ADA,
  GUARD_ID,
  GUARD_ID_2,
  OWNER,
  FakeGuardRpc,
  guardClient,
  invokedCall,
  makeDeps,
  refusalOf,
  schedule,
  scriptCancel,
} from "./helpers.ts";

const deps = (rpc: FakeGuardRpc, over = {}) => makeDeps(rpc, over);

async function ambiguousOf(fn: () => Promise<unknown>): Promise<ScheduleAmbiguous> {
  try {
    await fn();
  } catch (e) {
    if (e instanceof ScheduleAmbiguous) return e;
    throw e;
  }
  throw new Error("expected ScheduleAmbiguous");
}

describe("cancelSchedule — resolution", () => {
  it("cancels by id and decodes cancel_schedule(owner, id)", async () => {
    const rpc = new FakeGuardRpc();
    scriptCancel(rpc, [schedule({ id: 7 })]);
    const res = await cancelSchedule(deps(rpc))({ id: 7 });

    const call = invokedCall(res.unsignedXdr);
    expect(call.name).toBe("cancel_schedule");
    expect(call.contractId).toBe(GUARD_ID);
    expect(call.tx.source).toBe(OWNER);
    expect(call.args.map((a) => scValToNative(a))).toEqual([OWNER, 7]);
    expect(res.confirmation).toBe("light");
    expect(res.id).toBe(7);
    expect(res.summary.lines).toContain("Schedule id: 7");
    expect(res.summary.lines).toContain(`Recipient: ada (${ADA})`);
    expect(res.summary.lines).toContain("Amount: 5 USDC per run");
    expect(res.summary.lines).toContain("Confirmation: light — cancelling a schedule only tightens limits (owner auth only)");
    expect(res.summary.lines).toContain("Approval: owner signature required");
  });

  it("cancels by recipient when exactly one schedule matches", async () => {
    const rpc = new FakeGuardRpc();
    scriptCancel(rpc, [schedule({ id: 3 }), schedule({ id: 9, to: GUARD_ID_2 })]);
    const res = await cancelSchedule(deps(rpc))({ recipient: "ada" });
    expect(res.id).toBe(3);
    expect(res.recipientAlias).toBe("ada");
  });

  it("matches the alias case-insensitively and trimmed", async () => {
    const rpc = new FakeGuardRpc();
    scriptCancel(rpc, [schedule({ id: 3 })]);
    const res = await cancelSchedule(deps(rpc))({ recipient: "  ADA  " });
    expect(res.id).toBe(3);
  });

  it("throws ScheduleAmbiguous with the candidate list when two match", async () => {
    const rpc = new FakeGuardRpc();
    scriptCancel(rpc, [schedule({ id: 1 }), schedule({ id: 2 })]);
    const err = await ambiguousOf(() => cancelSchedule(deps(rpc))({ recipient: "ada" }));
    expect(err.code).toBe("schedule_ambiguous");
    expect(err.candidates.map((c) => c.id)).toEqual([1, 2]);
    expect(err.candidates[0]?.recipientAlias).toBe("ada");
    expect(err.candidates[0]?.amount).toBe("5");
  });

  it("picks the next run when which='next'", async () => {
    const rpc = new FakeGuardRpc();
    scriptCancel(rpc, [
      schedule({ id: 1, next_run_at: 2_000_000_000n }),
      schedule({ id: 2, next_run_at: 1_800_000_000n }),
    ]);
    const res = await cancelSchedule(deps(rpc))({ recipient: "ada", which: "next" });
    expect(res.id).toBe(2);
  });

  it("picks the last run when which='last'", async () => {
    const rpc = new FakeGuardRpc();
    scriptCancel(rpc, [
      schedule({ id: 1, next_run_at: 2_000_000_000n }),
      schedule({ id: 2, next_run_at: 1_800_000_000n }),
    ]);
    const res = await cancelSchedule(deps(rpc))({ recipient: "ada", which: "last" });
    expect(res.id).toBe(1);
  });

  it("lets an explicit id win over recipient", async () => {
    const rpc = new FakeGuardRpc();
    scriptCancel(rpc, [schedule({ id: 5 }), schedule({ id: 6 })]);
    const res = await cancelSchedule(deps(rpc))({ id: 6, recipient: "nobody" });
    expect(res.id).toBe(6);
  });

  it("parametrises the guard contract id", async () => {
    const rpc = new FakeGuardRpc();
    scriptCancel(rpc, [schedule({ id: 7 })]);
    const res = await cancelSchedule(deps(rpc, { guard: guardClient(rpc, GUARD_ID_2) }))({ id: 7 });
    expect(invokedCall(res.unsignedXdr).contractId).toBe(GUARD_ID_2);
  });
});

describe("cancelSchedule — refusals (never a raw TypeError)", () => {
  it("refuses a null request", async () => {
    const rpc = new FakeGuardRpc();
    const err = await refusalOf(() => cancelSchedule(deps(rpc))(null));
    expect(err.code).toBe("invalid_intent");
    expect(rpc.simulated).toHaveLength(0);
  });

  it("refuses a request with neither id nor recipient", async () => {
    const rpc = new FakeGuardRpc();
    const err = await refusalOf(() => cancelSchedule(deps(rpc))({ which: "next" }));
    expect(err.code).toBe("invalid_intent");
  });

  it("refuses a non-integer id", async () => {
    const rpc = new FakeGuardRpc();
    const err = await refusalOf(() => cancelSchedule(deps(rpc))({ id: 1.5 }));
    expect(err.code).toBe("invalid_intent");
  });

  it("refuses a non-string recipient", async () => {
    const rpc = new FakeGuardRpc();
    const err = await refusalOf(() => cancelSchedule(deps(rpc))({ recipient: 7 }));
    expect(err.code).toBe("unknown_recipient");
  });

  it("refuses an unknown alias with unknown_recipient", async () => {
    const rpc = new FakeGuardRpc();
    scriptCancel(rpc, []);
    const err = await refusalOf(() => cancelSchedule(deps(rpc))({ recipient: "nobody" }));
    expect(err.code).toBe("unknown_recipient");
  });

  it("refuses when no active schedule matches the recipient", async () => {
    const rpc = new FakeGuardRpc();
    scriptCancel(rpc, [schedule({ id: 1, to: GUARD_ID_2 })]);
    const err = await refusalOf(() => cancelSchedule(deps(rpc))({ recipient: "ada" }));
    expect(err.code).toBe("schedule_not_found");
  });

  it("refuses when the id is not among the active schedules", async () => {
    const rpc = new FakeGuardRpc();
    scriptCancel(rpc, [schedule({ id: 1 }), schedule({ id: 2, active: false })]);
    const err = await refusalOf(() => cancelSchedule(deps(rpc))({ id: 2 }));
    expect(err.code).toBe("schedule_not_found");
  });

  it("refuses an invalid which value", async () => {
    const rpc = new FakeGuardRpc();
    const err = await refusalOf(() => cancelSchedule(deps(rpc))({ recipient: "ada", which: "middle" }));
    expect(err.code).toBe("invalid_intent");
  });

  it("refuses with not_configured when the guard client is missing", () => {
    const err = (() => {
      try {
        cancelSchedule({ ownerAddress: OWNER, aliases: {}, assets: { get: () => undefined } } as never);
      } catch (e) {
        return e as { code?: string };
      }
      throw new Error("expected a refusal");
    })();
    expect(err.code).toBe("not_configured");
  });
});
