import assert from "node:assert/strict";
import { test } from "node:test";

import type { HistoryRow } from "./model.ts";
import {
  applyFilters,
  dayLabel,
  filterCounts,
  groupByDay,
  matchesFilter,
  matchesQuery,
  relativeTime,
} from "./group.ts";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 8, 20, 12, 0, 0);

function row(overrides: Partial<HistoryRow> = {}): HistoryRow {
  return {
    id: "turn:1",
    timestamp: 0,
    timestampMs: NOW,
    transcript: "ali'ye 10 XLM gönder",
    response: "Sent",
    action: "Transaction submitted",
    status: "success",
    txHash: null,
    explorerUrl: null,
    origin: "turn",
    kind: "sent",
    statusChip: "confirmed",
    title: "Sent 10 XLM to ali",
    amount: { text: "-10", direction: -1, asset: "XLM" },
    route: "direct",
    approvalMode: null,
    counterparty: null,
    counterpartyNickname: "ali",
    memo: null,
    fee: null,
    network: null,
    p2p: null,
    anchor: null,
    ...overrides,
  };
}

test("filter chips select the matching rows", () => {
  assert.equal(matchesFilter(row(), "all"), true);
  assert.equal(matchesFilter(row(), "sent"), true);
  assert.equal(matchesFilter(row(), "received"), false);
  assert.equal(matchesFilter(row(), "voice"), true);
  assert.equal(matchesFilter(row({ origin: "chain", kind: "received", amount: { text: "+1", direction: 1, asset: "XLM" } }), "received"), true);
  assert.equal(matchesFilter(row({ approvalMode: "auto", statusChip: "auto_approved" }), "auto"), true);
  assert.equal(matchesFilter(row({ origin: "p2p", route: "p2p", kind: "p2p" }), "p2p"), true);
  assert.equal(matchesFilter(row({ origin: "anchor", route: "anchor", kind: "anchor_deposit" }), "anchor"), true);
});

function p2pRow(): HistoryRow {
  return row({
    id: "p2p:1",
    origin: "p2p",
    route: "p2p",
    kind: "p2p",
    title: "P2P offer #1",
    transcript: "P2P trade",
    response: "Waiting for TRY",
    amount: { text: "-100", direction: 0, asset: "USDC" },
    counterpartyNickname: null,
  });
}

test("filterCounts counts each chip independently", () => {
  const counts = filterCounts([row(), p2pRow()]);
  assert.equal(counts.all, 2);
  assert.equal(counts.sent, 1);
  assert.equal(counts.p2p, 1);
  assert.equal(counts.received, 0);
});

test("search matches nickname, hash fragments and amounts", () => {
  assert.equal(matchesQuery(row(), "ali"), true);
  assert.equal(matchesQuery(row(), "10 XLM"), true);
  assert.equal(matchesQuery(row(), "xlm"), true);
  assert.equal(matchesQuery(row(), "zzz"), false);
});

test("applyFilters applies the chip and the query together", () => {
  const rows = [row(), p2pRow()];
  assert.equal(applyFilters(rows, { filter: "p2p", query: "" }).length, 1);
  assert.equal(applyFilters(rows, { filter: "all", query: "ali" }).length, 1);
});

test("rows group by local day with Today/Yesterday labels", () => {
  const groups = groupByDay([row(), row({ id: "old", timestampMs: NOW - DAY })], NOW);
  assert.equal(groups.length, 2);
  assert.equal(groups[0]?.label, "Today");
  assert.equal(groups[1]?.label, "Yesterday");
});

test("relativeTime is coarse and dayLabel is stable", () => {
  assert.equal(relativeTime(NOW - 5_000, NOW), "just now");
  assert.equal(relativeTime(NOW - 5 * 60_000, NOW), "5m ago");
  assert.equal(relativeTime(NOW - 3 * 3_600_000, NOW), "3h ago");
  assert.equal(relativeTime(NOW - 2 * DAY, NOW), "2d ago");
  assert.equal(dayLabel(NOW, NOW), "Today");
});
