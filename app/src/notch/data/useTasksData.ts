/**
 * Tasks page data — the owner's on-chain scheduled payments (NW3).
 *
 * The page renders only [`TaskRow`]s; this hook adapts the real `listUpcoming`
 * view models (via `@/lib/schedules`) into that shape. The mock rows in
 * `@/lib/mockData` are an explicit **demo** fallback, used only when the app is
 * not inside Tauri (the browser preview). A real read failure — including a
 * missing owner — is surfaced as an error with a Retry, never mock data.
 *
 * Cancel and create are the only value-moving actions here: each builds an
 * unsigned `@/lib/schedulesLive` call and pushes it through the shared
 * `@/lib/useTxRun` pipeline (approval card → Touch ID → wallet signing →
 * submit). Nothing else on the page moves value.
 *
 * Performance: the last successful read is kept in an **owner-scoped** cache
 * (`tasksCache`, keyed by `ownerAddress|networkPassphrase`) and concurrent
 * mounts share one in-flight load. A remount therefore paints the previous
 * rows immediately and revalidates in the background — it never blocks the
 * first frame on the chain read, and never fires a second identical read. The
 * key means a snapshot is never seeded or served after the active wallet
 * account changes; the cache is cleared on that edge and the effect refetches.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { isTauri } from "@tauri-apps/api/core";

import type { Intent } from "@polaris/interfaces";
import type { schedule } from "@polaris/stellar";

import { buildScheduleForm, deviceTimeZone, toScheduleRows, type ScheduleForm } from "../../lib/schedules.ts";
import { MOCK_SCHEDULED_TASKS, formatNextRun, type ScheduledTask } from "../../lib/mockData.ts";
import { useTxRun, type UseTxRun } from "../../lib/useTxRun.ts";
import type { TxRunOutcome } from "../../lib/txPipeline.ts";
import { walletSessionStore } from "../../lib/walletSessionLive.ts";

import { createSnapshotCache, type SnapshotLoad } from "./snapshotCache.ts";

/** One row the Tasks page renders (the hook boundary adapts every source). */
export interface TaskRow {
  /** Stable React key: `s-<id>` for a real row, the mock id in demo mode. */
  key: string;
  /** On-chain schedule id, or `null` for a demo row (no real cancel). */
  scheduleId: number | null;
  /** Recipient alias (falling back to the raw address), or the mock's text. */
  recipient: string;
  /** Human amount label, e.g. `5 XLM`; empty in demo mode. */
  amountLabel: string;
  /** Recurrence words, e.g. `every week` / `once`. */
  recurrence: string;
  /** Runs left, or `null` when the source cannot say (demo). */
  runsLeft: number | null;
  /** Next run in the device zone, e.g. `2026-09-25T10:00:00+03:00`. */
  nextRunLocal: string;
  /** Next run in UTC, e.g. `2026-09-25T07:00:00.000Z`. */
  nextRunUtc: string;
  status: schedule.UpcomingPayment["status"];
  statusLabel: string;
}

/** Maps `listUpcoming` view models to the page's rows (pure, no chain access). */
export function rowsFromUpcoming(rows: readonly schedule.UpcomingPayment[]): TaskRow[] {
  return toScheduleRows(rows).map((row) => ({
    key: `s-${row.id}`,
    scheduleId: row.id,
    recipient: row.recipient,
    amountLabel: `${row.amount} ${row.asset}`,
    recurrence: row.recurrence,
    runsLeft: row.runsLeft,
    nextRunLocal: row.nextRunLocal,
    nextRunUtc: row.nextRunUtc,
    status: row.status,
    statusLabel: row.statusLabel,
  }));
}

/** Maps the demo tasks to the same rows; demo rows are never cancellable. */
export function rowsFromMock(tasks: readonly ScheduledTask[]): TaskRow[] {
  return tasks.map((task) => ({
    key: task.id,
    scheduleId: null,
    recipient: task.description,
    amountLabel: "",
    recurrence: task.recurrence,
    runsLeft: null,
    nextRunLocal: formatNextRun(task.nextRunAt),
    nextRunUtc: new Date(task.nextRunAt * 1000).toISOString(),
    status: task.enabled ? "scheduled" : "finished",
    statusLabel: task.enabled ? "Scheduled" : "Disabled",
  }));
}

/**
 * Which source the page uses: real data inside Tauri with an owner address;
 * inside Tauri without an owner there is no real source (an honest empty +
 * error, never mock); outside Tauri the browser preview uses the labelled demo.
 * Pure so the rule is tested without a runtime.
 */
export function tasksSource(
  input: { inTauri: boolean; ownerAddress: string | null },
): "demo" | "live" | "unconfigured" {
  if (!input.inTauri) return "demo";
  return input.ownerAddress ? "live" : "unconfigured";
}

