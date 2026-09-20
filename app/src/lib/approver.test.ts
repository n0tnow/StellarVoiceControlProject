import assert from "node:assert/strict";
import { test } from "node:test";

import type { ApprovalRequest } from "@polaris/agent";

import { createTouchIdApprover, type ApproverDeps, type ApprovalResultEvent } from "./approver.ts";
import type { ApprovalStatus } from "./approval.ts";
import type { InvokeFn } from "./approval.ts";

const REQUEST: ApprovalRequest = {
  intent: { kind: "send", asset: "XLM", amount: "10", recipient: "acc2" },
  summary: { title: "Send 10 XLM", lines: ["to acc2"], estimatedFee: "0.00001 XLM" },
  payloadHash: "hash-1",
  unsignedXdr: "AAAA...unsigned",
};

/**
 * A controllable timer/clock. `runUntilIdle` drains every scheduled callback in
 * order, so a poll chain such as poll → timer → poll can be advanced without
 * real time. `advance` fires the deadline timer when the virtual clock passes it.
 */
function fakeTimers() {
  let nextId = 1;
  let now = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const setTimer = (callback: () => void, ms: number): ReturnType<typeof setTimeout> => {
    const id = nextId++;
    timers.set(id, { at: now + ms, callback });
    return id as unknown as ReturnType<typeof setTimeout>;
  };
  const clearTimer = (handle: ReturnType<typeof setTimeout>): void => {
    timers.delete(handle as unknown as number);
  };

  /** Fires every timer whose deadline is at or before `now + ms`, earliest first. */
  const advance = (ms: number): void => {
    const target = now + ms;
    for (;;) {
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      const [id, timer] = due;
      timers.delete(id);
      now = timer.at;
      timer.callback();
    }
    now = target;
  };

  return { setTimer, clearTimer, advance, now: () => now };
}

/** A scripted invoke that answers approval_begin and polls by command name. */
function mockInvoke(handler: (command: string, args?: Record<string, unknown>) => unknown) {
  const calls: { command: string; args?: Record<string, unknown> }[] = [];
  const invoke: InvokeFn = async <T>(command: string, args?: Record<string, unknown>) => {
    calls.push(args === undefined ? { command } : { command, args });
    return handler(command, args) as T;
  };
  return { invoke, calls };
}

