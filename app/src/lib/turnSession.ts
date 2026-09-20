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
 * that starts at the hotkey (capture `recording`) and ends exactly once, after a
 * terminal stage has had its dwell. No intermediate signal may collapse it: the
 * only signals that return `null` are `settled` (a terminal stage's dwell
 * elapsing) and an already-idle `null`.
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
 * - `awaiting_approval` / `signing` / `submitting` — the value-moving path (F1),
 *   reported by `onStage` at the real boundaries (approval requested, wallet
 *   signing, submit). See below.
 * - `done` / `error` — the two terminal stages. Collapsing is only ever allowed
 *   from here (or from an already-idle `null`), which is the invariant the F1
 *   bug was about: the notch used to shrink while the model, the approval card
 *   or the signer was still busy.
 *
 * ## The payment path stays open until it settles (F1)
 *
 * `executeApprovedIntent`/`signAndSubmit`/the Touch ID approver invoke an
 * additive `onStage` callback at their boundaries, and the shell folds those
 * into the same session. Because the approval card and the signing round trip
 * can each take far longer than the old 60 s `thinking` watchdog, a pending
 * payment now owns the notch: a new hotkey press is refused with a soft notice
 * instead of superseding (and thereby hiding) it. The watchdogs below give every
 * stage its own ceiling, plus one total ceiling for the whole turn.
 *
 * The validation of tool arguments into an `Intent` has no stage: it is
 * synchronous and takes microseconds, so a label for it could never be read.
 *
 * It is pure on purpose — no React, no Tauri, no timers. The failure dwell and
 * the watchdogs are scheduled by the caller and delivered as ordinary signals,
 * so the machine is deterministic and unit-testable (`turnSession.test.ts`).
 */
import type { CaptureState } from "@polaris/interfaces";
import { languageBase } from "@polaris/agent";

/**
 * The visible phase of a live turn. `done` and `error` are terminal but still
 * visible: the shell stays expanded with the stage's short label until the
 * caller settles the session.
 */
export type TurnStage =
  | "listening"
  | "thinking"
  | "speaking"
  | "awaiting_approval"
  | "signing"
  | "submitting"
  | "done"
  | "error";

/**
 * The stages of the value-moving path (F1). These are exactly the stages an
 * executor reports through `onStage`, so a stale or out-of-order report cannot
 * invent a listening/thinking/speaking stage of its own.
 */
export type PaymentStage = Extract<TurnStage, "awaiting_approval" | "signing" | "submitting">;

/** The stages a turn may end in; only their dwell may collapse the shell. */
export type TerminalStage = Extract<TurnStage, "done" | "error">;

/** A soft, non-error hint shown when a new take was refused mid-payment (F1). */
export type TurnNotice = "payment_pending";

/** One turn, from hotkey-down to the moment its terminal dwell ends. */
export interface TurnSession {
  /** Monotonic id; lets effects re-arm per turn without extra state. */
  readonly id: number;
  readonly stage: TurnStage;
  /** Short, ear-safe label for an `error`; null while the turn is healthy. */
  readonly failureLabel: string | null;
  /** Soft hint (see `noticeLabel`); null unless a take was refused mid-payment. */
  readonly notice: TurnNotice | null;
  /** BCP-47 language of the turn, for the stage labels; null until it is known. */
  readonly language: string | null;
}

/** Everything that can move a session. Raw capture states are passed through. */
export type TurnSignal =
  | { type: "capture"; state: CaptureState; label: string | null }
  /** The final transcript was handed to the agent (the agent's `thinking` stage). */
  | { type: "transcribed" }
  /** The turn's reconciled BCP-47 language became known; drives the labels. */
  | { type: "language"; language: string | null }
  /** An executor boundary of the payment path (F1). */
  | { type: "stage"; stage: PaymentStage }
  | { type: "failed"; label: string }
  | { type: "speech_started" }
  | { type: "speech_finished" }
  | { type: "settled" };

const nextId = (session: TurnSession | null): number => (session?.id ?? 0) + 1;

/** A fresh, healthy session in its first stage. */
function start(id: number): TurnSession {
  return { id, stage: "listening", failureLabel: null, notice: null, language: null };
}

/**
 * Enters the terminal `error` stage. Idempotent: a second failure while already
 * terminal returns the same session, so a turn settles exactly once and a late
 * failure cannot re-open the dwell.
 */
function fail(session: TurnSession | null, label: string): TurnSession {
  if (session !== null && isTerminalStage(session.stage)) return session;
  return {
    id: nextId(session),
    stage: "error",
    failureLabel: label,
    notice: null,
    language: session?.language ?? null,
  };
}

/** True for the approval/signing/submitting stages that own a pending payment. */
export function isPaymentStage(stage: TurnStage): stage is PaymentStage {
  return stage === "awaiting_approval" || stage === "signing" || stage === "submitting";
}

