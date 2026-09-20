/**
 * Autopay executor readiness (milestone W11a).
 *
 * Answers "can the agent pay inside the rule right now?": whether the active
 * wallet has an executor key (`executor_status`) and its public address.
 * Read-only: it never signs, never prompts and moves no funds.
 */
import { errorDetail, makeResult } from "@/debug/runner.ts";
import type { FeatureCheck } from "@/debug/types.ts";
import { executorStatus } from "@/lib/wallet.ts";

export default {
  id: "executor",
  title: "Autopay executor",
  milestone: "W11",
  async run() {
    try {
      const status = await executorStatus().catch(() => null);
      if (status === null) {
        return makeResult("warn", "executor_status is not present on this build");
      }
      if (!status.exists || !status.address) {
        return makeResult(
          "warn",
          "No autopay executor key yet — create one before enabling automatic payments.",
        );
      }
      return makeResult(
        "ok",
        `Executor ${status.address} ready (funding is checked over Horizon).`,
      );
    } catch (error) {
      return makeResult("fail", `executor check failed: ${errorDetail(error)}`);
    }
  },
} satisfies FeatureCheck;
