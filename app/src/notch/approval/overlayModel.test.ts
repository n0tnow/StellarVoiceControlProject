import assert from "node:assert/strict";
import { test } from "node:test";

import type { ApprovalSnapshot } from "../../lib/approval.ts";
import {
  CANCELLED_HINT,
  canApprove,
  initialOverlayState,
  isVisible,
  reduceOverlay,
  remainingMs,
  resultLine,
  resultTone,
  type OverlayState,
} from "./overlayModel.ts";

function snapshot(overrides: Partial<ApprovalSnapshot> = {}): ApprovalSnapshot {
  return {
    id: "req-1",
    payloadHash: "hash-1",
    summary: { title: "Send 1 XLM to Ada", lines: ["To Ada"], estimatedFee: "0.00001 XLM" },
    intent: { kind: "send", asset: "XLM", amount: "1" },
    mode: "touch_id",
    state: "pending",
    expiresAtMs: 10_000,
    ...overrides,
  };
}

/** A live pending overlay at `nowMs`. */
function pending(nowMs = 0): OverlayState {
  return reduceOverlay(initialOverlayState(), { type: "snapshot", snapshot: snapshot(), nowMs });
}

/* ------------------------------------------------------------------ *
 * Hydration — the overlay opens after the event, so this is the entry path.
 * ------------------------------------------------------------------ */

test("the overlay starts hidden and a null snapshot keeps it hidden", () => {
  assert.deepEqual(initialOverlayState(), {
    stage: "hidden",
    snapshot: null,
    nowMs: 0,
    hint: null,
    error: null,
  });
  assert.equal(
    isVisible(reduceOverlay(initialOverlayState(), { type: "snapshot", snapshot: null, nowMs: 0 })),
    false,
  );
});

test("hydrates pending, then expired when the deadline has passed", () => {
  const live = pending(5_000);
  assert.equal(live.stage, "pending");
  assert.equal(isVisible(live), true);
  assert.equal(canApprove(live), true);

  const stale = reduceOverlay(initialOverlayState(), {
    type: "snapshot",
    snapshot: snapshot({ expiresAtMs: 1_000 }),
    nowMs: 5_000,
  });
  assert.equal(stale.stage, "expired");
});

test("hydrates the gate's terminal states as results", () => {
  for (const [state, stage] of [
    ["authorized", "sent"],
    ["consumed", "sent"],
    ["denied", "denied"],
    ["expired", "expired"],
  ] as const) {
    const hydrated = reduceOverlay(initialOverlayState(), {
      type: "snapshot",
      snapshot: snapshot({ state }),
      nowMs: 0,
    });
    assert.equal(hydrated.stage, stage, `${state} must hydrate as ${stage}`);
  }
});

test("an unrecognised snapshot state fails closed", () => {
  const broken = snapshot({ state: "quantum" as ApprovalSnapshot["state"] });
  const state = reduceOverlay(initialOverlayState(), {
    type: "snapshot",
    snapshot: broken,
    nowMs: 0,
  });
  assert.equal(state.stage, "failed");
  assert.equal(canApprove(state), false);
});

/* ------------------------------------------------------------------ *
 * The approve/deny gestures.
 * ------------------------------------------------------------------ */

test("pending -> authorizing -> sent, and Approve is locked while authorizing", () => {
  const started = reduceOverlay(pending(), { type: "approveClicked" });
  assert.equal(started.stage, "authorizing");
  assert.equal(canApprove(started), false);

  const done = reduceOverlay(started, { type: "authorizeOk" });
  assert.equal(done.stage, "sent");
  assert.equal(resultLine(done), "Sent");
});

test("a double click cannot start a second gesture", () => {
  const started = reduceOverlay(pending(), { type: "approveClicked" });
  assert.deepEqual(reduceOverlay(started, { type: "approveClicked" }), started);
});

test("deny is available while pending and while authorizing", () => {
  assert.equal(reduceOverlay(pending(), { type: "denyClicked" }).stage, "denied");
  const authorizing = reduceOverlay(pending(), { type: "approveClicked" });
  assert.equal(reduceOverlay(authorizing, { type: "denyClicked" }).stage, "denied");
  assert.equal(resultLine(reduceOverlay(pending(), { type: "denyClicked" })), "Denied");
});

test("a cancelled prompt returns to pending with a calm hint", () => {
  const authorizing = reduceOverlay(pending(), { type: "approveClicked" });
  const back = reduceOverlay(authorizing, { type: "authorizeFailed", kind: "cancelled" });
  assert.equal(back.stage, "pending");
  assert.equal(back.hint, CANCELLED_HINT);
});

test("failed, unavailable, timeout and notPending become failed results", () => {
  const authorizing = reduceOverlay(pending(), { type: "approveClicked" });
  for (const kind of ["failed", "unavailable", "timeout", "notPending"] as const) {
    const state = reduceOverlay(authorizing, { type: "authorizeFailed", kind });
    assert.equal(state.stage, "failed", `${kind} must fail closed`);
    assert.equal(canApprove(state), false);
    assert.match(resultLine(state) ?? "", /^Failed: /);
  }
  assert.equal(resultTone(reduceOverlay(authorizing, { type: "authorizeFailed", kind: "failed" })), "danger");
});

/* ------------------------------------------------------------------ *
 * Expiry via the injected clock.
 * ------------------------------------------------------------------ */

test("a tick past the deadline expires the request and disables Approve", () => {
  const state = reduceOverlay(pending(), { type: "tick", nowMs: 10_000 });
  assert.equal(state.stage, "expired");
  assert.equal(canApprove(state), false);
  assert.equal(remainingMs(state), null);
});

test("a tick before the deadline only advances the clock and the countdown", () => {
  const state = reduceOverlay(pending(), { type: "tick", nowMs: 4_000 });
  assert.equal(state.stage, "pending");
  assert.equal(remainingMs(state), 6_000);
  assert.equal(canApprove(state), true);
});

/* ------------------------------------------------------------------ *
 * The result event is keyed by payload hash.
 * ------------------------------------------------------------------ */

test("a matching result approves or denies", () => {
  assert.equal(
    reduceOverlay(pending(), { type: "result", payloadHash: "hash-1", approved: true }).stage,
    "sent",
  );
  assert.equal(
    reduceOverlay(pending(), { type: "result", payloadHash: "hash-1", approved: false }).stage,
    "denied",
  );
});

test("a result for another payload is ignored", () => {
  const live = pending();
  assert.deepEqual(
    reduceOverlay(live, { type: "result", payloadHash: "other", approved: true }),
    live,
  );
});

/* ------------------------------------------------------------------ *
 * The result dwell: a null snapshot must not wipe a fresh result.
 * ------------------------------------------------------------------ */

test("a null snapshot clears pending but keeps a result until it is dismissed", () => {
  const sent = reduceOverlay(pending(), { type: "authorizeOk" });
  assert.equal(sent.stage, "sent");
  // The gate's next read returns nothing (the request was consumed); the result
  // must survive its dwell instead of blinking away.
  assert.equal(reduceOverlay(sent, { type: "snapshot", snapshot: null, nowMs: 1 }).stage, "sent");
  assert.equal(reduceOverlay(sent, { type: "dismiss" }).stage, "hidden");

  assert.equal(reduceOverlay(pending(), { type: "snapshot", snapshot: null, nowMs: 1 }).stage, "hidden");
});
