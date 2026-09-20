import { useEffect, useReducer, useRef, useState } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import {
  FALLBACK_SHELL_GEOMETRY,
  type CaptureStatus,
  type NavigationRequest,
  type ShellGeometry,
} from "@polaris/interfaces";

import { runAgentTurn, type AgentOutcome } from "@/lib/agent";
import { executeApprovedIntent } from "@/lib/chain";
import { applyNavigation } from "@/lib/navigation";
import { speakSentence, speakTurnResult } from "@/lib/speech";
import { failureSentence, submittedSentence } from "@polaris/agent";
import { TurnFlow } from "@/lib/turnFlow";
import { decideWalletGateForTurn } from "@/lib/walletGate";
import {
  recordTurnAnswer,
  recordTurnOutcome,
  recordTurnStart,
} from "@/lib/turnLog";
import {
  isActiveStage,
  isCurrentTurn,
  isPaymentStage,
  noticeLabel,
  reduceTurnSession,
  shellVoiceInputs,
  shouldSurfaceOutcome,
  stageLabel,
  stageWatchdog,
  TOTAL_WATCHDOG_MS,
  type PaymentStage,
  type TurnSession,
} from "@/lib/turnSession";
import { getCaptureStatus, getHotkeyPermission, listenPolarisEvents } from "@/lib/polaris";
import { ShellSurface } from "@/notch/ShellSurface";
import { getShellGeometry } from "@/notch/shellBridge";

const IDLE_STATUS: CaptureStatus = {
  state: "idle",
  recording: null,
  error: null,
  label: null,
};

/**
 * How long a failed turn's short label stays up before the shell collapses.
 * The full detail is never dropped: it reaches the console (and the Rust
 * terminal) regardless, only the notch settles.
 */
const FAILURE_DWELL_MS = 5000;

/** Display topology has no Tauri event; re-read geometry on a cheap interval. */
const GEOMETRY_POLL_MS = 2000;

/** Backoff before retrying a failed connection to the Rust core. */
const RECONNECT_MS = 3000;

/**
 * How long the one-time "Accessibility needed" hint stays expanded after the
 * overlay connects. The macOS consent dialog is the primary, non-modal signal;
 * this is the in-shell echo of it.
 */
const PERMISSION_HINT_MS = 8000;

/**
 * Polaris notch overlay.
 *
 * Two state machines live together here since the A5 merge, with one direction
 * of authority between them:
 *
 * - The **voice chain** is one explicit turn session (`reduceTurnSession`). A
 *   turn begins when the hotkey goes down and ends once — after the answer has
 *   been spoken, or after a failure label has had its dwell. In between it moves
 *   `listening -> thinking -> speaking` (and, for a payment, through
 *   `awaiting_approval -> signing -> submitting` before the confirmation
 *   speech) with no intermediate collapse; F1 makes those stages visible and
 *   gives each its own watchdog, so the notch cannot close while value moves.
 * - The **notch shell** (`ShellSurface` + `useShellState`) resolves that voice
 *   proposal against its own hover/prompt sources and owns every pixel: one
 *   surface, one state table. App is the bridge — it maps the turn session onto
 *   the shell's `visual`/`voiceState`/`voiceAttention` inputs (below) and never
 *   lets the shell derive turn state of its own. Hover/panel and the latched
 *   double-Control prompt stay shell-only sources.
 *
 * The typed prompt is not a shortcut around this seam: `PromptPanel` runs the
 * same `runAgentTurn` and, for a produced intent, the same `executeApprovedIntent`
 * gate before anything is added to the (mock) answer.
 */
