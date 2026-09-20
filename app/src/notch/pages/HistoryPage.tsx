/**
 * History page — a wallet-grade activity timeline inside the notch.
 *
 * Rows are grouped by day under sticky headers; each row carries a kind icon,
 * a clear title, a status chip and a signed monospace amount. Filter chips,
 * a search box and a "Copy CSV" action sit above the list. A row expands in
 * place into a detail drawer (full hash + copy + explorer, fee, memo, network,
 * the voice transcript/answer, approval mode, P2P/anchor specifics).
 *
 * Data comes from `useHistoryData`: the local turn log merged with the owner's
 * recent on-chain payments, P2P offers and anchor explain records. The mock
 * timeline is an explicit demo fallback only (no Tauri, or no owner address); a
 * real read failure shows its error + Retry. Nothing here signs or moves value.
 */
import { useCallback, useMemo, useState } from "react";
import {
  ArrowDownLeft,
  ArrowUpRight,
  Ban,
  CheckCircle2,
  ChevronDown,
  Clock,
  Copy,
  Download,
  LoaderCircle,
  RefreshCw,
  Search,
  Settings,
  Trash2,
  Users,
  WifiOff,
  XCircle,
  Zap,
} from "lucide-react";

import type { HistoryKind, HistoryRow, HistoryStatus } from "../history/model";
import { rowsToCsv } from "../history/csv";
import {
  applyFilters,
  exactTime,
  groupByDay,
  HISTORY_FILTERS,
  filterCounts,
  relativeTime,
  type HistoryFilter,
} from "../history/group";
import { ExplorerLink } from "../ExplorerLink";
import { useHistoryData } from "../data/useHistoryData";
import { LoginGate } from "../wallet/LoginGate";
import { useWalletLocked } from "../wallet/useWalletSession";
import "../history/history.css";

/** `localStorage` key for the remembered chip. */
const FILTER_KEY = "polaris.history.filter.v1";

/** A remembered chip, or `all` when storage is unavailable/foreign. */
function readFilter(): HistoryFilter {
  try {
    const raw = localStorage.getItem(FILTER_KEY);
    return HISTORY_FILTERS.some((chip) => chip.id === raw) ? (raw as HistoryFilter) : "all";
  } catch {
    return "all";
  }
}

/** Persists the chip; a private-mode failure is ignored. */
function writeFilter(filter: HistoryFilter): void {
  try {
    localStorage.setItem(FILTER_KEY, filter);
  } catch {
    // The chip still works for this session; it just will not be remembered.
  }
}

/** Best-effort clipboard copy. Returns whether the write succeeded. */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function KindIcon({ kind }: { kind: HistoryKind }) {
  const className = `history-kind is-${kind}`;
  switch (kind) {
    case "sent":
    case "anchor_withdraw":
      return <ArrowUpRight className={className} aria-hidden="true" />;
    case "received":
    case "anchor_deposit":
      return <ArrowDownLeft className={className} aria-hidden="true" />;
    case "scheduled":
      return <Clock className={className} aria-hidden="true" />;
    case "p2p":
      return <Users className={className} aria-hidden="true" />;
    case "rule_change":
      return <Settings className={className} aria-hidden="true" />;
    default:
      return <Clock className={className} aria-hidden="true" />;
  }
}

function StatusChip({ status }: { status: HistoryStatus }) {
  const label: Record<HistoryStatus, string> = {
    confirmed: "Confirmed",
    pending: "Pending",
    failed: "Failed",
    cancelled: "Cancelled",
    auto_approved: "Auto-approved",
  };
  const icon =
    status === "confirmed" ? (
      <CheckCircle2 aria-hidden="true" />
    ) : status === "pending" ? (
      <LoaderCircle aria-hidden="true" />
    ) : status === "cancelled" ? (
      <Ban aria-hidden="true" />
    ) : status === "auto_approved" ? (
      <Zap aria-hidden="true" />
    ) : (
      <XCircle aria-hidden="true" />
    );
  return (
    <span className={`history-chip is-${status}`}>
      {icon}
      {label[status]}
    </span>
  );
}

