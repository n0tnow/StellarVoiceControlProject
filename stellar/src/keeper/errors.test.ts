import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BACKOFF,
  backoffMs,
  classifyContractText,
  classifyThrown,
  classifyTxResultCode,
  type GuardErrorDef,
} from "./errors.ts";

const TABLE: Record<number, GuardErrorDef> = {
  1: { name: "AlreadyExecuted", kind: "already_executed" },
  2: { name: "NotDue", kind: "not_due" },
  3: { name: "ScheduleInactive", kind: "inactive" },
  4: { name: "LimitExceeded", kind: "rule_violated" },
  5: { name: "AllowanceMissing", kind: "allowance_missing" },
};

const simError = (n: number): string =>
  `HostError: Error(Contract, #${n})\n\nEvent log (newest first):\n   0: [Diagnostic Event] ...`;

test("maps known contract error codes to kinds", () => {
  assert.equal(classifyContractText(simError(1), TABLE).kind, "already_executed");
  assert.equal(classifyContractText(simError(2), TABLE).kind, "not_due");
  assert.equal(classifyContractText(simError(3), TABLE).kind, "inactive");
  assert.equal(classifyContractText(simError(4), TABLE).kind, "rule_violated");
  const allowance = classifyContractText(simError(5), TABLE);
  assert.equal(allowance.kind, "allowance_missing");
  assert.equal(allowance.name, "AllowanceMissing");
  assert.equal(allowance.code, 5);
});

test("unknown contract code is kept and backed off as unknown_contract", () => {
  const e = classifyContractText(simError(99), TABLE);
  assert.equal(e.kind, "unknown_contract");
  assert.equal(e.name, "ContractError#99");
});

test("message is trimmed to the first line (no event-log spam)", () => {
  const e = classifyContractText(simError(2), TABLE);
  assert.equal(e.message, "HostError: Error(Contract, #2)");
});

test("host/tx failures are not confused with contract errors", () => {
  assert.equal(classifyContractText("HostError: Error(Budget, ExceededLimit)").kind, "unknown");
  assert.equal(classifyTxResultCode("txBadSeq").kind, "bad_seq");
  assert.equal(classifyTxResultCode("txInsufficientBalance").kind, "keeper_funds");
  assert.equal(classifyTxResultCode("txTooLate").kind, "tx_expired");
});

test("thrown transport errors are transient rpc errors", () => {
  const e = classifyThrown(new Error("fetch failed"));
  assert.equal(e.kind, "rpc");
  assert.equal(classifyThrown("boom").kind, "rpc");
});

test("backoff grows exponentially per kind and is capped", () => {
  const p = BACKOFF.rule_violated;
  assert.equal(backoffMs("rule_violated", 1), p.baseMs);
  assert.equal(backoffMs("rule_violated", 2), p.baseMs * 2);
  assert.equal(backoffMs("rule_violated", 3), p.baseMs * 4);
  assert.equal(backoffMs("rule_violated", 50), p.maxMs);
  assert.ok(backoffMs("rpc", 1) < backoffMs("rule_violated", 1), "transient errors retry sooner");
});
