import assert from "node:assert/strict";
import { test } from "node:test";
import type { DuePage, ExecResult, KeeperChain, Schedule } from "./chain.ts";
import { backoffMs, type ClassifiedError } from "./errors.ts";
import { Keeper, MAX_PAGES_PER_TICK } from "./keeper.ts";
import type { LogFields, LogLevel } from "./log.ts";

/** Scriptable in-memory chain: no network, full control over each call. */
class FakeChain implements KeeperChain {
  due: number[] = [];
  listDueLimits: number[] = [];
  listDueCursors: number[] = [];
  listDueError: Error | undefined;
  /** Contract-side page cap (real pages may be smaller than the requested limit). */
  pageSize: number | undefined;
  /** When set, listDue throws on any page whose cursor is > 0. */
  failLaterPages = false;
  /** Pretend the index never ends (nextCursor always advances). */
  endless = false;
  executeCalls: Array<{ id: number; dryRun: boolean }> = [];
  checkCalls: string[] = [];
  /** Per-id scripted results; the last one repeats. Default: success. */
  script = new Map<number, Array<ExecResult | Error>>();
  pendingResult: ExecResult = { kind: "pending", hash: "H", expiresAt: 0 };
  /** Optional gate to hold an execute() open (concurrency tests). */
  gate: Promise<void> | undefined;

  async listDue(cursor: number, limit: number): Promise<DuePage> {
    this.listDueLimits.push(limit);
    this.listDueCursors.push(cursor);
    if (this.listDueError) throw this.listDueError;
    if (this.failLaterPages && cursor > 0) throw new Error("rpc hiccup on page 2");
    const size = Math.min(limit, this.pageSize ?? limit);
    const ids = this.due.slice(cursor, cursor + size);
    const next = cursor + size;
    return { ids, nextCursor: this.endless || next < this.due.length ? next : null };
  }
  async getSchedule(id: number): Promise<Schedule | null> {
    return { id, owner: "GOWNER", to: "GTO", asset: "CASSET", amount: 10n, next_run_at: 1n, interval_secs: 0n, runs_left: 1, active: true };
  }
  async execute(id: number, opts: { dryRun: boolean }): Promise<ExecResult> {
    this.executeCalls.push({ id, dryRun: opts.dryRun });
    if (this.gate) await this.gate;
    const q = this.script.get(id);
    const next = q && q.length > 1 ? q.shift() : q?.[0];
    if (next instanceof Error) throw next;
    return next ?? { kind: "success", hash: `hash-${id}`, ledger: 1 };
  }
  async checkPending(hash: string): Promise<ExecResult> {
    this.checkCalls.push(hash);
    return this.pendingResult;
  }
}

function harness(over: Partial<{ maxPerTick: number; dryRun: boolean }> = {}) {
  const chain = new FakeChain();
  const logs: Array<{ level: LogLevel } & LogFields> = [];
  let t = 1_000_000;
  const keeper = new Keeper(
    { pollSeconds: 15, maxPerTick: over.maxPerTick ?? 5, dryRun: over.dryRun ?? false },
    {
      chain,
      log: (level, f) => logs.push({ level, ...f }),
      now: () => t,
      sleep: async () => {},
    },
  );
  return { chain, keeper, logs, advance: (ms: number) => (t += ms) };
}

const rejected = (kind: ClassifiedError["kind"], name: string = kind): ExecResult => ({
  kind: "rejected",
  error: { kind, name, message: name },
});

test("a due id is executed exactly once and logged as structured data", async () => {
  const { chain, keeper, logs } = harness();
  chain.due = [7];
  const s = await keeper.tick();
  assert.deepEqual(chain.executeCalls, [{ id: 7, dryRun: false }]);
  assert.equal(s.executed, 1);
  const line = logs.find((l) => l.event === "executed");
  assert.ok(line);
  assert.equal(line.id, 7);
  assert.equal(line.hash, "hash-7");
  assert.equal(line.status, "SUCCESS");
});

