/**
 * The stricter-than-chain routing rule (D10).
 *
 * The chain decides what the executor *may* do alone; the app-side profile can
 * only narrow that, never widen it. `always_ask` therefore always selects the
 * owner-signed path even when `chooseGuardedRoute` would have allowed
 * `pay_executor`; `auto_under_limit` and `custom` defer to the chain decision.
 *
 * Pure: no I/O, no clock, no network.
 */
import type { GuardRoute } from "../guard/route.ts";
import type { ApprovalProfile } from "./types.ts";

export type { GuardRoute };

/**
 * Narrow a chain route with the app preference. The result is `pay_executor`
 * only when the chain allowed it AND the profile is not `always_ask`.
 */
export function resolveApprovalRoute(
  profile: ApprovalProfile | undefined,
  chainRoute: GuardRoute,
): GuardRoute {
  const mode = profile?.mode ?? "always_ask";
  return mode === "always_ask" ? "pay_owner" : chainRoute;
}

/** Whether the resolved route shows the user an approval card + Touch ID. */
export function requiresApprovalCard(route: GuardRoute): boolean {
  return route === "pay_owner";
}
