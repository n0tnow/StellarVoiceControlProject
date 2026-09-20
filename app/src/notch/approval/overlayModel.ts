/**
 * Pure state machine for the in-notch approval overlay (task W15g).
 *
 * The approval card used to live in its own window; it now renders inside the
 * notch, so this module owns the one question the overlay has to answer: when is
 * a pending request shown, when may Approve fire, and when does the card clear
 * itself after a decision. Keeping that decision here — out of React — makes it
 * fully unit-testable (`overlayModel.test.ts`) and keeps the view from inventing
 * its own notion of "still pending".
 *
 * Stages: `hidden -> pending -> authorizing -> sent | denied | expired | failed`.
 * A terminal stage is a short one-line result that the overlay clears from after
 * [`RESULT_DWELL_MS`]. Every transition is fail-closed: only `pending` admits an
 * approve click, and a snapshot state this machine does not recognise lands in
 * `failed`, where Approve is disabled.
 */
import type {
  ApprovalError,
  ApprovalErrorKind,
  ApprovalSnapshot,
} from "../../lib/approval.ts";

/** Mirrors the Rust `APPROVAL_TTL` (120 s); scales the countdown bar. */
export const APPROVAL_TTL_MS = 120_000;

/** How long the one-line result stays up before the overlay clears itself. */
export const RESULT_DWELL_MS = 2_000;

/** Shown when the user dismisses the Touch ID prompt without deciding. */
export const CANCELLED_HINT = "Touch ID cancelled — you can try again";

/** Shown when the request's `expiresAtMs` has passed. */
export const EXPIRED_MESSAGE = "This request expired — ask again by voice";

/** The stages the overlay renders. */
export type OverlayStage =
  | "hidden"
  | "pending"
  | "authorizing"
  | "sent"
  | "denied"
  | "expired"
  | "failed";

/** The whole overlay state. `snapshot` is null only while `hidden`. */
export interface OverlayState {
  readonly stage: OverlayStage;
  readonly snapshot: ApprovalSnapshot | null;
  readonly nowMs: number;
  readonly hint: string | null;
  readonly error: ApprovalError | null;
}

/** Every way the overlay can be driven. `nowMs` is always injected. */
export type OverlayAction =
  | {
      readonly type: "snapshot";
      readonly snapshot: ApprovalSnapshot | null;
      readonly nowMs: number;
    }
  | { readonly type: "snapshotFailed"; readonly error: ApprovalError }
  | { readonly type: "approveClicked" }
  | { readonly type: "denyClicked" }
  | { readonly type: "authorizeOk" }
  | {
      readonly type: "authorizeFailed";
      readonly kind: ApprovalErrorKind;
      readonly message?: string;
    }
  | { readonly type: "tick"; readonly nowMs: number }
  | { readonly type: "result"; readonly payloadHash: string; readonly approved: boolean }
  | { readonly type: "dismiss" };

const HIDDEN: OverlayState = {
  stage: "hidden",
  snapshot: null,
  nowMs: 0,
  hint: null,
  error: null,
};

/** The overlay opens hidden until `approval_current()` answers. */
export function initialOverlayState(): OverlayState {
  return HIDDEN;
}

/** Maps a snapshot's own state onto a terminal stage. */
function terminalStageOf(snapshot: ApprovalSnapshot): OverlayStage {
  switch (snapshot.state) {
    case "authorized":
    case "consumed":
      return "sent";
    case "denied":
      return "denied";
    case "expired":
      return "expired";
    default:
      return "failed";
  }
}

/** Hydrates the overlay from a gate snapshot (or hides it when there is none). */
function fromSnapshot(snapshot: ApprovalSnapshot | null, nowMs: number): OverlayState {
  if (snapshot === null) return HIDDEN;
  if (snapshot.state === "pending") {
    return nowMs >= snapshot.expiresAtMs
      ? { stage: "expired", snapshot, nowMs, hint: null, error: null }
      : { stage: "pending", snapshot, nowMs, hint: null, error: null };
  }
  return { stage: terminalStageOf(snapshot), snapshot, nowMs, hint: null, error: null };
}

/** Default copy for a failure kind, when Rust sent no message. */
function messageFor(kind: ApprovalErrorKind, message: string | undefined): string {
  if (message !== undefined && message.length > 0) return message;
  switch (kind) {
    case "unavailable":
      return "Touch ID is unavailable on this device";
    case "timeout":
      return "Touch ID timed out — try again";
    case "expired":
      return EXPIRED_MESSAGE;
    case "notPending":
      return "This request is no longer waiting for approval";
    default:
      return "Approval failed";
  }
}

