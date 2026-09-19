/**
 * Guard routing policy — PURE, no I/O, no clock, no network.
 *
 * Decides which on-chain entry point a guarded payment must use, *before* any
 * transaction is built, so the app can tell the user up front whether the
 * agent may settle it alone or a Touch ID approval card is needed.
 *
 * Policy:
 *  - `pay_executor` (the agent signs, no approval card) when ALL hold:
 *      * an executor is registered,
 *      * `amountRaw <= rule.auto_approve_limit`,
 *      * the asset is in `rule.allowed_assets`,
 *      * and, when `known_recipients_only` is set, the recipient is known.
 *  - `pay_owner` otherwise (owner signs after the approval card). The hard
 *    caps (`per_tx_limit`, `daily_limit`) still bind on-chain.
 *
 * Hard refusals are raised here, before anything is built, with the same names
 * the contract would return (`OverPerTxLimit`, `AssetNotAllowed`, ...), so the
 * app can explain *why* instead of discovering it in a simulation log. The
 * daily limit is deliberately NOT checked here: this function has no spend
 * counter, and `pay_owner` remains available as the owner-approved path.
 */
import { GuardClientError } from "./errors.ts";
import type { Rule } from "./types.ts";

export type GuardRoute = "pay_executor" | "pay_owner";

export interface GuardRouteDecision {
  route: GuardRoute;
  /** Human-readable explanation, safe to log. */
  reason: string;
}

export interface GuardRouteInput {
  rule: Rule;
  /** Registered executor address, or null when none is set. */
  executor: string | null;
  /** Payment amount in raw token units. */
  amountRaw: bigint;
  /** SAC contract id the payment would move. */
  assetContractId: string;
  /** Whether the recipient is in the owner's alias book. */
  recipientKnown: boolean;
}

function refuse(name: string, code: number, message: string): never {
  throw new GuardClientError({ name, kind: "rule_violated", code, message });
}

export function chooseGuardedRoute(input: GuardRouteInput): GuardRouteDecision {
  const { rule, executor, amountRaw, assetContractId, recipientKnown } = input;

  if (amountRaw <= 0n) {
    refuse("InvalidAmount", 101, `guarded amount must be positive, got ${amountRaw} raw units`);
  }
  if (!rule.allowed_assets.includes(assetContractId)) {
    refuse("AssetNotAllowed", 106, `asset ${assetContractId} is not in the owner's allowed_assets`);
  }
  if (amountRaw > rule.per_tx_limit) {
    refuse(
      "OverPerTxLimit",
      103,
      `amount ${amountRaw} raw units exceeds the owner's per_tx_limit ${rule.per_tx_limit}`,
    );
  }

  if (executor === null) {
    return { route: "pay_owner", reason: "no executor registered; the owner must sign" };
  }
  if (amountRaw > rule.auto_approve_limit) {
    return {
      route: "pay_owner",
      reason: `amount ${amountRaw} exceeds auto_approve_limit ${rule.auto_approve_limit}; the owner must sign`,
    };
  }
  if (rule.known_recipients_only && !recipientKnown) {
    return { route: "pay_owner", reason: "recipient is not in the alias book and known_recipients_only is set" };
  }
  return { route: "pay_executor", reason: "inside the agent mandate; the executor may sign" };
}
