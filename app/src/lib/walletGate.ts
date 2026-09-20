/**
 * The async half of the Wallet onboarding gate (task W10b).
 *
 * The pure decision lives in `turnFlow.ts` (`decideWalletGate`). This module only
 * observes the wallet engine: it reads the live status and returns the gate for
 * one turn. The shell action itself — showing the Wallet page — rides the NAV
 * `navigation` request (`lib/navigation.ts` → `ShellSurface`), so this stays a
 * policy module with no UI coupling.
 */
import type { Intent } from "@polaris/interfaces";

import { decideWalletGate, isValueMovingIntent, type WalletGateDecision } from "./turnFlow.ts";
import { walletEngine } from "./wallet.ts";

/**
 * Resolves the gate for one turn by reading the live wallet status.
 *
 * A wallet engine that is missing from this build (or a failed status read) does
 * **not** block: the chain tool's own owner check remains the fail-closed gate,
 * and an absent engine must not make every payment impossible.
 */
export async function decideWalletGateForTurn(intent: Intent): Promise<WalletGateDecision> {
  if (!isValueMovingIntent(intent)) {
    return { block: false, sentence: "", page: null };
  }
  try {
    const status = await walletEngine.status();
    return decideWalletGate(intent, status.active !== null);
  } catch {
    return { block: false, sentence: "", page: null };
  }
}
