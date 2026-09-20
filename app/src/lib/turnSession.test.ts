import assert from "node:assert/strict";
import { test } from "node:test";

import type { CaptureState } from "@polaris/interfaces";

import {
  APPROVAL_WATCHDOG_MS,
  isActiveStage,
  isCurrentTurn,
  isPaymentStage,
  isTerminalStage,
  isTurnExpanded,
  noticeLabel,
  reduceTurnSession,
  shellVoiceInputs,
  shouldSurfaceOutcome,
  SIGNING_WATCHDOG_MS,
  SPEAKING_WATCHDOG_MS,
  stageLabel,
  stageWatchdog,
  SUBMITTING_WATCHDOG_MS,
  THINKING_WATCHDOG_MS,
  TOTAL_WATCHDOG_MS,
  type TurnSession,
  type TurnSignal,
  type TurnStage,
} from "./turnSession.ts";
import { resolveShellState } from "../notch/shellState.ts";

/** A capture transition, with the optional short failure label the wire carries. */
function capture(state: CaptureState, label: string | null = null): TurnSignal {
  return { type: "capture", state, label };
}

/** Folds a scripted signal list, keeping the session after every step. */
function run(signals: TurnSignal[], from: TurnSession | null = null): (TurnSession | null)[] {
  const frames: (TurnSession | null)[] = [];
  let session = from;
  for (const signal of signals) {
    session = reduceTurnSession(session, signal);
    frames.push(session);
  }
  return frames;
}

/** The stage of a frame (`null` = no session / collapsed pill). */
function stageOf(frame: TurnSession | null | undefined): TurnStage | null {
  return frame?.stage ?? null;
}

/** A hand-built live session in `stage`; the reducer only reads the fields. */
function live(stage: TurnStage, language: string | null = null): TurnSession {
  return { id: 9, stage, failureLabel: null, notice: null, language };
}

const ACTIVE_STAGES: TurnStage[] = [
  "listening",
  "thinking",
  "speaking",
  "awaiting_approval",
  "signing",
  "submitting",
];

const TERMINAL_STAGES: TurnStage[] = ["done", "error"];

const EVERY_SIGNAL: TurnSignal[] = [
  capture("recording"),
  capture("ready"),
  capture("transcribing"),
  capture("idle"),
  capture("error", "Mic error"),
  { type: "transcribed" },
  { type: "language", language: "tr" },
  { type: "stage", stage: "awaiting_approval" },
  { type: "stage", stage: "signing" },
  { type: "stage", stage: "submitting" },
  { type: "failed", label: "Net error" },
  { type: "speech_started" },
  { type: "speech_finished" },
  { type: "settled" },
];

test("a successful turn never collapses between the hotkey and the terminal dwell", () => {
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

  // "thinking" holds from release through the STT gap and the whole agent turn
  // (including the TTS synthesis wait) — never "checking", never an early
  // "speaking". The answer ends in the terminal "done" stage, not a collapse.
  assert.deepEqual(frames.map(stageOf), [
    "listening",
    "thinking",
    "thinking",
    "thinking",
    "thinking",
    "speaking",
    "done",
  ]);

  // Only the terminal dwell collapses the shell.
  const done = frames.at(-1) ?? null;
  assert.equal(reduceTurnSession(done, { type: "settled" }), null);
});

test("the full payment path stays expanded from hotkey to post-submit speech", () => {
  const frames = run([
    capture("recording"),
    capture("ready"),
    capture("transcribing"),
    capture("idle"),
    { type: "transcribed" },
    { type: "stage", stage: "awaiting_approval" },
    { type: "stage", stage: "signing" },
    { type: "stage", stage: "submitting" },
    // The confirmation sentence is spoken only after the transaction is sent.
    { type: "speech_started" },
    { type: "speech_finished" },
  ]);

  assert.deepEqual(frames.map(stageOf), [
    "listening",
    "thinking",
    "thinking",
    "thinking",
    "thinking",
    "awaiting_approval",
    "signing",
    "submitting",
    "speaking",
    "done",
  ]);
  for (const frame of frames) {
    assert.equal(isTurnExpanded(frame), true);
  }
});

