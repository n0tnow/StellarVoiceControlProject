import { useEffect, useReducer, useRef, useState, type CSSProperties } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import type { CaptureStatus, NotchGeometry } from "@polaris/interfaces";

import { StageLabel } from "@/components/StageLabel";
import { runAgentTurn, type AgentOutcome } from "@/lib/agent";
import { executeApprovedIntent } from "@/lib/chain";
import { speakTurnResult } from "@/lib/speech";
import { TurnFlow } from "@/lib/turnFlow";
import { isCurrentTurn, reduceTurnSession, stageWatchdog, type TurnSession } from "@/lib/turnSession";
import {
  getCaptureStatus,
  getHotkeyPermission,
  getNotchGeometry,
  listenPolarisEvents,
} from "@/lib/polaris";

/**
 * Mirrors `notch::FALLBACK` in Rust — keep the two in step. The expanded height
 * equals the idle height on purpose: the shell only ever widens, never grows
 * down out of the hardware cutout.
 */
const FALLBACK_GEOMETRY: NotchGeometry = {
  idleWidth: 216,
  idleHeight: 34,
  expandedWidth: 216 + 2 * 110,
  expandedHeight: 34,
  pillTopRadius: 4.25,
  pillBottomRadius: 8.5,
  shellEarRadius: 6.12,
  shellBottomRadius: 15.3,
};

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
 * The shell is a pure function of two things: the `capture_status` event stream
 * and one explicit **turn session** (`reduceTurnSession`). A turn begins when
 * the hotkey goes down and ends once — after the answer has been spoken, or
 * after a failure label has had its dwell. In between the shell stays expanded,
 * moving `listening -> thinking -> checking -> speaking` with no intermediate
 * collapse; that continuity is the whole point of modelling the turn as one
 * session instead of several independent visuals that happened to overlap.
 */
