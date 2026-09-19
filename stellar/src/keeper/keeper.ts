/**
 * The keeper loop.
 *
 * Trust model: the keeper is a dumb, untrusted trigger. It never decides
 * whether a payment is allowed — the guard contract validates time, amount,
 * recipient and limits inside `execute_schedule`. All the keeper adds is
 * liveness (calling the contract when a schedule is due) plus operational
 * hygiene: never double-submit, back off on refusals, survive RPC hiccups.
 *
 * State is in-memory only. That is safe by construction: `list_due` is the
 * source of truth after a restart, and the contract rejects a stale or
 * duplicate run, so the worst case of losing state is one extra (harmless,
 * rejected-at-simulation) attempt.
 */
import {
  backoffMs,
  classifyThrown,
  type ClassifiedError,
  type ErrorKind,
} from "./errors.ts";
import type { ExecResult, KeeperChain, Schedule } from "./chain.ts";
import type { Logger } from "./log.ts";

/** Upper bound on `list_due` page size regardless of backoff pressure. */
const MAX_LIST_LIMIT = 200;
/** Cap for the tick-level (list_due failure) backoff. */
const MAX_TICK_BACKOFF_MS = 2 * 60_000;

export interface KeeperOptions {
  pollSeconds: number;
  maxPerTick: number;
  dryRun: boolean;
}

export interface KeeperDeps {
  chain: KeeperChain;
  log: Logger;
  now?: () => number;
  /** Must resolve early when `signal` aborts. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface TickSummary {
  /** false when `list_due` itself failed (RPC down, contract error). */
  ok: boolean;
  due: number;
  attempted: number;
  executed: number;
  failed: number;
  error?: ClassifiedError;
}

interface BackoffEntry {
  failures: number;
  until: number;
  kind: ErrorKind;
}

