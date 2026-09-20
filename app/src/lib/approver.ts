/**
 * The real Touch ID approver (milestone W4b): the shell's `IntentApprover`.
 *
 * `@polaris/agent`'s `IntentApprover` is a card-level gate: it sees the unsigned
 * transaction's `summary`, `payloadHash` and `unsignedXdr`, shows the user what
 * they are about to authorise, and answers `{ approved }`. This module is the
 * composition-root implementation that binds that seam to the **Rust gate**
 * (W3): the XDR and its hash go to Rust, the decision comes back from the gate —
 * never from this module. Since W15g the card renders inside the notch, which
 * picks up the `approval_request` event itself; this module opens no window.
 *
 * ## Fail-closed by construction
 *
 * `approve()` returns `approved: true` **only** when the gate reports the exact
 * `payloadHash` as `authorized`. A denied, expired, timed-out, superseded or
 * errored gate is never an approval, and neither is a transport failure: every
 * one of them resolves to `{ approved: false, reason }`. The `approval_begin`
 * call can itself reject (a hash mismatch, an oversized blob, a wallet-only
 * mode) and that rejection is propagated so `executeIntent` settles the turn as
 * a labelled `Approval error` rather than a silent reject — either way no value
 * moves.
 *
 * ## Event + poll
 *
 * The gate also emits `approval_result` on the typed event stream. As the wait
 * begins, a listener is attached so a decision that lands between the begin and
 * the first poll is not missed; a poll of `approval_status` runs concurrently as
 * the fallback, covering a dropped event or a gate that only exposes the
 * command. The bounded wait is armed as soon as the request is registered, so a
 * missed event can neither delay nor unbind the approval. The first terminal
 * observation wins; later ones are ignored. The
 * whole wait is bounded by [`APPROVER_TIMEOUT_MS`], after which the answer is a
 * fail-closed `false`.
 *
 * ## No secrets
 *
 * This module never sees a secret and never returns one. The XDR it hands to
 * Rust is the unsigned envelope; the signed envelope only exists inside Rust
 * after the wallet signs and is released on the separate `wallet_sign` path.
 * `approve()` returns only the boolean decision and the gate-assigned id, never
 * the payload.
 */
import type { IntentApprover, ApprovalRequest } from "@polaris/agent";

import { approvalBegin, type ApprovalStatus, type InvokeFn } from "./approval.ts";
import type { PaymentStage } from "./turnSession.ts";
import { webLog } from "./weblog.ts";

/**
 * How long to wait for the gate's decision. The Rust approval TTL is 120 s
 * (`APPROVAL_TTL` in `approval.rs`), so waiting slightly longer lets an expiry
 * surface as a real `expired` status rather than as this module's own timeout.
 */
export const APPROVER_TIMEOUT_MS = 130_000;

/** How often the poll fallback asks the gate, while waiting for an event. */
export const APPROVER_POLL_MS = 750;

/** Why a fail-closed `false` was returned; safe to show in the turn detail. */
export const DENIED_BY_USER = "the approval gate denied the request";
export const EXPIRED_REASON = "the approval request expired";
export const TIMEOUT_REASON = "timed out waiting for Touch ID";

/**
 * One event in the shape this module needs: the typed `approval_result` payload.
 * Declared structurally so tests can feed it without a Tauri event object.
 */
export interface ApprovalResultEvent {
  payloadHash: string;
  approved: boolean;
}

/**
 * Subscribes to the `approval_result` stream and resolves the unsubscribe. The
 * production binding is `listenPolarisEvents`; tests inject a scripted one.
 */
export type SubscribeApprovalEvents = (
  handler: (event: ApprovalResultEvent) => void,
) => Promise<() => void>;

/** Injected shell access. Production callers use the defaults. */
export interface ApproverDeps {
  invoke: InvokeFn;
  /** Subscribes to approval_result events; returns the unsubscribe function. */
  subscribe: SubscribeApprovalEvents;
  /** Injectable clock/timer seam so the wait is testable without real time. */
  now: () => number;
  setTimer: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer: (handle: ReturnType<typeof setTimeout>) => void;
  /**
   * Additive (F1): reports the approval-request boundary so the notch can show
   * "Approve in Polaris" for the whole gate wait. Optional, so existing callers
   * and tests are unaffected.
   */
  onStage?: (stage: PaymentStage) => void;
}

/**
 * The decision an approver reaches, plus the gate id when the gate accepted the
 * request. `approvalId` is only present when the request was registered (an
 * `approved: true` is impossible without one).
 */
export interface ApproverOutcome {
  approved: boolean;
  approvalId?: string;
  /** Short fail-closed reason; present only when `approved` is false. */
  reason?: string;
}

/** True for the gate states that end the wait. */
function isTerminal(status: ApprovalStatus): boolean {
  return (
    status.state === "authorized" ||
    status.state === "denied" ||
    status.state === "expired" ||
    status.state === "consumed"
  );
}