test("duplicate ids in list_due are executed once", async () => {
  const { chain, keeper } = harness();
  chain.due = [3, 3, 3];
  await keeper.tick();
  assert.equal(chain.executeCalls.length, 1);
});

test("an id already in flight is never submitted a second time concurrently", async () => {
  const { chain, keeper } = harness();
  let release!: () => void;
  chain.gate = new Promise((r) => (release = r));
  chain.due = [5];
  const first = keeper.tick(); // holds execute(5) open
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(keeper.state().inflight, [5]);
  const second = await keeper.tick(); // overlaps: must skip 5
  assert.equal(second.attempted, 0);
  release();
  await first;
  assert.equal(chain.executeCalls.length, 1);
  assert.deepEqual(keeper.state().inflight, []);
});

test("a pending (unresolved) tx blocks resubmission until it resolves", async () => {
  const { chain, keeper, logs } = harness();
  chain.due = [9];
  chain.script.set(9, [{ kind: "pending", hash: "PH", expiresAt: 0 }]);
  await keeper.tick();
  assert.deepEqual(keeper.state().pending, [9]);

  await keeper.tick(); // still pending -> checked, not resubmitted
  assert.equal(chain.executeCalls.length, 1);
  assert.deepEqual(chain.checkCalls, ["PH"]);

  chain.pendingResult = { kind: "success", hash: "PH", ledger: 42 };
  chain.due = []; // the contract no longer lists it once it has run
  await keeper.tick();
  assert.deepEqual(keeper.state().pending, []);
  assert.ok(logs.some((l) => l.event === "executed" && l.hash === "PH"));
});

test("a resolved restore is never logged as executed; the schedule is re-executed instead", async () => {
  const { chain, keeper, logs } = harness();
  chain.due = [9];
  chain.script.set(9, [
    { kind: "restore_pending", hash: "RH", expiresAt: 0 },
    { kind: "success", hash: "EH", ledger: 78 },
  ]);
  await keeper.tick();
  assert.deepEqual(keeper.state().pending, [9]);
  assert.ok(logs.some((l) => l.event === "restore_pending" && l.hash === "RH"));
  assert.ok(!logs.some((l) => l.event === "executed"), "the restore landing is not an execution");

  chain.pendingResult = { kind: "success", hash: "RH", ledger: 77 };
  const s = await keeper.tick();
  assert.equal(s.executed, 1, "the schedule runs in the same tick the restore settles");
  assert.equal(chain.executeCalls.length, 2);
  assert.ok(logs.some((l) => l.event === "restore_confirmed" && l.hash === "RH"));
  assert.ok(!logs.some((l) => l.event === "executed" && l.hash === "RH"));
  assert.ok(logs.some((l) => l.event === "executed" && l.hash === "EH"));
  assert.deepEqual(keeper.state().pending, []);
});

test("a failed restore is backed off as a restore failure, not as an executed schedule", async () => {
  const { chain, keeper, logs } = harness();
  chain.due = [9];
  chain.script.set(9, [{ kind: "restore_pending", hash: "RH", expiresAt: 0 }]);
  await keeper.tick();
  chain.pendingResult = { kind: "failed", hash: "RH", error: { kind: "tx_expired", name: "txTooLate", message: "x" } };
  await keeper.tick();
  assert.ok(logs.some((l) => l.event === "restore_failed" && l.hash === "RH"));
  assert.ok(!logs.some((l) => l.event === "executed" || l.event === "failed"));
  assert.deepEqual(keeper.state().pending, []);
  assert.deepEqual(keeper.state().backedOff, [9]);
  assert.equal(chain.executeCalls.length, 1, "not re-attempted while backed off");
});

