import { useEffect, useState, type CSSProperties } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import type { CaptureStatus, NotchGeometry } from "@polaris/interfaces";

import { getCaptureStatus, getNotchGeometry, listenPolarisEvents } from "@/lib/polaris";

const FALLBACK_GEOMETRY: NotchGeometry = {
  idleWidth: 216,
  idleHeight: 34,
  expandedWidth: 680,
  expandedHeight: 66,
};

const IDLE_STATUS: CaptureStatus = { state: "idle", recording: null, error: null };

/**
 * How long the expanded "Ready to send" shell stays up before collapsing back
 * to the idle pill. The recording is untouched — it stays on disk for step A1.
 */
const READY_DWELL_MS = 6000;

/** Display topology has no Tauri event; re-read geometry on a cheap interval. */
const GEOMETRY_POLL_MS = 2000;

/** Backoff before retrying a failed connection to the Rust core. */
const RECONNECT_MS = 3000;

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

  useEffect(() => {
    let disposed = false;
    let unlisten: UnlistenFn | undefined;
    let receivedStatus = false;
    let retry: ReturnType<typeof setTimeout> | undefined;

    // Subscribe first, then read the snapshot, so no transition is missed
    // between the two. A live event always wins over the startup snapshot.
    const connect = async () => {
      try {
        unlisten = await listenPolarisEvents((event) => {
          if (disposed) return;
          if (event.type === "capture_status") {
            receivedStatus = true;
            setStatus(event.status);
          }
        });
        if (disposed) {
          unlisten();
          return;
        }
        const snapshot = await getCaptureStatus();
        if (!disposed) {
          if (!receivedStatus) setStatus(snapshot);
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

  // Presentation-only dwell: the wire `ready` state persists (the WAV is still
  // waiting for A1), but the companion collapses so it does not sit expanded.
  useEffect(() => {
    if (status.state !== "ready") {
      setCollapsed(false);
      return;
    }
    const timer = setTimeout(() => setCollapsed(true), READY_DWELL_MS);
    return () => clearTimeout(timer);
  }, [status]);

  const state = connectionError ? "error" : status.state;
  const visual = state === "ready" && collapsed ? "idle" : state;
  const expanded = visual !== "idle" || !connected;
  const error = connectionError ?? status.error;
  const durationMs = status.recording?.durationMs ?? 0;

  const label =
    state === "recording"
      ? "Listening"
      : state === "ready"
        ? "Ready to send"
        : state === "error"
          ? "Recording unavailable"
          : "Connecting";
  const detail =
    connectionError
      ? "Reconnecting…"
      : state === "error"
        ? "Hold ⌃⌥ Space to retry"
        : state === "ready"
          ? `${(durationMs / 1000).toFixed(1)}s · Hold ⌃⌥ Space to re-record`
          : state === "recording"
            ? "Release ⌃⌥ Space when you are done"
            : "Starting up…";

  const style = {
    "--idle-width": `${geometry.idleWidth}px`,
    "--idle-height": `${geometry.idleHeight}px`,
    "--expanded-width": `${geometry.expandedWidth}px`,
    "--expanded-height": `${geometry.expandedHeight}px`,
  } as CSSProperties;

  return (
    <main className="notch-stage" style={style} aria-label="Polaris voice capture">
      <section
        className={`notch ${expanded ? "is-expanded" : ""} state-${visual}`}
        aria-label={
          expanded
            ? `${label}. ${detail}`
            : "Polaris ready. Hold Control, Option and Space to record."
        }
      >
        <div className="notch-content" aria-hidden={!expanded}>
          <div className="notch-copy">
            <p className="notch-label">{label}</p>
            <p className="notch-detail">{detail}</p>
          </div>
          <div className="notch-indicator" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
        </div>
        {state === "error" && error ? <p className="notch-error">{error}</p> : null}
      </section>
      <span
        className="sr-only"
        role={state === "error" ? "alert" : "status"}
        aria-live="polite"
        aria-atomic="true"
      >
        {expanded
          ? `${label}. ${detail}. ${error ?? ""}`
          : "Ready. Hold Control, Option and Space to record. Release to prepare your recording."}
      </span>
    </main>
  );
}
