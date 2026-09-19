import assert from "node:assert/strict";
import { test } from "node:test";

import { TurnFlow } from "./turnFlow.ts";

test("a blank transcript never starts a turn", () => {
  const flow = new TurnFlow();
  assert.deepEqual(flow.offer(""), { kind: "ignore", reason: "blank" });
  assert.deepEqual(flow.offer("   \n\t "), { kind: "ignore", reason: "blank" });
});

test("an identical re-emit of the in-flight transcript is ignored, not queued", () => {
  const flow = new TurnFlow();
  const first = flow.offer("send five usdc to ada");
  assert.equal(first.kind, "start");

  // The same event delivered twice (StrictMode double-listener, a re-emit) must
  // not start a second agent turn.
  assert.deepEqual(flow.offer("send five usdc to ada"), {
    kind: "ignore",
    reason: "duplicate",
  });
});

test("a second, different utterance supersedes the in-flight turn instead of being dropped", () => {
  const flow = new TurnFlow();
  const first = flow.offer("first");
  assert.equal(first.kind, "start");

  const second = flow.offer("second");
  assert.equal(second.kind, "start");
  if (first.kind !== "start" || second.kind !== "start") return;

  // The whole point of M2: the second utterance is admitted (so the shell is
  // never left waiting on a turn whose transcript was thrown away), and the
  // first turn can no longer touch the UI.
  assert.ok(second.ticket.generation > first.ticket.generation);
  assert.equal(flow.isCurrent(first.ticket), false);
  assert.equal(flow.isCurrent(second.ticket), true);
});

test("a superseded turn settling late does not clear the newer turn's guard", () => {
  const flow = new TurnFlow();
  const first = flow.offer("first");
  const second = flow.offer("second");
  if (first.kind !== "start" || second.kind !== "start") assert.fail("both should start");

  // The older turn's `.finally` runs after the newer turn started.
  flow.settle(first.ticket);
  assert.equal(flow.isCurrent(second.ticket), true);

  // A third utterance must still supersede the second (the guard is intact).
  const third = flow.offer("third");
  assert.equal(third.kind, "start");
  if (third.kind !== "start") return;
  assert.equal(flow.isCurrent(second.ticket), false);
});

test("the same words spoken again after the turn settles start a fresh turn", () => {
  const flow = new TurnFlow();
  const first = flow.offer("hello");
  if (first.kind !== "start") assert.fail("should start");
  flow.settle(first.ticket);

  const repeat = flow.offer("hello");
  assert.equal(repeat.kind, "start");
  if (repeat.kind !== "start") return;
  assert.equal(flow.isCurrent(first.ticket), false);
  assert.equal(flow.isCurrent(repeat.ticket), true);
});
