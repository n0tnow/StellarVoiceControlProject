/**
 * The onboarding flow's pure rules.
 *
 * Everything that can be wrong about first run is in this file: which page comes
 * next, which pages refuse to be left, what "skipped" costs, and what the window
 * remembers when it is closed halfway. None of it needs React, a DOM or a
 * bundler, so none of it is written in a component — the components below this
 * module render a [`FlowState`] and call the transitions here, and that is the
 * whole of their logic.
 *
 * The shape is a reducer over a small immutable state rather than a state chart
 * library or a `useState` per page, because the two genuinely hard questions —
 * "may I leave this page?" and "what happens when the user skips a gate?" — are
 * questions about the *whole* flow, and a per-page `useState` cannot answer
 * either one.
 *
 * ## Gates, and why skipping is a first-class outcome
 *
 * Three pages are gates: permissions, and the two shortcut lessons. A gate is a
 * page whose Continue is disabled until something real happens — both
 * permissions granted, a genuine 400 ms Control+Option hold, a genuine
 * double-Control tap.
 *
 * A gate with no way past it is a trap, and a first-run window that traps a user
 * traps them *before* they have any other way to reach the app. So every gate
 * also has an escape ([`skipStep`]) — muted, deliberately unattractive, but
 * present. The important part is that skipping is *recorded*: `skipped` is a set
 * on the state, it survives going backwards and forwards, and it is what lets
 * the final page say something true rather than congratulate someone whose
 * microphone is still off.
 *
 * Note what [`skipStep`] does **not** do: it does not mark the step passed.
 * "Passed" means the user did the thing; "skipped" means they did not and chose
 * to move on anyway. Collapsing the two would lose exactly the fact the final
 * page needs.
 *
 * ## Why steps are a list of ids, not an index
 *
 * `STEP_ORDER` is the single source of the sequence, and every function here
 * takes and returns a `StepId`. An index would make "the third page" meaningful,
 * which it is not: inserting a page between two others must not be able to
 * silently re-point a saved position at the wrong screen, and the notch page in
 * particular is one whose existence is contested (see `NotchPage`). Positions
 * are derived from the id when a position is needed — for the dot row and for
 * the slide direction — and never stored.
 */

/** Every page, in order. This list *is* the flow. */
export const STEP_ORDER = [
  "welcome",
  "permissions",
  "push-to-talk",
  "type-prompt",
  "notch",
  "ready",
] as const;

/** One page's identity. Derived from [`STEP_ORDER`] so the two cannot drift. */
export type StepId = (typeof STEP_ORDER)[number];

/**
 * The pages that will not let the user past until something real has happened.
 *
 * `notch` is **not** in this set, and that is the single most consequential line
 * in this module. Teaching hover by making the user actually hover cannot be
 * verified while the onboarding window is focused: the native `notch_hover`
 * edge comes from a `mouseMoved` monitor pair, and macOS pauses the *global*
 * monitor while our own app is active (`app/src-tauri/src/notch.rs` says so in
 * the hover-health diagnostic in as many words), while the *local* monitor never
 * sees those moves because the notch overlay is `ignoresMouseEvents` and the
 * cursor is not over any window of ours. A gate that can never open is worse
 * than no gate, so that page teaches by illustration and advances freely; it
 * still listens for a real hover and celebrates one if it somehow arrives.
 */
export const GATED_STEPS: readonly StepId[] = ["permissions", "push-to-talk", "type-prompt"];

/** The flow's whole memory. Immutable: every transition returns a new value. */
export interface FlowState {
  /** The page on screen. */
  readonly step: StepId;
  /** Gates the user satisfied for real. */
  readonly passed: readonly StepId[];
  /** Gates the user walked past unsatisfied. See the module header. */
  readonly skipped: readonly StepId[];
}

/** A fresh first run: page one, nothing passed, nothing skipped. */
export const INITIAL_FLOW: FlowState = { step: "welcome", passed: [], skipped: [] };

/** Position in [`STEP_ORDER`], or `-1` for an id that is not a step. */
export function stepIndex(step: StepId): number {
  return STEP_ORDER.indexOf(step);
}

/** Whether this page refuses to be left until it is satisfied. */
export function isGated(step: StepId): boolean {
  return GATED_STEPS.includes(step);
}

/** Whether the gate on this page has been satisfied for real. */
export function isPassed(state: FlowState, step: StepId): boolean {
  return state.passed.includes(step);
}

/** Whether this page's gate was walked past rather than satisfied. */
export function isSkipped(state: FlowState, step: StepId): boolean {
  return state.skipped.includes(step);
}

