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
 * ([`IntentApprover`]). The Touch ID approval flow (a separate milestone) drops
 * in here without reshaping anything: it only has to replace the placeholder
 * approver with one that presents the approval card and awaits the biometric.
 * When an approver denies, the chain tool is **never called** — that ordering is
 * pinned by a test.
 *
 * ## Unimplemented chain tools are an expected state, not a crash
 *
 * Owner B's `sendPayment`, `swap` and `guardPolicy` currently throw
 * `NotImplementedError`. That is the normal state today, so it is modelled
 * explicitly as [`ExecutionOutcome.status`] `"unavailable"` with a short,
 * user-safe label — the notch says plainly that the chain step is not wired yet
 * and settles, rather than showing an error or hanging. The detection is
 * structural (`name === "NotImplementedError"`) on purpose: it keeps this module
 * independent of the chain package, matching the error's own contract.
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
 * The approval gate. Owner A's Touch ID flow implements this; today the shell
 * passes the clearly named placeholder below.
 *
 * Implementations must not perform chain work — they only decide. The chain tool
 * is called here only after `approved: true`.
 */
export interface IntentApprover {
  approve(intent: Intent): Promise<ApprovalDecision>;
}

/**
 * Development placeholder — **not** Touch ID.
 *
 * This exists so the execution path is real end to end while the biometric
 * milestone is pending. It approves unconditionally and says so on the console;
 * because every `ChainTool` on `main` still throws `NotImplementedError`, no
 * value can move while it is in place. The Touch ID approver replaces this single
 * object in the composition root (`app/src/lib/chain.ts`).
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
 * - `failed` — the tool threw anything else.
 * - `executed` — the tool returned an unsigned XDR + summary.
 *
 * Never throws: callers get a labelled outcome they can render or settle.
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

  const decision = await options.approver.approve(intent);
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
