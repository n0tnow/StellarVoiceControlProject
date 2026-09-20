/**
 * Demo bank ↔ anchor loop readiness (milestone W14).
 *
 * Answers, for a non-developer: is the simulated bank ledger readable, which
 * anchor scenario is active, and (for the TR mock) are its deposit payouts
 * flowing? The payout read is read-only and time-boxed inside the check so it
 * cannot exhaust the runner's budget.
 */
import { getBankAccount, getBankHistory } from "@/lib/bank";
import { bankAnchorScenario, readBankPayoutHealth } from "@/lib/bankAnchor";
import { errorDetail, makeResult } from "@/debug/runner.ts";
import type { FeatureCheck } from "@/debug/types.ts";

/** Payout health is best-effort: never let it dominate the check's budget. */
const PAYOUT_BUDGET_MS = 2_500;

function withBudget<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([
    promise,
    new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), ms)),
  ]);
}

export default {
  id: "bank",
  title: "Demo bank + on/off-ramp",
  milestone: "W14",
  async run() {
    try {
      const [account, history] = await Promise.all([getBankAccount(), getBankHistory(5)]);
      if (!account.iban.startsWith("TR") || account.iban.length !== 26) {
        return makeResult("fail", "the demo bank ledger has no valid IBAN; use Reset demo bank in the Anchor panel");
      }
      const scenario = await bankAnchorScenario();
      const payout = await withBudget(readBankPayoutHealth(), PAYOUT_BUDGET_MS);
      if (payout?.verdict === "payouts-stalled") {
        return makeResult(
          "warn",
          `demo bank ${account.balanceTry} ${account.currency} · anchor ${scenario.id} · deposit payouts look stalled: ${payout.reasons[0] ?? ""}`,
        );
      }
      const payoutText = payout ? ` · payouts ${payout.verdict}` : "";
      return makeResult(
        "ok",
        `demo bank ${account.balanceTry} ${account.currency} · ${history.length} recent entries · anchor ${scenario.id}${payoutText}`,
      );
    } catch (error) {
      return makeResult("fail", `the demo bank or anchor scenario is unreachable: ${errorDetail(error)}`);
    }
  },
} satisfies FeatureCheck;
