/**
 * The threshold-aware approver: the owner's local `approvalThresholdUsd`
 * preference wrapped around the real Touch ID approver.
 *
 * The policy itself is pure (`approvalPolicy.ts`); this module only resolves
 * the preference (lazily — a turn that never reaches the chain never touches
 * storage), logs the decision, and hands the request on.
 *
 * ## Interim: an `auto` decision still shows the card (PR #29 review, CRITICAL-1)
 *
 * A genuine auto-approval has no `approvalId`, and the signing leg
 * (`signing.ts` → Rust `bridge_sign`) only releases an XDR to Freighter for a
 * **gate-registered, `Authorized`** approval id — so a payment that skipped the
 * gate could never execute: it settled as `executed` with no `txHash`, no
 * `tx_submitted`, no stage callbacks. The only honest auto path is the
 * **executor route**: a chain-built `pay_executor` XDR signed by the registered
 * executor key, with the guard contract enforcing `auto_approve_limit`
 * on-chain (`contracts/polaris_guard/src/lib.rs` `pay_executor`). That leg does
 * not exist in the app today: the shell holds no executor secret, the payment
 * tool always resolves `pay_owner` (the app never sets an `approvalProfile`, so
 * `DEFAULT_APPROVAL_PROFILE` = `always_ask`,
 * `stellar/src/payments/sendPayment.ts`), and `signEnvelope`
 * (`stellar/src/live/signer.ts`) is testnet-only live tooling, not an app
 * signer. Until it lands (see `backlog/touchid-approval.md` §6), an `auto`
 * decision is logged and then handed to the Touch ID gate like any other
 * request — the threshold influences the log only, never the security posture.
 *
 * ## The chain-required line is not the safety net (PR #29 review, MAJOR-2)
 *
 * `Approval card required: yes` is emitted only for the `pay_owner` route
 * (`stellar/src/approval/routing.ts`), and `pay_owner` deliberately skips the
 * agent-facing guardrails (`auto_approve_limit`, `known_recipients_only`,
 * `allowed_assets` — `contracts/polaris_guard/src/lib.rs` `pay_owner`). So the
 * line does not mean "the chain vetted/forbade this"; today it is on every
 * guarded payment because this build never routes `pay_executor`. The on-chain
 * auto-approve limit applies to the executor route, not the owner route.
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
        // The payment IS under the owner's threshold — but auto-execution is not
        // wired (module header, CRITICAL-1), so the honest behaviour is to log
        // the eligibility and still show the card. Never return an approvalId-
        // less `approved: true`: the sign leg would drop it without submitting.
        webLog(
          "info",
          `below the approval threshold (auto-pay unavailable — the executor ` +
            `route is not wired; the card still shows): ${decision.reason} ` +
            `(kind=${request.intent.kind} asset=${request.intent.asset} ` +
            `amount=${request.intent.amount} payloadHash=${request.payloadHash})`,
        );
      }
      return inner.approve(request);
    },
  };
}