test("onStage only moves the payment path forwards, and only when a turn is live", () => {
  // Out-of-order or duplicated reports are ignored.
  const thinking = live("thinking");
  assert.equal(reduceTurnSession(thinking, { type: "stage", stage: "signing" })?.stage, "thinking");
  assert.equal(
    reduceTurnSession(thinking, { type: "stage", stage: "submitting" })?.stage,
    "thinking",
  );

  const awaiting = reduceTurnSession(thinking, { type: "stage", stage: "awaiting_approval" });
  assert.equal(awaiting?.stage, "awaiting_approval");
  // A repeated awaiting_approval is a no-op, not a stage reset.
  assert.equal(reduceTurnSession(awaiting, { type: "stage", stage: "awaiting_approval" })?.stage,
    "awaiting_approval");

  const signing = reduceTurnSession(awaiting, { type: "stage", stage: "signing" });
  assert.equal(signing?.stage, "signing");
  // A stale approval report after signing cannot pull the turn backwards.
  assert.equal(reduceTurnSession(signing, { type: "stage", stage: "awaiting_approval" })?.stage,
    "signing");

  // No live turn: an executor report can never open the shell.
  assert.equal(reduceTurnSession(null, { type: "stage", stage: "signing" }), null);
});

/* ------------------------------------------------------------------ *
 * F1 — a pending payment owns the notch
 * ------------------------------------------------------------------ */

test("a new take is refused, not superseded, while a payment is pending", () => {
  for (const stage of ["awaiting_approval", "signing", "submitting"] as const) {
    const session = live(stage);
    const refused = reduceTurnSession(session, capture("recording"));
    assert.equal(refused?.stage, stage, "the pending payment must survive the hotkey");
    assert.equal(refused?.id, session.id, "refusing must not start a new turn");
    assert.equal(refused?.notice, "payment_pending", "the refusal is shown, not silent");
  }
});

test("a pending payment ignores the whole ignored take, so its release cannot settle it", () => {
  const session = live("awaiting_approval");
  const settled = reduceTurnSession(session, { type: "settled" });
  assert.equal(settled?.stage, "awaiting_approval", "settled is only honoured from a terminal stage");
  for (const signal of [
    capture("ready"),
    capture("transcribing"),
    capture("idle"),
    capture("error", "Mic error"),
  ]) {
    assert.equal(reduceTurnSession(session, signal)?.stage, "awaiting_approval");
  }
});

test("a hotkey before the payment stages still supersedes (existing policy)", () => {
  for (const stage of ["listening", "thinking", "speaking"] as const) {
    const fresh = reduceTurnSession(live(stage), capture("recording"));
    assert.equal(fresh?.stage, "listening");
    assert.ok(fresh !== null && fresh.id > 9, "a superseding take gets a new id");
    assert.equal(fresh?.notice, null);
  }
});

test("entering an earlier stage or a later terminal clears a stale notice", () => {
  const refused = reduceTurnSession(live("awaiting_approval"), capture("recording"));
  assert.equal(refused?.notice, "payment_pending");
  assert.equal(reduceTurnSession(refused, { type: "stage", stage: "signing" })?.notice, null);
});

/* ------------------------------------------------------------------ *
 * F1 — settle once and the no-collapse invariant
 * ------------------------------------------------------------------ */

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
  assert.equal(failed?.stage, "error");
  assert.equal(failed?.failureLabel, "Net error");

  // A second failure while terminal is the same session: no re-armed dwell.
  const again = reduceTurnSession(failed ?? null, { type: "failed", label: "Another" });
  assert.equal(again, failed, "a failure must not be re-applied");

  // The dwell elapses once, then the session is gone for good — no re-expand.
  const settled = reduceTurnSession(failed ?? null, { type: "settled" });
  assert.equal(settled, null);
  assert.equal(reduceTurnSession(settled, { type: "settled" }), null);
  assert.equal(reduceTurnSession(settled, { type: "speech_finished" }), null);
  assert.equal(reduceTurnSession(settled, capture("idle")), null);
});

