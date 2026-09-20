/**
 * The threshold decision: does an approval request need the Touch ID card, or
 * does the owner's local preference approve it silently?
 *
 * This is a pure function over the request the gate would receive, so the
 * policy is unit-tested without a store, a runtime, or the Rust gate. The
 * precedence is fixed and documented in `preferences.ts`:
 *
 * 1. `Approval card required: yes` in the tool summary **always** wins — the
 *    chain's own requirement can only be narrowed by the app, never loosened
 *    (D10c). Any other caller-set `requiresCard` flag is honoured the same way.
 * 2. Below that, the local `approvalThresholdUsd` applies — but only to
 *    **payments in a USD stablecoin**. The threshold is `0` (D10's "always
 *    ask") by default, and a payment **at** the threshold still asks (only
 *    strictly-below skips the card; an exact hit is not "small change").
 * 3. A non-USD asset (e.g. `XLM`) has no price oracle here, so its USD value
 *    is unknown — and unknown always asks.
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
  // `Number("")` is 0, which would silently pass a threshold: an empty amount
  // is unreadable, not "zero dollars".
  const usd = amount.trim() === "" ? Number.NaN : Number(amount);
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
