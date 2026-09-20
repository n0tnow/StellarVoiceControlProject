/**
 * Private payments (SPP) readiness (milestone W9).
 *
 * Read-only and non-destructive: it verifies the pinned testnet contracts are
 * well-formed and that the Soroban RPC answers `getLatestLedger`. It never
 * proves, signs, or submits anything. The full private-payment loop is a Rust
 * SDK flow whose auth-entry signing is not wired to the wallet yet, so a `warn`
 * (RPC up, wallet signing not connected) is the expected healthy state.
 */
import {
  SPP_CONTRACTS,
  isContractId,
  loadSppStatus,
  summarizeSppStatus,
} from "@/lib/spp.ts";
import { errorDetail, makeResult } from "@/debug/runner.ts";
import type { FeatureCheck } from "@/debug/types.ts";

export default {
  id: "spp",
  title: "Private payments (SPP)",
  milestone: "W9",
  async run() {
    try {
      for (const [name, id] of Object.entries(SPP_CONTRACTS)) {
        if (!isContractId(id)) {
          return makeResult("fail", `the pinned ${name} contract id is malformed`);
        }
      }
      const summary = summarizeSppStatus(await loadSppStatus());
      if (summary.status === "fail") {
        return makeResult("fail", summary.detail);
      }
      return makeResult(
        "warn",
        `${summary.detail} Wallet signing is not wired (needs a signAuthEntry extension).`,
      );
    } catch (error) {
      return makeResult("fail", `SPP readiness check failed: ${errorDetail(error)}`);
    }
  },
} satisfies FeatureCheck;