test("a failure during the payment path settles once from that stage", () => {
  const signing = live("signing");
  const failed = reduceTurnSession(signing, { type: "failed", label: "Wallet timed out" });
  assert.equal(failed?.stage, "error");
  assert.equal(failed?.failureLabel, "Wallet timed out");
  assert.equal(reduceTurnSession(failed, { type: "failed", label: "Wallet timed out" }), failed);
  assert.equal(reduceTurnSession(failed, { type: "settled" }), null);
});

test("no signal can collapse an active stage", () => {
  for (const stage of ACTIVE_STAGES) {
    assert.equal(isActiveStage(stage), true, `${stage} must count as active`);
    for (const signal of EVERY_SIGNAL) {
      const next = reduceTurnSession(live(stage), signal);
      assert.notEqual(
        next,
        null,
        `${signal.type} collapsed the active ${stage} stage`,
      );
      assert.equal(isTurnExpanded(next), true);
    }
  }
});

test("only the terminal dwell collapses a finished turn", () => {
  for (const stage of TERMINAL_STAGES) {
    assert.equal(isTerminalStage(stage), true);
    for (const signal of EVERY_SIGNAL) {
      const next = reduceTurnSession(live(stage), signal);
      if (signal.type === "settled") {
        assert.equal(next, null, "the dwell must collapse a terminal turn");
      } else {
        assert.notEqual(next, null, `${signal.type} must not collapse the terminal ${stage}`);
      }
    }
  }
});

/* ------------------------------------------------------------------ *
 * Input handling and stale-event guards (A9/M1)
 * ------------------------------------------------------------------ */

test("an STT failure settles a single failed session", () => {
  const frames = run([
    capture("recording"),
    capture("ready"),
    capture("transcribing"),
    capture("error", "No STT key"),
  ]);

  const failed = frames.at(-1);
  assert.equal(failed?.stage, "error");
  assert.equal(failed?.failureLabel, "No STT key");
  assert.equal(reduceTurnSession(failed ?? null, { type: "settled" }), null);
});

test("a mic error outside any turn still gets the generic label", () => {
  const failed = reduceTurnSession(null, capture("error"));
  assert.equal(failed?.stage, "error");
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
  const failed = live("error");
  const fresh = reduceTurnSession(failed, capture("recording"));
  assert.equal(fresh?.stage, "listening");
  assert.equal(fresh?.failureLabel, null);
  assert.ok(fresh !== null && fresh.id > failed.id);
});

test("capture chatter outside a turn never opens the shell", () => {
  assert.equal(reduceTurnSession(null, capture("idle")), null);
  assert.equal(reduceTurnSession(null, capture("ready")), null);
  assert.equal(reduceTurnSession(null, capture("transcribing")), null);
  assert.equal(reduceTurnSession(null, { type: "transcribed" }), null);
  assert.equal(reduceTurnSession(null, { type: "language", language: "tr" }), null);
  assert.equal(reduceTurnSession(null, { type: "speech_started" }), null);
  assert.equal(reduceTurnSession(null, { type: "speech_finished" }), null);
});

test("no signal can enter 'speaking' before a real playback-start event", () => {
  const frames = run([
    capture("recording"),
    capture("ready"),
    capture("transcribing"),
    capture("idle"),
    { type: "transcribed" },
    { type: "stage", stage: "awaiting_approval" },
    { type: "stage", stage: "signing" },
  ]);
  for (const frame of frames) {
    assert.notEqual(stageOf(frame), "speaking");
  }
  assert.equal(stageOf(frames.at(-1)), "signing");
});

test("speech_started is honoured from 'thinking' and 'submitting' and nothing else", () => {
  assert.equal(reduceTurnSession(live("thinking"), { type: "speech_started" })?.stage, "speaking");
  assert.equal(reduceTurnSession(live("submitting"), { type: "speech_started" })?.stage, "speaking");
  for (const stage of ["listening", "awaiting_approval", "signing"] as const) {
    assert.equal(reduceTurnSession(live(stage), { type: "speech_started" })?.stage, stage);
  }
});