test("contract refusals back off per id, exponentially, without touching other ids", async () => {
  const { chain, keeper, logs, advance } = harness();
  chain.due = [1, 2];
  chain.script.set(1, [rejected("allowance_missing", "AllowanceMissing")]);

  await keeper.tick();
  assert.deepEqual(chain.executeCalls.map((c) => c.id), [1, 2]);
  const rej = logs.find((l) => l.event === "rejected");
  assert.ok(rej);
  assert.equal(rej.id, 1);
  assert.deepEqual((rej.error as ClassifiedError).kind, "allowance_missing");
  assert.equal(rej.retryInMs, backoffMs("allowance_missing", 1));

  // Immediately again: id 1 is suppressed, id 2 (succeeded, still listed) runs again.
  chain.executeCalls = [];
  await keeper.tick();
  assert.deepEqual(chain.executeCalls.map((c) => c.id), [2]);

  // After the backoff window id 1 is retried, and fails again with a longer wait.
  advance(backoffMs("allowance_missing", 1) + 1);
  chain.executeCalls = [];
  await keeper.tick();
  assert.ok(chain.executeCalls.some((c) => c.id === 1));
  const last = [...logs].reverse().find((l) => l.event === "rejected");
  assert.equal(last?.retryInMs, backoffMs("allowance_missing", 2));
});

test("backed-off ids cannot starve later due schedules (list_due limit grows)", async () => {
  const { chain, keeper } = harness({ maxPerTick: 1 });
  chain.due = [1, 2, 3];
  chain.script.set(1, [rejected("rule_violated", "LimitExceeded")]);
  chain.script.set(2, [rejected("rule_violated", "LimitExceeded")]);

  await keeper.tick(); // tries 1 only (maxPerTick=1) -> backed off
  await keeper.tick(); // 1 suppressed; asks for 1+1 ids, runs 2 -> backed off
  await keeper.tick(); // 1,2 suppressed; must still reach 3
  assert.deepEqual(chain.executeCalls.map((c) => c.id), [1, 2, 3]);
  assert.deepEqual(chain.listDueLimits, [1, 2, 3]);
});

test("not-due / already-executed are logged at info, not as alarms", async () => {
  const { chain, keeper, logs } = harness();
  chain.due = [1, 2];
  chain.script.set(1, [rejected("not_due", "NotDue")]);
  chain.script.set(2, [rejected("already_executed", "AlreadyExecuted")]);
  await keeper.tick();
  const levels = logs.filter((l) => l.event === "rejected").map((l) => l.level);
  assert.deepEqual(levels, ["info", "info"]);
});

test("a thrown RPC error during execute is classified transient and retried soon", async () => {
  const { chain, keeper, logs, advance } = harness();
  chain.due = [4];
  chain.script.set(4, [new Error("fetch failed"), { kind: "success", hash: "ok", ledger: 2 }]);
  await keeper.tick();
  const rej = logs.find((l) => l.event === "rejected");
  assert.equal((rej?.error as ClassifiedError).kind, "rpc");
  advance(backoffMs("rpc", 1) + 1);
  const s = await keeper.tick();
  assert.equal(s.executed, 1);
});

test("list_due failure is reported, does not throw, and recovers on the next tick", async () => {
  const { chain, keeper, logs } = harness();
  chain.due = [8];
  chain.listDueError = new Error("503 Service Unavailable");
  const bad = await keeper.tick();
  assert.equal(bad.ok, false);
  assert.equal(chain.executeCalls.length, 0);
  assert.ok(logs.some((l) => l.event === "list_due_failed" && l.level === "error"));

  chain.listDueError = undefined;
  const good = await keeper.tick();
  assert.equal(good.ok, true);
  assert.equal(good.executed, 1);
});

test("run() survives failing ticks, backs off, and stops on abort", async () => {
  const chain = new FakeChain();
  chain.listDueError = new Error("rpc down");
  const delays: number[] = [];
  const ac = new AbortController();
  const keeper = new Keeper(
    { pollSeconds: 15, maxPerTick: 5, dryRun: false },
    {
      chain,
      log: () => {},
      sleep: async (ms) => {
        delays.push(ms);
        if (delays.length === 3) ac.abort();
      },
    },
  );
  await keeper.run(ac.signal);
  assert.equal(delays.length, 3);
  assert.ok(delays[1]! > delays[0]!, "tick-level backoff grows while RPC is down");
});

