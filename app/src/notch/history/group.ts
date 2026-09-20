/**
 * Pure filtering, search, day grouping and time formatting for the History page.
 *
 * Kept free of React so the filter chips, the search predicate and the sticky
 * day headers are unit-tested under `node:test` (`group.test.ts`).
 */
import type { HistoryRow } from "./model.ts";

/** The filter chips, in display order. */
export type HistoryFilter = "all" | "sent" | "received" | "auto" | "p2p" | "anchor" | "voice";

/** Chip definitions, shared by the UI and the counts. */
export const HISTORY_FILTERS: readonly { id: HistoryFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "sent", label: "Sent" },
  { id: "received", label: "Received" },
  { id: "auto", label: "Auto" },
  { id: "p2p", label: "P2P" },
  { id: "anchor", label: "Anchor" },
  { id: "voice", label: "Voice" },
];

/** Whether a row belongs to a filter chip. "All" always passes. */
export function matchesFilter(row: HistoryRow, filter: HistoryFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "sent":
      return row.kind === "sent" || row.kind === "anchor_withdraw" || row.amount?.direction === -1;
    case "received":
      return (
        row.kind === "received" || row.kind === "anchor_deposit" || row.amount?.direction === 1
      );
    case "auto":
      return row.approvalMode === "auto" || row.statusChip === "auto_approved";
    case "p2p":
      return row.origin === "p2p" || row.route === "p2p";
    case "anchor":
      return row.origin === "anchor" || row.route === "anchor";
    case "voice":
      return row.origin === "turn";
  }
}

/** Counts per chip over the unfiltered set, so a chip can show its total. */
export function filterCounts(rows: readonly HistoryRow[]): Record<HistoryFilter, number> {
  const counts = { all: 0, sent: 0, received: 0, auto: 0, p2p: 0, anchor: 0, voice: 0 };
  for (const row of rows) {
    for (const { id } of HISTORY_FILTERS) {
      if (matchesFilter(row, id)) counts[id] += 1;
    }
  }
  return counts;
}

/** Free-text search across nickname, address, hash, amount, transcript and memo. */
export function matchesQuery(row: HistoryRow, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return true;
  const haystack = [
    row.title,
    row.counterpartyNickname,
    row.counterparty,
    row.txHash,
    row.amount?.text,
    row.amount?.asset,
    row.transcript,
    row.response,
    row.memo,
    row.p2p?.offerId,
  ];
  return haystack.some((value) => value !== null && value !== undefined && value.toLowerCase().includes(needle));
}

/** Applies the active chip and the search box, preserving order. */
export function applyFilters(
  rows: readonly HistoryRow[],
  options: { filter: HistoryFilter; query: string },
): HistoryRow[] {
  return rows.filter((row) => matchesFilter(row, options.filter) && matchesQuery(row, options.query));
}

/** A local `YYYY-MM-DD` key. */
export function dayKey(timestampMs: number): string {
  const date = new Date(timestampMs);
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

const dayFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
});

/** "Today" / "Yesterday" / "Sep 19, 2026" for a sticky day header. */
export function dayLabel(timestampMs: number, nowMs: number = Date.now()): string {
  const key = dayKey(timestampMs);
  if (key === dayKey(nowMs)) return "Today";
  if (key === dayKey(nowMs - 86_400_000)) return "Yesterday";
  return dayFormatter.format(new Date(timestampMs));
}

/** A day bucket for the sticky-header timeline. */
export interface HistoryDayGroup {
  key: string;
  label: string;
  rows: HistoryRow[];
}

/** Groups already-sorted rows by local day, newest day first. */
export function groupByDay(
  rows: readonly HistoryRow[],
  nowMs: number = Date.now(),
): HistoryDayGroup[] {
  const groups: HistoryDayGroup[] = [];
  const index = new Map<string, HistoryDayGroup>();
  for (const row of rows) {
    const key = dayKey(row.timestampMs);
    let group = index.get(key);
    if (!group) {
      group = { key, label: dayLabel(row.timestampMs, nowMs), rows: [] };
      index.set(key, group);
      groups.push(group);
    }
    group.rows.push(row);
  }
  return groups;
}

const exactFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

/** The full timestamp shown on hover. */
export function exactTime(timestampMs: number): string {
  return exactFormatter.format(new Date(timestampMs));
}

/** "just now" / "5m ago" / "3h ago" / "2d ago" / a date, for the row's time. */
export function relativeTime(timestampMs: number, nowMs: number = Date.now()): string {
  const seconds = Math.max(0, Math.floor((nowMs - timestampMs) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${Math.max(1, minutes)}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return dayFormatter.format(new Date(timestampMs));
}
