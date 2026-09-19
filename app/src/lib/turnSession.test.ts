import assert from "node:assert/strict";
import { test } from "node:test";

import type { CaptureState } from "@polaris/interfaces";

import { reduceTurnSession, type TurnSession, type TurnSignal } from "./turnSession.ts";

/** A capture transition, with the optional short failure label the wire carries. */
function capture(state: CaptureState, label: string | null = null): TurnSignal {
  return { type: "capture", state, label };
}

/** Folds a scripted signal list, keeping the session after every step. */
function run(signals: TurnSignal[]): (TurnSession | null)[] {
  const frames: (TurnSession | null)[] = [];
  let session: TurnSession | null = null;
  for (const signal of signals) {
    session = reduceTurnSession(session, signal);
    frames.push(session);
  }
  return frames;
}

/** The stage of a frame (`null` = no session / collapsed pill). */
function stageOf(frame: TurnSession | null): string | null {
  return frame?.stage ?? null;
}

test("a successful turn never collapses between the hotkey and the end of speech", () => {
  const frames = run([
    capture("recording"),
    capture("ready"),
    capture("transcribing"),
    // The STT worker returns capture to idle before it emits the transcript.
    // This is exactly the gap that used to shrink the shell to the pill.
    capture("idle"),
    { type: "transcribed" },
    { type: "speech_started" },
    { type: "speech_finished" },
  ]);

  // Every frame but the last holds an expanded session — no intermediate idle.
  for (const frame of frames.slice(0, -1)) {
    assert.notEqual(frame, null, "the notch must not collapse in the middle of a turn");
  }
  assert.equal(frames.at(-1), null, "the turn ends once speech finishes");

  assert.deepEqual(frames.map(stageOf), [
    "listening",
    "thinking",
    "thinking",
    "thinking",
    "checking",
    "speaking",
    null,
  ]);
});

test("a failing turn shows one label and settles exactly once", () => {
  const frames = run([
    capture("recording"),
    capture("ready"),
    capture("transcribing"),
    capture("idle"),
    { type: "transcribed" },
    { type: "failed", label: "Net error" },
  ]);

  for (const frame of frames.slice(0, -1)) {
    assert.notEqual(frame, null, "the notch must stay expanded until the failure settles");
  }

  const failed = frames.at(-1);
  assert.equal(failed?.stage, "failed");
  assert.equal(failed?.failureLabel, "Net error");

  // The dwell elapses once, then the session is gone for good — no re-expand.
  const settled = reduceTurnSession(failed ?? null, { type: "settled" });
  assert.equal(settled, null);
  assert.equal(reduceTurnSession(settled, { type: "settled" }), null);
  assert.equal(reduceTurnSession(settled, { type: "speech_finished" }), null);
  assert.equal(reduceTurnSession(settled, capture("idle")), null);
});

test("an STT failure settles a single failed session", () => {
  const frames = run([
    capture("recording"),
    capture("ready"),
    capture("transcribing"),
    capture("error", "No STT key"),
  ]);

  const failed = frames.at(-1);
  assert.equal(failed?.stage, "failed");
  assert.equal(failed?.failureLabel, "No STT key");
  assert.equal(reduceTurnSession(failed ?? null, { type: "settled" }), null);
});

test("a mic error outside any turn still gets the generic label", () => {
  const failed = reduceTurnSession(null, capture("error"));
  assert.equal(failed?.stage, "failed");
  assert.equal(failed?.failureLabel, "Mic error");
});

test("a stale speech event cannot move or end a newer turn", () => {
  const speaking = run([
    capture("recording"),
    capture("ready"),
    capture("transcribing"),
    capture("idle"),
    { type: "transcribed" },
    { type: "speech_started" },
  ]).at(-1);
  assert.equal(speaking?.stage, "speaking");

  // The user starts a new take while the previous answer is still playing.
  const listening = reduceTurnSession(speaking ?? null, capture("recording"));
  assert.equal(listening?.stage, "listening");

  // The old utterance finishing must not end the new turn, nor may a stale
  // capture idle that trails it.
  assert.equal(reduceTurnSession(listening, { type: "speech_finished" })?.stage, "listening");
  assert.equal(reduceTurnSession(listening, capture("idle"))?.stage, "listening");
});

test("a new take supersedes a failed session", () => {
  const failed: TurnSession = { id: 4, stage: "failed", failureLabel: "Net error" };
  assert.deepEqual(reduceTurnSession(failed, capture("recording")), {
    id: 5,
    stage: "listening",
    failureLabel: null,
  });
});

test("capture chatter outside a turn never opens the shell", () => {
  assert.equal(reduceTurnSession(null, capture("idle")), null);
  assert.equal(reduceTurnSession(null, capture("ready")), null);
  assert.equal(reduceTurnSession(null, capture("transcribing")), null);
  assert.equal(reduceTurnSession(null, { type: "transcribed" }), null);
  assert.equal(reduceTurnSession(null, { type: "speech_started" }), null);
  assert.equal(reduceTurnSession(null, { type: "speech_finished" }), null);
});

test("speech only starts from the checking phase", () => {
  const listening: TurnSession = { id: 1, stage: "listening", failureLabel: null };
  assert.equal(reduceTurnSession(listening, { type: "speech_started" })?.stage, "listening");
});

test("a late capture event cannot pull a speaking turn backwards", () => {
  const speaking: TurnSession = { id: 2, stage: "speaking", failureLabel: null };
  assert.equal(reduceTurnSession(speaking, capture("ready"))?.stage, "speaking");
  assert.equal(reduceTurnSession(speaking, capture("transcribing"))?.stage, "speaking");
});
