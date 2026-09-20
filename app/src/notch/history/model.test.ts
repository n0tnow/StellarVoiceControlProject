import assert from "node:assert/strict";
import { test } from "node:test";

import type { WalletTransaction } from "../../lib/history.ts";
import type { TurnLogEntry } from "../../lib/turnLog.ts";
import {
  buildAmount,
  chainToHistoryRow,
  formatRawAmount,
  mergeRows,
  parseAmountRaw,
  p2pToHistoryRow,
  turnToHistoryRow,
} from "./model.ts";

const HASH = "a".repeat(64);
const FRIEND = "GB3HO3WGM273M2OZLE5DVRN5WNCNSART6H6SAHP4CXGK34MMGNNDYLX5";

test("amounts parse and format with 7 decimals and no float", () => {
  assert.equal(parseAmountRaw("10"), 100_000_000n);
  assert.equal(parseAmountRaw("0.0000001"), 1n);
  assert.equal(parseAmountRaw("18.4"), 184_000_000n);
  assert.equal(parseAmountRaw("1.2345678999"), 12_345_678n);
  assert.equal(parseAmountRaw("nope"), null);
  assert.equal(parseAmountRaw(""), null);
  assert.equal(formatRawAmount(100_000_000n), "10");
  assert.equal(formatRawAmount(1n), "0.0000001");
  assert.equal(formatRawAmount(-184_000_000n), "-18.4");
  assert.equal(buildAmount("10", "XLM", -1)?.text, "-10");
  assert.equal(buildAmount("5.5", "USDC", 1)?.text, "+5.5");
});

function turn(overrides: Partial<TurnLogEntry> = {}): TurnLogEntry {
  return {
    id: "t1",
    timestampMs: 1_700_000_100_000,
    transcript: "ali'ye 10 XLM gönder",
    answer: "Sent 10 XLM to ali.",
    outcome: "tx_submitted",
    txHash: HASH,
    explorerUrl: `https://stellar.expert/explorer/testnet/tx/${HASH}`,
    ...overrides,
  };
}

function payment(overrides: Partial<WalletTransaction> = {}): WalletTransaction {
  return {
    id: "p1",
    hash: HASH,
    direction: "sent",
    counterparty: FRIEND,
    amount: "10",
    asset: "USDC",
    createdAtMs: 1_700_000_200_000,
    explorerUrl: null,
    ...overrides,
  };
}

test("a turn maps to a rich row with metadata and a signed amount", () => {
  const row = turnToHistoryRow(
    turn({ kind: "sent", amount: "10", asset: "XLM", counterparty: FRIEND, counterpartyNickname: "ali", approvalMode: "auto" }),
  );
  assert.equal(row.origin, "turn");
  assert.equal(row.kind, "sent");
  assert.equal(row.statusChip, "auto_approved");
  assert.equal(row.amount?.text, "-10");
  assert.equal(row.title, "Sent 10 XLM to ali");
  assert.equal(row.counterpartyNickname, "ali");
});

test("turn chips track failure, supersede and progress", () => {
  assert.equal(turnToHistoryRow(turn({ outcome: "failed: Chain error" })).statusChip, "failed");
  assert.equal(turnToHistoryRow(turn({ outcome: "superseded" })).statusChip, "cancelled");
  assert.equal(turnToHistoryRow(turn({ outcome: "in_progress" })).statusChip, "pending");
});

test("a chain payment maps to a signed, confirmed row", () => {
  const row = chainToHistoryRow(payment({ counterpartyAlias: "alice" }));
  assert.equal(row.origin, "chain");
  assert.equal(row.statusChip, "confirmed");
  assert.equal(row.amount?.text, "-10");
  assert.equal(row.title, "Sent 10 USDC to alice");
});

test("a P2P offer signs the seller out and the buyer in", () => {
  const base = {
    offerId: "3",
    seller: FRIEND,
    buyer: null,
    amount: "100",
    asset: "USDC",
    priceTry: "3400",
    state: "Open",
    createdAtMs: 1_700_000_000_000,
    nextAction: "cancel",
    nextActionHint: "Cancel the open offer.",
    explorerUrl: null,
  };
  assert.equal(p2pToHistoryRow({ ...base, role: "seller" }).amount?.direction, -1);
  assert.equal(p2pToHistoryRow({ ...base, role: "seller" }).kind, "p2p");
  assert.equal(p2pToHistoryRow({ ...base, role: "buyer" }).amount?.direction, 1);
  assert.equal(p2pToHistoryRow({ ...base, role: "seller", state: "Cancelled" }).statusChip, "cancelled");
});

test("mergeRows sorts newest first and drops a chain echo of a submitted turn", () => {
  const rows = mergeRows(
    [turnToHistoryRow(turn())],
    [chainToHistoryRow(payment()), chainToHistoryRow(payment({ id: "p2", hash: "b".repeat(64) }))],
  );
  assert.deepEqual(
    rows.map((row) => row.id),
    ["chain:p2", "turn:t1"],
  );
});