/** True for the stages the shell may collapse after; `null` is the idle pill. */
export function isTerminalStage(stage: TurnStage): stage is TerminalStage {
  return stage === "done" || stage === "error";
}

/** True for every stage the notch must stay expanded through (F1 invariant). */
export function isActiveStage(stage: TurnStage): boolean {
  return !isTerminalStage(stage);
}

/**
 * Advances along the payment path. Only the real forward edges are accepted, so
 * an out-of-order or duplicated `onStage` cannot move the turn backwards (and a
 * stale one from a superseded turn cannot move a newer one at all).
 */
function advancePayment(session: TurnSession, stage: PaymentStage): TurnSession {
  const from = session.stage;
  const reaches =
    (stage === "awaiting_approval" && (from === "thinking" || from === "speaking")) ||
    (stage === "signing" && from === "awaiting_approval") ||
    (stage === "submitting" && from === "signing");
  return reaches ? { ...session, stage, notice: null } : session;
}

/**
 * Folds one signal into the current session (or `null` when no turn is live).
 *
 * Guarantees, each pinned by a test:
 * - a healthy turn is never `null` between `recording` and its terminal dwell;
 * - capture `ready` / `transcribing` / `idle` only advance or hold the stage,
 *   never end the session — `idle` is the STT gap that used to collapse the shell;
 * - `speaking` is reachable **only** through `speech_started`, and only from
 *   `thinking` (the model answer) or `submitting` (the post-submit confirmation);
 * - a pending payment owns the notch: `recording` while an approval is in flight
 *   is refused with a soft notice, never superseded;
 * - a failure ends the session exactly once, via one `settled`;
 * - a stale `speech_*` from a superseded turn cannot move or end a newer one.
 */