test("run() polls at the configured interval when healthy", async () => {
  const chain = new FakeChain();
  const delays: number[] = [];
  const ac = new AbortController();
  const keeper = new Keeper(
    { pollSeconds: 15, maxPerTick: 5, dryRun: false },
    { chain, log: () => {}, sleep: async (ms) => { delays.push(ms); ac.abort(); } },
  );
  await keeper.run(ac.signal);
  assert.deepEqual(delays, [15_000]);
});

test("dry-run asks the chain not to submit and logs what would run", async () => {
  const { chain, keeper, logs } = harness({ dryRun: true });
  chain.due = [6];
  chain.script.set(6, [{ kind: "dry_run" }]);
  const s = await keeper.tick();
  assert.deepEqual(chain.executeCalls, [{ id: 6, dryRun: true }]);
  assert.equal(s.executed, 0);
  const line = logs.find((l) => l.event === "dry_run");
  assert.ok(line);
  assert.equal(line.id, 6);
  assert.ok(!logs.some((l) => l.event === "executed"));
});

test("an aborted signal stops the tick between ids", async () => {
  const { chain, keeper } = harness();
  chain.due = [1, 2, 3];
  const ac = new AbortController();
  ac.abort();
  const s = await keeper.tick(ac.signal);
  assert.equal(s.attempted, 0);
});

// ── polaris_guard semantics: missed runs are skipped, never replayed ─────────

/**
 * Minimal model of the contract's schedule rules (`execute_schedule`):
 * one run per call, `next_run_at` jumps to the first slot strictly after now,
 * `runs_left` is decremented once per executed run.
 */
class SkipSemanticsChain implements KeeperChain {
  nowSec = 1_000;
  executed: Array<{ atSec: number; nextRunAt: number; runsLeft: number }> = [];
  rejectWith: ClassifiedError | undefined;
  sched = { id: 1, next_run_at: 1_000, interval_secs: 100, runs_left: 5, active: true };

  async listDue(_cursor: number, limit: number): Promise<DuePage> {
    const s = this.sched;
    return { ids: s.active && s.next_run_at <= this.nowSec ? [s.id].slice(0, limit) : [], nextCursor: null };
  }
  async getSchedule(): Promise<Schedule | null> {
    const s = this.sched;
    return { id: s.id, owner: "O", to: "T", asset: "A", amount: 1n, next_run_at: BigInt(s.next_run_at), interval_secs: BigInt(s.interval_secs), runs_left: s.runs_left, active: s.active };
  }
  async execute(): Promise<ExecResult> {
    const s = this.sched;
    if (this.rejectWith) return { kind: "rejected", error: this.rejectWith };
    if (!s.active) return { kind: "rejected", error: { kind: "inactive", name: "ScheduleInactive", message: "" } };
    if (this.nowSec < s.next_run_at) return { kind: "rejected", error: { kind: "not_due", name: "ScheduleNotDue", message: "" } };
    s.runs_left -= 1;
    if (s.runs_left === 0) s.active = false;
    else s.next_run_at += (Math.floor((this.nowSec - s.next_run_at) / s.interval_secs) + 1) * s.interval_secs;
    this.executed.push({ atSec: this.nowSec, nextRunAt: s.next_run_at, runsLeft: s.runs_left });
    return { kind: "success", hash: `h${this.executed.length}`, ledger: this.nowSec };
  }
  async checkPending(): Promise<ExecResult> {
    return { kind: "pending", hash: "x", expiresAt: 0 };
  }
}

