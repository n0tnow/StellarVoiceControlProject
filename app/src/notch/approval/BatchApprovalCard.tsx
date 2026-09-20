import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import type { ApprovalSnapshot } from "../../lib/approval.ts";
import { APPROVAL_TTL_MS, type OverlayStage } from "./overlayModel.ts";

export interface BatchApprovalCardProps {
  stage: OverlayStage;
  snapshot: ApprovalSnapshot;
  remainingMs: number | null;
  hint: string | null;
  canApprove: boolean;
  onApprove: () => void;
  onDeny: () => void;
}

/**
 * The in-notch batch card: several owner transactions authorised by ONE Touch
 * ID. It lists the numbered steps and gates them behind a single approve, like
 * the single card. It owns no policy.
 */
export function BatchApprovalCard({
  stage,
  snapshot,
  remainingMs,
  hint,
  canApprove,
  onApprove,
  onDeny,
}: BatchApprovalCardProps) {
  const [showDetails, setShowDetails] = useState(false);
  const denyRef = useRef<HTMLDivElement>(null);
  const deciding = stage === "pending" || stage === "authorizing";
  const batch = snapshot.batch;

  useEffect(() => {
    if (stage === "pending") denyRef.current?.querySelector("button")?.focus();
  }, [stage]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && deciding) {
        event.preventDefault();
        onDeny();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [deciding, onDeny]);

  if (batch === undefined) return null;
  const pct =
    remainingMs === null
      ? 0
      : Math.max(0, Math.min(100, (remainingMs / APPROVAL_TTL_MS) * 100));

  return (
    <div
      role="group"
      aria-label="Batch approval"
      className="space-y-3 rounded-xl border border-polaris-line bg-polaris-panel p-4 shadow-2xl"
    >
      {deciding && remainingMs !== null ? (
        <div className="h-1 overflow-hidden rounded-full bg-white/10" aria-hidden="true">
          <div
            className="h-full bg-polaris-accent transition-[width] duration-1000 ease-linear"
            style={{ width: `${pct}%` }}
          />
        </div>
      ) : null}

      <div className="flex items-baseline justify-between gap-2">
        <p className="text-base font-semibold leading-tight">{snapshot.summary.title}</p>
        <span className="shrink-0 text-[11px] text-polaris-muted">
          {batch.count} steps · 1 approval
        </span>
      </div>

      <ol className="space-y-2">
        {batch.steps.map((step, index) => (
          <li key={`${index}-${step.title}`} className="flex gap-3 text-sm">
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-white/10 text-[11px] font-semibold text-polaris-text">
              {index + 1}
            </span>
            <span className="font-medium text-polaris-text">{step.title}</span>
          </li>
        ))}
      </ol>

      {showDetails ? (
        <div className="rounded-md border border-polaris-line bg-black/20 p-2">
          <p className="text-[10px] uppercase tracking-wide text-polaris-muted">Approval id</p>
          <p className="selectable break-all font-mono text-[11px] text-polaris-text">
            {snapshot.id}
          </p>
        </div>
      ) : null}

      <button
        type="button"
        onClick={() => setShowDetails((open) => !open)}
        className="text-[11px] text-polaris-muted transition-colors hover:text-polaris-text"
      >
        {showDetails ? "Hide details" : "Details"}
      </button>

      {hint !== null ? (
        <p className="rounded-md border border-polaris-line bg-black/20 px-2 py-1 text-[11px] text-polaris-muted">
          {hint}
        </p>
      ) : null}

      <div className="flex gap-2">
        <Button
          variant="default"
          size="md"
          className="flex-1"
          disabled={!canApprove}
          aria-busy={stage === "authorizing"}
          onClick={onApprove}
        >
          {stage === "authorizing" ? "Waiting for Touch ID…" : "Approve all with Touch ID"}
        </Button>
        <div ref={denyRef} className="flex-1">
          <Button variant="outline" size="md" className="w-full" disabled={!deciding} onClick={onDeny}>
            Deny
          </Button>
        </div>
      </div>
    </div>
  );
}