test("a playback-finished event before playback started cannot end the turn", () => {
  const thinking = run([capture("recording"), capture("ready")]).at(-1) ?? null;
  assert.equal(thinking?.stage, "thinking");
  assert.equal(reduceTurnSession(thinking, { type: "speech_finished" })?.stage, "thinking");
});

test("a late capture event cannot pull a speaking turn backwards", () => {
  const speaking = live("speaking");
  assert.equal(reduceTurnSession(speaking, capture("ready"))?.stage, "speaking");
  assert.equal(reduceTurnSession(speaking, capture("transcribing"))?.stage, "speaking");
  assert.equal(reduceTurnSession(speaking, { type: "transcribed" })?.stage, "speaking");
});

/* ------------------------------------------------------------------ *
 * F1 — watchdog ceilings
 * ------------------------------------------------------------------ */

test("every stage has the required ceiling and the whole turn has a total bound", () => {
  const ceilings: [TurnStage, number][] = [
    ["thinking", THINKING_WATCHDOG_MS],
    ["speaking", SPEAKING_WATCHDOG_MS],
    ["awaiting_approval", APPROVAL_WATCHDOG_MS],
    ["signing", SIGNING_WATCHDOG_MS],
    ["submitting", SUBMITTING_WATCHDOG_MS],
  ];
  for (const [stage, ms] of ceilings) {
    const watchdog = stageWatchdog(stage);
    assert.equal(watchdog?.timeoutMs, ms, `${stage} ceiling`);
    assert.ok(watchdog !== null && watchdog.label.length > 0, `${stage} needs a label`);
  }
  assert.equal(THINKING_WATCHDOG_MS, 30_000);
  assert.equal(SPEAKING_WATCHDOG_MS, 45_000);
  assert.equal(APPROVAL_WATCHDOG_MS, 140_000);
  assert.equal(SIGNING_WATCHDOG_MS, 170_000);
  assert.equal(SUBMITTING_WATCHDOG_MS, 60_000);
  assert.equal(TOTAL_WATCHDOG_MS, 6 * 60_000);

  // `listening` ends on release; the terminal stages settle on their own dwell.
  assert.equal(stageWatchdog("listening"), null);
  assert.equal(stageWatchdog("done"), null);
  assert.equal(stageWatchdog("error"), null);
});

test("a ceiling failure lands in the terminal error stage", () => {
  for (const stage of ACTIVE_STAGES) {
    const watchdog = stageWatchdog(stage);
    if (watchdog === null) continue;
    const failed = reduceTurnSession(live(stage), { type: "failed", label: watchdog.label });
    assert.equal(failed?.stage, "error");
    assert.equal(failed?.failureLabel, watchdog.label);
    assert.equal(reduceTurnSession(failed, { type: "settled" }), null);
  }
});

/* ------------------------------------------------------------------ *
 * F1 — labels
 * ------------------------------------------------------------------ */

test("stage and notice labels follow the turn language", () => {
  assert.equal(stageLabel("awaiting_approval", null), "Approve in Autonomy");
  assert.equal(stageLabel("awaiting_approval", "en-US"), "Approve in Autonomy");
  assert.equal(stageLabel("awaiting_approval", "tr"), "Autonomy'de onayla");
  assert.equal(stageLabel("awaiting_approval", "tr-TR"), "Autonomy'de onayla");
  assert.equal(stageLabel("signing", "tr"), "İmzalanıyor");
  assert.equal(stageLabel("submitting", "tr"), "Gönderiliyor");
  assert.equal(stageLabel("listening", "tr"), "Dinliyorum");
  assert.equal(noticeLabel("payment_pending", "tr"), "Önce onayla");
  assert.equal(noticeLabel("payment_pending", null), "Approve first");
});

test("the language signal only relabels an existing turn", () => {
  const listening = reduceTurnSession(null, capture("recording"));
  const labelled = reduceTurnSession(listening, { type: "language", language: "tr" });
  assert.equal(labelled?.language, "tr");
  assert.equal(labelled?.stage, "listening");
});

/* ------------------------------------------------------------------ *
 * Payment-stage classifier + M1 cross-turn guard
 * ------------------------------------------------------------------ */

