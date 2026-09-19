/**
 * The notch's turn session — one explicit state machine for a whole spoken turn.
 *
 * Steps A0–A7 drove the shell from several independent booleans (`collapsed`,
 * `speakingVisual`, `agentFailureVisual`, …) that only had to overlap *by
 * accident*. They did not: capture returns to `idle` before the final transcript
 * is emitted, so the shell collapsed to the idle pill between "recording
 * finished" and "audio starts", then expanded again when speech began — the
 * mid-turn snap the owner reported.
 *
 * This module replaces that with a single value. A turn is one immutable session
 * that starts at the hotkey (capture `recording`) and ends exactly once, either
 * when playback finishes or after a failure has been shown for its dwell. No
 * intermediate signal may collapse it: the only signals that return `null` are
 * `speech_finished` (a healthy turn ending) and `settled` (a failure's dwell
 * elapsing).
 *
 * ## Every stage is entered by the event that actually marks it (A9)
 *
 * The A8 machine was structurally right but optimistic: `transcribed` jumped
 * straight to `checking`, so the *entire* model call wore a "Checking" label,
 * and the shell's `speaking` stage was driven by the request to speak rather than
 * by real audio. Each stage here is entered by one specific signal:
 *
 * - `listening` — only a capture `recording` event.
 * - `thinking` — from capture release / transcription (the machine is working on
 *   the utterance) through the model call. This deliberately covers the TTS
 *   synthesis wait too: it is honest ("Polaris is working"), whereas "Speaking"
 *   would not be.
 * - `speaking` — only a `speech_started` signal, which the shell raises from the
 *   Rust `speech_status: speaking` event the backend emits at **real playback
 *   start**. A synthesis-only wait can therefore never show "Speaking".
 *
 * The old `checking` stage (validating the tool arguments into an `Intent`) is
 * gone: that validation is synchronous and takes microseconds, so a label for it
 * could never be read. The report records that measurement rather than flashing
 * an unreadable state.
 *
 * It is pure on purpose — no React, no Tauri, no timers. The failure dwell and
 * the stuck-turn watchdog are scheduled by the caller and delivered as ordinary
 * signals, so the machine is deterministic and unit-testable
 * (`turnSession.test.ts`).
 */
import type { CaptureState } from "@polaris/interfaces";

/**
 * The visible phase of a live turn. `failed` is terminal but still visible: the
 * shell stays expanded with the short failure label until the caller settles it.
 */
export type TurnStage = "listening" | "thinking" | "speaking" | "failed";

/** One turn, from hotkey-down to the single moment it ends. */
export interface TurnSession {
  /** Monotonic id; lets effects re-arm per turn without extra state. */
  readonly id: number;
  readonly stage: TurnStage;
  /** Short, ear-safe label for a `failed` stage; null while the turn is healthy. */
  readonly failureLabel: string | null;
}

/** Everything that can move a session. Raw capture states are passed through. */
export type TurnSignal =
  | { type: "capture"; state: CaptureState; label: string | null }
  /** The final transcript was handed to the agent (the agent's `thinking` stage). */
  | { type: "transcribed" }
  | { type: "failed"; label: string }
  | { type: "speech_started" }
  | { type: "speech_finished" }
  | { type: "settled" };

const nextId = (session: TurnSession | null): number => (session?.id ?? 0) + 1;

function fail(session: TurnSession | null, label: string): TurnSession {
  return { id: nextId(session), stage: "failed", failureLabel: label };
}

/**
 * Folds one signal into the current session (or `null` when no turn is live).
 *
 * Guarantees, each pinned by a test:
 * - a healthy turn is never `null` between `recording` and `speech_finished`;
 * - capture `ready` / `transcribing` / `idle` only advance or hold the stage,
 *   never end the session — `idle` is the STT gap that used to collapse the shell;
 * - `speaking` is reachable **only** through `speech_started`, and only from
 *   `thinking`; no other signal can enter it early;
 * - a failure ends the session exactly once, via one `settled`;
 * - a stale `speech_*` from a superseded turn cannot move or end a newer one.
 */
