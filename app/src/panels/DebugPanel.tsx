import { useCallback, useEffect, useMemo, useState } from "react";
import type { AppInfo, PolarisEvent } from "@polaris/interfaces";

import { Button } from "@/components/ui/button";
import { getStellarConfigIfAvailable } from "@/debug/commands";
import { eventsInTail, recordEvent } from "@/debug/eventTail";
import { redact } from "@/debug/redact";
import { loadChecks } from "@/debug/registry";
import { runAll, runCheck, type CheckRun } from "@/debug/runner";
import type { CheckAction, CheckResult, CheckStatus, FeatureCheck } from "@/debug/types";
import { getAppInfo } from "@/lib/polaris";
import { usePolarisEvents } from "@/panels/events";
import { PanelNote, PanelShell } from "@/panels/PanelShell";
import { cn } from "@/lib/utils";

const STATUS_STYLES: Record<CheckStatus, string> = {
  ok: "border-polaris-ok/40 bg-polaris-ok/15 text-polaris-ok",
  warn: "border-polaris-warn/40 bg-polaris-warn/15 text-polaris-warn",
  fail: "border-polaris-danger/40 bg-polaris-danger/15 text-polaris-danger",
  unknown: "border-polaris-line bg-polaris-panel/60 text-polaris-muted",
};

const STATUS_LABELS: Record<CheckStatus, string> = {
  ok: "OK",
  warn: "WARN",
  fail: "FAIL",
  unknown: "UNKNOWN",
};

/**
 * Status badge: colour **and** text, so the state never depends on colour alone
 * (WCAG 1.4.1) and reads correctly to assistive tech.
 */
function StatusBadge({ status }: { status: CheckStatus }) {
  return (
    <span
      className={cn(
        "rounded-md border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
        STATUS_STYLES[status],
      )}
    >
      {STATUS_LABELS[status]}
    </span>
  );
}

function formatTime(milliseconds: number): string {
  return new Date(milliseconds).toLocaleTimeString();
}

/** A short, redactable summary of one event's payload. */
function summarizeEvent(event: PolarisEvent): string {
  switch (event.type) {
    case "hotkey":
      return event.state;
    case "hotkey_permission":
      return `trusted=${event.trusted}`;
    case "capture_status":
      return `${event.status.state}${event.status.label ? ` (${event.status.label})` : ""}`;
    case "audio_captured":
      return `${event.path} · ${event.durationMs} ms`;
    case "transcript":
      return `${event.final ? "final" : "partial"} · ${event.language ?? "?"} · ${event.text}`;
    case "agent_status":
      return event.stage;
    case "speech_status":
      return event.state;
    case "approval_request":
      return event.summary.title;
    case "approval_result":
      return `${event.approved ? "approved" : "denied"} ${event.payloadHash}`;
    case "tx_submitted":
      return event.hash;
    case "error":
      return event.message;
  }
}

/**
 * Debug panel (step W0b).
 *
 * One place that answers "is each feature working right now?": it runs the
 * registry's non-destructive checks on open, renders their status, and shows the
 * live event tail. Side-effecting self-tests are only ever run by an explicit
 * button. Everything it renders and copies passes through `redact`, so no key or
 * seed can reach the clipboard.
 */