/** The single reducer behind the overlay. */
export function reduceOverlay(state: OverlayState, action: OverlayAction): OverlayState {
  switch (action.type) {
    case "snapshot":
      // A null snapshot means the gate has nothing live. That clears a pending
      // request, but must never wipe a just-shown result before its dwell ends.
      if (action.snapshot === null) return isResultStage(state.stage) ? state : HIDDEN;
      return fromSnapshot(action.snapshot, action.nowMs);

    case "snapshotFailed":
      // A failed hydration with no request on screen stays hidden; a failure
      // while a request is live surfaces as a fail-closed result.
      return state.stage === "hidden"
        ? HIDDEN
        : { ...state, stage: "failed", error: action.error };

    case "approveClicked":
      if (state.stage !== "pending" || state.snapshot === null) return state;
      if (state.nowMs >= state.snapshot.expiresAtMs) {
        return { ...state, stage: "expired", hint: null };
      }
      return { ...state, stage: "authorizing", hint: null };

    case "denyClicked":
      // Deny is the safe action, so it stays available while authorizing too.
      if (state.stage !== "pending" && state.stage !== "authorizing") return state;
      return { ...state, stage: "denied", hint: null };

    case "authorizeOk":
      return state.snapshot === null ? state : { ...state, stage: "sent", hint: null };

    case "authorizeFailed": {
      // A stale failure from a superseded attempt must not move the overlay.
      if (state.stage !== "authorizing" || state.snapshot === null) return state;
      if (action.kind === "cancelled") {
        if (state.nowMs >= state.snapshot.expiresAtMs) return { ...state, stage: "expired" };
        return { ...state, stage: "pending", hint: CANCELLED_HINT };
      }
      if (action.kind === "expired") return { ...state, stage: "expired" };
      return {
        ...state,
        stage: "failed",
        error: { kind: action.kind, message: messageFor(action.kind, action.message) },
      };
    }

    case "tick": {
      if (state.stage !== "pending" && state.stage !== "authorizing") return state;
      if (state.snapshot !== null && action.nowMs >= state.snapshot.expiresAtMs) {
        return { ...state, stage: "expired", nowMs: action.nowMs };
      }
      return { ...state, nowMs: action.nowMs };
    }

    case "result": {
      // A result for a different payload is not this request's outcome. A batch
      // has no single digest, so its per-step results never match here and are
      // reconciled by the next `approval_current` read instead.
      if (state.snapshot === null || state.snapshot.payloadHash !== action.payloadHash) {
        return state;
      }
      return { ...state, stage: action.approved ? "sent" : "denied" };
    }

    case "dismiss":
      return HIDDEN;
  }
}

/** True while the overlay has something to show (including a result dwell). */
export function isVisible(state: OverlayState): boolean {
  return state.stage !== "hidden";
}

/** True for a terminal stage showing its one-line result. */
export function isResultStage(stage: OverlayStage): boolean {
  return stage === "sent" || stage === "denied" || stage === "expired" || stage === "failed";
}

/** True only for a live pending request whose deadline has not passed. */
export function canApprove(state: OverlayState): boolean {
  return (
    state.stage === "pending" &&
    state.snapshot !== null &&
    state.nowMs < state.snapshot.expiresAtMs
  );
}

/** Milliseconds left on the countdown, or `null` outside a bounded stage. */
export function remainingMs(state: OverlayState): number | null {
  if (state.stage !== "pending" && state.stage !== "authorizing") return null;
  if (state.snapshot === null) return null;
  return Math.max(0, state.snapshot.expiresAtMs - state.nowMs);
}

/** The one-line result for a terminal stage, or `null` while still deciding. */
export function resultLine(state: OverlayState): string | null {
  switch (state.stage) {
    case "sent":
      return "Sent";
    case "denied":
      return "Denied";
    case "expired":
      return "Expired";
    case "failed":
      return `Failed: ${state.error?.message ?? "approval failed"}`;
    default:
      return null;
  }
}

/** The tone a terminal result renders in, or `null` while still deciding. */
export function resultTone(state: OverlayState): "ok" | "danger" | null {
  switch (state.stage) {
    case "sent":
      return "ok";
    case "denied":
    case "expired":
    case "failed":
      return "danger";
    default:
      return null;
  }
}
