/**
 * Presentation helpers shared by `cancelSchedule` (ambiguity candidates) and
 * `listUpcoming` (the "Upcoming payments" rows). All chain values are decoded
 * from the `Schedule` struct; the alias is a display-only lookup.
 */
import { fromRawUnits } from "../guard/amount.ts";
import type { Schedule } from "../guard/types.ts";
import type { ScheduleCandidate } from "./errors.ts";
import { reverseAliases } from "./internal.ts";
import { intervalWords } from "./time.ts";
import type { ScheduleDeps } from "./types.ts";

/** Reverse the asset-code -> SAC table; falls back to the raw SAC id. */
export function assetCodeFor(deps: ScheduleDeps, assetSac: string): string {
  const table = deps.guardAssetContracts;
  if (table && typeof table === "object") {
    for (const [code, id] of Object.entries(table)) {
      if (id === assetSac) return code.toUpperCase();
    }
  }
  return assetSac;
}

export function nextRunUtc(schedule: Schedule): string {
  return new Date(Number(schedule.next_run_at) * 1000).toISOString();
}

export function candidateFor(
  deps: ScheduleDeps,
  schedule: Schedule,
  aliases: Map<string, string> = reverseAliases(deps.aliases),
): ScheduleCandidate {
  return {
    id: schedule.id,
    recipientAlias: aliases.get(schedule.to) ?? null,
    recipientAddress: schedule.to,
    asset: assetCodeFor(deps, schedule.asset),
    amountRaw: schedule.amount.toString(),
    amount: fromRawUnits(schedule.amount),
    nextRunUtc: nextRunUtc(schedule),
    intervalWords: intervalWords(Number(schedule.interval_secs)),
    runsLeft: schedule.runs_left,
  };
}
