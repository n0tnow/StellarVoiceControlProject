import assert from "node:assert/strict";
import { test } from "node:test";

import {
  GATED_STEPS,
  INITIAL_FLOW,
  STEP_ORDER,
  advance,
  canAdvance,
  completedCleanly,
  isFinalStep,
  isGated,
  isSkipped,
  nextStep,
  passStep,
  previousStep,
  retreat,
  skipStep,
  slideDirection,
  type FlowState,
  type StepId,
} from "./steps.ts";

/** A flow parked on `step` with nothing passed or skipped. */
function at(step: StepId): FlowState {
  return { ...INITIAL_FLOW, step };
}

/** Walks the flow to the end, satisfying every gate honestly. */
function runClean(): FlowState {
  let state = INITIAL_FLOW;
  for (const step of STEP_ORDER) {
    if (isGated(step)) state = passStep(state, step);
    state = advance(state);
  }
  return state;
}

test("the flow starts on welcome with a clean slate", () => {
  assert.deepEqual(INITIAL_FLOW, { step: "welcome", passed: [], skipped: [] });
});

test("the notch step is deliberately not a gate", () => {
  // The load-bearing decision of this module; see GATED_STEPS' doc comment.
  assert.equal(isGated("notch"), false);
  assert.deepEqual([...GATED_STEPS], ["permissions", "push-to-talk", "type-prompt"]);
});

test("ungated pages advance freely", () => {
  assert.equal(canAdvance(at("welcome")), true);
  assert.equal(advance(at("welcome")).step, "permissions");
  assert.equal(advance(at("notch")).step, "ready");
});

test("a gate blocks Continue until it is satisfied", () => {
  const blocked = at("push-to-talk");
  assert.equal(canAdvance(blocked), false);
  assert.equal(advance(blocked).step, "push-to-talk", "a blocked advance is a no-op");

  const passed = passStep(blocked, "push-to-talk");
  assert.equal(canAdvance(passed), true);
  assert.equal(advance(passed).step, "type-prompt");
});

test("passing a gate records it but never moves the page", () => {
  // The user must get a beat to see that their gesture worked.
  const passed = passStep(at("type-prompt"), "type-prompt");
  assert.equal(passed.step, "type-prompt");
  assert.deepEqual([...passed.passed], ["type-prompt"]);
});

test("passing twice is idempotent, because the probes are not", () => {
  const once = passStep(at("push-to-talk"), "push-to-talk");
  const twice = passStep(once, "push-to-talk");
  assert.equal(twice, once, "a repeat pass returns the same object");
  assert.deepEqual([...twice.passed], ["push-to-talk"]);
});

test("skipping a gate advances and is remembered as a skip, not a pass", () => {
  const skipped = skipStep(at("permissions"), "permissions");
  assert.equal(skipped.step, "push-to-talk");
  assert.deepEqual([...skipped.skipped], ["permissions"]);
  assert.deepEqual([...skipped.passed], [], "a skip is never a pass");
});

test("skipping an ungated page is a plain advance and is not recorded", () => {
  const moved = skipStep(at("welcome"), "welcome");
  assert.equal(moved.step, "permissions");
  assert.deepEqual([...moved.skipped], []);
});

test("a skipped gate enables Continue on a return visit", () => {
  const skipped = skipStep(at("permissions"), "permissions");
  const back = retreat(skipped);
  assert.equal(back.step, "permissions");
  assert.equal(canAdvance(back), true);
  assert.equal(isSkipped(back, "permissions"), true);
});

test("going back never clears what was passed or skipped", () => {
  const passed = advance(passStep(at("push-to-talk"), "push-to-talk"));
  const back = retreat(passed);
  assert.equal(back.step, "push-to-talk");
  assert.deepEqual([...back.passed], ["push-to-talk"]);
  assert.equal(canAdvance(back), true, "a satisfied gate is not re-demanded");
});

test("the ends of the flow are closed", () => {
  assert.equal(previousStep("welcome"), null);
  assert.equal(retreat(at("welcome")).step, "welcome");
  assert.equal(nextStep("ready"), null);
  assert.equal(advance(at("ready")).step, "ready");
  assert.equal(isFinalStep("ready"), true);
  assert.equal(isFinalStep("notch"), false);
});

test("the slide direction follows the reading direction", () => {
  assert.equal(slideDirection("welcome", "permissions"), "forward");
  assert.equal(slideDirection("permissions", "welcome"), "back");
  // First render: no previous page, so the stage starts in its incoming pose.
  assert.equal(slideDirection("welcome", "welcome"), "forward");
});

test("a clean run reaches the end having satisfied every gate", () => {
  const done = runClean();
  assert.equal(done.step, "ready");
  assert.deepEqual([...done.passed], [...GATED_STEPS]);
  assert.equal(completedCleanly(done), true);
});

test("one skip anywhere makes the final page tell a different truth", () => {
  let state = skipStep(INITIAL_FLOW, "welcome"); // ungated: not a skip
  assert.equal(completedCleanly(state), true);
  state = skipStep(state, "permissions");
  assert.equal(completedCleanly(state), false);
});

test("every step is reachable by walking forward from the start", () => {
  const seen: StepId[] = [INITIAL_FLOW.step];
  let state = INITIAL_FLOW;
  for (let guard = 0; guard < STEP_ORDER.length * 2; guard += 1) {
    const moved = skipStep(state, state.step);
    if (moved.step === state.step) break;
    state = moved;
    seen.push(state.step);
  }
  assert.deepEqual(seen, [...STEP_ORDER], "no page is stranded behind a gate");
});
