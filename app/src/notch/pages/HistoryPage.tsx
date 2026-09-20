/**
 * History page — past voice turns and the actions they produced.
 *
 * One row per turn: status icon, transcript snippet, time, and the agent's
 * answer. Rows with a chain action expand in place (detail toggle) to show
 * the action summary and transaction hash. All data is mock
 * (`@/lib/mockData`); the real wiring replaces the array, not the markup.
 */
import { useState } from "react";
import {
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  LoaderCircle,
} from "lucide-react";

import {
  MOCK_HISTORY,
  formatTimestamp,
  truncateKey,
  type HistoryEntry,
  type TxStatus,
} from "@/lib/mockData";

function StatusIcon({ status }: { status: TxStatus }) {
  // The class carries the colour; the icon carries the shape. Both are needed:
  // colour alone is not a status signal.
  if (status === "success") {
    return <CheckCircle2 className="page-status is-success" aria-label="Success" />;
  }
  if (status === "pending") {
    return <LoaderCircle className="page-status is-pending" aria-label="Pending" />;
  }
  return <CircleAlert className="page-status is-failed" aria-label="Failed" />;
}

function HistoryRow({ entry }: { entry: HistoryEntry }) {
  const [open, setOpen] = useState(false);
  const expandable = entry.action !== null;
  return (
    <li className="history-item">
      <button
        type="button"
        className="history-row"
        onClick={() => expandable && setOpen((value) => !value)}
        aria-expanded={expandable ? open : undefined}
        disabled={!expandable}
      >
        <StatusIcon status={entry.status} />
        <span className="history-main">
          <span className="history-transcript">{entry.transcript}</span>
          <span className="history-response">{entry.response}</span>
        </span>
        <span className="history-time">{formatTimestamp(entry.timestamp)}</span>
        {expandable ? (
          <ChevronDown
            className={`history-chevron${open ? " is-open" : ""}`}
            aria-hidden="true"
          />
        ) : null}
      </button>
      {open && entry.action !== null ? (
        <div className="history-detail">
          <p className="history-action">{entry.action}</p>
          {entry.txHash !== null ? (
            <p className="history-hash selectable" title={entry.txHash}>
              tx {truncateKey(entry.txHash, 8, 8)}
            </p>
          ) : (
            <p className="history-hash">no transaction submitted</p>
          )}
        </div>
      ) : null}
    </li>
  );
}

export function HistoryPage() {
  return (
    <ul className="page-list history-list">
      {MOCK_HISTORY.map((entry) => (
        <HistoryRow key={entry.id} entry={entry} />
      ))}
    </ul>
  );
}
