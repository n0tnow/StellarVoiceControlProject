/**
 * Intent execution seam (step A9) — infrastructure, never chain logic.
 *
 * Steps A2–A8 stop at a validated `Intent`: `send_payment` is approval-gated, so
 * the loop produces an `Intent` and deliberately never calls `run()`. Nothing in
 * the product could act on that intent. This module is the single, documented
 * path from "an approved `Intent`" to "the matching `ChainTool` from
 * `@polaris/stellar` was called and returned its `ChainToolResult`".
 *
 * ## What belongs here, and what does not
 *
 * Owner B owns `stellar/` (the chain tools, the anchor, the Soroban contracts) and
 * is implementing those behind the frozen `ChainTool`/`ChainToolResult` contract
 * in `@polaris/interfaces`. This module imports **none** of that package: the tool
 * set is injected as `ChainToolSet`, so the seam is testable with fakes and the
 * actual wiring lives in a composition root (the shell, `app/src/lib/chain.ts`).
 *
 * ## The approval gate
 *
 * An explicit seam sits between "intent produced" and "chain tool called"
 * ([`IntentApprover`]). When an approver denies, the chain tool is **never
 * called** — that ordering is pinned by a test.
 *
 * **Fail-closed by default.** The composition root must choose the approver
 * explicitly; [`resolveApprover`] returns a deny-all gate unless auto-approval
 * was opted into, so a real value-moving `ChainTool` can never execute by
 * accident. [`createAutoApprovalPlaceholder`] is a loud stand-in for the stubbed
 * demo only and is never the default.
 *
 * **Scope of the biometric drop-in (M6).** The approver receives only the
 * `Intent`. That is enough for *intent-level* gating — approve or deny before
 * any chain work — which is what this seam provides, and a Touch ID gate can
 * implement it as-is. It is **not** enough for the card-level approval the UI
 * ultimately wants: the confirmation card also needs post-tool material
 * (`summary` + `payloadHash`, see `PolarisEvent::approval_request` in
 * `@polaris/interfaces`), which does not exist until the tool has built the
 * unsigned XDR. Card-level approval therefore needs a second, post-tool phase
 * that this seam does not implement yet; the placeholder must not be described
 * as a full drop-in for it.
 *
 * ## Unimplemented chain tools are an expected state, not a crash
 *
 * Owner B's `sendPayment`, `swap` and `guardPolicy` currently throw
 * `NotImplementedError`. That is the normal state for those three, so it is
 * modelled explicitly as [`ExecutionOutcome.status`] `"unavailable"` with a
 * short, user-safe label — the notch says plainly that the chain step is not
 * wired yet and settles, rather than showing an error or hanging. The detection
 * is structural (`name === "NotImplementedError"`) on purpose: it keeps this
 * module independent of the chain package, matching the error's own contract.
 *
 * `depositTry` is **not** a stub (M8): with no anchor configured it throws a
 * plain error (reported as `"failed"` / `Chain error`), and with one configured
 * it builds the unsigned trustline or SEP-10 login XDR (reported as
 * `"executed"`). It never submits, so nothing reaches the network from here.
 */
import type { ChainTool, ChainToolResult, Intent, IntentKind } from "@polaris/interfaces";

/* ------------------------------------------------------------------ *
 * Approval gate
 * ------------------------------------------------------------------ */

/** What an approver answers for one intent. */
export interface ApprovalDecision {
  approved: boolean;
  /** Short, terminal-safe reason; shown when `approved` is false. */
  reason?: string;
}

/**
 * The approval gate. Owner A's Touch ID flow implements this.
 *
 * It is an **intent-level** gate: it sees the `Intent` and nothing else, so it
 * can approve or deny before any chain work. A card-level approval (post-tool
 * `summary` + `payloadHash`) is a separate phase this interface does not carry;
 * see the module header (M6).
 *
 * Implementations must not perform chain work — they only decide. The chain tool
 * is called here only after `approved: true`. Implementations **may throw** (for
 * example a biometric error); `executeIntent` maps that to a labelled failure
 * instead of letting it escape.
 */
export interface IntentApprover {
  approve(intent: Intent): Promise<ApprovalDecision>;
}

/**
 * Development placeholder — **not** Touch ID. It approves unconditionally.
 *
 * This exists so the execution path is real end to end for the stubbed demo, and
 * it is **never** the default: a composition root installs it only through
 * [`resolveApprover`] with an explicit opt-in. It was harmless while every tool
 * threw `NotImplementedError`, but `depositTry` is already real and any of
 * `sendPayment`, `swap` or `guardPolicy` may stop throwing at any time — at
 * which point an auto-approver would move value without a user gesture. Keeping
 * it opt-in is what makes that unreachable by accident.
 */
