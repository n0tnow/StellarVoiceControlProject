import assert from "node:assert/strict";
import { test } from "node:test";

import {
  applyHoverEdge,
  inlineVoiceStage,
  isCommitTransition,
  isUsableShellHeight,
  resolveShellState,
} from "./shellState.ts";

const collapsed = { voice: "collapsed", hover: "collapsed", hotkey: "collapsed" };

test("everything quiet resolves to collapsed", () => {
  assert.equal(resolveShellState(collapsed), "collapsed");
});

test("an attention voice state outranks hover", () => {
  assert.equal(
    resolveShellState(
      { voice: "compact", hover: "panel", hotkey: "collapsed" },
      { voiceAttention: true },
    ),
    "compact",
  );
});

test("hover opens the panel while voice is only the ready/error dwell", () => {
  // MINOR-1: the ambient voice proposal keeps the label up, but must not lock
  // hover out for the whole dwell.
  assert.equal(
    resolveShellState(
      { voice: "compact", hover: "panel", hotkey: "collapsed" },
      { voiceAttention: false },
    ),
    "panel",
  );
});

test("an ambient voice state still wins when hover is quiet", () => {
  assert.equal(
    resolveShellState(
      { voice: "compact", hover: "collapsed", hotkey: "collapsed" },
      { voiceAttention: false },
    ),
    "compact",
  );
});

test("a pinned wallet gate outranks the ready/error dwell (notch-clip)", () => {
  // The W13b wallet gate pins the panel while nobody is logged in. The voice
  // source's ready label must not keep the shell in the small strip the wallet
  // screen is rendered into.
  assert.equal(
    resolveShellState(
      { voice: "compact", hover: "collapsed", hotkey: "collapsed", pin: "panel" },
      { voiceAttention: false },
    ),
    "panel",
  );
});

test("a genuine attention voice state still outranks a pinned gate", () => {
  // Recording/transcribing/thinking/speaking (and the F1 payment stages) are
  // something the user must see now; the pin returns once they settle.
  assert.equal(
    resolveShellState(
      { voice: "compact", hover: "collapsed", hotkey: "collapsed", pin: "panel" },
      { voiceAttention: true },
    ),
    "compact",
  );
  // The same input with the attention flag cleared returns to the pin.
  assert.equal(
    resolveShellState(
      { voice: "compact", hover: "collapsed", hotkey: "collapsed", pin: "panel" },
      { voiceAttention: false },
    ),
    "panel",
  );
});

test("a pinned gate also outranks hover and the ambient voice proposal", () => {
  assert.equal(
    resolveShellState(
      { voice: "compact", hover: "panel", hotkey: "collapsed", pin: "panel" },
      { voiceAttention: false },
    ),
    "panel",
  );
});

test("a latched prompt mode outranks hover and attention voice", () => {
  // The double-Control prompt is an explicitly invoked mode: losing hover must
  // not collapse it, and a recording must not replace it. The prompt keeps the
  // surface while the voice stage is shown inline (`inlineVoiceStage`); the
  // status strip is not rendered in the `prompt` state.
  assert.equal(
    resolveShellState(
      { voice: "compact", hover: "panel", hotkey: "prompt" },
      { voiceAttention: true },
    ),
    "prompt",
  );
  assert.equal(
    resolveShellState(
      { voice: "collapsed", hover: "panel", hotkey: "prompt" },
      { voiceAttention: false },
    ),
    "prompt",
  );
});

test("a quiet hotkey source leaves the existing precedence intact", () => {
  // With no latched mode the order is unchanged: attention voice > hover >
  // ambient voice > collapsed.
  assert.equal(
    resolveShellState(
      { voice: "compact", hover: "panel", hotkey: "collapsed" },
      { voiceAttention: true },
    ),
    "compact",
  );
  assert.equal(
    resolveShellState(
      { voice: "collapsed", hover: "panel", hotkey: "collapsed" },
      { voiceAttention: false },
    ),
    "panel",
  );
});

test("voiceAttention defaults to true, preserving the documented precedence", () => {
  assert.equal(
    resolveShellState({ voice: "compact", hover: "panel", hotkey: "collapsed" }),
    "compact",
  );
});

