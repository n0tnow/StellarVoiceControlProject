/**
 * Diagnostics section — the in-app feature checks, on demand (task W15d).
 *
 * A click runs the Debug registry's checks (`runAll`) and lists one line per
 * feature with a pass / fail / needs-a-human status. The runner already routes
 * every detail through `redact`, so no key can reach the screen. Checks are
 * non-destructive; side-effecting self-tests stay in the Debug panel.
 */
import { useCallback, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { loadChecks } from "@/debug/registry";
import { runAll } from "@/debug/runner";
import type { CheckResult, CheckStatus } from "@/debug/types";
import { cn } from "@/lib/utils";

import { DOT, HINT } from "./ui";

const STATUS_META: Record<CheckStatus, { label: string; dot: string }> = {
  ok: { label: "Pass", dot: "bg-polaris-ok" },
  warn: { label: "Needs a human", dot: "bg-polaris-warn" },
  fail: { label: "Fail", dot: "bg-polaris-danger" },
  unknown: { label: "Not run", dot: "bg-polaris-muted" },
};

export function DiagnosticsSection() {
  const checks = useMemo(() => loadChecks(), []);
  const [runs, setRuns] = useState<Record<string, CheckResult>>({});
  const [running, setRunning] = useState(false);

  const runEverything = useCallback(async () => {
    setRunning(true);
    try {
      const results = await runAll(checks);
      const next: Record<string, CheckResult> = {};
      for (const { check, result } of results) next[check.id] = result;
      setRuns(next);
    } finally {
      setRunning(false);
    }
  }, [checks]);

  const hasRun = Object.keys(runs).length > 0;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <p className={HINT}>
          {hasRun ? `${checks.length} features checked` : "Check every feature from inside the app."}
        </p>
        <Button size="sm" disabled={running} onClick={() => void runEverything()}>
          {running ? "Running…" : "Run all checks"}
        </Button>
      </div>

      {hasRun ? (
        <ul className="space-y-2">
          {checks.map((check) => {
            const result = runs[check.id];
            const status: CheckStatus = result?.status ?? "unknown";
            const meta = STATUS_META[status];
            return (
              <li
                key={check.id}
                className="flex items-start gap-2 border-b border-white/5 pb-2 last:border-0 last:pb-0"
              >
                <span className={cn(DOT, meta.dot)} aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate text-xs font-medium">{check.title}</p>
                    <span className="shrink-0 text-[10px] uppercase tracking-wide text-polaris-muted">
                      {meta.label}
                    </span>
                  </div>
                  <p className={cn(HINT, "break-words")}>{result?.detail ?? "Not run."}</p>
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
