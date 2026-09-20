import { ApprovalCard } from "./ApprovalCard.tsx";
import { BatchApprovalCard } from "./BatchApprovalCard.tsx";
import { resultLine, resultTone } from "./overlayModel.ts";
import type { PendingApproval } from "./usePendingApproval.ts";

/** The short, single-line result shown for a moment after a decision. */
function ResultView({ message, tone }: { message: string; tone: "ok" | "danger" | null }) {
  const ok = tone === "ok";
  return (
    <p
      role="status"
      aria-live="polite"
      className={`text-center text-lg font-semibold ${
        ok ? "text-polaris-ok" : "text-polaris-danger"
      }`}
    >
      {ok ? `${message} ✓` : message}
    </p>
  );
}

/**
 * The approval surface inside the notch (task W15g): while the gate has a
 * request — or a just-decided result — this renders over the panel body. The
 * notch is forced to its pinned `panel` state by `ShellSurface`, so this is the
 * only place an approval is ever shown; there is no separate window.
 */
export function ApprovalOverlay({ approval }: { approval: PendingApproval }) {
  const { state, visible, canApprove, remainingMs, onApprove, onDeny } = approval;
  if (!visible) return null;

  const message = resultLine(state);
  const snapshot = state.snapshot;

  return (
    <div className="absolute inset-0 z-20 flex overflow-y-auto bg-black/60 px-4 py-3 backdrop-blur-sm">
      <div className="m-auto w-full max-w-md">
        {message !== null ? (
          <ResultView message={message} tone={resultTone(state)} />
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
