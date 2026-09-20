import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import type { ApprovalMode, ApprovalSnapshot } from "../../lib/approval.ts";
import { HashFingerprint } from "./HashFingerprint.tsx";
import { APPROVAL_TTL_MS, type OverlayStage } from "./overlayModel.ts";

/** The mode's short, non-technical label. */
const MODE_LABEL: Record<ApprovalMode, string> = {
  touch_id: "Touch ID required",
  wallet_only: "Wallet signature required",
};

/** First 4 + last 4 characters of an address, so a wrong recipient stands out. */
function shortAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 4)}…${address.slice(-4)}` : address;
}

/** The recipient's name and/or short address, or `null` when there is neither. */
function recipientLabel(intent: ApprovalSnapshot["intent"]): string | null {
  const name = intent.alias;
  const address = intent.recipient;
  if (name !== undefined && name.length > 0 && address !== undefined && address.length > 0) {
    return `${name} · ${shortAddress(address)}`;
  }
  if (name !== undefined && name.length > 0) return name;
  if (address !== undefined && address.length > 0) return shortAddress(address);
  return null;
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-3">
      <dt className="w-14 shrink-0 text-[10px] uppercase tracking-wide text-notch-muted">{label}</dt>
      <dd className="selectable break-all font-mono text-[11.5px] text-notch-text">{value}</dd>
    </div>
  );
}

export interface ApprovalCardProps {
  stage: OverlayStage;
  snapshot: ApprovalSnapshot;
  remainingMs: number | null;
  hint: string | null;
  canApprove: boolean;
  onApprove: () => void;
  onDeny: () => void;
}

/**
 * The in-notch single-transaction card. It owns no policy — whether Approve is
 * live comes from the pure overlay state — and it shows the essential lines
 * first, with the full address and payload hash behind a "Details" toggle.
 */
export function ApprovalCard({
  stage,
  snapshot,
  remainingMs,
  hint,
  canApprove,
  onApprove,
  onDeny,
}: ApprovalCardProps) {
  const [showDetails, setShowDetails] = useState(false);
  const denyRef = useRef<HTMLDivElement>(null);
  const deciding = stage === "pending" || stage === "authorizing";

  // Focus the safe choice by default: a stray Enter can only deny. The ref is on
  // the wrapper because the shared `Button` does not forward a ref.
  useEffect(() => {
    if (stage === "pending") denyRef.current?.querySelector("button")?.focus();
  }, [stage]);

  // Esc is a keyboard deny. Approving still needs an explicit click.
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

  const { intent, summary } = snapshot;
  const amount =
    intent.amount !== "" && intent.amount !== "0" && intent.asset !== ""
      ? `${intent.amount} ${intent.asset}`
      : null;
  const recipient = recipientLabel(intent);
  const pct =
    remainingMs === null
      ? 0
      : Math.max(0, Math.min(100, (remainingMs / APPROVAL_TTL_MS) * 100));

  return (
    <div
      role="group"
      aria-label="Transaction approval"
      className="rule-card space-y-3"
    >
      {deciding && remainingMs !== null ? (
        <div className="wallet-budget-bar" aria-hidden="true">
          <span
            className="transition-[width] duration-1000 ease-linear"
            style={{ width: `${pct}%` }}
          />
        </div>
      ) : null}

      <div>
        <p className="text-sm font-semibold leading-tight">{summary.title}</p>
        <p className="mt-0.5 text-[11px] text-notch-muted">{MODE_LABEL[snapshot.mode]}</p>
      </div>

      <dl className="space-y-1.5 text-sm">
        {amount !== null ? <Row label="Amount" value={amount} /> : null}
        {recipient !== null ? <Row label="To" value={recipient} /> : null}
        {summary.estimatedFee !== "" ? <Row label="Fee" value={summary.estimatedFee} /> : null}
      </dl>

      {showDetails ? (
        <div className="space-y-2 rounded-lg bg-black/40 p-2">
          {intent.recipient !== undefined && intent.recipient.length > 0 ? (
            <div>
              <p className="text-[10px] uppercase tracking-wide text-notch-muted">
                Full address
              </p>
              <p className="selectable break-all font-mono text-[11px] text-notch-text">
                {intent.recipient}
              </p>
            </div>
          ) : null}
          <div>
            <p className="text-[10px] uppercase tracking-wide text-notch-muted">Payload hash</p>
            <HashFingerprint hash={snapshot.payloadHash} />
          </div>
        </div>
      ) : null}

      <button
        type="button"
        onClick={() => setShowDetails((open) => !open)}
        className="text-[11px] text-notch-muted transition-colors hover:text-notch-text"
      >
        {showDetails ? "Hide details" : "Details"}
      </button>

      {hint !== null ? (
        <p className="rounded-lg bg-black/40 px-2 py-1 text-[11px] text-notch-muted">
          {hint}
        </p>
      ) : null}

      <div className="flex gap-2">
        <Button
          variant="notch"
          size="md"
          className="flex-1"
          disabled={!canApprove}
          aria-busy={stage === "authorizing"}
          onClick={onApprove}
        >
          {stage === "authorizing" ? "Waiting for Touch ID…" : "Approve with Touch ID"}
        </Button>
        <div ref={denyRef} className="flex-1">
          <Button variant="notchOutline" size="md" className="w-full" disabled={!deciding} onClick={onDeny}>
            Deny
          </Button>
        </div>
      </div>
    </div>
  );
}