function skipHarness() {
  const chain = new SkipSemanticsChain();
  const logs: Array<{ level: LogLevel } & LogFields> = [];
  const keeper = new Keeper(
    { pollSeconds: 15, maxPerTick: 5, dryRun: false },
    { chain, log: (level, f) => logs.push({ level, ...f }), now: () => chain.nowSec * 1000, sleep: async () => {} },
  );
  return { chain, keeper, logs };
}

test("a keeper that was offline for many intervals executes the schedule once, not once per missed slot", async () => {
  const { chain, keeper, logs } = skipHarness();
  chain.nowSec = 1_000 + 100 * 50; // 50 intervals missed while the keeper was down
  const first = await keeper.tick();
  assert.equal(first.executed, 1);
  assert.equal(chain.executed.length, 1);
  assert.equal(chain.sched.runs_left, 4, "one run consumed, not 50");
  assert.ok(chain.sched.next_run_at > chain.nowSec, "moved strictly into the future");

  // Later ticks inside the same interval do nothing (nothing is due, no replay).
  for (let i = 0; i < 5; i++) {
    chain.nowSec += 15;
    assert.equal((await keeper.tick()).attempted, 0);
  }
  assert.equal(chain.executed.length, 1);

  // The executed log line carries the post-run state read back from the contract.
  const line = logs.find((l) => l.event === "executed");
  assert.deepEqual(line?.after, { next_run_at: BigInt(chain.sched.next_run_at), runs_left: 4, active: true });
});

test("after a long refusal period, fixing the cause yields exactly one run then normal cadence", async () => {
  const { chain, keeper } = skipHarness();
  chain.rejectWith = { kind: "allowance_missing", name: "InsufficientAllowance", message: "" };
  // A week of ticks while the owner's allowance is missing: attempts are rare (backoff), payments zero.
  for (let i = 0; i < 7 * 24 * 4; i++) {
    chain.nowSec += 900;
    await keeper.tick();
  }
  assert.equal(chain.executed.length, 0);
  chain.rejectWith = undefined;
  chain.nowSec += 3_600; // backoff window (max 1h) elapses
  await keeper.tick();
  assert.equal(chain.executed.length, 1, "one payment, no catch-up burst");
  assert.equal(chain.sched.runs_left, 4);
  await keeper.tick();
  assert.equal(chain.executed.length, 1);
});

test("a not-due answer (clock skew) is handled quietly: info log, short backoff, then it runs", async () => {
  const { chain, keeper, logs } = skipHarness();
  chain.sched.next_run_at = 2_000;
  // list_due (stale read) claims the id is due although the ledger clock disagrees.
  chain.listDue = async () => ({ ids: [1], nextCursor: null });
  chain.nowSec = 1_500;
  const s = await keeper.tick();
  assert.equal(s.failed, 1);
  const rej = logs.find((l) => l.event === "rejected");
  assert.equal(rej?.level, "info");
  assert.equal((rej?.error as ClassifiedError).name, "ScheduleNotDue");
  assert.equal(rej?.retryInMs, backoffMs("not_due", 1));
  assert.equal((await keeper.tick()).attempted, 0, "suppressed during backoff");

  chain.nowSec = 2_000 + 30; // due now, backoff (15s) over
  assert.equal((await keeper.tick()).executed, 1);
});

// ── paginated list_due: bounded cursor loop ─────────────────────────────────

test("scans pages until it has KEEPER_MAX_PER_TICK eligible ids, then stops", async () => {
  const { chain, keeper } = harness({ maxPerTick: 3 });
  chain.due = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  chain.pageSize = 2; // contract hands out 2 ids per page
  await keeper.tick();
  assert.deepEqual(chain.executeCalls.map((c) => c.id), [1, 2, 3]);
  assert.deepEqual(chain.listDueCursors, [0, 2], "third id found on page 2; page 3 never requested");
});