export default function App() {
  const [status, setStatus] = useState<CaptureStatus>(IDLE_STATUS);
  const [geometry, setGeometry] = useState<ShellGeometry>(FALLBACK_SHELL_GEOMETRY);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [hotkeyTrusted, setHotkeyTrusted] = useState<boolean | null>(null);
  const [permissionHint, setPermissionHint] = useState(false);
  const [session, dispatchTurn] = useReducer(reduceTurnSession, null);
  // NAV: the latest voice navigation request, handed to the shell so it can
  // select a notch page. A fresh object per command is what re-triggers an
  // identical request.
  const [navigation, setNavigation] = useState<NavigationRequest | null>(null);
  // Admission/freshness policy for spoken turns: it dedupes a re-emitted
  // transcript and, the M2 fix, lets a genuine second utterance supersede an
  // in-flight turn instead of being dropped. Stable across renders.
  const flowRef = useRef(new TurnFlow());
  // Latest session, readable from async callbacks that were started during a
  // turn. A late failure from a superseded turn must not fail the current one.
  const sessionRef = useRef<TurnSession | null>(session);
  sessionRef.current = session;

  // A terminal turn stays up for its dwell, then a single `settled` ends it: the
  // failure label gets `FAILURE_DWELL_MS`, a healthy `done` collapses at once
  // (the answer has already been spoken). Keyed on the session id so a new
  // terminal stage re-arms while a re-render of the same one does not — it
  // settles exactly once.
  useEffect(() => {
    if (session?.stage !== "error" && session?.stage !== "done") return;
    const dwell = session.stage === "error" ? FAILURE_DWELL_MS : 0;
    const timer = setTimeout(() => dispatchTurn({ type: "settled" }), dwell);
    return () => clearTimeout(timer);
  }, [session?.id, session?.stage]);

  // F1: one ceiling for the whole turn, so a payment path that shuffles between
  // (individually bounded) stages cannot hold the notch open indefinitely.
  useEffect(() => {
    if (session === null || !isActiveStage(session.stage)) return;
    const timer = setTimeout(
      () => dispatchTurn({ type: "failed", label: "Timed out" }),
      TOTAL_WATCHDOG_MS,
    );
    return () => clearTimeout(timer);
  }, [session?.id]);

  // Stuck-stage watchdog (M4): both bounded stages are watched — the pre-speech
  // wait AND `speaking`, so a wedged player cannot hold the shell open forever.
  // Any stage change clears the timer and re-arms for the new stage.
  useEffect(() => {
    if (session === null) return;
    const watchdog = stageWatchdog(session.stage);
    if (watchdog === null) return;
    const timer = setTimeout(
      () => dispatchTurn({ type: "failed", label: watchdog.label }),
      watchdog.timeoutMs,
    );
    return () => clearTimeout(timer);
  }, [session?.id, session?.stage]);

  useEffect(() => {
    let disposed = false;
    let unlisten: UnlistenFn | undefined;
    let receivedStatus = false;
    let retry: ReturnType<typeof setTimeout> | undefined;

    // A final transcript is the input to the agent loop; the turn is already on
    // "thinking" and stays there through the model call. `TurnFlow` keeps a
    // StrictMode double-listener (or a re-emitted transcript) from starting two
    // model calls for one utterance, and — the M2 fix — admits a genuine second
    // utterance as a superseding turn instead of dropping it, so the shell is
    // never left waiting on a transcript that was thrown away.
    //
    // Speaks a successful turn, settling "thinking" if the utterance produced no
    // audio at all. With A9's real-playback "Speaking", a TTS failure emits no
    // `speech_status`, so without this the notch would wait for the watchdog.
    // The session id guard keeps a stale failure from a superseded turn from
    // failing a newer one.
    const speakWithSettle = (outcome: AgentOutcome): void => {
      const turnId = sessionRef.current?.id;
      speakTurnResult(outcome, (error) => {
        console.warn("speech produced no audio; settling the turn", error);
        if (isCurrentTurn(sessionRef.current, turnId)) {
          dispatchTurn({ type: "failed", label: "Voice error" });
        }
      });
    };

    const runFromTranscript = (raw: string, language?: string): void => {
      // F1: while a payment is awaiting approval, signing or submitting, a take
      // that slipped through the (refused) hotkey must not start a superseding
      // agent turn. The pending payment takes priority until it settles.
      const pending = sessionRef.current?.stage;
      if (pending !== undefined && isPaymentStage(pending)) {
        console.warn("ignoring a transcript while a payment is pending");
        return;
      }
      const admission = flowRef.current.offer(raw);
      if (admission.kind === "ignore") return;
      const { ticket } = admission;
      const current = (): boolean => flowRef.current.isCurrent(ticket);
      // NW4: the local turn log records the turn from start to outcome, so the
      // History page can show turns the chain never saw. No XDR is ever stored.
      const logId = recordTurnStart(ticket.transcript);
      // The STT-detected language labels the notch stages until the agent reports
      // the reconciled language below.
      dispatchTurn({ type: "language", language: language ?? null });
      // The agent core emits `agent_status: thinking` at the exact moment it
      // takes the transcript; that event — not this call — enters the thinking
      // stage. Nothing here may jump ahead to "speaking": that is raised only by
      // the backend's real playback-start event.
      //
      // Step A12: the STT-detected language rides the transcript event and is
      // handed to the agent, which pins it into the prompt and reconciles it
      // against the model's own report for the reply/voice.
      void runAgentTurn(
        ticket.transcript,
        {
          onAgentStage: (stage) => {
            if (stage === "thinking" && current()) dispatchTurn({ type: "transcribed" });
          },
        },
        language,
      )
        .then((run) => {
          if (disposed || !current()) return;
          if (!run.ok) {
            // Only the short label reaches the notch; the full detail is already
            // on the console and in the Rust log.
            recordTurnOutcome(logId, { label: `failed: ${run.failure.label}` });
            dispatchTurn({ type: "failed", label: run.failure.label });
            return;
          }
          // The model's reconciled language is the authoritative one for the
          // reply/voice (A14), so it also drives the notch labels from here on.
          dispatchTurn({ type: "language", language: run.outcome.language ?? null });
          recordTurnAnswer(logId, run.outcome.answer);
          // NAV: a voice navigation request selects a notch page. ShellSurface
          // applies the page; the spoken confirmation is the outcome's answer,
          // spoken below like any conversational turn.
          if (run.outcome.navigation) {
            setNavigation(run.outcome.navigation);
            void applyNavigation(run.outcome.navigation);
          }
          if (!run.outcome.intent) {
            // A conversational turn has nothing to execute: speak the answer and
            // let the real `speech_status` stream end the turn.
            speakWithSettle(run.outcome);
            return;
          }
          // A produced intent goes down the single A9 execution seam (approval
          // gate → chain tool) before anything is spoken. The confirmation is
          // spoken only once the transaction is signed/submitted; a failure is
          // announced with its real label.
          //
          // M1: bind the outcome to the turn that dispatched it. If a newer turn
          // is on screen by the time execution resolves, this result is stale and
          // must not overwrite the newer turn's UI — the same rule the speech
          // path applies.
          const turnId = sessionRef.current?.id;
          // Capture the narrowed intent: TypeScript does not carry the `if`
          // narrowing into the async closure below.
          const intent = run.outcome.intent;
          // F1: the approval gate and the sign/submit path report their real
          // boundaries here, so the notch wears the matching stage for the whole
          // (human-paced) wait instead of the generic "Thinking".
          const onStage = (stage: PaymentStage): void => {
            if (disposed || !isCurrentTurn(sessionRef.current, turnId)) return;
            dispatchTurn({ type: "stage", stage });
          };
          const runExecution = (): void => {
            void executeApprovedIntent(intent, { onStage })
            .then((outcome) => {
              if (disposed) return;
              // M1: a non-submitted stale result is still dropped. W4b-2: a tx
              // that actually reached the network is always surfaced, even if a
              // watchdog settled the turn as failed first (MAJOR-1).
              const submitted = outcome.status === "executed" && outcome.txHash !== undefined;
              if (!shouldSurfaceOutcome(sessionRef.current, turnId, submitted)) return;
              if (submitted) {
                // W4b: the signed transaction reached the network. Announce the
                // real result (not the pre-approval confirmation) and let the
                // real `speech_status` stream end the turn.
                recordTurnOutcome(logId, {
                  label: "tx_submitted",
                  txHash: outcome.txHash,
                  explorerUrl: outcome.explorerUrl ?? null,
                });
                console.info("transaction submitted", outcome.explorerUrl);
                const sentence = submittedSentence(intent, run.outcome.language);
                speakSentence(sentence, run.outcome.language, (error) => {
                  console.warn("speech produced no audio; settling the turn", error);
                  if (isCurrentTurn(sessionRef.current, turnId)) {
                    dispatchTurn({ type: "failed", label: "Voice error" });
                  }
                });
              } else {
                // A deny, wallet refusal, timeout, integrity or submit failure:
                // a short spoken line plus the visible label.
                console.warn(`execution ${outcome.status}: ${outcome.detail ?? ""}`);
                const label = outcome.label ?? "Chain error";
                recordTurnOutcome(logId, { label: `failed: ${label}` });
                speakSentence(
                  failureSentence(label, run.outcome.language),
                  run.outcome.language,
                );
                dispatchTurn({ type: "failed", label });
              }
            })
            .catch((error: unknown) => {
              if (disposed || !isCurrentTurn(sessionRef.current, turnId)) return;
              console.error("execution seam failed unexpectedly", error);
              recordTurnOutcome(logId, { label: "failed: Chain error" });
              dispatchTurn({ type: "failed", label: "Chain error" });
            });
          };

          // W10b onboarding gate: a value-moving intent with no active wallet is
          // refused before any chain call — one short sentence and the Wallet
          // page. A build without the wallet engine passes through (the chain
          // tool's own owner check stays the fail-closed gate).
          void decideWalletGateForTurn(intent).then((gate) => {
            if (disposed || !isCurrentTurn(sessionRef.current, turnId)) return;
            if (gate.block) {
              void speakSentence(gate.sentence, run.outcome.language);
              // NAV: reuse the voice-navigation mechanism so the notch selects
              // the Wallet page (ShellSurface applies notch targets).
              setNavigation({
                target: "wallet",
                spoken: gate.sentence,
                ...(run.outcome.language ? { language: run.outcome.language } : {}),
              });
              recordTurnOutcome(logId, { label: "failed: Connect wallet" });
              dispatchTurn({ type: "failed", label: "Connect wallet" });
              return;
            }
            runExecution();
          });
        })
        .finally(() => flowRef.current.settle(ticket));
    };

    // Subscribe first, then read the snapshot, so no transition is missed
    // between the two. A live event always wins over the startup snapshot.
    const connect = async () => {
      try {
        unlisten = await listenPolarisEvents((event) => {
          if (disposed) return;
          if (event.type === "capture_status") {
            receivedStatus = true;
            setStatus(event.status);
            dispatchTurn({
              type: "capture",
              state: event.status.state,
              label: event.status.label,
            });
          } else if (event.type === "hotkey_permission") {
            setHotkeyTrusted(event.trusted);
          } else if (event.type === "speech_status") {
            dispatchTurn(
              event.state === "speaking" ? { type: "speech_started" } : { type: "speech_finished" },
            );
          } else if (event.type === "transcript" && event.final) {
            runFromTranscript(event.text, event.language ?? undefined);
          }
        });
        if (disposed) {
          unlisten();
          return;
        }
        const [snapshot, trusted] = await Promise.all([
          getCaptureStatus(),
          getHotkeyPermission(),
        ]);
        if (!disposed) {
          if (!receivedStatus) {
            setStatus(snapshot);
            dispatchTurn({ type: "capture", state: snapshot.state, label: snapshot.label });
          }
          setHotkeyTrusted(trusted);
          setConnected(true);
          setConnectionError(null);
        }
      } catch (error) {
        unlisten?.();
        unlisten = undefined;
        if (!disposed) {
          setConnectionError(String(error));
          retry = setTimeout(() => void connect(), RECONNECT_MS);
        }
      }
    };

    const refreshGeometry = () => {
      getShellGeometry()
        .then((next) => {
          if (!disposed) setGeometry(next);
        })
        .catch((error: unknown) => {
          if (!disposed) setConnectionError(`Display unavailable: ${String(error)}`);
        });
    };

    void connect();
    refreshGeometry();
    const geometryTimer = setInterval(refreshGeometry, GEOMETRY_POLL_MS);

    return () => {
      disposed = true;
      unlisten?.();
      clearTimeout(retry);
      clearInterval(geometryTimer);
    };
  }, []);

  // One-time, non-modal echo of the macOS Accessibility consent dialog. The
  // system dialog is the primary signal; this expands the shell briefly so the
  // user sees that Control+Option is unavailable and the shortcut still works.
  useEffect(() => {
    if (!connected || hotkeyTrusted !== false) {
      setPermissionHint(false);
      return;
    }
    setPermissionHint(true);
    const timer = setTimeout(() => setPermissionHint(false), PERMISSION_HINT_MS);
    return () => clearTimeout(timer);
  }, [connected, hotkeyTrusted]);

  // One-time hint echo of the macOS Accessibility dialog; only replaces the idle
  // pill, never a live turn.
  const showPermissionHint =
    permissionHint && connected && hotkeyTrusted === false && session === null && !connectionError;

  // The voice source's visual name. It reuses the shell's existing `state-*`
  // language: capture's `recording`/`transcribing` names stay the selectors for
  // the listening and thinking stages, the speaking stage has its own name, and
  // a failed session borrows the error treatment. The F1 payment stages borrow
  // `transcribing` on purpose: they are all "Polaris is working" and the label
  // carries the meaning, so no new CSS state is needed.
  const visual =
    connectionError || session?.stage === "error"
      ? "error"
      : session?.stage === "listening"
        ? "recording"
        : session?.stage === "speaking"
          ? "speaking"
          : session !== null
            ? "transcribing"
            : "idle";

  // The shell is expanded for the whole of a live turn — including its terminal
  // stage, until the dwell collapses it — plus a connection in progress or the
  // one-time permission hint. The voice source only outranks hover while it is
  // an attention state the user must see (listening/thinking/speaking, a pending
  // payment, a permission hint, a connection error). During a terminal dwell it
  // only keeps the label up, so hover can still open the panel instead of being
  // locked out for the whole dwell (MINOR-1). Both inputs come from the pure
  // `shellVoiceInputs` so the precedence is unit-tested (`turnSession.test.ts`).
  const { state: voiceState, attention: voiceAttention } = shellVoiceInputs(session, {
    connectionError: connectionError !== null,
    connected,
    permissionHint: showPermissionHint,
  });
  const expanded = voiceState === "compact";

  // The label is the ONLY thing drawn in the left ear, so it has to stay short:
  // the ear is deliberately narrow and anything longer would be clipped (it can
  // never spill right, because that is the camera housing). The full wording
  // still reaches assistive tech through the live region below. Labels follow the
  // turn's language; an `error` keeps the outcome's own short label.
  const label = connectionError
    ? "Reconnecting"
    : session === null
      ? showPermissionHint
        ? "Grant access"
        : connected
          ? "Ready"
          : "Connecting"
      : session.notice !== null
        ? noticeLabel(session.notice, session.language)
        : session.stage === "error"
          ? (session.failureLabel ?? stageLabel("error", session.language))
          : stageLabel(session.stage, session.language);
  const detail = connectionError
    ? "Reconnecting…"
    : session?.stage === "error"
      ? "⌃⌥ to retry"
      : session?.stage === "listening"
        ? "Release to finish"
        : session?.stage === "speaking"
          ? "Polaris is talking"
          : session !== null
            ? "Working…"
            : showPermissionHint
              ? "System Settings › Privacy & Security › Accessibility"
              : "Starting up…";
  const error = connectionError ?? status.error;

  return (
    <main className="notch-stage" aria-label="Polaris voice capture">
      <ShellSurface
        geometry={geometry}
        visual={visual}
        voiceState={voiceState}
        voiceAttention={voiceAttention}
        label={label}
        detail={detail}
        navigation={navigation}
      />
      <span
        className="sr-only"
        role={visual === "error" ? "alert" : "status"}
        aria-live="polite"
        aria-atomic="true"
      >
        {expanded
          ? `${label}. ${detail}. ${error ?? ""}`
          : "Ready. Hold Control and Option to record, or Control, Option and Space. Release to prepare your recording."}
      </span>
    </main>
  );
}
