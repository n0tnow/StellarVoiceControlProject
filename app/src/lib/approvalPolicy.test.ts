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

test("USDC and the demo PGUSD are treated as stable; XLM always asks", () => {
  assert.equal(
    decideApproval(input({ asset: "usdc", amount: "10", thresholdUsd: 25 })).action,
    "auto",
  );
  assert.equal(
    decideApproval(input({ asset: "PGUSD", amount: "10", thresholdUsd: 25 })).action,
    "auto",
  );
  // A bare "USD" code is not in the chain registry, so it is not eligible
  // either (PR #29 review, MAJOR-3) — the chain tool would refuse it anyway.
  const usd = decideApproval(input({ asset: "USD", amount: "10", thresholdUsd: 25 }));
  assert.equal(usd.action, "card");
  assert.match(usd.reason, /no USD price/);
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

// PR #29 review, MINOR-5: pins the precedence ordering — a chain-required card
// beats an otherwise fully auto-eligible combination (send + pinned USD stable
// + strictly-below amount), not just any weak auto candidate.
test("precedence pin: chain-required card beats a would-be auto combination", () => {
  const decision = decideApproval({
    kind: "send",
    asset: "USDC",
    amount: "10",
    thresholdUsd: 25,
    summaryLines: ["Approval profile: always_ask", "Approval card required: yes"],
  });
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

// PR #29 review, MINOR-4: `Number()` accepts shapes the chain amount regex
// (`stellar/src/guard/amount.ts`) rejects — hex, exponents, whitespace, bare
// dots. None of them may pass a threshold.
test("strict decimal only: hex, exponents, signs and whitespace always ask", () => {
  for (const bad of ["0x10", "1e2", " 5", "5 ", " 5 ", ".5", "5.", "+5", "1_0"]) {
    const decision = decideApproval(input({ amount: bad, thresholdUsd: 1000 }));
    assert.equal(decision.action, "card", `amount ${JSON.stringify(bad)}`);
    assert.match(decision.reason, /not a readable decimal/, `amount ${JSON.stringify(bad)}`);
  }
  // And the well-formed decimals the regex accepts still work.
  for (const good of ["5", "5.0", "0.0000001", "123456789012"]) {
    const decision = decideApproval(input({ amount: good, thresholdUsd: 1e15 }));
    assert.equal(decision.action, "auto", `amount ${JSON.stringify(good)}`);
  }
  // Shapes beyond the chain's own digit caps are unreadable here too.
  for (const bad of ["1234567890123", "0.00000001"]) {
    const decision = decideApproval(input({ amount: bad, thresholdUsd: 1e15 }));
    assert.equal(decision.action, "card", `amount ${JSON.stringify(bad)}`);
  }
});

test("a negative or NaN threshold behaves as always-ask", () => {
  assert.equal(decideApproval(input({ thresholdUsd: -25 })).action, "card");
  assert.equal(decideApproval(input({ thresholdUsd: Number.NaN })).action, "card");
});
