import { describe, expect, it } from "vitest";
import { DEFAULT_POLL_SECONDS } from "../constants.ts";
import { listUpcoming } from "../listUpcoming.ts";
import {
  ADA,
  ASSET_SAC,
  FakeGuardRpc,
  GUARD_ID,
  OWNER,
  errSim,
  makeDeps,
  refusalOf,
  schedule,
  scriptList,
} from "./helpers.ts";

const NOW = new Date("2026-09-19T12:00:00.000Z");
const NOW_SEC = Math.floor(NOW.getTime() / 1000);
const deps = (rpc: FakeGuardRpc, over = {}) => makeDeps(rpc, over);

describe("listUpcoming — view models", () => {
  it("maps a schedule to the documented view model", async () => {
    const rpc = new FakeGuardRpc();
    scriptList(rpc, [schedule({ id: 4, next_run_at: BigInt(NOW_SEC + 3600) })]);
    const rows = await listUpcoming(deps(rpc))({ now: NOW, timeZone: "Europe/Istanbul" });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      id: 4,
      recipientAlias: "ada",
      recipientAddress: ADA,
      asset: "USDC",
      amountRaw: "50000000",
      amount: "5",
      nextRunUtc: "2026-09-19T13:00:00.000Z",
      nextRunLocal: "2026-09-19T16:00:00+03:00",
      runsLeft: 1,
      intervalWords: "one-shot (no repeat)",
      status: "scheduled",
    });
  });

  it("renders the next run in the requested zone (half-hour offset)", async () => {
    const rpc = new FakeGuardRpc();
    const due = Date.UTC(2026, 8, 20, 12, 0, 0) / 1000;
    scriptList(rpc, [schedule({ next_run_at: BigInt(due) })]);
    const rows = await listUpcoming(deps(rpc))({ now: NOW, timeZone: "Asia/Kolkata" });
    expect(rows[0]?.nextRunLocal).toBe("2026-09-20T17:30:00+05:30");
    expect(rows[0]?.nextRunUtc).toBe("2026-09-20T12:00:00.000Z");
  });

  it("shows interval words for a weekly recurrence", async () => {
    const rpc = new FakeGuardRpc();
    scriptList(rpc, [schedule({ next_run_at: BigInt(NOW_SEC + 600), interval_secs: 604_800n })]);
    const rows = await listUpcoming(deps(rpc))({ now: NOW, timeZone: "UTC" });
    expect(rows[0]?.intervalWords).toBe("every week");
  });

  it("returns null recipientAlias for an unknown address", async () => {
    const rpc = new FakeGuardRpc();
    scriptList(rpc, [schedule({ to: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5" })]);
    const rows = await listUpcoming(deps(rpc))({ now: NOW, timeZone: "UTC" });
    expect(rows[0]?.recipientAlias).toBeNull();
  });

  it("falls back to the SAC id when the asset code is unknown", async () => {
    const rpc = new FakeGuardRpc();
    scriptList(rpc, [schedule({ asset: GUARD_ID })]);
    const rows = await listUpcoming(deps(rpc))({ now: NOW, timeZone: "UTC" });
    expect(rows[0]?.asset).toBe(GUARD_ID);
  });

  it("sorts rows by next run", async () => {
    const rpc = new FakeGuardRpc();
    scriptList(rpc, [
      schedule({ id: 2, next_run_at: BigInt(NOW_SEC + 7200) }),
      schedule({ id: 1, next_run_at: BigInt(NOW_SEC + 3600) }),
    ]);
    const rows = await listUpcoming(deps(rpc))({ now: NOW, timeZone: "UTC" });
    expect(rows.map((r) => r.id)).toEqual([1, 2]);
  });
});

describe("listUpcoming — status grading", () => {
  it("grades a future run as scheduled", async () => {
    const rpc = new FakeGuardRpc();
    scriptList(rpc, [schedule({ next_run_at: BigInt(NOW_SEC + 3600) })]);
    const rows = await listUpcoming(deps(rpc))({ now: NOW, timeZone: "UTC" });
    expect(rows[0]?.status).toBe("scheduled");
  });

  it("grades an overdue run (<2 poll intervals) as due", async () => {
    const rpc = new FakeGuardRpc();
    scriptList(rpc, [schedule({ next_run_at: BigInt(NOW_SEC - 10) })]);
    const rows = await listUpcoming(deps(rpc))({ now: NOW, timeZone: "UTC" });
    expect(rows[0]?.status).toBe("due");
  });

  it("grades a long-overdue run (>=2 poll intervals) as delayed", async () => {
    const rpc = new FakeGuardRpc();
    scriptList(rpc, [schedule({ next_run_at: BigInt(NOW_SEC - 40) })]);
    const rows = await listUpcoming(deps(rpc))({ now: NOW, timeZone: "UTC" });
    expect(rows[0]?.status).toBe("delayed");
  });

  it("grades exactly 2 poll intervals overdue as delayed (boundary)", async () => {
    const rpc = new FakeGuardRpc();
    scriptList(rpc, [schedule({ next_run_at: BigInt(NOW_SEC - 2 * DEFAULT_POLL_SECONDS) })]);
    const rows = await listUpcoming(deps(rpc))({ now: NOW, timeZone: "UTC" });
    expect(rows[0]?.status).toBe("delayed");
  });

  it("grades one second before 2 poll intervals overdue as due (boundary)", async () => {
    const rpc = new FakeGuardRpc();
    scriptList(rpc, [schedule({ next_run_at: BigInt(NOW_SEC - (2 * DEFAULT_POLL_SECONDS - 1)) })]);
    const rows = await listUpcoming(deps(rpc))({ now: NOW, timeZone: "UTC" });
    expect(rows[0]?.status).toBe("due");
  });

  it("honours an injected poll interval", async () => {
    const rpc = new FakeGuardRpc();
    scriptList(rpc, [schedule({ next_run_at: BigInt(NOW_SEC - 10) })]);
    const rows = await listUpcoming(deps(rpc, { pollSeconds: 5 }))({ now: NOW, timeZone: "UTC" });
    expect(rows[0]?.status).toBe("delayed");
  });

  it("grades a spent schedule as finished", async () => {
    const rpc = new FakeGuardRpc();
    scriptList(rpc, [schedule({ next_run_at: BigInt(NOW_SEC - 40), runs_left: 0 })]);
    const rows = await listUpcoming(deps(rpc))({ now: NOW, timeZone: "UTC" });
    expect(rows[0]?.status).toBe("finished");
  });

  it("grades an inactive schedule as finished", async () => {
    const rpc = new FakeGuardRpc();
    scriptList(rpc, [schedule({ active: false })]);
    const rows = await listUpcoming(deps(rpc))({ now: NOW, timeZone: "UTC" });
    expect(rows[0]?.status).toBe("finished");
  });
});

describe("listUpcoming — input validation", () => {
  it("refuses a missing options object", async () => {
    const rpc = new FakeGuardRpc();
    const err = await refusalOf(() => listUpcoming(deps(rpc))(undefined));
    expect(err.code).toBe("invalid_intent");
  });

  it("refuses an invalid timezone", async () => {
    const rpc = new FakeGuardRpc();
    const err = await refusalOf(() => listUpcoming(deps(rpc))({ now: NOW, timeZone: "Nope/Nope" }));
    expect(err.code).toBe("invalid_time");
  });

  it("refuses an invalid now", async () => {
    const rpc = new FakeGuardRpc();
    const err = await refusalOf(() => listUpcoming(deps(rpc))({ now: new Date("nope"), timeZone: "UTC" }));
    expect(err.code).toBe("invalid_time");
  });

  it("refuses with not_configured when the guard client is missing", () => {
    let caught: { code?: string } | undefined;
    try {
      listUpcoming({ ownerAddress: OWNER, aliases: {}, assets: { get: () => undefined } } as never);
    } catch (e) {
      caught = e as { code?: string };
    }
    expect(caught?.code).toBe("not_configured");
  });

  it("returns an empty list when there are no schedules", async () => {
    const rpc = new FakeGuardRpc();
    scriptList(rpc, []);
    const rows = await listUpcoming(deps(rpc))({ now: NOW, timeZone: "UTC" });
    expect(rows).toEqual([]);
  });

  it("translates a guard read failure through scheduleRefusalFromGuard", async () => {
    const rpc = new FakeGuardRpc();
    rpc.sims = [errSim("HostError: Error(Contract, #100)")];
    const err = await refusalOf(() => listUpcoming(deps(rpc))({ now: NOW, timeZone: "UTC" }));
    expect(err.code).toBe("guard_rule_missing");
    expect(err.details?.guardErrorName).toBe("NotConfigured");
  });

  it("exposes the pinned USDC asset code and raw amount", async () => {
    const rpc = new FakeGuardRpc();
    scriptList(rpc, [schedule({ asset: ASSET_SAC, amount: 12_345678n })]);
    const rows = await listUpcoming(deps(rpc))({ now: NOW, timeZone: "UTC" });
    expect(rows[0]?.asset).toBe("USDC");
    expect(rows[0]?.amountRaw).toBe("12345678");
    expect(rows[0]?.amount).toBe("1.2345678");
  });
});