export function createAutoApprovalPlaceholder(): IntentApprover {
  return {
    async approve(intent: Intent): Promise<ApprovalDecision> {
      console.warn(
        `[polaris] approval gate is the A9 placeholder (Touch ID is a later milestone); ` +
          `auto-approving a "${intent.kind}" intent`,
      );
      return { approved: true };
    },
  };
}

/**
 * The safe default: deny everything until a real gate is installed.
 *
 * Used whenever auto-approval was not explicitly opted into, so a value-moving
 * `ChainTool` cannot run without a deliberate decision (M5).
 */
export function createDenyApprover(
  reason = "the approval gate is not configured",
): IntentApprover {
  return {
    async approve(intent: Intent): Promise<ApprovalDecision> {
      console.warn(
        `[polaris] refusing to approve a "${intent.kind}" intent: ${reason} ` +
          `(the Touch ID approver is a later milestone)`,
      );
      return { approved: false, reason };
    },
  };
}

/**
 * Selects the approver for a composition root. **Fail-closed by default**: only
 * an explicit `autoApprove === true` installs the auto-approving placeholder;
 * everything else gets the deny-all gate, so the dangerous wiring cannot be
 * reached by forgetting a flag (M5). The caller reads the flag from an explicit
 * opt-in (see `app/src/lib/chain.ts`), never from an implicit default.
 */
export function resolveApprover(autoApprove: boolean): IntentApprover {
  return autoApprove ? createAutoApprovalPlaceholder() : createDenyApprover();
}

/* ------------------------------------------------------------------ *
 * Dispatch
 * ------------------------------------------------------------------ */

/** The chain tools available to the agent, keyed by the intent kind they serve. */
export type ChainToolSet = Partial<Record<IntentKind, ChainTool>>;

/** Why an intent did not produce a `ChainToolResult`. */
export type ExecutionStatus = "executed" | "rejected" | "unsupported" | "unavailable" | "failed";

/** One intent's execution result. `label`/`detail` are set for every non-success. */
export interface ExecutionOutcome {
  status: ExecutionStatus;
  intent: Intent;
  /** Short, overlay-safe label (e.g. "Chain not wired"). Absent when executed. */
  label?: string;
  /** Full terminal detail. Absent when executed. */
  detail?: string;
  /** The unsigned XDR + decoded summary. Present iff `status === "executed"`. */
  result?: ChainToolResult;
}

export interface ExecuteIntentOptions {
  /** The approval gate; the chain tool runs only if this approves. */
  approver: IntentApprover;
  /** Owner B's tools, injected by the composition root. */
  chainTools: ChainToolSet;
}

/** True for Owner B's `NotImplementedError` stubs, matched structurally. */
export function isNotImplementedError(error: unknown): boolean {
  return error instanceof Error && error.name === "NotImplementedError";
}

function detailOf(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/**
 * The single path from an approved `Intent` to its chain tool.
 *
 * Order is part of the contract (pinned by a test): resolve the tool, ask the
 * approver, and only then call the tool. Outcomes:
 *
 * - `unsupported` — no chain tool is registered for this intent kind.
 * - `rejected` — the approver denied; the tool was not called.
 * - `unavailable` — the tool exists but is not wired yet (`NotImplementedError`).
 * - `failed` — the approver threw, or the tool threw anything else.
 * - `executed` — the tool returned an unsigned XDR + summary.
 *
 * Never throws: a throwing approver (the realistic Touch ID error/cancel shape)
 * is caught and returned as a labelled `failed` outcome, exactly like a tool
 * failure, so callers always get something they can render or settle.
 */
export async function executeIntent(
  intent: Intent,
  options: ExecuteIntentOptions,
): Promise<ExecutionOutcome> {
  const tool = options.chainTools[intent.kind];
  if (!tool) {
    return {
      status: "unsupported",
      intent,
      label: "Not supported",
      detail: `no chain tool is registered for intent kind "${intent.kind}"`,
    };
  }

  let decision: ApprovalDecision;
  try {
    decision = await options.approver.approve(intent);
  } catch (error) {
    // A biometric gate may reject or error by throwing (cancel, hardware
    // failure). That must not escape the seam: map it to a labelled outcome so
    // the shell can settle the turn instead of hitting its generic catch.
    return {
      status: "failed",
      intent,
      label: "Approval error",
      detail: detailOf(error),
    };
  }
  if (!decision.approved) {
    return {
      status: "rejected",
      intent,
      label: "Not approved",
      detail: decision.reason ?? "the approval gate rejected the intent",
    };
  }

  try {
    const result = await tool(intent);
    return { status: "executed", intent, result };
  } catch (error) {
    if (isNotImplementedError(error)) {
      return {
        status: "unavailable",
        intent,
        label: "Chain not wired",
        detail: detailOf(error),
      };
    }
    return { status: "failed", intent, label: "Chain error", detail: detailOf(error) };
  }
}
