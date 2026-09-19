import { useCallback, useEffect, useMemo, useState } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { Mic, Plug, RadioTower, Trash2 } from "lucide-react";
import type { AppInfo } from "@polaris/interfaces";

import { EventLog } from "@/components/EventLog";
import { Button } from "@/components/ui/button";
import {
  describeEvent,
  devSelfTest,
  getAppInfo,
  listenPolarisEvents,
  makeLine,
  type LogLine,
} from "@/lib/polaris";

type StreamState = "connecting" | "live" | "failed";

/**
 * Polaris shell — skeleton stage.
 *
 * Wired today: the typed `polaris-event` channel from Rust, app metadata, and the
 * log pane that every later step is demoed through.
 * Not wired yet: hotkey and microphone (step A0), STT (A1), the agent round trip
 * (A2), speech output (A3), Touch ID approval (A5).
 */
export default function App() {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [stream, setStream] = useState<StreamState>("connecting");
  const [busy, setBusy] = useState(false);
  const [wireEventCount, setWireEventCount] = useState(0);

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
    })
      .then((stop) => {
        if (cancelled) {
          stop();
          return;
        }
        unlisten = stop;
        setStream("live");
        append({
          origin: "ui",
          title: "Subscribed to polaris-event",
          tone: "ok",
        });
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

  const runSelfTest = useCallback(async () => {
    setBusy(true);
    try {
      const expected = await devSelfTest();
      append({
        origin: "ui",
        title: `dev_self_test emitted ${expected.length} events`,
        detail: expected.map((event) => event.type).join(" -> "),
        tone: "ok",
      });
    } catch (error: unknown) {
      append({
        origin: "ui",
        title: "dev_self_test failed",
        detail: String(error),
        tone: "danger",
      });
    } finally {
      setBusy(false);
    }
  }, [append]);

  const statusTone = useMemo(
    () => (stream === "live" ? "text-polaris-ok" : stream === "failed" ? "text-polaris-danger" : "text-polaris-warn"),
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
          <p className="text-xs text-polaris-muted">
            push-to-talk Stellar assistant · skeleton
          </p>
        </div>
        <div className="flex items-center gap-2 text-[11px] text-polaris-muted">
          {info ? (
            <>
              <span className="rounded-md border border-polaris-line px-2 py-0.5">
                v{info.version}
              </span>
              <span className="rounded-md border border-polaris-line px-2 py-0.5">
                {info.network}
              </span>
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
          variant="default"
          className="gap-2"
          disabled
          title="Step A0: global hotkey + microphone capture are not wired yet"
        >
          <Mic className="size-4" />
          Hold to talk
        </Button>
        <Button variant="secondary" onClick={runSelfTest} disabled={busy || stream !== "live"}>
          {busy ? "Running…" : "Run self-test"}
        </Button>
        <Button variant="ghost" onClick={() => setLines([])}>
          <Trash2 className="size-4" />
          Clear
        </Button>
        <span className="ml-auto text-[11px] text-polaris-muted">
          {wireEventCount} events received · next: A0 audio capture
        </span>
      </footer>
    </div>
  );
}