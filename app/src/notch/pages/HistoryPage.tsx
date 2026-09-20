/**
 * History page — past voice turns and the actions they produced.
 *
 * One row per turn: status icon, transcript snippet, time, and the agent's
 * answer. Rows with a chain action expand in place (detail toggle) to show the
 * action summary and transaction hash (linked to the explorer).
 *
 * Data comes from `useHistoryData`: the local turn log merged with the owner's
 * recent on-chain payments. The mock timeline is an explicit demo fallback only
 * (no Tauri, or no owner address); a real read failure shows its error + Retry.
 */
import { useState } from "react";
import {
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  LoaderCircle,
  RefreshCw,
  Trash2,
} from "lucide-react";

import { formatTimestamp, truncateKey, type TxStatus } from "@/lib/mockData";
import type { HistoryEntryView } from "../data/historyModel";
import { useHistoryData } from "../data/useHistoryData";
import { LoginGate } from "../wallet/LoginGate";
import { useWalletLocked } from "../wallet/useWalletSession";

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

function HistoryRow({ entry }: { entry: HistoryEntryView }) {
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
            entry.explorerUrl !== null ? (
              <a
                className="history-hash selectable"
                href={entry.explorerUrl}
                target="_blank"
                rel="noreferrer"
                title={entry.txHash}
              >
                tx {truncateKey(entry.txHash, 8, 8)}
              </a>
            ) : (
              <p className="history-hash selectable" title={entry.txHash}>
                tx {truncateKey(entry.txHash, 8, 8)}
              </p>
            )
          ) : (
            <p className="history-hash">no transaction submitted</p>
          )}
        </div>
      ) : null}
    </li>
  );
}

export function HistoryPage() {
  const locked = useWalletLocked();
  if (locked) return <LoginGate />;
  return <HistoryBody />;
}

function HistoryBody() {
  const { entries, source, loading, error, refresh, clearLocal } = useHistoryData();

  return (
    <div className="page-stack">
      <div className="history-toolbar">
        <button
          type="button"
          className="page-icon-button"
          onClick={refresh}
          disabled={loading}
          aria-label="Refresh history"
          title="Refresh"
        >
          <RefreshCw aria-hidden="true" />
        </button>
        <button
          type="button"
          className="page-icon-button"
          onClick={clearLocal}
          aria-label="Clear local history"
          title="Clear local history"
        >
          <Trash2 aria-hidden="true" />
        </button>
      </div>

      {error !== null ? (
        <p className="history-hash">
          {error}{" "}
          <button
            type="button"
            className="page-icon-button"
            onClick={refresh}
            aria-label="Retry"
            title="Retry"
          >
            <RefreshCw aria-hidden="true" />
          </button>
        </p>
      ) : null}

      {loading && entries.length === 0 ? (
        <p className="history-hash">Loading…</p>
      ) : entries.length === 0 && error === null ? (
        <p className="history-hash">No history yet</p>
      ) : (
        <ul className="page-list history-list">
          {entries.map((entry) => (
            <HistoryRow key={entry.id} entry={entry} />
          ))}
        </ul>
      )}

      {source === "demo" ? (
        <p className="history-hash">Demo data — connect a wallet for live history</p>
      ) : null}
    </div>
  );
}
