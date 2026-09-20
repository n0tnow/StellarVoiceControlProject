/**
 * Wallet login session readiness (task W13b).
 *
 * Answers "is the wallet login working right now?" from non-secret session
 * metadata only: whether `wallet_session` exists in this build and what state it
 * reports. Read-only: it never prompts for Touch ID and never signs.
 */
import { errorDetail, makeResult } from "@/debug/runner.ts";
import type { FeatureCheck } from "@/debug/types.ts";
import { walletSessionEngine } from "@/lib/walletSessionLive";

export default {
  id: "walletSession",
  title: "Wallet login session",
  milestone: "W13",
  async run() {
    try {
      const available = await walletSessionEngine.available();
      if (!available) {
        return makeResult("warn", "wallet_session is not present on this build");
      }
      const session = await walletSessionEngine.current();
      if (session.state === "none") {
        return makeResult("warn", "No wallet yet — create or import one to log in");
      }
      if (session.state === "locked") {
        return makeResult(
          "warn",
          `${session.count} wallet(s) stored; locked — unlock with Touch ID on the Wallet page`,
        );
      }
      const address = session.active?.address ?? "unknown";
      return makeResult("ok", `Unlocked; active account ${address}`);
    } catch (error) {
      return makeResult("fail", `wallet session check failed: ${errorDetail(error)}`);
    }
  },
} satisfies FeatureCheck;
