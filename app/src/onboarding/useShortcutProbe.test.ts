import assert from "node:assert/strict";
import { test } from "node:test";

import {
  INITIAL_TAP,
  MAX_TAP_HOLD_MS,
  MIN_HOLD_MS,
  TAP_GAP_MS,
  isQualifyingHold,
  tapEventFor,
  tapReducer,
  type TapEvent,
  type TapState,
} from "./useShortcutProbe.ts";

/** Feeds a sequence and reports the final state plus how many double taps fired. */
function run(events: TapEvent[], from: TapState = INITIAL_TAP) {
  let state = from;
  let fired = 0;
  for (const event of events) {
    const result = tapReducer(state, event);
    state = result.state;
    if (result.fired) fired += 1;
  }
  return { state, fired };
}

/** A Control tap: down at `at`, up `hold` later. */
function tap(at: number, hold = 60): TapEvent[] {
  return [
    { kind: "control-down", at },
    { kind: "control-up", at: at + hold },
  ];
}

/* --- the hold rule --------------------------------------------------- */

test("a hold of exactly the minimum qualifies", () => {
  assert.equal(isQualifyingHold(1000, 1000 + MIN_HOLD_MS), true);
});

test("a hold one millisecond short does not", () => {
  assert.equal(isQualifyingHold(1000, 1000 + MIN_HOLD_MS - 1), false);
});

test("the lesson's minimum is above the native latch's arm delay", () => {
  // gesture::ARM_DELAY is 300 ms. A hold that passes the lesson must always be
  // one the real latch would have armed, or we would teach a dead gesture.
  assert.ok(MIN_HOLD_MS > 300, "MIN_HOLD_MS must exceed ARM_DELAY");
});

/* --- the double-tap rules -------------------------------------------- */

test("two quick taps fire a double tap", () => {
  const { fired, state } = run([...tap(0), ...tap(100)]);
  assert.equal(fired, 1);
  assert.deepEqual(state, INITIAL_TAP, "a fired double tap resets the machine");
});

test("one tap alone fires nothing but remembers its release", () => {
  const { fired, state } = run(tap(0, 60));
  assert.equal(fired, 0);
  assert.equal(state.lastReleaseAt, 60);
});

test("a second tap that starts too late starts a fresh pair", () => {
  const late = 60 + TAP_GAP_MS + 1;
  const { fired, state } = run([...tap(0, 60), ...tap(late)]);
  assert.equal(fired, 0, "the pair is too slow to be a double tap");
  assert.equal(state.lastReleaseAt, late + 60, "but the late tap becomes the new first");
});

test("a second tap at exactly the gap limit still fires", () => {
  const { fired } = run([...tap(0, 60), ...tap(60 + TAP_GAP_MS)]);
  assert.equal(fired, 1);
});

test("a press held too long is a hold, not a tap", () => {
  const { fired, state } = run(tap(0, MAX_TAP_HOLD_MS + 1));
  assert.equal(fired, 0);
  assert.deepEqual(state, INITIAL_TAP, "a hold leaves no pending first tap");
});

test("two long presses never make a double tap", () => {
  const long = MAX_TAP_HOLD_MS + 50;
  const { fired } = run([...tap(0, long), ...tap(long + 50, long)]);
  assert.equal(fired, 0);
});

test("a Control chord is not a tap", () => {
  // Ctrl+C: Control down, an ordinary key down, Control up.
  const { fired } = run([
    { kind: "control-down", at: 0 },
    { kind: "other-key" },
    { kind: "control-up", at: 40 },
    ...tap(100),
  ]);
  assert.equal(fired, 0, "the poisoned press must not pair with the next tap");
});

test("a foreign modifier between the two taps invalidates the sequence", () => {
  const { fired } = run([...tap(0), { kind: "foreign-modifier" }, ...tap(100)]);
  assert.equal(fired, 0);
});

test("a release clears the poison so the next attempt can succeed", () => {
  const { fired } = run([
    { kind: "control-down", at: 0 },
    { kind: "other-key" },
    { kind: "control-up", at: 40 },
    ...tap(200),
    ...tap(300),
  ]);
  assert.equal(fired, 1, "one bad chord must not disable the lesson for good");
});

test("a stray release with no press is ignored", () => {
  const { fired, state } = run([{ kind: "control-up", at: 10 }]);
  assert.equal(fired, 0);
  assert.deepEqual(state, INITIAL_TAP);
});

test("losing focus resets a half-finished attempt", () => {
  const { fired, state } = run([...tap(0), { kind: "reset" }, ...tap(100)]);
  assert.equal(fired, 0, "the first tap does not survive a blur");
  assert.deepEqual(state.pressedAt, null);
});

test("three taps fire once, not twice: a double tap needs two fresh taps", () => {
  const { fired } = run([...tap(0), ...tap(100), ...tap(200)]);
  assert.equal(fired, 1);
});

/* --- reading the browser's keyboard events --------------------------- */

const CLEAN = { altKey: false, metaKey: false, shiftKey: false };

test("a Control keydown and keyup map to the tap events", () => {
  assert.deepEqual(tapEventFor("keydown", "Control", CLEAN, 7), {
    kind: "control-down",
    at: 7,
  });
  assert.deepEqual(tapEventFor("keyup", "Control", CLEAN, 9), { kind: "control-up", at: 9 });
});

test("any foreign modifier flag poisons, whichever key carried it", () => {
  for (const flag of ["altKey", "metaKey", "shiftKey"] as const) {
    const modifiers = { ...CLEAN, [flag]: true };
    assert.deepEqual(
      tapEventFor("keydown", "Control", modifiers, 0),
      { kind: "foreign-modifier" },
      `${flag} must poison the attempt`,
    );
  }
});

test("Control+Option — the push-to-talk gesture — can never be read as a tap", () => {
  // The lesson before this one teaches exactly this hold; it must not also
  // satisfy the lesson after it.
  const held = { ...CLEAN, altKey: true };
  assert.deepEqual(tapEventFor("keydown", "Control", held, 0), { kind: "foreign-modifier" });
});

test("an ordinary key down is a chord marker; its key up says nothing", () => {
  assert.deepEqual(tapEventFor("keydown", "c", CLEAN, 0), { kind: "other-key" });
  assert.equal(tapEventFor("keyup", "c", CLEAN, 0), null);
});

test("the DOM rules agree with the Rust detector's constants", () => {
  assert.equal(MAX_TAP_HOLD_MS, 350, "ctrl_tap::MAX_TAP_HOLD");
  assert.equal(TAP_GAP_MS, 400, "ctrl_tap::TAP_GAP");
});