/** The expanded drawer: every public fact about the row. */
function DetailDrawer({ row }: { row: HistoryRow }) {
  const [copied, setCopied] = useState<string | null>(null);
  const [copyFailed, setCopyFailed] = useState(false);

  const copy = (value: string): void => {
    void copyText(value).then((ok) => {
      setCopyFailed(!ok);
      setCopied(ok ? value : null);
    });
  };

  const facts: { label: string; value: string }[] = [
    { label: "Network", value: row.network ?? "Testnet" },
    { label: "Approval", value: row.approvalMode ?? "—" },
    { label: "Network fee", value: row.fee ?? "—" },
    { label: "Memo", value: row.memo ?? "—" },
    { label: "Time", value: exactTime(row.timestampMs) },
  ];

  return (
    <div className="history-detail">
      {row.txHash !== null ? (
        <div className="history-detail-line">
          <span className="history-detail-label">Transaction</span>
          <span className="history-hash selectable" title={row.txHash}>
            {row.txHash}
          </span>
          <button
            type="button"
            className="page-icon-button"
            onClick={() => copy(row.txHash ?? "")}
            aria-label="Copy transaction hash"
            title="Copy hash"
          >
            <Copy aria-hidden="true" />
          </button>
          <ExplorerLink target={row.txHash} kind="tx" />
        </div>
      ) : (
        <div className="history-detail-line">
          <span className="history-detail-label">Transaction</span>
          <span className="history-detail-value">No transaction submitted</span>
        </div>
      )}

      <dl className="history-facts">
        {facts.map((fact) => (
          <div key={fact.label} className="history-fact">
            <dt>{fact.label}</dt>
            <dd>{fact.value}</dd>
          </div>
        ))}
      </dl>

      {row.origin === "turn" && row.transcript.length > 0 ? (
        <div className="history-voice">
          <p className="history-detail-label">You said</p>
          <p className="history-detail-value">{row.transcript}</p>
          <p className="history-detail-label">The agent answered</p>
          <p className="history-detail-value">{row.response}</p>
        </div>
      ) : null}

      {row.p2p !== null ? (
        <div className="history-voice">
          <p className="history-detail-label">P2P offer #{row.p2p.offerId}</p>
          <p className="history-detail-value">
            State: {row.p2p.state} — {row.p2p.nextAction}
          </p>
        </div>
      ) : null}

      {row.anchor !== null ? (
        <div className="history-voice">
          <p className="history-detail-label">Anchor transaction</p>
          <p className="history-detail-value">
            {row.anchor.transactionId ?? "No link"} ({row.anchor.status})
          </p>
        </div>
      ) : null}

      {copyFailed ? <p className="history-detail-value">Copy failed — select the text manually.</p> : null}
      {copied !== null ? <p className="history-detail-value">Copied.</p> : null}
    </div>
  );
}

function HistoryRowItem({ row }: { row: HistoryRow }) {
  const [open, setOpen] = useState(false);
  const expandable = row.txHash !== null || row.p2p !== null || row.anchor !== null || row.origin === "turn";
  return (
    <li className="history-item">
      <button
        type="button"
        className="history-row"
        onClick={() => expandable && setOpen((value) => !value)}
        aria-expanded={expandable ? open : undefined}
        disabled={!expandable}
      >
        <KindIcon kind={row.kind} />
        <span className="history-main">
          <span className="history-title">{row.title}</span>
          <span className="history-meta">
            <StatusChip status={row.statusChip} />
            {row.counterpartyNickname !== null ? (
              <span className="history-nick">{row.counterpartyNickname}</span>
            ) : null}
          </span>
        </span>
        {row.amount !== null ? (
          <span
            className={`history-amount ${row.amount.direction < 0 ? "is-out" : row.amount.direction > 0 ? "is-in" : ""}`}
            title={`${row.amount.text} ${row.amount.asset}`}
          >
            {row.amount.text} {row.amount.asset}
          </span>
        ) : null}
        <time className="history-time" dateTime={new Date(row.timestampMs).toISOString()} title={exactTime(row.timestampMs)}>
          {relativeTime(row.timestampMs)}
        </time>
        {expandable ? (
          <ChevronDown className={`history-chevron${open ? " is-open" : ""}`} aria-hidden="true" />
        ) : null}
      </button>
      {open ? <DetailDrawer row={row} /> : null}
    </li>
  );
}