interface PendingTx {
  hash: string;
  expiresAt: number;
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done(): void {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

export class Keeper {
  private readonly chain: KeeperChain;
  private readonly log: Logger;
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;

  /** Ids with an `execute` call currently running (never submitted twice at once). */
  private readonly inflight = new Set<number>();
  /** Ids whose transaction was submitted but has no final status yet. */
  private readonly pending = new Map<number, PendingTx>();
  /** Per-id backoff after a refusal/failure. */
  private readonly backoff = new Map<number, BackoffEntry>();
  private tickFailures = 0;
  private readonly opts: KeeperOptions;

  constructor(opts: KeeperOptions, deps: KeeperDeps) {
    this.opts = opts;
    this.chain = deps.chain;
    this.log = deps.log;
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? abortableSleep;
  }

  /** Snapshot for tests/diagnostics. */
  state(): { inflight: number[]; pending: number[]; backedOff: number[] } {
    const now = this.now();
    return {
      inflight: [...this.inflight],
      pending: [...this.pending.keys()],
      backedOff: [...this.backoff].filter(([, b]) => b.until > now).map(([id]) => id),
    };
  }

  /** One poll cycle: resolve unresolved txs, list due ids, execute the eligible ones. */
  async tick(signal?: AbortSignal): Promise<TickSummary> {
    await this.resolvePending();

    const now = this.now();
    const suppressed = (id: number): boolean =>
      this.inflight.has(id) || this.pending.has(id) || (this.backoff.get(id)?.until ?? 0) > now;

    // Ask for enough ids that backed-off/pending ones cannot starve the rest.
    const skipCount = new Set([...this.inflight, ...this.pending.keys(), ...this.activeBackoffIds(now)]).size;
    const limit = Math.min(MAX_LIST_LIMIT, this.opts.maxPerTick + skipCount);

    let due: number[];
    try {
      due = await this.chain.listDue(limit);
    } catch (err) {
      const error = classifyThrown(err);
      this.tickFailures += 1;
      this.log("error", { event: "list_due_failed", error, consecutiveFailures: this.tickFailures });
      return { ok: false, due: 0, attempted: 0, executed: 0, failed: 0, error };
    }
    this.tickFailures = 0;

    const dueIds = [...new Set(due)];
    this.pruneBackoff(new Set(dueIds), now);
    const candidates = dueIds.filter((id) => !suppressed(id)).slice(0, this.opts.maxPerTick);
    this.log("debug", { event: "tick", due: dueIds, candidates, limit });

    const summary: TickSummary = { ok: true, due: dueIds.length, attempted: 0, executed: 0, failed: 0 };
    for (const id of candidates) {
      if (signal?.aborted) break;
      summary.attempted += 1;
      const result = await this.runOne(id);
      if (result.kind === "success") summary.executed += 1;
      else if (result.kind !== "dry_run" && result.kind !== "pending") summary.failed += 1;
    }
    return summary;
  }

  /** Poll until aborted. Never throws: a failing tick just backs off and retries. */
  async run(signal: AbortSignal): Promise<void> {
    const pollMs = this.opts.pollSeconds * 1000;
    this.log("info", { event: "keeper_started", pollSeconds: this.opts.pollSeconds, dryRun: this.opts.dryRun });
    while (!signal.aborted) {
      let ok = true;
      try {
        ok = (await this.tick(signal)).ok;
      } catch (err) {
        // Defensive: tick() is written not to throw, but the loop must never die.
        ok = false;
        this.tickFailures += 1;
        this.log("error", { event: "tick_crashed", error: classifyThrown(err) });
      }
      const delay = ok ? pollMs : Math.min(MAX_TICK_BACKOFF_MS, pollMs * 2 ** Math.min(this.tickFailures, 6));
      await this.sleep(delay, signal);
    }
    this.log("info", { event: "keeper_stopped", pending: [...this.pending.keys()] });
  }

  // ── internals ────────────────────────────────────────────────────────────

  private async runOne(id: number): Promise<ExecResult> {
    if (this.inflight.has(id) || this.pending.has(id)) {
      // Unreachable via tick() (filtered above); kept as the hard invariant.
      return { kind: "dry_run", note: "already in flight" };
    }
    this.inflight.add(id);
    let result: ExecResult;
    try {
      result = await this.chain.execute(id, { dryRun: this.opts.dryRun });
    } catch (err) {
      result = { kind: "rejected", error: classifyThrown(err) };
    } finally {
      this.inflight.delete(id);
    }
    await this.handle(id, result);
    return result;
  }

  private async handle(id: number, result: ExecResult): Promise<void> {
    switch (result.kind) {
      case "success":
        this.backoff.delete(id);
        this.log("info", { event: "executed", id, hash: result.hash, status: "SUCCESS", ledger: result.ledger });
        return;
      case "dry_run": {
        const schedule = await this.describe(id);
        this.log("info", { event: "dry_run", id, note: result.note, schedule });
        return;
      }
      case "pending":
        this.pending.set(id, { hash: result.hash, expiresAt: result.expiresAt });
        this.log("warn", { event: "pending", id, hash: result.hash, status: "PENDING" });
        return;
      case "failed":
        this.registerFailure(id, result.error);
        this.log("error", { event: "failed", id, hash: result.hash, status: "FAILED", error: result.error, retryInMs: this.retryIn(id) });
        return;
      case "rejected":
        this.registerFailure(id, result.error);
        this.log(levelFor(result.error.kind), {
          event: "rejected",
          id,
          hash: result.hash,
          status: "REJECTED",
          error: result.error,
          retryInMs: this.retryIn(id),
        });
        return;
    }
  }

  private async resolvePending(): Promise<void> {
    for (const [id, p] of [...this.pending]) {
      let res: ExecResult;
      try {
        res = await this.chain.checkPending(p.hash, p.expiresAt);
      } catch (err) {
        this.log("warn", { event: "pending_check_failed", id, hash: p.hash, error: classifyThrown(err) });
        continue; // keep it pending; try again next tick
      }
      if (res.kind === "pending") continue;
      this.pending.delete(id);
      await this.handle(id, res);
    }
  }

  private registerFailure(id: number, error: ClassifiedError): void {
    const prev = this.backoff.get(id);
    const failures = (prev?.kind === error.kind ? prev.failures : 0) + 1;
    this.backoff.set(id, { failures, kind: error.kind, until: this.now() + backoffMs(error.kind, failures) });
  }

  private retryIn(id: number): number {
    return Math.max(0, (this.backoff.get(id)?.until ?? 0) - this.now());
  }

  private activeBackoffIds(now: number): number[] {
    return [...this.backoff].filter(([, b]) => b.until > now).map(([id]) => id);
  }

  /** Forget backoff entries for ids that are no longer due and whose window has passed. */
  private pruneBackoff(dueNow: Set<number>, now: number): void {
    for (const [id, b] of this.backoff) {
      if (b.until <= now && !dueNow.has(id)) this.backoff.delete(id);
    }
  }

  private async describe(id: number): Promise<Schedule | undefined> {
    try {
      return await this.chain.getSchedule(id);
    } catch {
      return undefined; // purely informational
    }
  }
}

/** Expected refusals are info; things an operator should look at are warn/error. */
function levelFor(kind: ErrorKind): "info" | "warn" | "error" {
  switch (kind) {
    case "already_executed":
    case "not_due":
      return "info";
    case "keeper_funds":
      return "error";
    default:
      return "warn";
  }
}
