import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  BACKOFF,
  GUARD_ERRORS,
  TOKEN_ERRORS,
  backoffMs,
  classifyContractText,
  classifyThrown,
  classifyTxResultCode,
  type ErrorKind,
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

// ── the real polaris_guard error table ──────────────────────────────────────

const simText = (n: number): string => `HostError: Error(Contract, #${n})\n\nEvent log (newest first):\n   0: ...`;

test("every polaris_guard error code is mapped to the expected back-off class", () => {
  const expected: Record<number, [string, ErrorKind]> = {
    100: ["NotConfigured", "rule_violated"],
    101: ["InvalidAmount", "rule_violated"],
    102: ["InvalidRule", "rule_violated"],
    103: ["OverPerTxLimit", "rule_violated"],
    104: ["OverDailyLimit", "rule_violated"],
    105: ["NeedsOwnerApproval", "rule_violated"],
    106: ["AssetNotAllowed", "rule_violated"],
    107: ["NoExecutor", "auth_required"],
    108: ["NotExecutor", "auth_required"],
    109: ["ScheduleNotFound", "inactive"],
    110: ["ScheduleNotDue", "not_due"],
    111: ["ScheduleInactive", "inactive"],
    112: ["InvalidSchedule", "inactive"],
    113: ["NotScheduleOwner", "auth_required"],
    114: ["TooManySchedules", "rule_violated"],
    115: ["Overflow", "unknown_contract"],
    116: ["InsufficientAllowance", "allowance_missing"],
  };
  assert.equal(Object.keys(GUARD_ERRORS).length, Object.keys(expected).length);
  for (const [code, [name, kind]] of Object.entries(expected)) {
    const e = classifyContractText(simText(Number(code)));
    assert.equal(e.name, name, `name for #${code}`);
    assert.equal(e.kind, kind, `kind for #${code}`);
    assert.equal(e.code, Number(code));
  }
});

test("the three codes the keeper meets in practice", () => {
  assert.equal(classifyContractText(simText(110)).kind, "not_due"); // ScheduleNotDue
  assert.equal(classifyContractText(simText(116)).kind, "allowance_missing"); // InsufficientAllowance
  assert.equal(classifyContractText(simText(105)).name, "NeedsOwnerApproval");
});

test("codes below 100 are token/host errors and are never read as guard policy", () => {
  // SAC AllowanceError = 9 must not be mistaken for a guard error.
  const allowance = classifyContractText(simText(9));
  assert.equal(allowance.name, "SacAllowanceError");
  assert.equal(allowance.kind, "allowance_missing");
  assert.equal(classifyContractText(simText(10)).kind, "allowance_missing"); // BalanceError
  assert.equal(classifyContractText(simText(13)).name, "SacTrustlineMissing");
  // Code 1 is reserved in soroban-env (`_Reserved1`, formerly InternalError): it
  // is intentionally unmapped and degrades to unknown_contract.
  const reserved = classifyContractText(simText(1));
  assert.equal(reserved.kind, "unknown_contract");
  assert.equal(reserved.name, "ContractError#1");
  assert.equal(classifyContractText(simText(117)).kind, "unknown_contract");
  for (const code of Object.keys(TOKEN_ERRORS)) assert.ok(Number(code) < 100);
  for (const code of Object.keys(GUARD_ERRORS)) assert.ok(Number(code) >= 100);
});

test("the token contract error table matches soroban-env contract_error.rs codes 2..15", () => {
  const expected: Record<number, [string, ErrorKind]> = {
    2: ["SacOperationNotSupported", "unknown_contract"],
    3: ["SacAlreadyInitialized", "unknown_contract"],
    4: ["SacUnauthorized", "auth_required"],
    5: ["SacAuthentication", "auth_required"],
    6: ["SacAccountMissing", "rule_violated"],
    7: ["SacAccountIsNotClassic", "rule_violated"],
    8: ["SacNegativeAmount", "rule_violated"],
    9: ["SacAllowanceError", "allowance_missing"],
    10: ["SacBalanceError", "allowance_missing"],
    11: ["SacBalanceDeauthorized", "rule_violated"],
    12: ["SacOverflow", "unknown_contract"],
    13: ["SacTrustlineMissing", "rule_violated"],
    14: ["SacInsufficientAccountReserve", "allowance_missing"],
    15: ["SacTooManyAccountSubentries", "rule_violated"],
  };
  assert.equal(Object.keys(TOKEN_ERRORS).length, Object.keys(expected).length);
  for (const [code, [name, kind]] of Object.entries(expected)) {
    const e = classifyContractText(simText(Number(code)));
    assert.equal(e.name, name, `name for #${code}`);
    assert.equal(e.kind, kind, `kind for #${code}`);
    assert.equal(e.code, Number(code));
  }
  assert.equal(TOKEN_ERRORS[1], undefined, "code 1 is reserved in soroban-env");
});

test("GUARD_ERRORS matches the #[contracterror] enum in the contract source (drift guard)", (t) => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = process.env.GUARD_SRC ?? resolve(here, "../../../contracts/polaris_guard/src/lib.rs");
  if (!existsSync(src)) return t.skip("contract source not found");
  const text = readFileSync(src, "utf8");
  const block = /#\[contracterror\][\s\S]*?pub enum Error\s*\{([\s\S]*?)\n\}/.exec(text)?.[1];
  if (!block) return t.skip("no #[contracterror] enum in this revision of the contract");
  const fromSource = new Map<number, string>();
  for (const m of block.matchAll(/^\s*([A-Za-z0-9]+)\s*=\s*(\d+)\s*,/gm)) {
    fromSource.set(Number(m[2]), m[1]!);
  }
  assert.ok(fromSource.size > 0);
  assert.deepEqual(
    [...fromSource].map(([c, n]) => [c, n]).sort(),
    Object.entries(GUARD_ERRORS).map(([c, d]) => [Number(c), d.name]).sort(),
    "update GUARD_ERRORS in errors.ts to match the contract's error enum",
  );
});
