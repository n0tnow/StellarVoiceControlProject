/**
 * Tasks page — the owner's on-chain scheduled payments, inside the notch.
 *
 * Rows come from real `listUpcoming` data (a labelled demo only in the browser
 * preview). Cancel runs through the shared `txPipeline` (approval card → Touch
 * ID → signing → submit); "New schedule" reveals the small To / Amount / Every /
 * First run form, which creates through the same pipeline. The empty state is a
 * single line and locked/loading/error states stay inline.
 */
import { useState } from "react";
import { CalendarClock, LoaderCircle, Plus, RefreshCw, Trash2 } from "lucide-react";

import { useTasksData, type TaskRow } from "@/notch/data/useTasksData";
import { ExplorerLink } from "@/notch/ExplorerLink";
import { NewScheduleForm } from "@/notch/tasks/NewScheduleForm";
import type { SimpleSchedule } from "@/notch/tasks/newSchedule";

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
      {row.scheduleId !== null ? (
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
      ) : null}
    </li>
  );
}

export function TasksPage() {
  const locked = useWalletLocked();
  if (locked) return <LoginGate />;
  return <TasksBody />;
}

function TasksBody() {
  const { rows, loading, error, demo, timeZone, refresh, cancel, create, actionError, tx } =
    useTasksData();
  const [showNew, setShowNew] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);
  const running = tx.state === "running";
  const last = tx.outcomes[tx.outcomes.length - 1];

  const onCancel = async (row: TaskRow): Promise<void> => {
    if (row.scheduleId === null || running) return;
    setBusyId(row.scheduleId);
    await cancel(row);
    setBusyId(null);
  };

  const onCreate = (schedule: SimpleSchedule): void => {
    setShowNew(false);
    void create(schedule.form);
  };

  return (
    <div className="page-stack">
      <p className="rule-name">Upcoming payments</p>

      {demo ? (
        <p className="rule-condition">Demo data — open the desktop app for live schedules.</p>
      ) : null}

      {error !== null ? (
        <p className="task-schedule">
          {error}{" "}
          <button type="button" className="page-icon-button" aria-label="Retry" onClick={refresh}>
            <RefreshCw aria-hidden="true" />
          </button>
        </p>
      ) : null}

      {running && tx.progress ? (
        <p className="task-schedule">
          <LoaderCircle className="page-status is-pending" aria-hidden="true" />
          {tx.progress.label} — {tx.progress.phase}…
        </p>
      ) : actionError !== null ? (
        <p className="task-schedule">{actionError}</p>
      ) : last && last.status === "submitted" ? (
        <p className="task-schedule">
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

      {loading ? (
        <p className="task-schedule">Loading upcoming payments…</p>
      ) : error !== null ? null : rows.length === 0 ? (
        <p className="task-schedule">No scheduled payments yet.</p>
      ) : (
        <ul className="page-list task-list">
          {rows.map((row) => (
            <TaskRowItem
              key={row.key}
              row={row}
              busy={busyId === row.scheduleId}
              disabled={running}
              onCancel={(target) => void onCancel(target)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