/** Lets queued microtasks run, so async setup (begin/first poll) completes. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

/** A subscribable set of approval_result listeners. */
function fakeEvents() {
  const listeners = new Set<(event: ApprovalResultEvent) => void>();
  return {
    emit(event: ApprovalResultEvent): void {
      for (const listener of listeners) listener(event);
    },
    count(): number {
      return listeners.size;
    },
    subscribe: async (handler: (event: ApprovalResultEvent) => void) => {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
  };
}

function status(state: ApprovalStatus["state"], reason?: string): ApprovalStatus {
  return reason === undefined ? { id: "apr_1", state } : { id: "apr_1", state, reason };
}

test("approved: the gate reports authorized and the approver approves", async () => {
  const { invoke, calls } = mockInvoke((command) =>
    command === "approval_begin" ? "apr_1" : status("authorized"),
  );
  const events = fakeEvents();
  const timers = fakeTimers();
  const deps: ApproverDeps = {
    invoke,
    subscribe: events.subscribe,
    ...timers,
  };

  const decision = await createTouchIdApprover(deps).approve(REQUEST);

  assert.equal(decision.approved, true);
  assert.equal(decision.approvalId, "apr_1");
  // The begin carried the exact blob and hash the card will show.
  const begin = calls.find((call) => call.command === "approval_begin");
  assert.deepEqual(begin?.args, {
    request: {
      payloadHash: "hash-1",
      unsignedXdr: "AAAA...unsigned",
      summary: REQUEST.summary,
      intent: REQUEST.intent,
      mode: "touch_id",
    },
  });
});

test("denied: the gate reports denied and the approver refuses", async () => {
  const { invoke } = mockInvoke((command) =>
    command === "approval_begin" ? "apr_1" : status("denied", "denied by user"),
  );
  const events = fakeEvents();
  const timers = fakeTimers();
  const decision = await createTouchIdApprover({
    invoke,
    subscribe: events.subscribe,
    ...timers,
  }).approve(REQUEST);

  assert.equal(decision.approved, false);
  assert.equal(decision.reason, "denied by user");
});

test("expired: the gate reports expired and the approver refuses", async () => {
  const { invoke } = mockInvoke((command) =>
    command === "approval_begin" ? "apr_1" : status("expired"),
  );
  const events = fakeEvents();
  const timers = fakeTimers();
  const decision = await createTouchIdApprover({
    invoke,
    subscribe: events.subscribe,
    ...timers,
  }).approve(REQUEST);

  assert.equal(decision.approved, false);
  assert.match(decision.reason ?? "", /expired/);
});

test("timeout: no terminal status before the deadline is a fail-closed refusal", async () => {
  const { invoke } = mockInvoke((command) =>
    command === "approval_begin" ? "apr_1" : status("pending"),
  );
  const events = fakeEvents();
  const timers = fakeTimers();
  const promise = createTouchIdApprover({
    invoke,
    subscribe: events.subscribe,
    ...timers,
  }).approve(REQUEST);

  // Let begin/first-poll run, then push past the 130 s deadline; the pending
  // answer never arrives.
  await flush();
  timers.advance(131_000);
  const decision = await promise;

  assert.equal(decision.approved, false);
  assert.match(decision.reason ?? "", /timed out/);
});

test("approval takes 90 s: the gate still decides, the deadline does not fire", async () => {
  let state: ApprovalStatus["state"] = "pending";
  const { invoke } = mockInvoke((command) => {
    if (command === "approval_begin") return "apr_1";
    return status(state);
  });
  const events = fakeEvents();
  const timers = fakeTimers();
  const promise = createTouchIdApprover({
    invoke,
    subscribe: events.subscribe,
    ...timers,
  }).approve(REQUEST);

  await flush();
  // 90 s of Touch ID: the approval ceiling (140 s) and this module's 130 s
  // deadline are both still in the future, so the gate decides the outcome.
  timers.advance(90_000);
  state = "authorized";
  events.emit({ payloadHash: "hash-1", approved: true });

  const decision = await promise;
  assert.equal(decision.approved, true);
  assert.equal(decision.approvalId, "apr_1");
});

test("begin failure: a rejected approval_begin propagates (fail closed)", async () => {
  const events = fakeEvents();
  const timers = fakeTimers();
  const { invoke } = mockInvoke(() => {
    throw { kind: "failed", message: "hash mismatch" };
  });

  await assert.rejects(
    createTouchIdApprover({
      invoke,
        subscribe: events.subscribe,
      ...timers,
    }).approve(REQUEST),
    (error: unknown) => {
      assert.deepEqual(error, { kind: "failed", message: "hash mismatch" });
      return true;
    },
  );
});

test("event-before-subscribe race: a decision that lands before the poll is still seen", async () => {
  // The gate reports `authorized` from the very first poll, which runs before
  // the event subscription has resolved. The poll fallback must still decide.
  let authorized = false;
  const { invoke, calls } = mockInvoke((command) => {
    if (command === "approval_begin") {
      authorized = true;
      return "apr_1";
    }
    return status(authorized ? "authorized" : "pending");
  });
  const events = fakeEvents();
  const timers = fakeTimers();
  const promise = createTouchIdApprover({
    invoke,
    subscribe: events.subscribe,
    ...timers,
  }).approve(REQUEST);

  const decision = await promise;
  assert.equal(decision.approved, true);
  assert.ok(calls.some((call) => call.command === "approval_status"));
  // The subscription still exists; the approver unsubscribes when it settles.
  await Promise.resolve();
  assert.equal(events.count(), 0);
});

test("an approval_result event for another payload is ignored", async () => {
  let polls = 0;
  const { invoke } = mockInvoke((command) => {
    if (command === "approval_begin") return "apr_1";
    polls += 1;
    return status("pending");
  });
  const events = fakeEvents();
  const timers = fakeTimers();
  const promise = createTouchIdApprover({
    invoke,
    subscribe: events.subscribe,
    ...timers,
  }).approve(REQUEST);

  // A result for a different payload must not end the wait.
  await flush();
  events.emit({ payloadHash: "other-hash", approved: true });
  await flush();
  assert.equal(polls >= 1, true);

  await flush();
  timers.advance(131_000);
  const decision = await promise;
  assert.equal(decision.approved, false);
});

test("a matching event triggers a gate re-read that decides", async () => {
  let state: ApprovalStatus["state"] = "pending";
  const { invoke } = mockInvoke((command) => {
    if (command === "approval_begin") return "apr_1";
    return status(state);
  });
  const events = fakeEvents();
  const timers = fakeTimers();
  const promise = createTouchIdApprover({
    invoke,
    subscribe: events.subscribe,
    ...timers,
  }).approve(REQUEST);

  await Promise.resolve();
  state = "authorized";
  events.emit({ payloadHash: "hash-1", approved: true });

  const decision = await promise;
  assert.equal(decision.approved, true);
});

test("a subscription failure leaves the poll to decide", async () => {
  const { invoke } = mockInvoke((command) =>
    command === "approval_begin" ? "apr_1" : status("authorized"),
  );
  const timers = fakeTimers();
  const decision = await createTouchIdApprover({
    invoke,
    subscribe: async () => {
      throw new Error("no event bus");
    },
    ...timers,
  }).approve(REQUEST);

  assert.equal(decision.approved, true);
});
