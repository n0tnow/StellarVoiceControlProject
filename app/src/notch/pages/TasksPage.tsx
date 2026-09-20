/**
 * Tasks page — the owner's on-chain scheduled payments.
 *
 * Rows come from [`useTasksData`] (real `listUpcoming` when a wallet is
 * configured, an explicit demo fallback otherwise). Cancel is the only
 * value-moving action: it runs through the shared `txPipeline` (approval card →
 * Touch ID → Freighter → submit) and the page shows its progress and outcome.
 * Creating a schedule stays a voice action, so the empty state points at the
 * spoken example instead of offering a form.
 */
import { useState } from "react";
import { CalendarClock, LoaderCircle, RefreshCw, Trash2 } from "lucide-react";

import { useTasksData, type TaskRow } from "@/notch/data/useTasksData";

import { LoginGate } from "../wallet/LoginGate";
import { useWalletLocked } from "../wallet/useWalletSession";

/** "5 XLM → acc2", or just the recipient label in demo mode. */
function rowTitle(row: TaskRow): string {
  return row.amountLabel ? `${row.amountLabel} → ${row.recipient}` : row.recipient;
}

/** "every week · 8 runs left · Scheduled" — omits what the source cannot say. */
function rowMeta(row: TaskRow): string {
  const runs =
    row.runsLeft === null ? null : `${row.runsLeft} run${row.runsLeft === 1 ? "" : "s"} left`;
  return [row.recurrence, runs, row.statusLabel].filter(Boolean).join(" · ");
}

interface TaskRowItemProps {
  row: TaskRow;
  busy: boolean;
  disabled: boolean;
  onCancel: (row: TaskRow) => void;
}

function TaskRowItem({ row, busy, disabled, onCancel }: TaskRowItemProps) {
  return (
    <li className="task-row">
      <span className="task-main">
        <span className="task-description">{rowTitle(row)}</span>
        <span className="task-schedule">
          <CalendarClock aria-hidden="true" />
          {rowMeta(row)}
        </span>
        <span className="task-schedule">
          <span className="selectable">{row.nextRunLocal}</span> local ·{" "}
          <span className="selectable">{row.nextRunUtc}</span> UTC
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
  const { rows, loading, error, demo, keeper, refresh, cancel, actionError, tx } = useTasksData();
  const [busyId, setBusyId] = useState<number | null>(null);
  const running = tx.state === "running";
  const last = tx.outcomes[tx.outcomes.length - 1];

  const onCancel = async (row: TaskRow): Promise<void> => {
    if (row.scheduleId === null || running) return;
    setBusyId(row.scheduleId);
    await cancel(row);
    setBusyId(null);
  };

  return (
    <div className="page-stack">
      {demo ? (
        <p className="task-schedule">Demo data — no owner wallet is configured in this build.</p>
      ) : null}

      {keeper.needed ? (
        <p className="task-schedule">
          Keeper needed: <code className="selectable">{keeper.command}</code>
        </p>
      ) : null}

      {error ? (
        <p className="task-schedule">
          {error}{" "}
          <button type="button" className="page-icon-button" aria-label="Retry" onClick={refresh}>
            <RefreshCw aria-hidden="true" />
          </button>
        </p>
      ) : null}

      {running && tx.progress ? (
        <p className="task-schedule">
          {tx.progress.label} — {tx.progress.phase}…
        </p>
      ) : actionError ? (
        <p className="task-schedule">{actionError}</p>
      ) : last && last.status === "submitted" ? (
        <p className="task-schedule">Cancelled — the list was refreshed.</p>
      ) : null}

      {loading ? (
        <p className="task-schedule">Loading upcoming payments…</p>
      ) : error ? null : rows.length === 0 ? (
        <p className="task-schedule">
          No scheduled payments yet. Try saying: “her cuma 10:00’da acc2’ye 5 XLM gönder”.
        </p>
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
