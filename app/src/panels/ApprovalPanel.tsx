import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import type { PolarisEvent } from "@polaris/interfaces";

import { createApprovalCommands, toApprovalError, type ApprovalCommands } from "@/lib/approval";
import {
  canApprove,
  currentSnapshot,
  initialApprovalState,
  reduceApproval,
  remainingMs,
  type ApprovalFlowState,
} from "@/panels/approval/approvalFlow";
import { ApprovalCard } from "@/panels/approval/ApprovalCard";
import { createDemoCommands } from "@/panels/approval/demo";
import { usePolarisEvents } from "@/panels/events";
import { parseApprovalDemo } from "@/panels/panelRoutes";
import { PanelShell } from "@/panels/PanelShell";
import { playSfx } from "@/lib/sfx";

/** The card's live error, if the current stage is `error`. */
function errorOf(state: ApprovalFlowState) {
  return state.stage === "error" ? state.error : null;
}

/** The non-alarming hint attached to the current stage, if any. */
function hintOf(state: ApprovalFlowState): string | null {
  return state.stage === "pending" ? state.hint : null;
}

/**
 * Approval card window.
 *
 * The Rust gate (W3) owns the pending-approval store and Touch ID; this panel is
 * its typed webview face. Because the window can open *after* `approval_request`
 * was emitted, it hydrates from `approval_current()` on mount and re-reads on
 * every `approval_request` / `approval_result` event, rather than trusting a
 * single event it may have missed. Demo mode (`#/approval?demo=…`) swaps in
 * fixture commands and shows a mandatory banner; real mode never uses a fixture.
 */
export function ApprovalPanel() {
  const demo = useMemo(() => parseApprovalDemo(window.location.hash), []);
  const commands: ApprovalCommands = useMemo(
    () => (demo === null ? createApprovalCommands() : createDemoCommands(demo)),
    [demo],
  );

  const [state, dispatch] = useReducer(reduceApproval, undefined, initialApprovalState);
  // Readable from the async callbacks below without re-subscribing them.
  const stateRef = useRef(state);
  stateRef.current = state;

  const refresh = useCallback(() => {
    commands
      .current()
      .then((snapshot) => dispatch({ type: "snapshot", snapshot, nowMs: Date.now() }))
      .catch((error: unknown) => dispatch({ type: "snapshotFailed", error: toApprovalError(error) }));
  }, [commands]);

  // Subscribe first, then read the snapshot, so a request that lands between the
  // two is not missed (the same ordering the notch overlay uses).
  useEffect(() => {
    refresh();
  }, [refresh]);

  const onEvent = useCallback(
    (event: PolarisEvent) => {
      if (event.type === "approval_request") {
        refresh();
      } else if (event.type === "approval_result") {
        // Apply the result for the request we are showing, then re-read to
        // reconcile against the store (and ignore a different payloadHash).
        dispatch({ type: "result", payloadHash: event.payloadHash, approved: event.approved });
        refresh();
      }
    },
    [refresh],
  );
  usePolarisEvents(onEvent);

  // The countdown is the only timer; it runs while the request is still live.
  useEffect(() => {
    if (state.stage !== "pending" && state.stage !== "authorizing") return;
    const timer = setInterval(() => dispatch({ type: "tick", nowMs: Date.now() }), 1_000);
    return () => clearInterval(timer);
  }, [state.stage]);

  const onApprove = useCallback(() => {
    const current = stateRef.current;
    if (!canApprove(current)) return;
    const snapshot = currentSnapshot(current);
    if (snapshot === null) return;
    dispatch({ type: "approveClicked" });
    commands
      .authorize(snapshot.id)
      .then((next) => {
        playSfx("success");
        dispatch({ type: "authorizeOk", snapshot: next });
      })
      .catch((error: unknown) => {
        playSfx("error");
        const failure = toApprovalError(error);
        dispatch({ type: "authorizeFailed", kind: failure.kind, message: failure.message });
      });
  }, [commands]);

  const onDeny = useCallback(() => {
    const current = stateRef.current;
    const snapshot = currentSnapshot(current);
    if (snapshot === null) return;
    if (current.stage !== "pending" && current.stage !== "authorizing") return;
    dispatch({ type: "denyClicked" });
    commands
      .deny(snapshot.id)
      .then((next) => {
        playSfx("error");
        dispatch({ type: "snapshot", snapshot: next, nowMs: Date.now() });
      })
      .catch(() => {
        playSfx("error");
        refresh();
      });
  }, [commands, refresh]);

  return (
    <PanelShell
      title="Approve transaction"
      subtitle="Review the exact transaction before it is signed"
    >
      <ApprovalCard
        stage={state.stage}
        snapshot={currentSnapshot(state)}
        remainingMs={remainingMs(state)}
        hint={hintOf(state)}
        error={errorOf(state)}
        canApprove={canApprove(state)}
        demo={demo !== null}
        onApprove={onApprove}
        onDeny={onDeny}
      />
    </PanelShell>
  );
}
