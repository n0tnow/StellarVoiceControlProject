/**
 * CSV export for the History page (visible rows only, never a secret).
 *
 * Pure string building, unit-tested under `node:test`. Only public fields are
 * written: no key material, no XDR, no seed.
 */
import type { HistoryRow } from "./model.ts";

const HEADER = [
  "time",
  "kind",
  "status",
  "title",
  "amount",
  "asset",
  "counterparty",
  "tx_hash",
  "route",
  "approval",
];

/** Quotes a field when it contains a comma, quote or newline (RFC 4180 style). */
function field(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** The public cells of one row, in header order. */
function cells(row: HistoryRow): string[] {
  return [
    new Date(row.timestampMs).toISOString(),
    row.kind,
    row.statusChip,
    row.title,
    row.amount?.text ?? "",
    row.amount?.asset ?? "",
    row.counterpartyNickname ?? row.counterparty ?? "",
    row.txHash ?? "",
    row.route,
    row.approvalMode ?? "",
  ];
}

/** Serializes rows to CSV, header included. */
export function rowsToCsv(rows: readonly HistoryRow[]): string {
  const lines = [HEADER.join(",")];
  for (const row of rows) {
    lines.push(cells(row).map(field).join(","));
  }
  return lines.join("\n");
}
