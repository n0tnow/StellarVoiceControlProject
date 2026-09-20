/**
 * Tasks page data — the owner's on-chain scheduled payments (NW3).
 *
 * The page renders only [`TaskRow`]s; this hook adapts the real `listUpcoming`
 * view models (via `@/lib/schedules`) into that shape. The mock rows in
 * `@/lib/mockData` are an explicit **demo** fallback, used only when the app is
 * not inside Tauri or when `stellar_config` has no owner address. A real read
 * failure is surfaced as an error with a Retry — never silently replaced by
 * mock data.
 *
 * Cancel is the only value-moving action here: it builds the unsigned
 * `cancel_schedule` (`@/lib/schedulesLive`) and pushes it through the shared
 * `@/lib/useTxRun` pipeline (approval card → Touch ID → wallet signing → submit),
 * exactly like the Schedules panel. Nothing else on the page moves value.
 */
import { useCallback, useEffect, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";

import type { Intent } from "@polaris/interfaces";
import type { schedule } from "@polaris/stellar";

import {
  deviceTimeZone,
  keeperStatus,
  toScheduleRows,
  type KeeperStatus,
} from "../../lib/schedules.ts";
import { MOCK_SCHEDULED_TASKS, formatNextRun, type ScheduledTask } from "../../lib/mockData.ts";
import { useTxRun, type UseTxRun } from "../../lib/useTxRun.ts";
import type { TxRunOutcome } from "../../lib/txPipeline.ts";

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
 * Which source the page uses: real data only inside Tauri with an owner
 * address; anything else is the explicit demo fallback. Pure so the rule is
 * tested without a runtime.
 */
export function tasksSource(input: { inTauri: boolean; ownerAddress: string | null }): "demo" | "live" {
  return input.inTauri && input.ownerAddress ? "live" : "demo";
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

/** Seconds until the earliest upcoming run across rows, or `null` if none. */
function nextDueSeconds(rows: readonly TaskRow[]): number | null {
  let earliest = Number.POSITIVE_INFINITY;
  for (const row of rows) {
    const ms = Date.parse(row.nextRunUtc);
    if (Number.isFinite(ms)) earliest = Math.min(earliest, ms);
  }
  return Number.isFinite(earliest) ? Math.floor(earliest / 1000) : null;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface TasksLoad {
  rows: TaskRow[];
  demo: boolean;
  error: string | null;
}

/**
 * Loads the list: demo fallback outside Tauri / without an owner, real
 * `listUpcoming` otherwise. Never throws — a read failure is returned as the
 * `error` so the page can show it with a Retry.
 */
async function loadTasks(timeZone: string): Promise<TasksLoad> {
  if (!isTauri()) {
    return { rows: rowsFromMock(MOCK_SCHEDULED_TASKS), demo: true, error: null };
  }

  let ownerAddress: string | null = null;
  try {
    const { getStellarConfig } = await import("@/lib/stellarConfig");
    ownerAddress = (await getStellarConfig()).ownerAddress;
  } catch (failure) {
    return { rows: [], demo: false, error: messageOf(failure) };
  }
  if (tasksSource({ inTauri: true, ownerAddress }) === "demo") {
    return { rows: rowsFromMock(MOCK_SCHEDULED_TASKS), demo: true, error: null };
  }

  try {
    const { loadUpcoming } = await import("@/lib/schedulesLive");
    return { rows: rowsFromUpcoming(await loadUpcoming(timeZone)), demo: false, error: null };
  } catch (failure) {
    return { rows: [], demo: false, error: messageOf(failure) };
  }
}

/** The whole view the Tasks page consumes. */
export interface TasksData {
  rows: TaskRow[];
  loading: boolean;
  /** Human read error from the last load, or `null`. */
  error: string | null;
  /** True when the rows are the demo fallback, not real chain data. */
  demo: boolean;
  /** Keeper strip facts: whether a keeper is needed and how to start one. */
  keeper: KeeperStatus;
  timeZone: string;
  refresh: () => void;
  /** Runs the row's cancel through the shared tx pipeline; never throws. */
  cancel: (row: TaskRow) => Promise<TxRunOutcome | null>;
  /** Short human error from the last cancel (build/approval/sign), or `null`. */
  actionError: string | null;
  tx: UseTxRun;
}

/**
 * Owns the list lifecycle (load on mount + refresh) and the cancel run. All
 * chain access is in `@/lib/schedulesLive`; this hook only holds React state.
 */
export function useTasksData(): TasksData {
  const timeZone = deviceTimeZone();
  const [rows, setRows] = useState<TaskRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [demo, setDemo] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const tx = useTxRun();
  const run = tx.run;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    loadTasks(timeZone).then((load) => {
      if (cancelled) return;
      setRows(load.rows);
      setDemo(load.demo);
      setError(load.error);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [timeZone, nonce]);

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

  const keeper = keeperStatus({
    hasSchedules: rows.length > 0,
    nextDueSeconds: nextDueSeconds(rows),
    nowSeconds: Math.floor(Date.now() / 1000),
  });

  return { rows, loading, error, demo, keeper, timeZone, refresh, cancel, actionError, tx };
}