/**
 * Whether the primary "Continue" on the current page is enabled.
 *
 * An ungated page is always ready; a gate is ready once it is passed **or**
 * skipped. Skipping enabling Continue is not a loophole — [`skipStep`] is the
 * act of pressing the escape, and this keeps the page's primary control honest
 * afterwards instead of leaving a permanently dead button next to a live link.
 */
export function canAdvance(state: FlowState): boolean {
  if (!isGated(state.step)) return true;
  return isPassed(state, state.step) || isSkipped(state, state.step);
}

/** The next page, or `null` on the last one. */
export function nextStep(step: StepId): StepId | null {
  return STEP_ORDER[stepIndex(step) + 1] ?? null;
}

/** The previous page, or `null` on the first one. */
export function previousStep(step: StepId): StepId | null {
  const index = stepIndex(step);
  return index > 0 ? (STEP_ORDER[index - 1] ?? null) : null;
}

/** Appends `step` to `list` if it is not already there, preserving identity. */
function withStep(list: readonly StepId[], step: StepId): readonly StepId[] {
  return list.includes(step) ? list : [...list, step];
}

/**
 * Records that a gate was satisfied for real.
 *
 * Idempotent, because the probes that call it are not: the push-to-talk probe
 * reads both a native `hotkey` event and a DOM `keyup`, and a user who holds the
 * keys twice passes twice. Idempotence here is what lets those sources stay
 * naive.
 *
 * It deliberately does **not** advance. A page that jumps away the instant the
 * user releases a key gives them no moment to see that it worked, and the
 * confirmation is the entire pedagogical payload of a "now you try it" step.
 * The page shows its success state and the user presses Continue.
 */
export function passStep(state: FlowState, step: StepId): FlowState {
  if (isPassed(state, step)) return state;
  return { ...state, passed: withStep(state.passed, step) };
}

/**
 * Records that a gate was walked past unsatisfied, and advances.
 *
 * This one *does* advance, and the asymmetry with [`passStep`] is the point: a
 * skip is a single deliberate act with nothing to admire afterwards, so making
 * the user then press Continue would be asking them to confirm giving up twice.
 *
 * A skip on an ungated page is meaningless and is recorded as a plain advance —
 * writing it into `skipped` would tell the final page that a user who never saw
 * a gate had declined one.
 *
 * The skip is recorded **before** the advance, and the order is not cosmetic:
 * [`advance`] consults [`canAdvance`], which on an unsatisfied gate is exactly
 * `false`. Advancing first therefore moved nobody anywhere and then wrote a skip
 * against a page the user was still standing on — a dead escape hatch on the one
 * control whose entire purpose is to never be dead. A unit test pinned it.
 */
export function skipStep(state: FlowState, step: StepId): FlowState {
  const recorded = isGated(step)
    ? { ...state, skipped: withStep(state.skipped, step) }
    : state;
  return advance(recorded);
}

/**
 * Moves to the next page if the current one allows it.
 *
 * Returns the state unchanged when the gate is unsatisfied or there is no next
 * page, rather than throwing. The callers are a click handler and a key handler;
 * neither has anywhere to put an exception, and "nothing happened" is the
 * correct user-visible result of pressing a disabled button.
 */
export function advance(state: FlowState): FlowState {
  if (!canAdvance(state)) return state;
  const next = nextStep(state.step);
  return next ? { ...state, step: next } : state;
}

/**
 * Moves to the previous page.
 *
 * Never blocked. Going back is how a user re-reads a page they skimmed, and a
 * gate they have already passed stays passed — `passed` and `skipped` are never
 * cleared by navigation, so returning to a satisfied gate shows it satisfied
 * rather than demanding the gesture again.
 */
export function retreat(state: FlowState): FlowState {
  const previous = previousStep(state.step);
  return previous ? { ...state, step: previous } : state;
}

/** Whether this is the last page — the one whose button finishes first run. */
export function isFinalStep(step: StepId): boolean {
  return nextStep(step) === null;
}

/**
 * Which way the stage slides between two pages.
 *
 * Forward slides left and back slides right, matching the reading direction, so
 * the motion says which way through the flow the user just went. Equal ids give
 * `forward`: a first render has no previous page, and starting the stage in its
 * neutral incoming position is what the page-mount transition expects.
 */
export function slideDirection(from: StepId, to: StepId): "forward" | "back" {
  return stepIndex(to) < stepIndex(from) ? "back" : "forward";
}

/**
 * Whether first run ended with everything genuinely working.
 *
 * Read by the final page to choose between two honest sentences. It asks about
 * `skipped` rather than `passed` on purpose: a user who reached the end without
 * skipping anything satisfied every gate by definition, whereas checking
 * `passed` would have to enumerate the gates and would quietly start lying the
 * day a gate is added.
 */
export function completedCleanly(state: FlowState): boolean {
  return state.skipped.length === 0;
}