export function reduceTurnSession(
  session: TurnSession | null,
  signal: TurnSignal,
): TurnSession | null {
  switch (signal.type) {
    case "capture": {
      switch (signal.state) {
        // A new take always starts a fresh session and supersedes whatever the
        // shell was showing (a previous failure or a still-playing answer).
        case "recording":
          return { id: nextId(session), stage: "listening", failureLabel: null };
        case "error":
          return fail(session, signal.label ?? "Mic error");
        // Release and transcription move the turn into "thinking" — from here
        // until real playback the machine is working on the utterance. Only a
        // turn still in the capture phase may advance, so a late event can never
        // pull a speaking turn backwards.
        case "ready":
        case "transcribing":
          return session !== null && session.stage === "listening"
            ? { ...session, stage: "thinking" }
            : session;
        // The STT worker returns capture to `idle` *before* it emits the final
        // transcript. Holding the session here is the whole fix: the shell stays
        // expanded across that gap instead of collapsing to the pill.
        case "idle":
          return session;
      }
    }
    case "transcribed":
      // The transcript was handed to the agent. It arrives while the session is
      // already `thinking`; this only recovers a session that skipped the
      // capture transitions (e.g. a snapshot read after startup).
      return session !== null && session.stage === "listening"
        ? { ...session, stage: "thinking" }
        : session;
    case "failed":
      return fail(session, signal.label);
    case "speech_started":
      // Only a turn that is still waiting on the model/voice may start speaking;
      // a queued or stale utterance from a previous turn is ignored. Crucially,
      // this is the *single* way into `speaking`.
      return session?.stage === "thinking" ? { ...session, stage: "speaking" } : session;
    case "speech_finished":
      // A healthy turn completes here — the one and only place it ends itself.
      return session?.stage === "speaking" ? null : session;
    case "settled":
      // The failure dwell elapsed; the failed session is over.
      return session?.stage === "failed" ? null : session;
  }
}

/** True while the notch must stay expanded for a live turn. */
export function isTurnExpanded(session: TurnSession | null): boolean {
  return session !== null;
}

/* ------------------------------------------------------------------ *
 * Stuck-stage watchdogs (M4)
 * ------------------------------------------------------------------ */

/**
 * How long the model/TTS wait may sit in `thinking` before the shell abandons
 * it. Far beyond every legitimate phase (the model request itself is capped at
 * 30 s), so it only fires when an upstream event is genuinely lost.
 */
export const THINKING_WATCHDOG_MS = 60_000;

/**
 * How long `speaking` may last before the shell assumes the player is wedged.
 * Playback normally ends itself via `speech_status: idle`, but a player that
 * never returns would otherwise hold the notch open forever (the speech drain
 * is unbounded). Generous on purpose: a long sentence is not a stuck one.
 */
export const SPEAKING_WATCHDOG_MS = 120_000;

/** The recovery timer for one non-terminal stage. */
export interface StageWatchdog {
  readonly timeoutMs: number;
  /** Short, ear-safe label shown if the timer fires. */
  readonly label: string;
}

/**
 * The watchdog for a live stage, or `null` when the stage recovers by itself.
 *
 * Returns a bound for both `thinking` (the pre-speech wait) and `speaking` (a
 * wedged player). `listening` ends on the hotkey release and `failed` ends on
 * its own dwell, so neither needs a timer here. The caller schedules and clears
 * the timer; this function stays pure so the policy is unit-testable.
 */
export function stageWatchdog(stage: TurnStage): StageWatchdog | null {
  switch (stage) {
    case "thinking":
      return { timeoutMs: THINKING_WATCHDOG_MS, label: "Timed out" };
    case "speaking":
      return { timeoutMs: SPEAKING_WATCHDOG_MS, label: "Voice error" };
    case "listening":
    case "failed":
      return null;
  }
}

/* ------------------------------------------------------------------ *
 * Cross-turn result guard (M1)
 * ------------------------------------------------------------------ */

/**
 * Whether an async result tagged with `turnId` may still touch the UI.
 *
 * A result whose turn id no longer matches the current session must be dropped:
 * an older turn's speech/execution outcome must never overwrite a newer turn's
 * state (M1). An undefined id — no live session, or a result that was never
 * bound to one — is never current. The speech path used this check inline; it
 * lives here so the execution path can share the exact same rule.
 */
export function isCurrentTurn(session: TurnSession | null, turnId: number | undefined): boolean {
  return turnId !== undefined && session?.id === turnId;
}
