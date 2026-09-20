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
 */
import { useCallback, useEffect, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";

import type { Intent } from "@polaris/interfaces";
import type { schedule } from "@polaris/stellar";

import { buildScheduleForm, deviceTimeZone, toScheduleRows, type ScheduleForm } from "../../lib/schedules.ts";
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

/**
 * Loads the list: the labelled demo outside Tauri, real `listUpcoming` inside
 * Tauri. Never throws — a read failure (or a missing owner) is returned as the
 * `error` so the page can show it with a Retry; mock rows never appear once a
 * real runtime is available.
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
  if (tasksSource({ inTauri: true, ownerAddress }) === "unconfigured") {
    return { rows: [], demo: false, error: "POLARIS_OWNER_ADDRESS is not set" };
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

  return { rows, loading, error, demo, timeZone, refresh, cancel, create, actionError, tx };
}