/**
 * Waits for the gate to reach a terminal state for `id`, returning the first
 * terminal status seen. Resolves `null` when the gate never reports one (the
 * caller maps that to a fail-closed timeout).
 *
 * The event and the poll are both just signals: neither can fabricate an
 * approval, because a fabricated `approved: true` event only becomes an
 * approval if `approval_status` agrees the state is `authorized`. That is what
 * keeps a rogue event from flipping the gate.
 */
function waitForDecision(
  id: string,
  payloadHash: string,
  deps: ApproverDeps,
): Promise<ApprovalStatus | null> {
  return new Promise((resolve) => {
    let settled = false;
    let unsubscribe: (() => void) | undefined;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;

    const finish = (status: ApprovalStatus | null): void => {
      if (settled) return;
      settled = true;
      if (pollTimer !== undefined) deps.clearTimer(pollTimer);
      deps.clearTimer(deadline);
      unsubscribe?.();
      resolve(status);
    };

    const poll = async (): Promise<void> => {
      if (settled) return;
      try {
        const status = await deps.invoke<ApprovalStatus | null>("approval_status", { id });
        if (status && isTerminal(status)) {
          finish(status);
          return;
        }
      } catch (error) {
        // A failed poll is not a decision: the request is simply still open
        // (or the gate is gone). Keep waiting; the timeout is the backstop.
        console.warn("approval_status poll failed", error);
      }
      if (!settled) {
        pollTimer = deps.setTimer(() => void poll(), APPROVER_POLL_MS);
      }
    };

    const onResult = (event: ApprovalResultEvent): void => {
      // A result for another payload is not this request's outcome. On a match,
      // re-read the gate so the *authoritative* state decides, never the event.
      if (event.payloadHash !== payloadHash) return;
      void poll();
    };

    // The overall deadline is armed first so the wait can never hang: if the
    // subscription and the first poll both stall, this resolves `null`.
    const deadline = deps.setTimer(() => finish(null), APPROVER_TIMEOUT_MS);

    void deps
      .subscribe(onResult)
      .then((off) => {
        if (settled) {
          off();
          return;
        }
        unsubscribe = off;
      })
      .catch((error: unknown) => {
        // Without a subscription the poll is the only signal, which is enough
        // to decide; the request is not abandoned.
        console.warn("approval_result subscription failed; polling only", error);
      });

    // Kick the first poll immediately so a decision already made before this
    // call is not missed.
    void poll();
  });
}

/**
 * Builds the production dependency set from the shell's real seams. Kept out of
 * the approver itself so the wait can be driven by an injected clock in tests.
 */
export async function defaultApproverDeps(
  onStage?: (stage: PaymentStage) => void,
): Promise<ApproverDeps> {
  const [{ listenPolarisEvents }, { invoke }] = await Promise.all([
    import("@/lib/polaris"),
    import("@tauri-apps/api/core"),
  ]);
  return {
    invoke,
    subscribe: async (handler) =>
      listenPolarisEvents((event) => {
        if (event.type === "approval_result") {
          handler({ payloadHash: event.payloadHash, approved: event.approved });
        }
      }),
    now: () => Date.now(),
    setTimer: (callback, ms) => setTimeout(callback, ms),
    clearTimer: (handle) => clearTimeout(handle),
    onStage,
  };
}

/**
 * The Touch ID approver. It returns `approved: true` only when the Rust gate,
 * asked after the fact, reports the request `authorized`.
 *
 * `deps` is injected so `approver.test.ts` can drive every branch — approved,
 * denied, expired, timeout, a begin failure, and the event-before-subscribe
 * race — without a Tauri runtime or real time.
 */
export function createTouchIdApprover(deps: ApproverDeps): IntentApprover {
  return {
    async approve(request: ApprovalRequest): Promise<ApproverOutcome> {
      // F1: the approval gate owns the notch from here until a decision lands;
      // the shell shows "Approve in Polaris" for the whole wait.
      deps.onStage?.("awaiting_approval");
      // Register the exact blob with the gate. The gate re-hashes it and rejects
      // a mismatch, so the digest the card showed binds what will be released.
      const id = await approvalBegin(
        {
          payloadHash: request.payloadHash,
          unsignedXdr: request.unsignedXdr,
          summary: request.summary,
          intent: request.intent,
          mode: "touch_id",
        },
        deps.invoke,
      );

      // Arm the bounded wait (deadline + subscription + first poll) as soon as
      // the request is registered, so the listener cannot miss an early decision.
      const decision = waitForDecision(id, request.payloadHash, deps);

      // The in-notch overlay hydrates itself from the gate's `approval_request`
      // event (W15g); nothing here opens a window.
      const status = await decision;
      if (status === null) {
        webLog("error", `approval timed out after ${APPROVER_TIMEOUT_MS} ms`, true);
        return { approved: false, approvalId: id, reason: TIMEOUT_REASON };
      }
      if (status.state === "authorized") {
        return { approved: true, approvalId: id };
      }
      if (status.state === "expired") {
        webLog("error", "approval request expired", true);
        return { approved: false, approvalId: id, reason: EXPIRED_REASON };
      }
      webLog("error", `approval denied: ${status.reason ?? DENIED_BY_USER}`, true);
      return {
        approved: false,
        approvalId: id,
        reason: status.reason ?? DENIED_BY_USER,
      };
    },
  };
}
