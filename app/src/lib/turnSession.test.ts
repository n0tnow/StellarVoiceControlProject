import assert from "node:assert/strict";
import { test } from "node:test";

import type { CaptureState } from "@polaris/interfaces";

import {
  isCurrentTurn,
  reduceTurnSession,
  stageWatchdog,
  type TurnSession,
  type TurnSignal,
} from "./turnSession.ts";

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
function stageOf(frame: TurnSession | null | undefined): string | null {
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

  // "thinking" holds from release through the STT gap and the whole agent turn
  // (including the TTS synthesis wait) — never "checking", never an early
  // "speaking". "speaking" appears only after the real playback-start signal.
  assert.deepEqual(frames.map(stageOf), [
    "listening",
    "thinking",
    "thinking",
    "thinking",
    "thinking",
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

/* ------------------------------------------------------------------ *
 * A9 — no stage may be entered before the event that marks it.
 * ------------------------------------------------------------------ */

test("no signal can enter 'speaking' before a real playback-start event", () => {
  // Every pre-playback step must stay off 'speaking', including the whole
  // synthesis wait, which deliberately keeps the honest 'thinking' label.
  const frames = run([
    capture("recording"),
    capture("ready"),
    capture("transcribing"),
    capture("idle"),
    { type: "transcribed" },
  ]);
  for (const frame of frames) {
    assert.notEqual(stageOf(frame), "speaking");
  }
  assert.equal(stageOf(frames.at(-1)), "thinking");
});

test("speech_started is the only way into 'speaking', and only from 'thinking'", () => {
  // From a live recording ("listening") a playback event can never be honoured.
  const listening = reduceTurnSession(null, capture("recording"));
  assert.equal(listening?.stage, "listening");
  assert.equal(reduceTurnSession(listening, { type: "speech_started" })?.stage, "listening");

  // From 'thinking' it is the expected, and only, transition into 'speaking'.
  const thinking = reduceTurnSession(listening, capture("ready"));
  assert.equal(thinking?.stage, "thinking");
  assert.equal(reduceTurnSession(thinking, { type: "speech_started" })?.stage, "speaking");
});

test("a playback-finished event before playback started cannot end the turn", () => {
  // The core A9 bug: a synthesis failure used to emit only 'idle', which must not
  // be read as "the answer finished playing". The turn stays up until its own
  // failure/dwell path settles it.
  const thinking = run([capture("recording"), capture("ready")]).at(-1) ?? null;
  assert.equal(thinking?.stage, "thinking");
  assert.equal(reduceTurnSession(thinking, { type: "speech_finished" })?.stage, "thinking");
});

test("'listening' is entered by capture recording and by nothing else", () => {
  assert.equal(reduceTurnSession(null, capture("recording"))?.stage, "listening");
  for (const signal of [
    capture("ready"),
    capture("transcribing"),
    capture("idle"),
    { type: "transcribed" } as TurnSignal,
    { type: "speech_started" } as TurnSignal,
  ]) {
    const frame = reduceTurnSession(null, signal);
    assert.notEqual(stageOf(frame), "listening", `unexpected listening from ${signal.type}`);
  }
});

test("a late capture event cannot pull a speaking turn backwards", () => {
  const speaking: TurnSession = { id: 2, stage: "speaking", failureLabel: null };
  assert.equal(reduceTurnSession(speaking, capture("ready"))?.stage, "speaking");
  assert.equal(reduceTurnSession(speaking, capture("transcribing"))?.stage, "speaking");
  assert.equal(reduceTurnSession(speaking, { type: "transcribed" })?.stage, "speaking");
});

/* ------------------------------------------------------------------ *
 * M4 — both non-terminal stages are bounded, including speaking.
 * ------------------------------------------------------------------ */

test("speaking is watchdogged, so a wedged player cannot hold the shell open", () => {
  // Regression guard for M4: playback used to be trusted to end itself, so a
  // stuck utterance left the session in `speaking` forever with no recovery.
  const speaking = stageWatchdog("speaking");
  assert.notEqual(speaking, null, "speaking must have a watchdog");
  assert.ok(
    speaking !== null && speaking.timeoutMs > 0,
    "the speaking watchdog must be a positive bound",
  );

  // The pre-speech wait keeps its own (shorter) bound and its own label.
  const thinking = stageWatchdog("thinking");
  assert.notEqual(thinking, null);
  assert.ok(thinking !== null && thinking.timeoutMs > 0);

  // `listening` ends on the hotkey release and `failed` on its dwell: no timer.
  assert.equal(stageWatchdog("listening"), null);
  assert.equal(stageWatchdog("failed"), null);
});

/* ------------------------------------------------------------------ *
 * M1 — an async result is bound to the turn that dispatched it.
 * ------------------------------------------------------------------ */

test("an async result is dropped once its turn id is no longer current", () => {
  const older: TurnSession = { id: 7, stage: "thinking", failureLabel: null };
  const newer: TurnSession = { id: 8, stage: "thinking", failureLabel: null };

  assert.equal(isCurrentTurn(older, 7), true);
  // The regression: a late outcome from turn 7 must not be applied to turn 8.
  assert.equal(isCurrentTurn(newer, 7), false);
  assert.equal(isCurrentTurn(null, 7), false, "no live session means no match");
  assert.equal(isCurrentTurn(older, undefined), false, "an unbound result is never current");
});
