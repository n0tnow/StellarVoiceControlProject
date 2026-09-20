import assert from "node:assert/strict";
import { test } from "node:test";

import type { ApprovalRequest, IntentApprover } from "@polaris/agent";

import { PREFERENCES_STORAGE_KEY, type PreferenceStore } from "./preferences.ts";
import { createThresholdApprover } from "./thresholdApprover.ts";

const REQUEST: ApprovalRequest = {
  intent: { kind: "send", asset: "USDC", amount: "10", recipient: "acc2" },
  summary: {
    title: "Send 10 USDC",
    lines: ["to acc2", "Approval profile: always_ask", "Approval card required: no"],
    estimatedFee: "0.00001 XLM",
  },
  payloadHash: "hash-1",
  unsignedXdr: "AAAA...unsigned",
};

function fakeStore(threshold: number | null): PreferenceStore {
  const data = new Map<string, string>();
  if (threshold !== null) {
    data.set(PREFERENCES_STORAGE_KEY, JSON.stringify({ approvalThresholdUsd: threshold }));
  }
  return {
    getItem: (key) => (data.has(key) ? (data.get(key) as string) : null),
    setItem: (key, value) => {
      data.set(key, value);
    },
  };
}

/** A scripted inner approver that records whether it was consulted. */
function fakeInner(decision = true): IntentApprover & { calls: number } {
  const state = { calls: 0 };
  return {
    get calls() {
      return state.calls;
    },
    async approve() {
      state.calls += 1;
      return { approved: decision, approvalId: "apr_1" };
    },
  };
}

// PR #29 review, CRITICAL-1: an approvalId-less `approved: true` could never be
// signed (`bridge_sign` needs a gate-registered id), so until the executor
// route is wired an `auto` decision logs and defers to the card — it never
// skips the gate.
test("below the threshold still reaches the gate (interim: executor route not wired)", async () => {
  const inner = fakeInner();
  const approver = createThresholdApprover(inner, {}, fakeStore(25));
  const decision = await approver.approve(REQUEST);
  assert.equal(inner.calls, 1);
  assert.equal(decision.approved, true);
  assert.equal(decision.approvalId, "apr_1");
});

test("a threshold skip can never leak an approvalId-less approval", async () => {
  const inner = fakeInner();
  const approver = createThresholdApprover(inner, {}, fakeStore(1000));
  const decision = await approver.approve(REQUEST);
  if (decision.approved === true) {
    assert.equal(typeof decision.approvalId, "string");
  }
});

test("at or above the threshold defers to the gate approver", async () => {
  for (const amount of ["25", "30"]) {
    const inner = fakeInner();
    const approver = createThresholdApprover(inner, {}, fakeStore(25));
    const decision = await approver.approve({
      ...REQUEST,
      intent: { ...REQUEST.intent, amount },
    });
    assert.equal(inner.calls, 1, `amount ${amount}`);
    assert.equal(decision.approved, true);
    assert.equal(decision.approvalId, "apr_1");
  }
});

test("a chain-required card always reaches the gate, even below the threshold", async () => {
  const inner = fakeInner();
  const approver = createThresholdApprover(inner, {}, fakeStore(25));
  await approver.approve({
    ...REQUEST,
    summary: { ...REQUEST.summary, lines: ["Approval card required: yes"] },
  });
  assert.equal(inner.calls, 1);
});

test("a non-USD asset reaches the gate even below the threshold", async () => {
  const inner = fakeInner();
  const approver = createThresholdApprover(inner, {}, fakeStore(1000));
  await approver.approve({
    ...REQUEST,
    intent: { ...REQUEST.intent, asset: "XLM", amount: "1" },
  });
  assert.equal(inner.calls, 1);
});

test("no stored preference means always ask", async () => {
  const inner = fakeInner();
  const approver = createThresholdApprover(inner, {}, fakeStore(null));
  await approver.approve({ ...REQUEST, intent: { ...REQUEST.intent, amount: "0.01" } });
  assert.equal(inner.calls, 1);
});

test("a requiresCard override forces the gate regardless of the threshold", async () => {
  const inner = fakeInner();
  const approver = createThresholdApprover(inner, { requiresCard: () => true }, fakeStore(100));
  await approver.approve(REQUEST);
  assert.equal(inner.calls, 1);
});

test("a denied gate decision is passed through untouched", async () => {
  const inner = fakeInner(false);
  const approver = createThresholdApprover(inner, {}, fakeStore(25));
  const decision = await approver.approve({
    ...REQUEST,
    intent: { ...REQUEST.intent, amount: "30" },
  });
  assert.equal(decision.approved, false);
});