function SkeletonList() {
  return (
    <ul className="page-list history-list" aria-hidden="true">
      {Array.from({ length: 6 }, (_, index) => (
        <li key={index} className="history-skeleton" />
      ))}
    </ul>
  );
}

export function HistoryPage() {
  const locked = useWalletLocked();
  if (locked) return <LoginGate />;
  return <HistoryBody />;
}

function HistoryBody() {
  const { rows, source, loading, loadingMore, hasMore, error, offline, refresh, loadMore, clearLocal } =
    useHistoryData();
  const [filter, setFilter] = useState<HistoryFilter>(() => readFilter());
  const [query, setQuery] = useState("");
  const [csvNote, setCsvNote] = useState<string | null>(null);

  const counts = useMemo(() => filterCounts(rows), [rows]);
  const visible = useMemo(() => applyFilters(rows, { filter, query }), [rows, filter, query]);
  const groups = useMemo(() => groupByDay(visible), [visible]);

  const choose = useCallback((next: HistoryFilter) => {
    setFilter(next);
    writeFilter(next);
  }, []);

  const copyCsv = useCallback(() => {
    const csv = rowsToCsv(visible);
    void copyText(csv).then((ok) => {
      setCsvNote(ok ? `Copied ${visible.length} row(s) as CSV.` : "Copy failed.");
      window.setTimeout(() => setCsvNote(null), 2_500);
    });
  }, [visible]);

  const showSkeleton = loading && rows.length === 0;
  const showEmpty = !loading && error === null && visible.length === 0;

  return (
    <div className="page-stack history-page">
      <div className="history-toolbar">
        <button
          type="button"
          className="page-icon-button"
          onClick={copyCsv}
          disabled={visible.length === 0}
          aria-label="Copy visible rows as CSV"
          title="Copy CSV"
        >
          <Download aria-hidden="true" />
        </button>
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

      <label className="history-search">
        <Search aria-hidden="true" />
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search name, address, hash, amount"
          aria-label="Search history"
        />
      </label>

      <div className="history-filters" role="tablist" aria-label="History filters">
        {HISTORY_FILTERS.map((chip) => (
          <button
            key={chip.id}
            type="button"
            role="tab"
            aria-selected={filter === chip.id}
            className={`history-filter${filter === chip.id ? " is-active" : ""}`}
            onClick={() => choose(chip.id)}
          >
            {chip.label}
            <span className="history-filter-count">{counts[chip.id]}</span>
          </button>
        ))}
      </div>

      {offline ? (
        <p className="history-notice">
          <WifiOff aria-hidden="true" />
          Offline — showing saved history.
        </p>
      ) : null}

      {error !== null ? (
        <p className="history-notice is-error">
          {error}{" "}
          <button type="button" className="page-icon-button" onClick={refresh} aria-label="Retry" title="Retry">
            <RefreshCw aria-hidden="true" />
          </button>
        </p>
      ) : null}

      {csvNote !== null ? <p className="history-notice">{csvNote}</p> : null}

      {showSkeleton ? (
        <SkeletonList />
      ) : showEmpty ? (
        <div className="history-empty">
          <p>No activity yet.</p>
          <p className="history-empty-hint">
            Try saying “ali'ye 10 XLM gönder” — the turn shows up here with its transaction.
          </p>
        </div>
      ) : (
        groups.map((group) => (
          <section key={group.key} className="history-day">
            <h3 className="history-day-header">{group.label}</h3>
            <ul className="page-list history-list">
              {group.rows.map((row) => (
                <HistoryRowItem key={row.id} row={row} />
              ))}
            </ul>
          </section>
        ))
      )}

      {hasMore ? (
        <button type="button" className="history-load-more" onClick={loadMore} disabled={loadingMore}>
          {loadingMore ? "Loading…" : "Load more"}
        </button>
      ) : null}

      {source === "demo" ? (
        <p className="history-notice">Demo data — connect a wallet for live history</p>
      ) : null}
    </div>
  );
}
