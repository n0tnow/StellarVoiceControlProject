/**
 * History readiness (milestone NW4).
 *
 * Answers "is the History page showing real data right now?": how many local
 * turns are stored, whether the owner is configured, and whether Horizon returns
 * the owner's recent payments that make up the on-chain half of the timeline.
 * Read-only: it never signs or moves funds.
 */
import { getStellarConfigIfAvailable } from "@/debug/commands.ts";
import { errorDetail, makeResult } from "@/debug/runner.ts";
import type { FeatureCheck } from "@/debug/types.ts";
import { fetchOwnerPayments } from "@/lib/history.ts";
import { readTurnLog } from "@/lib/turnLog.ts";
import { loadAnchorRows } from "@/notch/history/anchorHistory.ts";
import { loadP2pRows } from "@/notch/history/p2pHistory.ts";

export default {
  id: "history",
  title: "History (turns + Horizon)",
  milestone: "W4",
  async run() {
    try {
      const turns = readTurnLog().length;
      const config = await getStellarConfigIfAvailable();
      if (config === null) {
        return makeResult("warn", `${turns} local turn(s); stellar_config is not present on this build`);
      }
      if (!config.ownerAddress) {
        return makeResult(
          "warn",
          `${turns} local turn(s); POLARIS_OWNER_ADDRESS is not set, the page shows demo data`,
        );
      }
      if (!config.horizonUrl) {
        return makeResult("fail", "horizonUrl is not configured; on-chain history cannot be read");
      }

      const payments = await fetchOwnerPayments(config.horizonUrl, config.ownerAddress, {
        limit: 5,
      });
      switch (payments.status) {
        case "offline":
          return makeResult("fail", `Horizon is unreachable at ${config.horizonUrl}`);
        case "not_found":
          return makeResult(
            "warn",
            `${turns} local turn(s); owner account is not funded on testnet`,
          );
        case "ok": {
          // The optional lanes are best-effort: `[]` means not configured or
          // unreadable, which the detail reports as 0 rather than failing.
          const [p2p, anchor] = await Promise.all([loadP2pRows(), loadAnchorRows()]);
          return makeResult(
            "ok",
            `${turns} turn(s), ${payments.payments.length} payment(s), ${p2p.length} P2P offer(s), ${anchor.length} anchor row(s)`,
          );
        }
      }
    } catch (error) {
      return makeResult("fail", `history check failed: ${errorDetail(error)}`);
    }
  },
} satisfies FeatureCheck;
