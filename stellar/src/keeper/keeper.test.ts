import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExecResult, KeeperChain, Schedule } from "./chain.ts";
import { backoffMs, type ClassifiedError } from "./errors.ts";
import { Keeper } from "./keeper.ts";
import type { LogFields, LogLevel } from "./log.ts";

/** Scriptable in-memory chain: no network, full control over each call. */
class FakeChain implements KeeperChain {
  due: number[] = [];
  listDueLimits: number[] = [];
  listDueError: Error | undefined;
  executeCalls: Array<{ id: number; dryRun: boolean }> = [];
  checkCalls: string[] = [];
  /** Per-id scripted results; the last one repeats. Default: success. */
  script = new Map<number, Array<ExecResult | Error>>();
  pendingResult: ExecResult = { kind: "pending", hash: "H", expiresAt: 0 };
  /** Optional gate to hold an execute() open (concurrency tests). */
  gate: Promise<void> | undefined;

  async listDue(limit: number): Promise<number[]> {
    this.listDueLimits.push(limit);
    if (this.listDueError) throw this.listDueError;
    return this.due.slice(0, limit);
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

  async listDue(limit: number): Promise<number[]> {
    const s = this.sched;
    return s.active && s.next_run_at <= this.nowSec ? [s.id].slice(0, limit) : [];
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
  chain.listDue = async () => [1];
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
