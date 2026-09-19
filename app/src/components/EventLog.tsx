import { useEffect, useRef } from "react";

import { cn } from "@/lib/utils";
import type { LogLine, LogTone } from "@/lib/polaris";

const toneClass: Record<LogTone, string> = {
  neutral: "text-polaris-text",
  accent: "text-polaris-accent",
  ok: "text-polaris-ok",
  warn: "text-polaris-warn",
  danger: "text-polaris-danger",
};

const toneDot: Record<LogTone, string> = {
  neutral: "bg-polaris-muted",
  accent: "bg-polaris-accent",
  ok: "bg-polaris-ok",
  warn: "bg-polaris-warn",
  danger: "bg-polaris-danger",
};

/**
 * The harness log pane (step A0). Every later step is demoed through this pane:
 * transcripts, tool calls, approval requests and errors all land here as
 * `PolarisEvent`s, so a missing line is immediately visible.
 */
export function EventLog({ lines }: { lines: LogLine[] }) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [lines.length]);

  if (lines.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center p-8 text-sm text-polaris-muted">
        No events yet — press “Run self-test” to exercise the Rust → UI event stream.
      </div>
    );
  }

  return (
    <div className="polaris-scroll selectable flex-1 overflow-y-auto font-mono text-xs leading-relaxed">
      {lines.map((line) => (
        <div
          key={line.id}
          className="flex gap-3 border-b border-polaris-line/40 px-4 py-2 last:border-b-0"
        >
          <span className="shrink-0 text-polaris-muted/70">{line.at}</span>
          <span className={cn("mt-1.5 size-1.5 shrink-0 rounded-full", toneDot[line.tone])} />
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2">
              <span className={cn("font-medium", toneClass[line.tone])}>{line.title}</span>
              <span className="text-[10px] tracking-wide text-polaris-muted/60 uppercase">
                {line.origin}
              </span>
            </div>
            {line.detail ? (
              <pre className="mt-1 whitespace-pre-wrap break-words text-polaris-muted">
                {line.detail}
              </pre>
            ) : null}
          </div>
        </div>
      ))}
      <div ref={bottomRef} />
    </div>
  );
}