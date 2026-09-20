import { ExplorerLink } from "@/notch/ExplorerLink";

import { ApprovalCard } from "./ApprovalCard.tsx";
import { BatchApprovalCard } from "./BatchApprovalCard.tsx";
import { resultLine, resultTone } from "./overlayModel.ts";
import type { PendingApproval } from "./usePendingApproval.ts";

/** The short, single-line result shown for a moment after a decision. */
function ResultView({
  message,
  tone,
  txHash,
}: {
  message: string;
  tone: "ok" | "danger" | null;
  txHash: string | null;
}) {
  const ok = tone === "ok";
  return (
    <div
      role="status"
      aria-live="polite"
      className={`flex flex-col items-center gap-1 text-center text-lg font-semibold ${
        ok ? "text-polaris-ok" : "text-polaris-danger"
      }`}
    >
      <p>{ok ? `${message} ✓` : message}</p>
      {ok && txHash ? <ExplorerLink target={txHash} kind="tx" /> : null}
    </div>
  );
}

/**
 * The approval surface inside the notch (task W15g): while the gate has a
 * request — or a just-decided result — this renders over the panel body. The
 * notch is forced to its pinned `panel` state by `ShellSurface`, so this is the
 * only place an approval is ever shown; there is no separate window.
 */
export function ApprovalOverlay({ approval }: { approval: PendingApproval }) {
  const { state, visible, canApprove, remainingMs, txHash, onApprove, onDeny } = approval;
  if (!visible) return null;

  const message = resultLine(state);
  const snapshot = state.snapshot;

  return (
    <div className="approval-overlay polaris-scroll">
      <div className="m-auto w-full max-w-md">
        {message !== null ? (
          <ResultView message={message} tone={resultTone(state)} txHash={txHash} />
        ) : snapshot === null ? null : snapshot.batch !== undefined ? (
          <BatchApprovalCard
            stage={state.stage}
            snapshot={snapshot}
            remainingMs={remainingMs}
            hint={state.hint}
            canApprove={canApprove}
            onApprove={onApprove}
            onDeny={onDeny}
          />
        ) : (
          <ApprovalCard
            stage={state.stage}
            snapshot={snapshot}
            remainingMs={remainingMs}
            hint={state.hint}
            canApprove={canApprove}
            onApprove={onApprove}
            onDeny={onDeny}
          />
        )}
      </div>
    </div>
  );
}
