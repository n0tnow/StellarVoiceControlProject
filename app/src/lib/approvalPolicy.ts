/**
 * The threshold decision: is a payment below the owner's local USD
 * auto-approval preference, or must it take the Touch ID card path?
 *
 * This is a pure function over the request the gate would receive, so the
 * policy is unit-tested without a store, a runtime, or the Rust gate. The
 * precedence is fixed and documented in `preferences.ts`:
 *
 * 1. `Approval card required: yes` in the tool summary **always** wins — the
 *    chain's own requirement can only be narrowed by the app, never loosened
 *    (D10c). Any other caller-set `requiresCard` flag is honoured the same way.
 *    Note what that line actually means (PR #29 review, MAJOR-2): today it is
 *    present on **every** guarded payment, because `DEFAULT_APPROVAL_PROFILE` =
 *    `always_ask` forces the `pay_owner` route — and `pay_owner` is the
 *    owner-signed path that deliberately skips the agent-facing guardrails
 *    (`auto_approve_limit` / `known_recipients_only` / `allowed_assets`;
 *    `contracts/polaris_guard/src/lib.rs`). The on-chain auto-approve limit is
 *    checked on the `pay_executor` route, which this build never selects. So
 *    this check is fail-closed plumbing, not "the chain vetted this payment".
 * 2. Below that, the local `approvalThresholdUsd` applies — but only to
 *    **payments in a USD stablecoin**. The threshold is `0` (D10's "always
 *    ask") by default, and a payment **at** the threshold still asks (only
 *    strictly-below is eligible; an exact hit is not "small change").
 * 3. A non-USD asset (e.g. `XLM`) has no price oracle here, so its USD value
 *    is unknown — and unknown always asks.
 *
 * An `auto` result is only *eligibility*: `thresholdApprover.ts` still shows
 * the card until the executor-signing leg exists (PR #29 review, CRITICAL-1).
 */

import { USD_STABLE_ASSETS } from "./preferences.ts";

/** What `decideApproval` weighs: the request, plus the resolved preference. */
export interface ApprovalDecisionInput {
  kind: string;
  asset: string;
  /** Display units (e.g. `"25"`), as the intent carries them. */
  amount: string;
  /** The decoded summary lines the chain tool produced. */
  summaryLines: readonly string[];
  /** The owner's local USD ceiling (`0` = always ask). */
  thresholdUsd: number;
}

export type ApprovalDecision =
  | { action: "card"; reason: string }
  | { action: "auto"; reason: string };

/**
 * A strict positive decimal amount, mirroring the chain layer
 * (`stellar/src/guard/amount.ts` `AMOUNT_RE`, 1–12 integer digits, at most 7
 * fraction digits — the pinned USD stables use 7 decimals). `Number()` alone
 * is not a validator here: it accepts `"0x10"`, `"1e2"`, `Infinity` and
 * surrounding whitespace, and none of those are amounts the chain would ever
 * build. Anything that fails this regex is *unreadable*, and unreadable always
 * asks (PR #29 review, MINOR-4).
 */
const AMOUNT_RE = /^\d{1,12}(\.\d{1,7})?$/;

/** True when the summary declares the chain itself demands a card. */
export function chainRequiresCard(summaryLines: readonly string[]): boolean {
  return summaryLines.some(
    (line) => line.trim().toLowerCase() === "approval card required: yes",
  );
}

/**
 * The decision. Any doubt — a NaN amount, a threshold of `0`, a non-USD asset,
 * a chain-required card — resolves to the card, never to a silent approval.
 */
export function decideApproval(input: ApprovalDecisionInput): ApprovalDecision {
  const { kind, asset, amount, summaryLines, thresholdUsd } = input;

  if (chainRequiresCard(summaryLines)) {
    return { action: "card", reason: "the chain requires an approval card" };
  }
  if (kind !== "send") {
    return { action: "card", reason: `a "${kind}" intent always asks` };
  }
  if (!USD_STABLE_ASSETS.includes(asset.trim().toUpperCase())) {
    return {
      action: "card",
      reason: `${asset} has no USD price here, so its value is unknown`,
    };
  }
  // Strict decimal only: hex, exponents, signs and whitespace are unreadable,
  // not "small numbers" (MINOR-4). The regex is the chain layer's own shape.
  if (!AMOUNT_RE.test(amount)) {
    return { action: "card", reason: "the amount is not a readable decimal number" };
  }
  const usd = Number(amount);
  if (!Number.isFinite(usd) || usd < 0) {
    return { action: "card", reason: "the amount is not a readable number" };
  }
  if (thresholdUsd > 0 && usd < thresholdUsd) {
    return {
      action: "auto",
      reason: `${amount} ${asset} is below the $${thresholdUsd} approval threshold`,
    };
  }
  return {
    action: "card",
    reason:
      thresholdUsd > 0
        ? `${amount} ${asset} is at or above the $${thresholdUsd} approval threshold`
        : "always ask (the approval threshold is 0)",
  };
}
