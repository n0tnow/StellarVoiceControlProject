import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { Mic, Plug, RadioTower, Trash2 } from "lucide-react";
import type { AppInfo } from "@polaris/interfaces";

import { EventLog } from "@/components/EventLog";
import { Button } from "@/components/ui/button";
import {
  describeEvent,
  getAppInfo,
  listenPolarisEvents,
  makeLine,
  startCapture,
  stopCapture,
  type LogLine,
} from "@/lib/polaris";

type StreamState = "connecting" | "live" | "failed";

/** Default push-to-talk hotkey (Rust side: `audio::DEFAULT_HOTKEY`). */
const HOTKEY_LABEL = "Ctrl + Option + Space";

/**
 * Polaris shell — step A0 harness.
 *
 * Wired today: the typed `polaris-event` stream, push-to-talk via the global
 * hotkey (Ctrl+Option+Space) or by holding the button below; each push writes a
 * WAV recording and lands an `audio_captured` line in the log pane.
 * Not wired yet: STT (A1), the agent round trip (A2), speech output (A3),
 * screen reading (A4), Touch ID approval + signing (A5).
 */
export default function App() {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [stream, setStream] = useState<StreamState>("connecting");
  const [recording, setRecording] = useState(false);
  const [wireEventCount, setWireEventCount] = useState(0);
  // Ref mirror of `recording` for stable callbacks (StrictMode, pointer races).
  const recordingRef = useRef(false);

  const append = useCallback((line: Omit<LogLine, "id" | "at">) => {
    setLines((previous) => [...previous, makeLine(line)]);
  }, []);

  // Subscribe to the Rust event stream, then fetch app metadata.
  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    let cancelled = false;

    listenPolarisEvents((event) => {
      setWireEventCount((count) => count + 1);
      append(describeEvent(event));

      // Keep the recording indicator in sync with whatever started the push
      // (hotkey or button) — the UI must not be the source of truth here.
      if (event.type === "hotkey") {
        recordingRef.current = event.state === "down";
        setRecording(event.state === "down");
      } else if (event.type === "audio_captured" || event.type === "error") {
        recordingRef.current = false;
        setRecording(false);
      }
    })
      .then((stop) => {
        if (cancelled) {
          stop();
          return;
        }
        unlisten = stop;
        setStream("live");
        append({ origin: "ui", title: "Subscribed to polaris-event", tone: "ok" });
      })
      .catch((error: unknown) => {
        setStream("failed");
        append({
          origin: "ui",
          title: "Could not subscribe to the event stream",
          detail: String(error),
          tone: "danger",
        });
      });

    getAppInfo()
      .then((metadata) => {
        setInfo(metadata);
        append({
          origin: "ui",
          title: `Polaris ${metadata.version} ready`,
          detail: `network: ${metadata.network} · tauri: ${metadata.tauriVersion}`,
          tone: "accent",
        });
      })
      .catch((error: unknown) => {
        append({
          origin: "ui",
          title: "app_info command failed",
          detail: String(error),
          tone: "danger",
        });
      });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [append]);

  const startTalk = useCallback(async () => {
    if (recordingRef.current) return;
    recordingRef.current = true;
    setRecording(true);
    append({ origin: "ui", title: "Recording started (button)", tone: "accent" });
    try {
      await startCapture();
    } catch (error: unknown) {
      recordingRef.current = false;
      setRecording(false);
      append({
        origin: "ui",
        title: "Could not start recording",
        detail: String(error),
        tone: "danger",
      });
    }
  }, [append]);

  const stopTalk = useCallback(async () => {
    if (!recordingRef.current) return;
    recordingRef.current = false;
    setRecording(false);
    // The `audio_captured` event (or an `error` event) lands via the stream.
    try {
      await stopCapture();
    } catch (error: unknown) {
      const message = String(error);
      if (!message.includes("not recording")) {
        append({
          origin: "ui",
          title: "Could not stop recording",
          detail: message,
          tone: "danger",
        });
      }
    }
  }, [append]);

  const statusTone = useMemo(
    () =>
      stream === "live"
        ? "text-polaris-ok"
        : stream === "failed"
          ? "text-polaris-danger"
          : "text-polaris-warn",
    [stream],
  );

  return (
    <div className="flex h-full flex-col bg-polaris-bg text-polaris-text">
      <header className="flex items-center gap-4 border-b border-polaris-line px-5 py-4">
        <div className="flex size-9 items-center justify-center rounded-xl bg-polaris-accent/15">
          <RadioTower className="size-4 text-polaris-accent" />
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="text-sm font-semibold tracking-wide">Polaris</h1>
          <p className="text-xs text-polaris-muted">push-to-talk Stellar assistant · A0 harness</p>
        </div>
        <div className="flex items-center gap-2 text-[11px] text-polaris-muted">
          {info ? (
            <>
              <span className="rounded-md border border-polaris-line px-2 py-0.5">v{info.version}</span>
              <span className="rounded-md border border-polaris-line px-2 py-0.5">{info.network}</span>
            </>
          ) : null}
          <span className={`flex items-center gap-1.5 ${statusTone}`}>
            <Plug className="size-3" />
            {stream}
          </span>
        </div>
      </header>

      <EventLog lines={lines} />

      <footer className="flex items-center gap-3 border-t border-polaris-line px-5 py-4">
        <Button
          variant={recording ? "danger" : "default"}
          className="gap-2"
          disabled={stream !== "live"}
          title={`Hold to talk — or hold ${HOTKEY_LABEL} anywhere`}
          onPointerDown={() => void startTalk()}
          onPointerUp={() => void stopTalk()}
          onPointerLeave={() => void stopTalk()}
        >
          <Mic className="size-4" />
          {recording ? "Recording… release to stop" : "Hold to talk"}
        </Button>
        <Button variant="ghost" onClick={() => setLines([])}>
          <Trash2 className="size-4" />
          Clear
        </Button>
        <span className="ml-auto text-[11px] text-polaris-muted">
          {wireEventCount} events · hotkey: {HOTKEY_LABEL} · next: A1 speech-to-text
        </span>
      </footer>
    </div>
  );
}
