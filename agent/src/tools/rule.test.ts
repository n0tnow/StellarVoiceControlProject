import assert from "node:assert/strict";
import { test } from "node:test";

import { AgentError } from "../errors.ts";
import type { ToolContext } from "./registry.ts";
import { normalizeRuleMode, parseSetApprovalRule } from "./rule.ts";

const ctx: ToolContext = { transcript: "test", network: "testnet" };

test("an auto-approve limit in a named asset becomes a guard_policy proposal", () => {
  const intent = parseSetApprovalRule(
    { mode: "auto_under_limit", autoApproveLimit: "5", asset: "XLM", dailyLimit: "50" },
    ctx,
  );
  assert.equal(intent.kind, "guard_policy");
  assert.equal(intent.rule?.mode, "auto_under_limit");
  assert.equal(intent.rule?.autoApproveLimit, "5");
  assert.equal(intent.rule?.asset, "XLM");
  assert.equal(intent.rule?.dailyLimit, "50");
  assert.equal(intent.amount, "5");
});

test("a dollar limit with no asset asks which asset instead of guessing", () => {
  assert.throws(
    () => parseSetApprovalRule({ mode: "auto_under_limit", autoApproveLimit: "10" }, ctx),
    (error: unknown) => {
      assert.ok(error instanceof AgentError);
      assert.equal(error.kind, "input");
      assert.equal(error.pending?.question, "rule_asset");
      assert.deepEqual(error.pending?.missing, ["asset"]);
      return true;
    },
  );
});

test("always_ask produces a zero-limit rule with no asset required", () => {
  const intent = parseSetApprovalRule({ mode: "always ask" }, ctx);
  assert.equal(intent.rule?.mode, "always_ask");
  assert.equal(intent.amount, "0");
});

test("contacts-only is allowed on its own", () => {
  const intent = parseSetApprovalRule({ mode: "auto_under_limit", knownRecipientsOnly: true }, ctx);
  assert.equal(intent.rule?.knownRecipientsOnly, true);
  assert.equal(intent.rule?.autoApproveLimit, undefined);
});

test("an unsupported asset is refused, not guessed", () => {
  assert.throws(
    () => parseSetApprovalRule({ mode: "auto_under_limit", autoApproveLimit: "5", asset: "EUR" }, ctx),
    AgentError,
  );
});

test("mode synonyms fold to the two profiles", () => {
  assert.equal(normalizeRuleMode("always ask"), "always_ask");
  assert.equal(normalizeRuleMode("auto-approve"), "auto_under_limit");
  assert.equal(normalizeRuleMode("nonsense"), undefined);
});
