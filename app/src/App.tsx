import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import type { AgentStage, CaptureState, CaptureStatus, NotchGeometry } from "@polaris/interfaces";

import { AgentTrace } from "@/components/AgentTrace";
import { runAgentTurn, subscribeAgentEvents, type AgentRun } from "@/lib/agent";
import { speakTurnResult } from "@/lib/speech";
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
 * How long the expanded "Ready to send" shell stays up before collapsing back
 * to the idle pill. The recording is untouched — it stays on disk for step A1.
 */
const READY_DWELL_MS = 6000;

/**
 * How long a step-A1 failure label ("No STT key", "Net error", …) stays up
 * before the overlay returns to the resting pill. The full detail still reaches
 * the terminal; the wire state is left as-is and simply presented as idle.
 */
const STT_ERROR_DWELL_MS = 5000;

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
 * How long the step-A2 agent trace (transcript + intent/answer) stays under the
 * notch before it clears itself. Long enough to read, short enough not to linger
 * over the desktop.
 */
const AGENT_TRACE_DWELL_MS = 12000;

/**
 * Polaris notch overlay (step A0).
 *
 * The shell is a pure function of the `capture_status` event stream: idle ->
 * recording (hotkey down) -> ready (release, WAV on disk). Release never sends
 * or submits anything. Microphone and permission failures arrive as the `error`
 * state instead of crashing the shell.
 */
