import assert from "node:assert/strict";
import { test } from "node:test";

import { chainRequiresCard, decideApproval, type ApprovalDecisionInput } from "./approvalPolicy.ts";

function input(overrides: Partial<ApprovalDecisionInput> = {}): ApprovalDecisionInput {
  return {
    kind: "send",
    asset: "USDC",
    amount: "10",
    summaryLines: ["Approval profile: always_ask", "Approval card required: no"],
    thresholdUsd: 0,
    ...overrides,
  };
}

test("chainRequiresCard matches only the exact 'yes' line", () => {
  assert.equal(chainRequiresCard(["Approval card required: yes"]), true);
  assert.equal(chainRequiresCard(["approval card required: yes"]), true);
  assert.equal(chainRequiresCard(["  Approval card required: yes  "]), true);
  assert.equal(chainRequiresCard(["Approval card required: no"]), false);
  assert.equal(chainRequiresCard(["Approval card required: yes please"]), false);
  assert.equal(chainRequiresCard([]), false);
});

test("threshold 0 always asks, even for a tiny USD payment", () => {
  const decision = decideApproval(input({ amount: "0.01", thresholdUsd: 0 }));
  assert.equal(decision.action, "card");
});

test("below the threshold auto-approves a USD stablecoin", () => {
  const decision = decideApproval(input({ amount: "10", thresholdUsd: 25 }));
  assert.equal(decision.action, "auto");
});

test("exactly at the threshold still asks (strictly-below only)", () => {
  const decision = decideApproval(input({ amount: "25", thresholdUsd: 25 }));
  assert.equal(decision.action, "card");
});

test("above the threshold asks", () => {
  const decision = decideApproval(input({ amount: "25.01", thresholdUsd: 25 }));
  assert.equal(decision.action, "card");
});

test("USD and the demo PGUSD are treated as stable; XLM always asks", () => {
  assert.equal(
    decideApproval(input({ asset: "usd", amount: "10", thresholdUsd: 25 })).action,
    "auto",
  );
  assert.equal(
    decideApproval(input({ asset: "PGUSD", amount: "10", thresholdUsd: 25 })).action,
    "auto",
  );
  const xlm = decideApproval(input({ asset: "XLM", amount: "1", thresholdUsd: 1000 }));
  assert.equal(xlm.action, "card");
  assert.match(xlm.reason, /no USD price/);
});

test("the chain's required card always wins over the threshold", () => {
  const decision = decideApproval(
    input({
      amount: "10",
      thresholdUsd: 25,
      summaryLines: ["Approval card required: yes"],
    }),
  );
  assert.equal(decision.action, "card");
  assert.match(decision.reason, /chain requires/);
});

test("a non-send intent always asks, threshold or not", () => {
  const decision = decideApproval(input({ kind: "swap", amount: "1", thresholdUsd: 1000 }));
  assert.equal(decision.action, "card");
});

test("an unreadable amount asks rather than auto-approving", () => {
  for (const bad of ["abc", "", "NaN", "-5"]) {
    const decision = decideApproval(input({ amount: bad, thresholdUsd: 25 }));
    assert.equal(decision.action, "card", `amount ${JSON.stringify(bad)}`);
  }
});

test("a negative or NaN threshold behaves as always-ask", () => {
  assert.equal(decideApproval(input({ thresholdUsd: -25 })).action, "card");
  assert.equal(decideApproval(input({ thresholdUsd: Number.NaN })).action, "card");
});