export function DebugPanel() {
  const checks = useMemo<FeatureCheck[]>(() => loadChecks(), []);
  const [runs, setRuns] = useState<Record<string, CheckResult>>({});
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [runningAll, setRunningAll] = useState(false);
  const [events, setEvents] = useState<PolarisEvent[]>(() => [...eventsInTail()]);
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [ownerAddress, setOwnerAddress] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");

  const onEvent = useCallback((event: PolarisEvent) => {
    recordEvent(event);
    setEvents([...eventsInTail()]);
  }, []);
  usePolarisEvents(onEvent);

  useEffect(() => {
    let cancelled = false;
    void getAppInfo()
      .then((info) => {
        if (!cancelled) setAppInfo(info);
      })
      .catch((error: unknown) => {
        if (!cancelled) console.warn("debug could not read app_info", error);
      });
    // The owner command belongs to another milestone; a missing one is fine.
    void getStellarConfigIfAvailable().then((config) => {
      if (!cancelled) setOwnerAddress(config?.ownerAddress ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const applyRuns = useCallback((next: CheckRun[]) => {
    setRuns((previous) => {
      const merged = { ...previous };
      for (const { check, result } of next) merged[check.id] = result;
      return merged;
    });
  }, []);

  const runEverything = useCallback(async () => {
    setRunningAll(true);
    try {
      applyRuns(await runAll(checks));
    } finally {
      setRunningAll(false);
    }
  }, [applyRuns, checks]);

  // Auto-run the non-destructive checks once when the panel opens. Actions are
  // side-effecting and are never run here.
  useEffect(() => {
    void runEverything();
  }, [runEverything]);

  const runOne = useCallback(async (check: FeatureCheck) => {
    setBusy((previous) => new Set(previous).add(check.id));
    try {
      const result = await runCheck(check);
      setRuns((previous) => ({ ...previous, [check.id]: result }));
    } finally {
      setBusy((previous) => {
        const next = new Set(previous);
        next.delete(check.id);
        return next;
      });
    }
  }, []);

  const runAction = useCallback(
    async (check: FeatureCheck, action: CheckAction) => {
      setBusy((previous) => new Set(previous).add(action.id));
      try {
        const result = await action.run();
        setRuns((previous) => ({ ...previous, [check.id]: result }));
      } finally {
        setBusy((previous) => {
          const next = new Set(previous);
          next.delete(action.id);
          return next;
        });
      }
    },
    [],
  );

  const copyReport = useCallback(async () => {
    const report = {
      generatedAt: new Date().toISOString(),
      app: appInfo,
      ownerAddress,
      checks: checks.map((check) => ({
        id: check.id,
        title: check.title,
        milestone: check.milestone,
        result: runs[check.id] ?? null,
      })),
      events: events.slice(-20),
    };
    try {
      await navigator.clipboard.writeText(redact(JSON.stringify(report, null, 2)));
      setCopyState("copied");
    } catch (error: unknown) {
      console.warn("debug could not copy the report", error);
      setCopyState("failed");
    }
  }, [appInfo, checks, events, ownerAddress, runs]);

  const newestFirst = [...events].reverse();

  return (
    <PanelShell title="Debug" subtitle="Live feature checks and the event stream">
      <div className="space-y-5">
        <dl className="flex flex-wrap gap-x-6 gap-y-1 text-xs">
          <div className="flex gap-2">
            <dt className="text-polaris-muted">Version</dt>
            <dd className="selectable">{appInfo?.version ?? "…"}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="text-polaris-muted">Network</dt>
            <dd className="selectable">{appInfo?.network ?? "…"}</dd>
          </div>
          {ownerAddress ? (
            <div className="flex gap-2">
              <dt className="text-polaris-muted">Owner</dt>
              <dd className="selectable break-all font-mono">{ownerAddress}</dd>
            </div>
          ) : null}
        </dl>

        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold">Checks</h2>
          <div className="flex items-center gap-2">
            {copyState === "copied" ? (
              <span className="text-xs text-polaris-ok">Copied</span>
            ) : null}
            {copyState === "failed" ? (
              <span className="text-xs text-polaris-danger">Copy failed</span>
            ) : null}
            <Button variant="outline" size="sm" sound={false} onClick={() => void copyReport()}>
              Copy report
            </Button>
            <Button
              variant="secondary"
              size="sm"
              sound={false}
              disabled={runningAll}
              onClick={() => void runEverything()}
            >
              {runningAll ? "Running…" : "Run all"}
            </Button>
          </div>
        </div>

        <ul className="space-y-2">
          {checks.map((check) => {
            const result = runs[check.id];
            const status: CheckStatus = result?.status ?? "unknown";
            const isBusy = busy.has(check.id);
            return (
              <li
                key={check.id}
                className="space-y-2 rounded-lg border border-polaris-line bg-polaris-panel/40 p-3"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusBadge status={status} />
                      <span className="text-sm font-medium">{check.title}</span>
                      <span className="rounded border border-polaris-line px-1.5 py-0.5 text-[10px] text-polaris-muted">
                        {check.milestone}
                      </span>
                    </div>
                    <p className="break-words text-xs text-polaris-muted">
                      {result?.detail ?? "Not run yet."}
                    </p>
                    {result ? (
                      <p className="text-[10px] text-polaris-muted">
                        Last checked {formatTime(result.checkedAt)}
                      </p>
                    ) : null}
                  </div>
                  <Button
                    variant="secondary"
                    size="sm"
                    sound={false}
                    disabled={isBusy}
                    onClick={() => void runOne(check)}
                  >
                    {isBusy ? "Running…" : "Run"}
                  </Button>
                </div>
                {check.actions && check.actions.length > 0 ? (
                  <div className="flex flex-wrap gap-2 border-t border-polaris-line pt-2">
                    {check.actions.map((action) => (
                      <Button
                        key={action.id}
                        variant="outline"
                        size="sm"
                        sound={false}
                        title={action.description}
                        disabled={busy.has(action.id)}
                        onClick={() => void runAction(check, action)}
                      >
                        {action.label}
                      </Button>
                    ))}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>

        <div className="space-y-2">
          <h2 className="text-sm font-semibold">
            Event tail <span className="text-xs text-polaris-muted">({events.length}/50)</span>
          </h2>
          {newestFirst.length === 0 ? (
            <PanelNote>
              No events yet. Turn on the microphone with Control+Option and the typed
              stream will appear here.
            </PanelNote>
          ) : (
            <ul className="polaris-scroll max-h-64 space-y-1 overflow-y-auto rounded-lg border border-polaris-line bg-polaris-panel/40 p-2 font-mono text-[11px]">
              {newestFirst.map((event, index) => (
                <li key={`${event.type}-${index}`} className="flex gap-2 break-all">
                  <span className="shrink-0 text-polaris-accent">{event.type}</span>
                  <span className="selectable text-polaris-muted">
                    {redact(summarizeEvent(event))}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </PanelShell>
  );
}
