/**
 * Pure classification of a rule change (D10c) and the chain -> app profile map.
 *
 * No I/O, no clock, no network: this runs inside the approval decision and is
 * unit-testable with plain fixtures.
 *
 * Loosening = ANY limit increases, the allowed-asset set grows, or
 * `known_recipients_only` turns off. Tightening = only decreases/narrowings.
 * Both at once = mixed; nothing moves = same; no current rule = new_rule.
 */
import type { Rule } from "../guard/types.ts";
import { ApprovalError, type ApprovalProfile } from "./types.ts";

export type ChangeKind = "loosening" | "tightening" | "mixed" | "same" | "new_rule";

/** D10c: loosening/mixed/new rules need the full card; tightening is lighter. */
export type ConfirmationLevel = "card_and_touch_id" | "light" | "none";

/** The numeric fields compared directionally. */
const LIMIT_KEYS = ["auto_approve_limit", "per_tx_limit", "daily_limit"] as const;

export function classifyChange(current: Rule | undefined, next: Rule): ChangeKind {
  if (current === undefined) return "new_rule";

  let loosened = false;
  let tightened = false;

  for (const key of LIMIT_KEYS) {
    if (next[key] > current[key]) loosened = true;
    else if (next[key] < current[key]) tightened = true;
  }

  // Allowed assets: growing the set is a loosening, dropping an asset is a
  // tightening. A replacement (A -> B) does both, so it is mixed.
  const currentAssets = new Set(current.allowed_assets);
  const nextAssets = new Set(next.allowed_assets);
  for (const asset of nextAssets) if (!currentAssets.has(asset)) loosened = true;
  for (const asset of currentAssets) if (!nextAssets.has(asset)) tightened = true;

  if (current.known_recipients_only && !next.known_recipients_only) loosened = true;
  if (!current.known_recipients_only && next.known_recipients_only) tightened = true;

  if (loosened && tightened) return "mixed";
  if (loosened) return "loosening";
  if (tightened) return "tightening";
  return "same";
}

export function confirmationLevel(change: ChangeKind): ConfirmationLevel {
  switch (change) {
    case "loosening":
    case "mixed":
    case "new_rule":
      return "card_and_touch_id";
    case "tightening":
      return "light";
    case "same":
      return "none";
  }
}

/**
 * Derive the app-side profile from what the chain actually enforces.
 *
 * No executor, no rule, or `auto_approve_limit == 0` (the contract's own
 * "always ask me" encoding, which `validate_rule` accepts) all mean
 * `always_ask`; a registered executor with a positive threshold means the chain
 * would let the agent pay alone, so the app mirrors it as `auto_under_limit`.
 */
export function profileFromChain(
  rule: Rule | null | undefined,
  executor: string | null | undefined,
): ApprovalProfile {
  if (!rule || !executor) return { mode: "always_ask" };
  if (rule.auto_approve_limit <= 0n) return { mode: "always_ask" };
  return { mode: "auto_under_limit" };
}

/**
 * Throw `use_enable_flow` when a change requires the full enable flow
 * (loosening/mixed/new rule). Tightening and no-op changes pass untouched.
 */
export function assertTightening(change: ChangeKind): void {
  if (confirmationLevel(change) === "card_and_touch_id") {
    throw new ApprovalError(
      "use_enable_flow",
      `a ${change} change must go through the enable flow (card + Touch ID), not the tighten flow`,
    );
  }
}