export default function App() {
  const [status, setStatus] = useState<CaptureStatus>(IDLE_STATUS);
  const [geometry, setGeometry] = useState<NotchGeometry>(FALLBACK_GEOMETRY);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [hotkeyTrusted, setHotkeyTrusted] = useState<boolean | null>(null);
  const [permissionHint, setPermissionHint] = useState(false);
  const [agentRun, setAgentRun] = useState<AgentRun | null>(null);
  const [agentStage, setAgentStage] = useState<AgentStage | null>(null);
  // Step A6: a failed agent turn surfaces its short label in the notch for a
  // dwell and then settles, exactly like a step-A1 capture failure. The full
  // detail still goes to the console and stays on the trace's tooltip.
  const [agentError, setAgentError] = useState<{ label: string; detail: string } | null>(null);
  const [agentErrorCollapsed, setAgentErrorCollapsed] = useState(false);
  // Step A5: true while the Rust `speak` command reports audio in flight. Driven
  // by `speech_status` events, which the command emits at the start of playback
  // and again — success or failure — once it has finished.
  const [speaking, setSpeaking] = useState(false);
  // One transcript must produce exactly one agent turn, even though React
  // StrictMode attaches the event listener twice in development.
  const agentBusyRef = useRef(false);

  // The agent core's local bus (not the Tauri stream) drives the stage readout.
  useEffect(() => {
    return subscribeAgentEvents((event) => {
      if (event.type === "agent_status") setAgentStage(event.stage);
    });
  }, []);

  // Auto-clear the trace; a live stage only makes sense while a run exists.
  useEffect(() => {
    if (!agentRun) {
      setAgentStage(null);
      return;
    }
    const timer = setTimeout(() => setAgentRun(null), AGENT_TRACE_DWELL_MS);
    return () => clearTimeout(timer);
  }, [agentRun]);

  // A failed agent turn shows its short label for the same dwell a step-A1
  // failure gets, then collapses back to the resting pill. The failure itself is
  // never dismissed from the console/trace — only the notch label settles.
  useEffect(() => {
    if (agentError === null) {
      setAgentErrorCollapsed(false);
      return;
    }
    setAgentErrorCollapsed(false);
    const timer = setTimeout(() => setAgentErrorCollapsed(true), STT_ERROR_DWELL_MS);
    return () => clearTimeout(timer);
  }, [agentError]);

  useEffect(() => {
    let disposed = false;
    let unlisten: UnlistenFn | undefined;
    let receivedStatus = false;
    let retry: ReturnType<typeof setTimeout> | undefined;

    // Step A2: a final transcript is the input to the agent loop. The guard
    // keeps a StrictMode double-listener (or a re-emitted transcript) from
    // starting two model calls for one utterance.
    const runFromTranscript = (raw: string): void => {
      const transcript = raw.trim();
      if (transcript.length === 0 || agentBusyRef.current) return;
      agentBusyRef.current = true;
      setAgentRun(null);
      setAgentError(null);
      void runAgentTurn(transcript)
        .then((run) => {
          if (disposed) return;
          // Show the result first, then speak: `speakTurnResult` returns
          // immediately and the audio arrives when Fish/local is ready, so a
          // slow TTS backend never delays the transcript or the intent.
          setAgentRun(run);
          setAgentError(run.ok ? null : { label: run.failure.label, detail: run.failure.detail });
          if (run.ok) speakTurnResult(run.outcome);
        })
        .finally(() => {
          agentBusyRef.current = false;
        });
    };

    // Subscribe first, then read the snapshot, so no transition is missed
    // between the two. A live event always wins over the startup snapshot.
    const connect = async () => {
      try {
        unlisten = await listenPolarisEvents((event) => {
          if (disposed) return;
          if (event.type === "capture_status") {
            receivedStatus = true;
            // A new take always supersedes any speech that was still in flight
            // (the user cannot meaningfully record and be spoken to at once),
            // and it clears a previous agent failure from the notch.
            if (event.status.state === "recording") {
              setSpeaking(false);
              setAgentError(null);
            }
            setStatus(event.status);
          } else if (event.type === "hotkey_permission") {
            setHotkeyTrusted(event.trusted);
          } else if (event.type === "speech_status") {
            setSpeaking(event.state === "speaking");
          } else if (event.type === "transcript" && event.final) {
            runFromTranscript(event.text);
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
          if (!receivedStatus) setStatus(snapshot);
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

  // Presentation-only dwell: the wire `ready` state persists (the WAV was handed
  // to A1), but the companion collapses so it does not sit expanded. A step-A1
  // failure label gets the same treatment so the overlay always returns to the
  // resting pill. `transcribing` deliberately has no dwell — it stays up until
  // the transcript or failure lands.
  useEffect(() => {
    const dwell =
      status.state === "ready"
        ? READY_DWELL_MS
        : status.state === "error" && status.label !== null
          ? STT_ERROR_DWELL_MS
          : null;
    if (dwell === null) {
      setCollapsed(false);
      return;
    }
    const timer = setTimeout(() => setCollapsed(true), dwell);
    return () => clearTimeout(timer);
  }, [status]);

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

  const state = connectionError ? "error" : status.state;
  // One-time hint echo of the macOS Accessibility dialog; only replaces the
  // idle pill, never a real recording/ready/error state.
  const showPermissionHint =
    permissionHint && connected && hotkeyTrusted === false && state === "idle";
  // States that collapse back to the pill after their dwell. A connection error
  // is never dismissed: it needs the user's attention.
  const dismissible =
    !connectionError &&
    (state === "ready" || (state === "error" && status.label !== null));
  // Step A5: while audio is actually playing the shell stays expanded and shows
  // the same "working" treatment as Thinking, labelled "Speaking". It only
  // applies once capture has returned to idle; a live recording/ready/error
  // state always takes precedence, and a failed utterance still emits `idle`, so
  // the shell can never be stuck here.
  // Step A6: a failed agent turn is a shell state too. It only replaces the idle
  // pill once capture has settled, and it collapses after its dwell like A1.
  const agentFailureVisual =
    agentError !== null && state === "idle" && connected && !showPermissionHint && !agentErrorCollapsed;
  const speakingVisual = speaking && state === "idle" && connected && !showPermissionHint;
  const visual: CaptureState | "speaking" = speakingVisual
    ? "speaking"
    : agentFailureVisual
      ? "error"
      : dismissible && collapsed
        ? "idle"
        : state;
  const expanded = visual !== "idle" || !connected || showPermissionHint;
  const error =
    connectionError ?? status.error ?? (agentFailureVisual ? agentError?.detail ?? null : null);
  const durationMs = status.recording?.durationMs ?? 0;

  // The label is the ONLY thing drawn in the left ear, so it has to stay short:
  // the ear is deliberately narrow and anything longer would be clipped (it can
  // never spill right, because that is the camera housing). The full wording
  // still reaches assistive tech through the live region below.
  const label = showPermissionHint
    ? "Grant access"
    : state === "recording"
      ? "Listening"
      : state === "transcribing"
        ? "Thinking"
        : state === "ready"
          ? "Ready"
          : state === "error"
            ? // A step-A1 failure carries its own short label; a microphone or
              // connection failure keeps the generic one.
              (status.label ?? "Mic error")
            : agentFailureVisual
              ? // Step A6: the agent's short label, exactly like A1's STT label.
                (agentError?.label ?? "Agent error")
              : visual === "speaking"
                ? "Speaking"
                : "Connecting";
  const detail = showPermissionHint
    ? "System Settings › Privacy & Security › Accessibility"
    : connectionError
      ? "Reconnecting…"
      : state === "error"
        ? "⌃⌥ to retry"
        : state === "ready"
          ? `${(durationMs / 1000).toFixed(1)}s · hold ⌃⌥ again`
          : state === "recording"
            ? "Release to finish"
            : state === "transcribing"
              ? "Transcribing…"
              : agentFailureVisual
                ? "⌃⌥ to retry"
                : visual === "speaking"
                  ? "Polaris is talking"
                  : "Starting up…";

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
        className={`notch ${expanded ? "is-expanded" : ""} state-${visual}`}
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
            <p className="notch-label">{label}</p>
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
      <AgentTrace run={agentRun} stage={agentStage} />
      <span
        className="sr-only"
        role={state === "error" ? "alert" : "status"}
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