test("the payment classifier names exactly the value-moving stages", () => {
  for (const stage of ["awaiting_approval", "signing", "submitting"] as const) {
    assert.equal(isPaymentStage(stage), true);
  }
  for (const stage of ["listening", "thinking", "speaking", "done", "error"] as const) {
    assert.equal(isPaymentStage(stage), false);
  }
});

test("an async result is dropped once its turn id is no longer current", () => {
  const older = live("thinking");
  const newer: TurnSession = { ...live("thinking"), id: 8 };

  assert.equal(isCurrentTurn(older, 9), true);
  // The regression: a late outcome from turn 9 must not be applied to turn 8.
  assert.equal(isCurrentTurn(newer, 9), false);
  assert.equal(isCurrentTurn(null, 9), false, "no live session means no match");
  assert.equal(isCurrentTurn(older, undefined), false, "an unbound result is never current");
});

test("a submitted outcome is surfaced even after its turn was settled as failed", () => {
  // A watchdog settles the payment turn while the submit is still in flight.
  const submitting = live("submitting");
  const failed = reduceTurnSession(submitting, { type: "failed", label: "Submit timed out" });
  assert.equal(failed?.stage, "error");
  assert.notEqual(failed?.id, submitting.id, "the failure starts a new terminal session");

  // A non-submitted stale result is still dropped (M1) ...
  assert.equal(shouldSurfaceOutcome(failed, submitting.id, false), false);
  // ... but a transaction that reached the network is never dropped (MAJOR-1).
  assert.equal(shouldSurfaceOutcome(failed, submitting.id, true), true);
  assert.equal(shouldSurfaceOutcome(null, submitting.id, true), true);
  // The still-current case is unchanged either way.
  assert.equal(shouldSurfaceOutcome(submitting, submitting.id, false), true);
});

test("a 90 s approval wait uses the approval ceiling, not the thinking one", () => {
  // F1 gives the pending approval its own 140 s ceiling; the 30 s `thinking`
  // watchdog no longer applies, so a human taking 90 s to authenticate cannot
  // trip the notch (MAJOR-1, scenario "approval takes 90 s").
  const approval = stageWatchdog("awaiting_approval");
  assert.equal(approval?.timeoutMs, APPROVAL_WATCHDOG_MS);
  assert.ok(approval !== null && approval.timeoutMs > 90_000);
  assert.notEqual(approval.timeoutMs, THINKING_WATCHDOG_MS);
});

/** Resolves the shell target for a session with the cursor hovering the notch. */
function hoverTarget(session: TurnSession | null): string {
  const voice = shellVoiceInputs(session, { connected: true });
  return resolveShellState(
    { voice: voice.state, hover: "panel", hotkey: "collapsed" },
    { voiceAttention: voice.attention },
  );
}

test("a failed payment still lets hover open the panel (and never locks it out)", () => {
  // Hotkey → thinking → approval card → the gate denies (fail-closed).
  let session = reduceTurnSession(null, capture("recording"));
  session = reduceTurnSession(session, capture("ready"));
  session = reduceTurnSession(session, { type: "stage", stage: "awaiting_approval" });
  session = reduceTurnSession(session, { type: "failed", label: "Wallet didn't sign" });
  assert.equal(session?.stage, "error");

  // During the error dwell the label stays up but hover already wins.
  assert.equal(hoverTarget(session), "panel");

  // After the dwell the session is gone and hover is still honoured.
  session = reduceTurnSession(session, { type: "settled" });
  assert.equal(session, null);
  assert.equal(hoverTarget(session), "panel");
});

test("a pending payment keeps hover out until it settles (F1 guarantee)", () => {
  let session = reduceTurnSession(null, capture("recording"));
  session = reduceTurnSession(session, capture("ready"));
  session = reduceTurnSession(session, { type: "stage", stage: "awaiting_approval" });

  // An attention stage must win the surface: the panel cannot replace the
  // approval card while value is about to move.
  const voice = shellVoiceInputs(session, { connected: true });
  assert.equal(voice.attention, true);
  assert.equal(hoverTarget(session), "compact");
});