/** The `cancel_schedule` intent for a cancellable row, or `null` for demo rows. */
export function cancelIntentFor(row: TaskRow): Intent | null {
  if (row.scheduleId === null) return null;
  return {
    kind: "cancel_schedule",
    asset: "",
    amount: "",
    scheduleId: row.scheduleId,
    source: "notch tasks",
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface TasksLoad {
  rows: TaskRow[];
  demo: boolean;
  error: string | null;
}

/* ------------------------------------------------------------------ *
 * Owner-scoped snapshot cache
 * ------------------------------------------------------------------ */

/** The cache key for the browser preview (no owner). */
const PREVIEW_KEY = "preview";

/** Separator between the owner and the network in a scope key. */
const KEY_SEPARATOR = "|";

/** The scope key a snapshot is read for: `ownerAddress|networkPassphrase`. */
function scopeKey(owner: string, network: string): string {
  return `${owner}${KEY_SEPARATOR}${network}`;
}

/** The owner half of a scope key. */
function scopeOwner(key: string): string {
  const end = key.indexOf(KEY_SEPARATOR);
  return end === -1 ? key : key.slice(0, end);
}

/** The active wallet account, or `null` when locked/absent or in the preview. */
function useActiveOwner(): string | null {
  const read = (): string | null => walletSessionStore.getSnapshot().session?.active?.address ?? null;
  return useSyncExternalStore(walletSessionStore.subscribe, read, read);
}

/** The last successful read, shared across mounts of the page. */
const tasksCache = createSnapshotCache<TasksLoad>(loadTasks);

/**
 * The cached snapshot's key, but only when it belongs to `owner`; `null`
 * otherwise. A network change also changes the key, so it can never seed.
 */
function seedKeyFor(owner: string | null): string | null {
  const stored = tasksCache.cachedKey();
  if (stored === null) return null;
  if (owner === null) return stored === PREVIEW_KEY ? PREVIEW_KEY : null;
  return scopeOwner(stored) === owner ? stored : null;
}

/** Which body the page renders, derived from the load state. Pure. */
export type TasksViewState = "skeleton" | "error" | "empty" | "rows";

/**
 * The page's body is never blank: while the first read is in flight it shows a
 * skeleton, a failed read shows the error, and a successful empty read shows
 * the empty state. Cached rows always win, so a background refresh never
 * collapses the list back to a skeleton.
 */
export function tasksViewState(input: {
  loading: boolean;
  error: string | null;
  count: number;
}): TasksViewState {
  if (input.count > 0) return "rows";
  if (input.loading) return "skeleton";
  if (input.error !== null) return "error";
  return "empty";
}

/**
 * Loads the list: the labelled demo outside Tauri, real `listUpcoming` inside
 * Tauri. Never throws — a read failure (or a missing owner) comes back as
 * `{ ok: false }` so the cache can keep the last good snapshot; mock rows never
 * appear once a real runtime is available.
 */
async function loadTasks(_key: string): Promise<SnapshotLoad<TasksLoad>> {
  if (!isTauri()) {
    return {
      ok: true,
      key: PREVIEW_KEY,
      value: { rows: rowsFromMock(MOCK_SCHEDULED_TASKS), demo: true, error: null },
    };
  }

  try {
    const { getStellarConfig } = await import("@/lib/stellarConfig");
    const config = await getStellarConfig();
    if (tasksSource({ inTauri: true, ownerAddress: config.ownerAddress }) === "unconfigured") {
      return { ok: false, error: "POLARIS_OWNER_ADDRESS is not set" };
    }
    const owner = config.ownerAddress as string;
    const key = scopeKey(owner, config.networkPassphrase);
    const { loadUpcoming } = await import("@/lib/schedulesLive");
    return {
      ok: true,
      key,
      value: { rows: rowsFromUpcoming(await loadUpcoming(deviceTimeZone())), demo: false, error: null },
    };
  } catch (failure) {
    return { ok: false, error: messageOf(failure) };
  }
}

/** The whole view the Tasks page consumes. */
export interface TasksData {
  rows: TaskRow[];
  loading: boolean;
  /** True while a background revalidation runs over already-shown rows. */
  refreshing: boolean;
  /** Human read error from the last load, or `null`. */
  error: string | null;
  /** A failed background revalidation's message, while the last good rows stay. */
  refreshError: string | null;
  /** True when the rows are the demo fallback, not real chain data. */
  demo: boolean;
  timeZone: string;
  refresh: () => void;
  /** Runs the row's cancel through the shared tx pipeline; never throws. */
  cancel: (row: TaskRow) => Promise<TxRunOutcome | null>;
  /** Creates a schedule through the shared tx pipeline; never throws. */
  create: (form: ScheduleForm) => Promise<TxRunOutcome | null>;
  /** Short human error from the last cancel/create (build/approval/sign), or `null`. */
  actionError: string | null;
  tx: UseTxRun;
}

/**
 * Owns the list lifecycle (load on mount + refresh) and the cancel run. All
 * chain access is in `@/lib/schedulesLive`; this hook only holds React state.
 */
export function useTasksData(): TasksData {
  // The IANA zone cannot change while the panel is open, so resolve it once.
  const timeZone = useMemo(() => deviceTimeZone(), []);
  const owner = useActiveOwner();
  const seed = tasksCache.peek(seedKeyFor(owner));
  const [rows, setRows] = useState<TaskRow[]>(seed?.rows ?? []);
  /** The owner the current rows were read for; gates the first frame after a switch. */
  const [rowsOwner, setRowsOwner] = useState<string | null>(owner);
  const [loading, setLoading] = useState(seed === null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(seed?.error ?? null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [demo, setDemo] = useState(seed?.demo ?? false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const tx = useTxRun();
  const run = tx.run;
  const firstRun = useRef(true);
  const previousOwner = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    const first = firstRun.current;
    firstRun.current = false;
    const ownerChanged = !first && previousOwner.current !== owner;
    previousOwner.current = owner;
    if (ownerChanged) {
      // The active account changed: no snapshot from the previous owner may be
      // seeded or served again.
      tasksCache.clear();
      setRefreshError(null);
    }

    const seedKey = seedKeyFor(owner);
    const cached = tasksCache.peek(seedKey);
    if (ownerChanged) {
      setRows(cached?.rows ?? []);
      setRowsOwner(owner);
      setDemo(cached?.demo ?? false);
      setError(cached?.error ?? null);
      setLoading(cached === null);
      setRefreshing(false);
    } else if (cached === null) {
      // Cached rows paint immediately; only the very first read blocks on the
      // chain. A revalidation after that is a quiet background refresh.
      setLoading(true);
    } else {
      setRefreshing(true);
    }

    const requestedKey = seedKey ?? (owner === null ? PREVIEW_KEY : `${owner}${KEY_SEPARATOR}`);
    tasksCache.load(requestedKey, { force: !first }).then((read) => {
      if (cancelled) return;
      setRowsOwner(owner);
      if (read.value === null) {
        // A failed first read is an honest error, never stale mock data.
        setRows([]);
        setDemo(false);
        setError(read.error);
        setRefreshError(null);
      } else if (read.stale) {
        // A failed revalidation keeps the last good rows and only hints.
        setRows(read.value.rows);
        setDemo(read.value.demo);
        setError(read.value.error);
        setRefreshError(read.error);
      } else {
        setRows(read.value.rows);
        setDemo(read.value.demo);
        setError(read.value.error);
        setRefreshError(null);
      }
      setLoading(false);
      setRefreshing(false);
    });
    return () => {
      cancelled = true;
    };
  }, [timeZone, nonce, owner]);

  const refresh = useCallback(() => setNonce((value) => value + 1), []);

  const cancel = useCallback(
    async (row: TaskRow): Promise<TxRunOutcome | null> => {
      const intent = cancelIntentFor(row);
      if (!intent) return null;
      setActionError(null);
      try {
        const { cancelChainTool } = await import("@/lib/schedulesLive");
        const result = await cancelChainTool(intent);
        const [outcome] = await run([
          { result, intent, label: `Cancel schedule #${row.scheduleId}` },
        ]);
        if (outcome?.status === "submitted") refresh();
        else setActionError(outcome?.detail ?? "The cancellation was not submitted.");
        return outcome ?? null;
      } catch (failure) {
        const detail = messageOf(failure);
        setActionError(detail);
        return {
          status: "failed",
          label: `Cancel schedule #${row.scheduleId}`,
          detail,
          atMs: Date.now(),
        };
      }
    },
    [run, refresh],
  );

  const create = useCallback(
    async (form: ScheduleForm): Promise<TxRunOutcome | null> => {
      setActionError(null);
      const built = buildScheduleForm(form);
      if (!built.ok) {
        setActionError(built.error);
        return null;
      }
      const label = `Schedule ${form.amount} ${form.asset} to ${form.recipient}`;
      try {
        const { scheduleChainTool } = await import("@/lib/schedulesLive");
        const result = await scheduleChainTool(built.intent);
        const [outcome] = await run([{ result, intent: built.intent, label }]);
        if (outcome?.status === "submitted") refresh();
        else setActionError(outcome?.detail ?? "The schedule was not created.");
        return outcome ?? null;
      } catch (failure) {
        const detail = messageOf(failure);
        setActionError(detail);
        return { status: "failed", label, detail, atMs: Date.now() };
      }
    },
    [run, refresh],
  );

  return {
    // Gate the first frame after an account switch: never paint another owner's rows.
    rows: rowsOwner === owner ? rows : [],
    loading,
    refreshing,
    error,
    refreshError,
    demo,
    timeZone,
    refresh,
    cancel,
    create,
    actionError,
    tx,
  };
}