export default function App() {
  const [status, setStatus] = useState<CaptureStatus>(IDLE_STATUS);
  const [geometry, setGeometry] = useState<NotchGeometry>(FALLBACK_GEOMETRY);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [hotkeyTrusted, setHotkeyTrusted] = useState<boolean | null>(null);
  const [permissionHint, setPermissionHint] = useState(false);
  const [session, dispatchTurn] = useReducer(reduceTurnSession, null);
  // Admission/freshness policy for spoken turns: it dedupes a re-emitted
  // transcript and, the M2 fix, lets a genuine second utterance supersede an
  // in-flight turn instead of being dropped. Stable across renders.
  const flowRef = useRef(new TurnFlow());
  // Latest session, readable from async callbacks that were started during a
  // turn. A late failure from a superseded turn must not fail the current one.
  const sessionRef = useRef<TurnSession | null>(session);
  sessionRef.current = session;

  // A failed turn stays up for its dwell, then a single `settled` ends it. The
  // effect is keyed on the session id so a new failure re-arms while a re-render
  // of the same failure does not (so it settles exactly once).
  useEffect(() => {
    if (session?.stage !== "failed") return;
    const timer = setTimeout(() => dispatchTurn({ type: "settled" }), FAILURE_DWELL_MS);
    return () => clearTimeout(timer);
  }, [session?.id, session?.stage]);

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
      const admission = flowRef.current.offer(raw);
      if (admission.kind === "ignore") return;
      const { ticket } = admission;
      const current = (): boolean => flowRef.current.isCurrent(ticket);
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
            dispatchTurn({ type: "failed", label: run.failure.label });
            return;
          }
          if (!run.outcome.intent) {
            // A conversational turn has nothing to execute: speak the answer and
            // let the real `speech_status` stream end the turn.
            speakWithSettle(run.outcome);
            return;
          }
          // A produced intent goes down the single A9 execution seam (approval
          // gate → chain tool) before anything is spoken. The confirmation is
          // spoken only once an unsigned transaction exists; while Owner B's
          // tools are `NotImplementedError` stubs, the notch says so plainly and
          // settles instead of hanging.
          //
          // M1: bind the outcome to the turn that dispatched it. If a newer turn
          // is on screen by the time execution resolves, this result is stale and
          // must not overwrite the newer turn's UI — the same rule the speech
          // path applies.
          const turnId = sessionRef.current?.id;
          void executeApprovedIntent(run.outcome.intent)
            .then((outcome) => {
              if (disposed || !isCurrentTurn(sessionRef.current, turnId)) return;
              if (outcome.status === "executed") {
                console.info(
                  "chain tool produced an unsigned transaction",
                  outcome.result?.summary,
                );
                speakWithSettle(run.outcome);
              } else {
                console.warn(`execution ${outcome.status}: ${outcome.detail ?? ""}`);
                dispatchTurn({ type: "failed", label: outcome.label ?? "Chain error" });
              }
            })
            .catch((error: unknown) => {
              if (disposed || !isCurrentTurn(sessionRef.current, turnId)) return;
              console.error("execution seam failed unexpectedly", error);
              dispatchTurn({ type: "failed", label: "Chain error" });
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
      getNotchGeometry()
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

  // The CSS treatment reuses the existing `state-*` language: capture's
  // `recording`/`transcribing` names stay the selectors for the listening and
  // thinking stages, and a failed session borrows the error treatment. (A9
  // removed the `checking` stage: the intent-validation step is synchronous and
  // unreadable, so no label is flashed for it.)
  const shellState = connectionError || session?.stage === "failed"
    ? "error"
    : session?.stage === "listening"
      ? "recording"
      : session?.stage === "thinking"
        ? "transcribing"
        : session?.stage === "speaking"
          ? "speaking"
          : "idle";

  // The shell is expanded for the whole of a live turn, and only a live turn
  // (plus a connection in progress or the one-time permission hint) expands it.
  const expanded = shellState !== "idle" || !connected || showPermissionHint;

  // The label is the ONLY thing drawn in the left ear, so it has to stay short:
  // the ear is deliberately narrow and anything longer would be clipped (it can
  // never spill right, because that is the camera housing). The full wording
  // still reaches assistive tech through the live region below.
  const label = connectionError
    ? "Reconnecting"
    : session?.stage === "failed"
      ? (session.failureLabel ?? "Error")
      : session?.stage === "listening"
        ? "Listening"
        : session?.stage === "thinking"
          ? "Thinking"
          : session?.stage === "speaking"
            ? "Speaking"
            : showPermissionHint
              ? "Grant access"
              : connected
                ? "Ready"
                : "Connecting";
  const detail = connectionError
    ? "Reconnecting…"
    : session?.stage === "failed"
      ? "⌃⌥ to retry"
      : session?.stage === "listening"
        ? "Release to finish"
        : session?.stage === "thinking"
          ? "Working…"
          : session?.stage === "speaking"
            ? "Polaris is talking"
            : showPermissionHint
                ? "System Settings › Privacy & Security › Accessibility"
                : "Starting up…";
  const error = connectionError ?? status.error;

  const style = {
    "--idle-width": `${geometry.idleWidth}px`,
    "--idle-height": `${geometry.idleHeight}px`,
    "--expanded-width": `${geometry.expandedWidth}px`,
    "--expanded-height": `${geometry.expandedHeight}px`,
    "--pill-top-radius": `${geometry.pillTopRadius}px`,
    "--pill-bottom-radius": `${geometry.pillBottomRadius}px`,
    "--shell-ear-radius": `${geometry.shellEarRadius}px`,
    "--shell-bottom-radius": `${geometry.shellBottomRadius}px`,
  } as CSSProperties;

  return (
    <main className="notch-stage" style={style} aria-label="Polaris voice capture">
      <section
        className={`notch ${expanded ? "is-expanded" : ""} state-${shellState}`}
        aria-label={
          expanded
            ? `${label}. ${detail}`
            : "Polaris ready. Hold Control and Option to record, or hold Control, Option and Space."
        }
      >
        <div className="notch-content" aria-hidden={!expanded}>
          <div className="notch-copy">
            {/* Label only. `detail` and `error` are not drawn — the ear is too
                narrow for them and the housing to its right cannot be used —
                but they still reach assistive tech via the live region below. */}
            <StageLabel label={label} />
          </div>
          {/* The camera housing: no pixels exist here, so it stays empty. */}
          <span className="notch-gap" aria-hidden="true" />
          <div className="notch-indicator" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
        </div>
      </section>
      <span
        className="sr-only"
        role={shellState === "error" ? "alert" : "status"}
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