export function reduceTurnSession(
  session: TurnSession | null,
  signal: TurnSignal,
): TurnSession | null {
  switch (signal.type) {
    case "capture": {
      // F1: a payment in flight must not be hidden. A new take (the hotkey) is
      // refused with a soft notice so the user sees why nothing happened; every
      // other capture signal belongs to that ignored take and is dropped too, so
      // its release/error cannot settle the approval.
      if (session !== null && isPaymentStage(session.stage)) {
        return signal.state === "recording" ? { ...session, notice: "payment_pending" } : session;
      }
      switch (signal.state) {
        // A new take always starts a fresh session and supersedes whatever the
        // shell was showing (a previous failure or a still-playing answer).
        case "recording":
          return start(nextId(session));
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
    case "language":
      // Labels only; a language report can never open or end a turn.
      return session !== null ? { ...session, language: signal.language } : session;
    case "stage":
      return session !== null ? advancePayment(session, signal.stage) : session;
    case "failed":
      return fail(session, signal.label);
    case "speech_started":
      // The model answer (`thinking`) or the post-submit confirmation
      // (`submitting`) may start real playback; a queued or stale utterance from
      // a previous turn is ignored. Crucially, this is the *single* way in.
      return session !== null &&
        (session.stage === "thinking" || session.stage === "submitting")
        ? { ...session, stage: "speaking", notice: null }
        : session;
    case "speech_finished":
      // A healthy turn completes here — and only into `done`, so the collapse
      // always happens from a terminal stage.
      return session !== null && session.stage === "speaking"
        ? { ...session, stage: "done" }
        : session;
    case "settled":
      // The terminal dwell elapsed; the session is over.
      return session !== null && isTerminalStage(session.stage) ? null : session;
  }
}

/** True while the notch must stay expanded for a live turn. */
export function isTurnExpanded(session: TurnSession | null): boolean {
  return session !== null;
}

/** The voice source's inputs to the shell reducer, derived from the session. */
export interface ShellVoiceInputs {
  /** The state the voice source proposes to the shell. */
  state: "compact" | "collapsed";
  /** Does voice outrank hover right now (an attention stage)? */
  attention: boolean;
}

/** Non-turn flags that also expand/attention the shell. */
export interface ShellVoiceFlags {
  /** A connection error is showing ("Reconnecting"). */
  connectionError?: boolean;
  /** The Rust core has not connected yet. */
  connected?: boolean;
  /** The one-time Accessibility hint is showing. */
  permissionHint?: boolean;
}

/**
 * Maps the turn session (plus the connect/permission flags) onto the shell's
 * `voiceState`/`voiceAttention` inputs. Pure, so the precedence that decides
 * whether hover may open the panel is unit-testable.
 *
 * Only an **active** stage outranks hover. A terminal stage (`done`/`error`)
 * keeps the label up during its dwell but must not lock hover out, and no
 * session (`null`) never does — that is the "a failed payment still lets hover
 * open the panel" guarantee the merge regression was about.
 */
export function shellVoiceInputs(
  session: TurnSession | null,
  flags: ShellVoiceFlags = {},
): ShellVoiceInputs {
  const connectionError = flags.connectionError ?? false;
  const disconnected = flags.connected === false;
  const permissionHint = flags.permissionHint ?? false;
  const attention =
    connectionError ||
    disconnected ||
    permissionHint ||
    (session !== null && isActiveStage(session.stage));
  const expanded = session !== null || connectionError || disconnected || permissionHint;
  return { state: expanded ? "compact" : "collapsed", attention };
}

/* ------------------------------------------------------------------ *
 * Stage labels (F1)
 * ------------------------------------------------------------------ */

/** Short, ear-safe label per stage; the label is the only drawn text. */
const STAGE_LABELS: Record<TurnStage, { en: string; tr: string }> = {
  listening: { en: "Listening", tr: "Dinliyorum" },
  thinking: { en: "Thinking", tr: "Düşünüyorum" },
  speaking: { en: "Speaking", tr: "Konuşuyorum" },
  awaiting_approval: { en: "Approve in Polaris", tr: "Polaris'te onayla" },
  signing: { en: "Signing", tr: "İmzalanıyor" },
  submitting: { en: "Sending", tr: "Gönderiliyor" },
  done: { en: "Done", tr: "Tamam" },
  error: { en: "Error", tr: "Hata" },
};

const NOTICE_LABELS: Record<TurnNotice, { en: string; tr: string }> = {
  payment_pending: { en: "Approve first", tr: "Önce onayla" },
};

/** Picks the Turkish string for a `tr` turn, English otherwise. */
function localized(text: { en: string; tr: string }, language: string | null): string {
  return languageBase(language ?? undefined) === "tr" ? text.tr : text.en;
}

/** The short notch label for a stage, in the turn's language. */
export function stageLabel(stage: TurnStage, language: string | null): string {
  return localized(STAGE_LABELS[stage], language);
}

/** The soft label shown when a take was refused because a payment is pending. */
export function noticeLabel(notice: TurnNotice, language: string | null): string {
  return localized(NOTICE_LABELS[notice], language);
}

/* ------------------------------------------------------------------ *
 * Stuck-stage watchdogs (M4, ceilings retuned in F1)
 * ------------------------------------------------------------------ */

/**
 * Per-stage ceilings. `thinking` bounds the model + TTS-synthesis wait;
 * `speaking` bounds playback. The payment stages get their own, longer bounds
 * because the approval card and the wallet round trip are human-paced: the
 * ceilings track the Rust approval TTL (120 s) and the wallet's own timeout.
 */
export const THINKING_WATCHDOG_MS = 30_000;
export const SPEAKING_WATCHDOG_MS = 45_000;
export const APPROVAL_WATCHDOG_MS = 140_000;
export const SIGNING_WATCHDOG_MS = 170_000;
export const SUBMITTING_WATCHDOG_MS = 60_000;

/**
 * One ceiling for the whole turn, independent of any single stage. Even if every
 * stage recovers just inside its own bound the turn cannot outlive this.
 */
export const TOTAL_WATCHDOG_MS = 6 * 60_000;

/** The recovery timer for one non-terminal stage. */
export interface StageWatchdog {
  readonly timeoutMs: number;
  /** Short, ear-safe label shown if the timer fires. */
  readonly label: string;
}

/**
 * The watchdog for a live stage, or `null` when the stage recovers by itself.
 *
 * `listening` ends on the hotkey release and the terminal stages on their own
 * dwell, so neither needs a timer here. The caller schedules and clears the
 * timer; this function stays pure so the policy is unit-testable.
 */
export function stageWatchdog(stage: TurnStage): StageWatchdog | null {
  switch (stage) {
    case "thinking":
      return { timeoutMs: THINKING_WATCHDOG_MS, label: "Timed out" };
    case "speaking":
      return { timeoutMs: SPEAKING_WATCHDOG_MS, label: "Voice error" };
    case "awaiting_approval":
      return { timeoutMs: APPROVAL_WATCHDOG_MS, label: "Approval timed out" };
    case "signing":
      return { timeoutMs: SIGNING_WATCHDOG_MS, label: "Wallet timed out" };
    case "submitting":
      return { timeoutMs: SUBMITTING_WATCHDOG_MS, label: "Submit timed out" };
    case "listening":
    case "done":
    case "error":
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

/**
 * Whether an execution outcome may still touch the UI (F1).
 *
 * A non-submitted result obeys the M1 cross-turn guard exactly as before. A
 * **submitted** transaction is always surfaced, even when a watchdog already
 * settled its turn as failed: value has moved, and the user must never lose the
 * confirmation or the explorer link because the notch timed out first (the F1
 * scenario the review calls MAJOR-1).
 */
export function shouldSurfaceOutcome(
  session: TurnSession | null,
  turnId: number | undefined,
  submitted: boolean,
): boolean {
  return submitted || isCurrentTurn(session, turnId);
}
