/**
 * Wallet session (milestone W13a): login / logout / auto-lock.
 *
 * Answers "is the wallet session working right now?" from the read-only
 * `wallet_session` command: whether a wallet exists, whether it is locked, and
 * the configured idle auto-lock. It never prompts and moves no funds.
 */
import { errorDetail, makeResult } from "@/debug/runner.ts";
import type { FeatureCheck } from "@/debug/types.ts";
import { walletSession } from "@/lib/wallet.ts";

export default {
  id: "walletSession",
  title: "Wallet login",
  milestone: "W13",
  async run() {
    try {
      const session = await walletSession().catch(() => null);
      if (session === null) {
        return makeResult("warn", "wallet_session is not present on this build");
      }
      switch (session.state) {
        case "none":
          return makeResult("warn", "No wallet yet — create or import one to log in");
        case "locked":
          return makeResult(
            "warn",
            `${session.count} wallet(s) stored; locked. Use Log in to sign.`,
          );
        case "unlocked": {
          const timeout =
            session.autoLockMinutes > 0
              ? `auto-locks after ${session.autoLockMinutes} min idle`
              : "auto-lock off";
          return makeResult(
            "ok",
            `${session.active?.address ?? "wallet"} is logged in (${timeout})`,
          );
        }
      }
    } catch (error) {
      return makeResult("fail", `wallet session check failed: ${errorDetail(error)}`);
    }
  },
} satisfies FeatureCheck;
