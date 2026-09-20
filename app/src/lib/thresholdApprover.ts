/**
 * The threshold-aware approver: the owner's local `approvalThresholdUsd`
 * preference wrapped around the real Touch ID approver.
 *
 * The policy itself is pure (`approvalPolicy.ts`); this module only resolves
 * the preference (lazily — a turn that never reaches the chain never touches
 * storage) and picks the path:
 *
 * - **`card`** — hand the request to the wrapped approver unchanged (the Rust
 *   gate, the card, the wait).
 * - **`auto`** — approve *without* registering with the Rust gate, so no
 *   `approval_request` is emitted and no card can linger for a payment that
 *   never needed one. This is a *local* convenience, not a security boundary:
 *   the wrapped approver (and the Rust gate behind it) is the fail-closed
 *   default, and `decideApproval` can only ever *skip* a card the chain did
 *   not require — it can never force one open.
 *
 * The skip is logged to the terminal (`webLog`) so an automatic approval is
 * never silent in the record, even though no card is shown.
 */
import type { IntentApprover, ApprovalRequest } from "@polaris/agent";

import { decideApproval } from "./approvalPolicy.ts";
import { loadPreferences, type PreferenceStore } from "./preferences.ts";
import { webLog } from "./weblog.ts";

export interface ThresholdApproverDeps {
  /** Reads the persisted preference; defaults to `loadPreferences`. */
  load?: () => { approvalThresholdUsd: number };
  /** Extra hard override: force the card regardless of the threshold. */
  requiresCard?: (request: ApprovalRequest) => boolean;
}

/**
 * Wraps `inner` with the threshold policy. `store` is injectable only so tests
 * can drive it; production passes nothing and the browser store is used.
 */
export function createThresholdApprover(
  inner: IntentApprover,
  deps: ThresholdApproverDeps = {},
  store?: PreferenceStore | null,
): IntentApprover {
  const load =
    deps.load ?? (() => loadPreferences(store === undefined ? undefined : store));
  return {
    async approve(request: ApprovalRequest) {
      const thresholdUsd = load().approvalThresholdUsd;
      const override = deps.requiresCard?.(request) === true;
      const decision = override
        ? ({ action: "card", reason: "the caller requires an approval card" } as const)
        : decideApproval({
            kind: request.intent.kind,
            asset: request.intent.asset,
            amount: request.intent.amount,
            summaryLines: request.summary.lines,
            thresholdUsd,
          });
      if (decision.action === "auto") {
        webLog(
          "info",
          `auto-approved without a card: ${decision.reason} ` +
            `(kind=${request.intent.kind} asset=${request.intent.asset} ` +
            `amount=${request.intent.amount} payloadHash=${request.payloadHash})`,
        );
        return { approved: true };
      }
      return inner.approve(request);
    },
  };
}