test("pages are followed past backed-off ids so later schedules are still reached", async () => {
  const { chain, keeper } = harness({ maxPerTick: 2 });
  chain.due = [1, 2, 3, 4, 5];
  chain.pageSize = 2;
  chain.script.set(1, [rejected("rule_violated", "OverDailyLimit")]);
  chain.script.set(2, [rejected("rule_violated", "OverDailyLimit")]);
  await keeper.tick(); // attempts 1,2 -> both backed off
  chain.executeCalls = [];
  chain.listDueCursors = [];
  await keeper.tick(); // 1,2 suppressed: the sweep resumes past their page and reaches 3,4
  assert.deepEqual(chain.executeCalls.map((c) => c.id), [3, 4]);
  assert.deepEqual(chain.listDueCursors, [2], "resumed instead of restarting at 0 (no re-scan of backed-off ids)");
});

test("scan ends when the contract reports no more pages", async () => {
  const { chain, keeper } = harness({ maxPerTick: 50 });
  chain.due = [1, 2, 3];
  chain.pageSize = 2;
  const s = await keeper.tick();
  assert.equal(s.due, 3);
  assert.deepEqual(chain.listDueCursors, [0, 2], "second page returned nextCursor=null");
});

test("an endless cursor is still bounded by MAX_PAGES_PER_TICK", async () => {
  const { chain, keeper } = harness({ maxPerTick: 1000 });
  chain.due = Array.from({ length: 500 }, (_, i) => i + 1);
  chain.pageSize = 1;
  chain.endless = true;
  await keeper.tick();
  assert.equal(chain.listDueCursors.length, MAX_PAGES_PER_TICK);
});

test("a cursor that does not advance ends the scan (no infinite loop)", async () => {
  const { chain, keeper } = harness();
  let calls = 0;
  chain.listDue = async (cursor: number) => {
    calls += 1;
    return { ids: [], nextCursor: cursor };
  };
  const s = await keeper.tick();
  assert.equal(s.ok, true);
  assert.equal(calls, 1);
});

test("a failure on a later page keeps what was found; a failure on page 1 fails the tick", async () => {
  const { chain, keeper, logs } = harness({ maxPerTick: 5 });
  chain.due = [1, 2, 3, 4];
  chain.pageSize = 2;
  chain.failLaterPages = true;
  const s = await keeper.tick();
  assert.equal(s.ok, true);
  assert.deepEqual(chain.executeCalls.map((c) => c.id), [1, 2]);
  assert.ok(logs.some((l) => l.event === "list_due_page_failed"));
  assert.equal(keeper.state().sweepCursor, 2, "the failed page is retried next tick, not skipped");

  chain.listDueError = new Error("down");
  assert.equal((await keeper.tick()).ok, false);
});

// ── F1: persistent sweep cursor over the global id space ────────────────────

/**
 * Models the guard's global, ever-growing id space: ids `1..idSpace` exist
 * (holes included, never reused) and `list_due` scans a window of `limit` ids
 * from `cursor`, returning end-of-space as `null` (the port's translation of
 * the contract's cursor `0`). Owners are deliberately absent: the id space is
 * shared by every tenant, which is why a fixed per-tick window starves ids.
 */
class SparseIdSpaceChain implements KeeperChain {
  readonly idSpace: number;
  readonly dueIds: Set<number>;
  listDueCursors: number[] = [];
  executed: number[] = [];

  constructor(idSpace: number, dueIds: number[]) {
    this.idSpace = idSpace;
    this.dueIds = new Set(dueIds);
  }

  async listDue(cursor: number, limit: number): Promise<DuePage> {
    this.listDueCursors.push(cursor);
    const endOfSpace = this.idSpace + 1;
    const start = Math.max(1, cursor);
    if (limit === 0 || start >= endOfSpace) return { ids: [], nextCursor: null };
    const end = Math.min(start + limit, endOfSpace);
    const ids: number[] = [];
    for (let id = start; id < end; id++) if (this.dueIds.has(id)) ids.push(id);
    return { ids, nextCursor: end >= endOfSpace ? null : end };
  }
  async getSchedule(): Promise<Schedule | null> {
    return null;
  }
  async execute(id: number): Promise<ExecResult> {
    this.executed.push(id);
    return { kind: "success", hash: `h${id}`, ledger: 1 };
  }
  async checkPending(): Promise<ExecResult> {
    return { kind: "pending", hash: "x", expiresAt: 0 };
  }
}

