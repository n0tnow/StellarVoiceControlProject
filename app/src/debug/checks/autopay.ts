/**
 * Automatic payments (W11b).
 *
 * Non-destructive: it reads the executor status and the on-chain rule, executor,
 * alias book and spent-today counter, and never signs or moves funds. `ok` means
 * the account is armed (executor + positive auto-approve limit); `warn` means the
 * commands are absent or auto-pay is off; `fail` means the state could not be
 * read.
 */
import { guard } from "@polaris/stellar";

import { createAutoPayCommands, isAutoPaySupported } from "@/lib/autopayLive";
import { loadSecurityState } from "@/lib/guardStateLive";
import { errorDetail, makeResult } from "@/debug/runner";
import type { FeatureCheck } from "@/debug/types";

export default {
  id: "autopay",
  title: "Automatic payments (auto-pay)",
  milestone: "W11",
  async run() {
    try {
      if (!(await isAutoPaySupported())) {
        return makeResult("warn", "The executor commands are not present on this build; auto-pay is off.");
      }
      const status = await createAutoPayCommands().executorStatus();
      const load = await loadSecurityState();
      if (load.kind === "unconfigured") return makeResult("warn", load.detail);
      if (load.kind === "unreachable") return makeResult("fail", load.detail);

      const state = load.state;
      const rule = state.rule;
      const armed = state.executor !== null && (rule?.auto_approve_limit ?? 0n) > 0n;
      const aliases = state.aliases.filter((alias) => alias.onChain !== null).length;
      const detail = [
        `executor ${status.address ? guard.shortKey(status.address) : "none"}`,
        `auto limit ${rule ? guard.fromRawUnits(rule.auto_approve_limit) : "0"} ${state.assetSymbol}`,
        `spent today ${guard.fromRawUnits(state.spentTodayRaw)} ${state.assetSymbol}`,
        `${aliases} aliases on-chain`,
      ].join(" · ");
      return makeResult(armed ? "ok" : "warn", armed ? detail : `${detail} (not armed; every payment asks)`);
    } catch (error) {
      return makeResult("fail", `auto-pay read failed: ${errorDetail(error)}`);
    }
  },
} satisfies FeatureCheck;
