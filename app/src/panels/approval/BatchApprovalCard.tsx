import { useEffect, useRef } from "react";

import { Button } from "@/components/ui/button";
import type { ApprovalBatchSnapshot, ApprovalError } from "../../lib/approval.ts";
import { EXPIRED_MESSAGE, type ApprovalStage } from "./approvalFlow.ts";

/** `1:05` for a minute or more, otherwise `9s`. */
function formatRemaining(ms: number): string {
  const total = Math.ceil(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes > 0 ? `${minutes}:${String(seconds).padStart(2, "0")}` : `${seconds}s`;
}

export interface BatchApprovalCardProps {
  stage: ApprovalStage;
  batch: ApprovalBatchSnapshot;
  remainingMs: number | null;
  hint: string | null;
  error: ApprovalError | null;
  canApprove: boolean;
  demo: boolean;
  onApprove: () => void;
  onDeny: () => void;
}

/**
 * Presentation-only batch approval card. It lists the owner transactions of one
 * auto-pay setup and gates them behind ONE "Approve with Touch ID". It owns no
 * policy: the stage, the countdown and whether Approve is live come from
 * `approvalFlow.ts`, exactly like the single-item card.
 */
export function BatchApprovalCard({
  stage,
  batch,
  remainingMs,
  hint,
  error,
  canApprove,
  demo,
  onApprove,
  onDeny,
}: BatchApprovalCardProps) {
  const denyRef = useRef<HTMLDivElement>(null);
  const decided = stage === "pending" || stage === "authorizing";

  useEffect(() => {
    if (stage === "pending") denyRef.current?.querySelector("button")?.focus();
  }, [stage]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && decided) {
        event.preventDefault();
        onDeny();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [decided, onDeny]);

  const message = (() => {
    switch (stage) {
      case "authorizing":
        return "Waiting for Touch ID…";
      case "authorized":
        return "Approved — signing every step";
      case "denied":
        return "Denied";
      case "expired":
        return EXPIRED_MESSAGE;
      case "error":
        return error?.message ?? "Approval failed";
      default:
        return null;
    }
  })();

  return (
    <div role="group" aria-label="Batch approval" className="space-y-4">
      {demo ? (
        <p
          role="note"
          className="rounded-md border border-polaris-warn/60 bg-polaris-warn/10 px-3 py-2 text-center text-xs font-semibold tracking-wide text-polaris-warn"
        >
          DEMO — nothing is signed
        </p>
      ) : null}

      <div className="space-y-3 rounded-lg border border-polaris-line bg-polaris-panel/60 p-3">
        <div className="flex items-baseline justify-between gap-2">
          <p className="text-lg font-semibold leading-tight">{batch.title}</p>
          <span className="shrink-0 text-xs text-polaris-muted">{batch.count} steps · 1 approval</span>
        </div>
        <ol className="space-y-2">
          {batch.steps.map((step) => (
            <li key={step.index} className="flex gap-3 text-sm">
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-polaris-panel-alt text-[11px] font-semibold text-polaris-text">
                {step.index}
              </span>
              <span>
                <span className="font-medium text-polaris-text">{step.title}</span>
                {step.detail ? (
                  <span className="block text-xs text-polaris-muted">{step.detail}</span>
                ) : null}
              </span>
            </li>
          ))}
        </ol>
      </div>

      {remainingMs !== null && stage !== "expired" ? (
        <p className="text-xs text-polaris-muted" aria-live="off">
          Expires in <span className="font-mono text-polaris-text">{formatRemaining(remainingMs)}</span>
        </p>
      ) : null}

      {hint ? (
        <p className="rounded-md border border-polaris-line bg-polaris-panel-alt/60 px-3 py-2 text-xs text-polaris-muted">
          {hint}
        </p>
      ) : null}

      <p
        role={stage === "error" ? "alert" : "status"}
        aria-live="polite"
        className={
          stage === "authorized"
            ? "text-sm text-polaris-ok"
            : stage === "error"
              ? "text-sm text-polaris-danger"
              : "text-sm text-polaris-text"
        }
      >
        {message ?? ""}
      </p>

      <div className="flex gap-2">
        <Button
          variant="secondary"
          size="md"
          className="flex-1"
          disabled={!canApprove}
          aria-busy={stage === "authorizing"}
          onClick={onApprove}
        >
          {stage === "authorizing" ? "Waiting for Touch ID…" : "Approve all with Touch ID"}
        </Button>
        <div ref={denyRef} className="flex-1">
          <Button
            variant="outline"
            size="md"
            className="w-full"
            disabled={!decided}
            onClick={onDeny}
          >
            Deny
          </Button>
        </div>
      </div>
    </div>
  );
}