function sparseHarness(idSpace: number, dueIds: number[], maxPerTick: number) {
  const chain = new SparseIdSpaceChain(idSpace, dueIds);
  const keeper = new Keeper(
    { pollSeconds: 15, maxPerTick, dryRun: false },
    { chain, log: () => {}, now: () => 1_000_000, sleep: async () => {} },
  );
  return { chain, keeper };
}

test("review F1: a due id past one tick's page window is executed within N ticks (id 999)", async () => {
  // 10 pages x 5 ids = 50 ids per tick. With the old cursor-reset-every-tick
  // scan, id 999 was never reached (the reviewer's repro: 20 ticks, 0 runs).
  const { chain, keeper } = sparseHarness(1000, [999], 5);
  let executedAtTick = 0;
  for (let tickNo = 1; tickNo <= 20; tickNo++) {
    const s = await keeper.tick();
    if (s.executed > 0) {
      executedAtTick = tickNo;
      break;
    }
    assert.notEqual(keeper.state().sweepCursor, 0, `tick ${tickNo} must not restart at 0 before reaching the far id`);
  }
  assert.deepEqual(chain.executed, [999], "the far id was reached and executed");
  assert.ok(executedAtTick > 0 && executedAtTick <= 20, `executed on tick ${executedAtTick}`);
  assert.equal(chain.listDueCursors.length, 200, "same 200 calls as the reviewer's repro, but call #200 scans ids 996..1000");

  // The scan window slid forward instead of restarting: every cursor recorded
  // before the wrap (which happens on the tick that reaches end-of-space) is
  // strictly greater than the previous one, so nothing was skipped or rescanned.
  const cursors = chain.listDueCursors;
  assert.equal(cursors[0], 0);
  assert.ok(cursors.at(-1)! > 900, "the sweep reached the top of the id space");
  assert.deepEqual(cursors, [...cursors].sort((a, b) => a - b));
  assert.equal(new Set(cursors).size, cursors.length);

  // The due id sat in the final window, so that same tick wrapped the cursor:
  // the next tick starts a fresh sweep at the bottom.
  assert.equal(keeper.state().sweepCursor, 0);
});

test("review F1 cross-tenant: front-page due ids do not monopolize the sweep", async () => {
  const { chain, keeper } = sparseHarness(1000, [1, 999], 5);
  for (let tickNo = 1; tickNo <= 19; tickNo++) await keeper.tick();
  assert.deepEqual(chain.executed, [1], "id 1 paid once, not once per tick");
  await keeper.tick(); // tick 20 reaches the 996..1000 window
  assert.deepEqual(chain.executed, [1, 999], "the tenant at the far id is served too");
});

test("the sweep cursor resumes across ticks and wraps only at the end of the id space", async () => {
  const { chain, keeper } = sparseHarness(12, [11], 1);
  await keeper.tick(); // scans cursors 0,2..10 (10 pages x 1 id), nothing due
  assert.deepEqual(chain.executed, []);
  assert.equal(keeper.state().sweepCursor, 11, "resumes where the page cap stopped it");

  await keeper.tick(); // cursor 11 -> id 11 found and executed
  assert.deepEqual(chain.executed, [11]);
  assert.equal(keeper.state().sweepCursor, 12, "advanced past the executed id");

  await keeper.tick(); // cursor 12 -> id 12, end of space -> wrap
  assert.equal(keeper.state().sweepCursor, 0);

  const before = chain.listDueCursors.length;
  await keeper.tick(); // a fresh sweep starts at the bottom
  assert.equal(chain.listDueCursors[before], 0);
});