test("voice and prompt may be active at once; the prompt keeps the surface", () => {
  // New co-active case: a voice turn starts while the typed prompt is latched.
  // The prompt must not close (and the typed text must survive), so the reducer
  // still resolves to `prompt`; the voice stage is carried into the prompt by
  // `inlineVoiceStage` instead of the (unrendered) status strip.
  assert.equal(
    resolveShellState(
      { voice: "compact", hover: "collapsed", hotkey: "prompt" },
      { voiceAttention: true },
    ),
    "prompt",
  );
  // The same holds mid-turn when hover has also armed.
  assert.equal(
    resolveShellState(
      { voice: "compact", hover: "panel", hotkey: "prompt" },
      { voiceAttention: true },
    ),
    "prompt",
  );
});

test("inlineVoiceStage maps the shell visual to the prompt's stage vocabulary", () => {
  // Reuses the exact stage names the strip uses: no new vocabulary.
  assert.equal(inlineVoiceStage("recording"), "listening");
  assert.equal(inlineVoiceStage("transcribing"), "thinking");
  assert.equal(inlineVoiceStage("speaking"), "speaking");
  // Nothing to show when no turn is live (`idle`) or the turn has settled into
  // the error dwell, so the indicator unmounts and the prompt looks normal.
  assert.equal(inlineVoiceStage("idle"), null);
  assert.equal(inlineVoiceStage("error"), null);
  // An unknown future visual must not be treated as a voice stage.
  assert.equal(inlineVoiceStage("something-new"), null);
});

test("a state the reducer has never heard of passes through unchanged", () => {
  // Extensibility: a new row in the Rust table needs no change here.
  assert.equal(
    resolveShellState(
      { voice: "hotkey-small", hover: "collapsed", hotkey: "collapsed" },
      { voiceAttention: true },
    ),
    "hotkey-small",
  );
});

test("MINOR-1: a content-driven state commits on its height transition", () => {
  // The prompt keeps its width and only tweens height, so the width-only rule
  // would drop the fast-path commit and strand the window oversized.
  assert.equal(isCommitTransition("height", true), true);
  assert.equal(isCommitTransition("width", true), true);
  // A fixed state still commits on width and never on height.
  assert.equal(isCommitTransition("width", false), true);
  assert.equal(isCommitTransition("height", false), false);
  // The co-transitioned radius and any other property never commit.
  assert.equal(isCommitTransition("border-radius", true), false);
  assert.equal(isCommitTransition("opacity", false), false);
});

test("MINOR-2: a NaN/Infinity/non-positive height is rejected before IPC", () => {
  // Without the isFinite guard, `NaN <= 0` is false and NaN sails through.
  assert.equal(isUsableShellHeight(Number.NaN), false);
  assert.equal(isUsableShellHeight(Number.POSITIVE_INFINITY), false);
  assert.equal(isUsableShellHeight(0), false);
  assert.equal(isUsableShellHeight(-12), false);
  assert.equal(isUsableShellHeight(244), true);
  // The value is rounded before the check in the hook; this pins that NaN
  // survives Math.round, which is exactly why the isFinite guard is required.
  assert.equal(Number.isNaN(Math.round(Number.NaN)), true);
});

test("MAJOR-2: an explicit dismissal latches hover until the cursor leaves", () => {
  // Dismissed while the cursor is inside: arm the latch, swallow the inside
  // edges, and keep swallowing them.
  assert.deepEqual(applyHoverEdge(true, false), { latched: false, accept: true });
  assert.deepEqual(applyHoverEdge(true, true), { latched: true, accept: false });
  // A leave clears the latch and is accepted...
  assert.deepEqual(applyHoverEdge(false, true), { latched: false, accept: true });
  // ...so the next entry can arm hover again.
  assert.deepEqual(applyHoverEdge(true, false), { latched: false, accept: true });
  // A quiet leave without a latch is idempotent.
  assert.deepEqual(applyHoverEdge(false, false), { latched: false, accept: true });
});
