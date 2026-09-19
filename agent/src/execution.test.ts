import assert from "node:assert/strict";
import { test } from "node:test";

import type { ChainToolResult, Intent } from "@polaris/interfaces";

import {
  createAutoApprovalPlaceholder,
  executeIntent,
  isNotImplementedError,
  type ChainToolSet,
  type IntentApprover,
} from "./execution.ts";

const INTENT: Intent = { kind: "send", asset: "USDC", amount: "5", recipient: "Ahmet" };

const RESULT: ChainToolResult = {
  unsignedXdr: "AAAA...unsigned",
  summary: {
    title: "Send 5 USDC to Ahmet",
    lines: ["amount: 5 USDC", "destination: Ahmet"],
    estimatedFee: "0.00001 XLM",
  },
};

/** Records the order in which the gate and the tool are reached. */
function recordingApprover(
  decision: { approved: boolean; reason?: string },
  log: string[],
): IntentApprover {
  return {
    async approve() {
      log.push("approve");
      return decision;
    },
  };
}

test("an approved intent is dispatched to its chain tool and returns the XDR + summary", async () => {
  const log: string[] = [];
  const chainTools: ChainToolSet = {
    send: async (intent) => {
      log.push(`tool:${intent.kind}`);
      return RESULT;
    },
  };

  const outcome = await executeIntent(INTENT, {
    approver: recordingApprover({ approved: true }, log),
    chainTools,
  });

  assert.equal(outcome.status, "executed");
  assert.deepEqual(outcome.result, RESULT);
  // The approval gate strictly precedes the chain tool: no chain work happens
  // before a human decision.
  assert.deepEqual(log, ["approve", "tool:send"]);
});

test("a rejected intent never reaches the chain tool", async () => {
  const log: string[] = [];
  let toolCalls = 0;
  const chainTools: ChainToolSet = {
    send: async () => {
      toolCalls += 1;
      return RESULT;
    },
  };

  const outcome = await executeIntent(INTENT, {
    approver: recordingApprover({ approved: false, reason: "user cancelled" }, log),
    chainTools,
  });

  assert.equal(outcome.status, "rejected");
  assert.equal(outcome.label, "Not approved");
  assert.equal(outcome.detail, "user cancelled");
  assert.equal(toolCalls, 0, "the chain tool must not run for a rejected intent");
  assert.equal(outcome.result, undefined);
});

test("a NotImplementedError stub is the expected 'not wired yet' state, not a failure", async () => {
  class NotImplementedError extends Error {
    constructor(what: string) {
      super(`${what} is not implemented yet (Milestone 3, Owner B)`);
      this.name = "NotImplementedError";
    }
  }

  const chainTools: ChainToolSet = {
    send: async (intent) => {
      throw new NotImplementedError(`sendPayment (intent: ${JSON.stringify(intent)})`);
    },
  };

  const outcome = await executeIntent(INTENT, {
    approver: recordingApprover({ approved: true }, []),
    chainTools,
  });

  assert.equal(outcome.status, "unavailable");
  assert.equal(outcome.label, "Chain not wired");
  assert.match(outcome.detail ?? "", /sendPayment .* not implemented yet/);
  assert.equal(outcome.result, undefined);
});

test("a real chain failure is reported as a failure, distinct from 'not wired'", async () => {
  const chainTools: ChainToolSet = {
    send: async () => {
      throw new Error("horizon: 503");
    },
  };

  const outcome = await executeIntent(INTENT, {
    approver: recordingApprover({ approved: true }, []),
    chainTools,
  });

  assert.equal(outcome.status, "failed");
  assert.equal(outcome.label, "Chain error");
  assert.equal(outcome.detail, "horizon: 503");
});

test("an intent with no registered chain tool is 'unsupported', never silently ignored", async () => {
  const outcome = await executeIntent(
    { kind: "raw_tx", asset: "USDC", amount: "1" },
    { approver: recordingApprover({ approved: true }, []), chainTools: {} },
  );

  assert.equal(outcome.status, "unsupported");
  assert.equal(outcome.label, "Not supported");
  assert.match(outcome.detail ?? "", /raw_tx/);
});

test("the placeholder approver approves and is clearly not Touch ID", async () => {
  const outcome = await executeIntent(INTENT, {
    approver: createAutoApprovalPlaceholder(),
    chainTools: { send: async () => RESULT },
  });
  assert.equal(outcome.status, "executed");
});

test("isNotImplementedError matches by name, like the stellar stub contract", () => {
  const error = new Error("nope");
  error.name = "NotImplementedError";
  assert.equal(isNotImplementedError(error), true);
  assert.equal(isNotImplementedError(new Error("nope")), false);
  assert.equal(isNotImplementedError("nope"), false);
  assert.equal(isNotImplementedError(undefined), false);
});
