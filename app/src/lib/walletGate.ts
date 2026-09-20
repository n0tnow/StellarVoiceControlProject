/**
 * The async half of the Wallet login gate (task W10b, extended by W13b).
 *
 * The pure decision lives in `turnFlow.ts` (`decideWalletGateForSession`). This
 * module only observes the live wallet session and returns the gate for one
 * turn. The shell action itself — showing the Wallet page — rides the NAV
 * `navigation` request (`lib/navigation.ts` → `ShellSurface`), so this stays a
 * policy module with no UI coupling.
 */
import type { Intent } from "@polaris/interfaces";

import { decideWalletGateForSession, isValueMovingIntent, type WalletGateDecision } from "./turnFlow.ts";
import { walletSessionEngine } from "./walletSessionLive.ts";

/**
 * Resolves the gate for one turn by reading the live wallet session.
 *
 * A session engine that is missing from this build (or a failed read) does
 * **not** block: the chain tool's own owner check remains the fail-closed gate,
 * and an absent engine must not make every payment impossible.
 */
export async function decideWalletGateForTurn(intent: Intent): Promise<WalletGateDecision> {
  if (!isValueMovingIntent(intent)) {
    return { block: false, sentence: "", page: null };
  }
  try {
    const session = await walletSessionEngine.current();
    return decideWalletGateForSession(intent, session.state);
  } catch {
    return { block: false, sentence: "", page: null };
  }
}
