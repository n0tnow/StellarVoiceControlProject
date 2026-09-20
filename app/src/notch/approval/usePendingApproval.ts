/**
 * The notch's live view of the Rust approval gate (task W15g).
 *
 * The approval card no longer gets its own window, so this hook is what makes
 * the notch the only surface: it hydrates from `approval_current()` on mount,
 * re-reads on every `approval_request` / `approval_result` event, and exposes the
 * pure overlay state ([`overlayModel`]) plus the two decisions the card can make.
 *
 * The wait for a decision still belongs to `@/lib/approver`; this hook only
 * renders the pending request and drives the same gate commands the card always
 * did. It never sees an XDR and never decides anything: a result is whatever the
 * gate reports.
 */
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { PolarisEvent } from "@polaris/interfaces";

import {
  createApprovalCommands,
  toApprovalError,
  type ApprovalCommands,
} from "../../lib/approval.ts";
import {
  RESULT_DWELL_MS,
  canApprove,
  initialOverlayState,
  isResultStage,
  isVisible,
  reduceOverlay,
  remainingMs,
  type OverlayState,
} from "./overlayModel.ts";
import { usePolarisEvents } from "./usePolarisEvents.ts";

/** Everything `ApprovalOverlay` needs to render and to decide. */
export interface PendingApproval {
  readonly state: OverlayState;
  /** True while the overlay should be shown (a request, or a result dwell). */
  readonly visible: boolean;
  readonly canApprove: boolean;
  readonly remainingMs: number | null;
  /** The tx hash of the most recent `tx_submitted`, for the result link. */
  readonly txHash: string | null;
  readonly onApprove: () => void;
  readonly onDeny: () => void;
}

export function usePendingApproval(): PendingApproval {
  const commands = useMemo<ApprovalCommands>(() => createApprovalCommands(), []);
  const [state, dispatch] = useReducer(reduceOverlay, undefined, initialOverlayState);
  // The submitted tx hash arrives on its own event, a moment after the approval
  // is authorised; the result view links to it when it is there.
  const [txHash, setTxHash] = useState<string | null>(null);
  // Readable from the async callbacks below without re-subscribing them.
  const stateRef = useRef(state);
  stateRef.current = state;

  const refresh = useCallback(() => {
    commands
      .current()
      .then((snapshot) => dispatch({ type: "snapshot", snapshot, nowMs: Date.now() }))
      .catch((error: unknown) =>
        dispatch({ type: "snapshotFailed", error: toApprovalError(error) }),
      );
  }, [commands]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const onEvent = useCallback(
    (event: PolarisEvent) => {
      if (event.type === "approval_request") {
        // A fresh request starts clean: the previous result's hash is not its own.
        setTxHash(null);
        refresh();
      } else if (event.type === "approval_result") {
        // Apply the result for the request we are showing, then re-read to
        // reconcile against the store (a batch reconciles here only).
        dispatch({ type: "result", payloadHash: event.payloadHash, approved: event.approved });
        refresh();
      } else if (event.type === "tx_submitted") {
        setTxHash(event.hash);
      }
    },
    [refresh],
  );
  usePolarisEvents(onEvent);

  // The countdown is the only timer while the request is still live.
  useEffect(() => {
    if (state.stage !== "pending" && state.stage !== "authorizing") return;
    const timer = setInterval(() => dispatch({ type: "tick", nowMs: Date.now() }), 1_000);
    return () => clearInterval(timer);
  }, [state.stage]);

  // A terminal result clears itself after a short dwell. A new request arriving
  // in the meantime changes the stage and cancels this timer.
  useEffect(() => {
    if (!isResultStage(state.stage)) return;
    const timer = setTimeout(() => {
      dispatch({ type: "dismiss" });
      setTxHash(null);
    }, RESULT_DWELL_MS);
    return () => clearTimeout(timer);
  }, [state.stage]);

  const onApprove = useCallback(() => {
    const current = stateRef.current;
    if (!canApprove(current)) return;
    const snapshot = current.snapshot;
    if (snapshot === null) return;
    dispatch({ type: "approveClicked" });
    // A batch is authorised with ONE Touch ID; the single-item path is unchanged.
    const authorize =
      snapshot.batch !== undefined && commands.authorizeBatch !== undefined
        ? () => commands.authorizeBatch!(snapshot.id)
        : () => commands.authorize(snapshot.id);
    // The command's own snapshot is not used: a batch returns step ids, not a
    // snapshot, so the authoritative state is re-read from the gate instead.
    authorize()
      .then(() => {
        dispatch({ type: "authorizeOk" });
        refresh();
      })
      .catch((error: unknown) => {
        const failure = toApprovalError(error);
        dispatch({ type: "authorizeFailed", kind: failure.kind, message: failure.message });
      });
  }, [commands, refresh]);

  const onDeny = useCallback(() => {
    const current = stateRef.current;
    const snapshot = current.snapshot;
    if (snapshot === null) return;
    if (current.stage !== "pending" && current.stage !== "authorizing") return;
    dispatch({ type: "denyClicked" });
    // Denying any step of a batch denies the whole batch in the gate.
    const stepId = snapshot.batch?.steps[0]?.id;
    const id = stepId !== undefined && stepId.length > 0 ? stepId : snapshot.id;
    commands
      .deny(id)
      .then((next) => dispatch({ type: "snapshot", snapshot: next, nowMs: Date.now() }))
      .catch(() => refresh());
  }, [commands, refresh]);

  return {
    state,
    visible: isVisible(state),
    canApprove: canApprove(state),
    remainingMs: remainingMs(state),
    txHash,
    onApprove,
    onDeny,
  };
}
