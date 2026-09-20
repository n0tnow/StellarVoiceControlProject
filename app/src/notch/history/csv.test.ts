import assert from "node:assert/strict";
import { test } from "node:test";

import type { HistoryRow } from "./model.ts";
import { rowsToCsv } from "./csv.ts";

function row(overrides: Partial<HistoryRow> = {}): HistoryRow {
  return {
    id: "turn:1",
    timestamp: 1_700_000_000,
    timestampMs: 1_700_000_000_000,
    transcript: "ali'ye 10 XLM gönder",
    response: "Sent",
    action: "Transaction submitted",
    status: "success",
    txHash: "a".repeat(64),
    explorerUrl: null,
    origin: "turn",
    kind: "sent",
    statusChip: "confirmed",
    title: "Sent 10 XLM to ali",
    amount: { text: "-10", direction: -1, asset: "XLM" },
    route: "direct",
    approvalMode: "auto",
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

test("csv has a header and one line per row", () => {
  const csv = rowsToCsv([row()]);
  const [header, line] = csv.split("\n");
  assert.equal(header, "time,kind,status,title,amount,asset,counterparty,tx_hash,route,approval");
  assert.ok(line?.includes("sent,confirmed"));
  assert.ok(line?.includes("ali"));
});

test("csv quotes fields containing commas", () => {
  const csv = rowsToCsv([row({ title: "Sent 10, then 5" })]);
  assert.ok(csv.includes('"Sent 10, then 5"'));
});
