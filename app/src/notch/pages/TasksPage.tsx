/**
 * Tasks page — the owner's on-chain scheduled payments, inside the notch.
 *
 * Rows come from real `listUpcoming` data (a labelled demo only in the browser
 * preview). Cancel runs through the shared `txPipeline` (approval card → Touch
 * ID → signing → submit); "New schedule" reveals the small To / Amount form,
 * with the recurring details folded behind "Advanced". The empty state is a
 * single centred line and locked/loading/error states stay inline.
 *
 * The hook caches the last read, so reopening the page paints the previous rows
 * at once and revalidates quietly; the first open shows a skeleton, never a
 * blank panel.
 */
import { memo, useCallback, useState } from "react";
import {
  CalendarClock,
  CheckCircle2,
  CircleAlert,
  LoaderCircle,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";

import { useTasksData, tasksViewState, type TaskRow } from "@/notch/data/useTasksData";
import { ExplorerLink } from "@/notch/ExplorerLink";
import { NewScheduleForm } from "@/notch/tasks/NewScheduleForm";
import type { SimpleSchedule } from "@/notch/tasks/newSchedule";

import "./tasks-rules.css";
import { LoginGate } from "../wallet/LoginGate";
import { useWalletLocked } from "../wallet/useWalletSession";

/** "5 XLM → ada", or just the recipient when the source has no amount. */
function rowTitle(row: TaskRow): string {
  return row.amountLabel ? `${row.amountLabel} → ${row.recipient}` : row.recipient;
}

/** "every week · 8 runs left · Scheduled" — omits what the source cannot say. */
function rowMeta(row: TaskRow): string {
  const runs =
    row.runsLeft === null ? null : `${row.runsLeft} run${row.runsLeft === 1 ? "" : "s"} left`;
  return [row.recurrence, runs, row.statusLabel].filter(Boolean).join(" · ");
}

/** The status tone the row's indicator wears. */
export function taskStatusTone(row: Pick<TaskRow, "status">): "active" | "warn" | "off" {
  if (row.status === "delayed") return "warn";
  if (row.status === "finished") return "off";
  return "active";
}

function TaskRowItem({
  row,
  busy,
  disabled,
  onCancel,
}: {
  row: TaskRow;
  busy: boolean;
  disabled: boolean;
  onCancel: (row: TaskRow) => void;
}) {
  return (
    <li className="task-row">
      <span className="nr-row-main">
        <span className={`nr-dot is-${taskStatusTone(row)}`} aria-hidden="true" />
        <span className="task-main">
          <span className="task-description">{rowTitle(row)}</span>
          <span className="task-schedule">
            <CalendarClock aria-hidden="true" />
            {rowMeta(row)}
          </span>
          <span className="task-schedule">
            Next <span className="selectable">{row.nextRunLocal}</span>
          </span>
        </span>
      </span>
      {row.scheduleId !== null ? (
        <span className="nr-row-actions">
          <button
            type="button"
            className="page-icon-button"
            aria-label={`Cancel schedule #${row.scheduleId}`}
            title={busy ? "Cancelling…" : "Cancel schedule"}
            disabled={busy || disabled}
            onClick={() => onCancel(row)}
          >
            {busy ? (
              <LoaderCircle className="page-status is-pending" aria-hidden="true" />
            ) : (
              <Trash2 aria-hidden="true" />
            )}
          </button>
        </span>
      ) : null}
    </li>
  );
}

/** Rows only change when their identity or busy/disabled flags change. */
const MemoTaskRow = memo(TaskRowItem);

function TaskSkeleton() {
  return (
    <ul className="page-list nr-skeleton-list" aria-hidden="true">
      {Array.from({ length: 3 }, (_, index) => (
        <li key={index} className="nr-skeleton" />
      ))}
    </ul>
  );
}

export function TasksPage() {
  const locked = useWalletLocked();
  if (locked) return <LoginGate />;
  return <TasksBody />;
}

function TasksBody() {
  const {
    rows,
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
  } = useTasksData();
  const [showNew, setShowNew] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);
  const running = tx.state === "running";
  const last = tx.outcomes[tx.outcomes.length - 1];
  const view = tasksViewState({ loading, error, count: rows.length });

  // Stable identity so `MemoTaskRow` really memoizes across unrelated renders.
  const onCancel = useCallback(
    async (row: TaskRow): Promise<void> => {
      if (row.scheduleId === null || running) return;
      setBusyId(row.scheduleId);
      await cancel(row);
      setBusyId(null);
    },
    [cancel, running],
  );

  const onCreate = (schedule: SimpleSchedule): void => {
    setShowNew(false);
    void create(schedule.form);
  };

  const subtitle = demo
    ? "Demo preview"
    : rows.length === 0
      ? "No scheduled payments yet"
      : `${rows.length} scheduled payment${rows.length === 1 ? "" : "s"}`;

  return (
    <div className="page-stack nr-page">
      <header className="nr-head">
        <div className="nr-head-main">
          <h2 className="nr-title">Scheduled payments</h2>
          <p className="nr-sub">{subtitle}</p>
        </div>
        <button
          type="button"
          className="page-icon-button"
          aria-label="Refresh scheduled payments"
          title="Refresh"
          disabled={loading || refreshing}
          onClick={refresh}
        >
          <RefreshCw className={refreshing ? "page-status is-pending" : undefined} aria-hidden="true" />
        </button>
      </header>

      {demo ? (
        <p className="nr-notice">
          <CheckCircle2 aria-hidden="true" />
          Demo data — open the desktop app for live schedules.
        </p>
      ) : null}

      {error !== null ? (
        <p className="nr-notice is-error">
          <CircleAlert aria-hidden="true" />
          {error}{" "}
          <button type="button" className="page-icon-button" aria-label="Retry" onClick={refresh}>
            <RefreshCw aria-hidden="true" />
          </button>
        </p>
      ) : refreshError !== null ? (
        <p className="nr-notice is-hint" title={refreshError}>
          <CircleAlert aria-hidden="true" />
          Couldn&apos;t refresh.{" "}
          <button type="button" className="page-icon-button" aria-label="Retry refresh" onClick={refresh}>
            <RefreshCw aria-hidden="true" />
          </button>
        </p>
      ) : null}

      {running && tx.progress ? (
        <p className="nr-notice">
          <LoaderCircle className="page-status is-pending" aria-hidden="true" />
          {tx.progress.label} — {tx.progress.phase}…
        </p>
      ) : actionError !== null ? (
        <p className="nr-notice is-error">{actionError}</p>
      ) : last && last.status === "submitted" ? (
        <p className="nr-notice">
          Done — the list was refreshed. <ExplorerLink target={last.txHash} kind="tx" />
        </p>
      ) : null}

      {demo ? null : showNew ? (
        <NewScheduleForm disabled={running} timeZone={timeZone} onCreate={onCreate} />
      ) : (
        <button type="button" className="rule-add" disabled={running} onClick={() => setShowNew(true)}>
          <Plus aria-hidden="true" />
          New schedule
        </button>
      )}

      {view === "skeleton" ? (
        <TaskSkeleton />
      ) : view === "empty" ? (
        <p className="nr-empty">No scheduled payments yet. Create one above.</p>
      ) : view === "rows" ? (
        <ul className="page-list task-list">
          {rows.map((row) => (
            <MemoTaskRow
              key={row.key}
              row={row}
              busy={busyId === row.scheduleId}
              disabled={running}
              onCancel={onCancel}
            />
          ))}
        </ul>
      ) : null}
    </div>
  );
}
