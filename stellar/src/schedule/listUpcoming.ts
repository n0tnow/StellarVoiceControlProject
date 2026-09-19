/**
 * `listUpcoming` — the "Upcoming payments" view models.
 *
 * Reads the owner's active schedules and grades each one against an injected
 * clock and the keeper poll interval:
 *
 *  - `scheduled` — the next run is still in the future
 *  - `due`       — due now, less than 2 poll intervals late
 *  - `delayed`   — 2 poll intervals or more late ("the keeper may be offline")
 *  - `finished`  — no runs left / inactive (defensive; `list_schedules`
 *                  normally omits these)
 *
 * The design's **"failing/retrying"** status is intentionally not modelled:
 * the contract exposes no on-chain failure signal (only `active` and
 * `runs_left`), so a run that failed to settle is indistinguishable from a
 * keeper that has not fired yet. The UI lane (T5) should read a long-`delayed`
 * row as "possibly failing". No `getAllowance` read is needed here (this is a
 * pure read), but `schedulePayment` requires it.
 *
 * Sorted by next run (then id). The local time is rendered in the requested
 * IANA zone; the chain value itself is always UTC epoch seconds.
 */
import { fromRawUnits } from "../guard/amount.ts";
import type { Schedule } from "../guard/types.ts";
import { DEFAULT_POLL_SECONDS } from "./constants.ts";
import { ScheduleRefusal } from "./errors.ts";
import {
  assertScheduleDeps,
  notConfigured,
  reverseAliases,
  scheduleRefusalFromGuard,
} from "./internal.ts";
import { formatInZone, intervalWords, isValidTimeZone } from "./time.ts";
import { assetCodeFor } from "./view.ts";
import type { ListUpcomingOptions, ScheduleDeps, UpcomingPayment } from "./types.ts";

function coerceNow(now: unknown): Date {
  if (now === undefined || now === null) return new Date();
  const date = now instanceof Date ? now : new Date(now as string | number);
  if (Number.isNaN(date.getTime())) {
    throw new ScheduleRefusal("invalid_time", `"now" is not a valid date: ${JSON.stringify(now)}`);
  }
  return date;
}

function parseOptions(options: unknown): ListUpcomingOptions {
  if (options === null || options === undefined || typeof options !== "object") {
    throw new ScheduleRefusal(
      "invalid_intent",
      `listUpcoming expects { now?, timeZone }, got ${JSON.stringify(options)}`,
    );
  }
  const raw = options as Record<string, unknown>;
  if (!isValidTimeZone(raw.timeZone)) {
    throw new ScheduleRefusal(
      "invalid_time",
      `timeZone must be a valid IANA zone, got ${JSON.stringify(raw.timeZone)}`,
    );
  }
  const out: ListUpcomingOptions = { timeZone: raw.timeZone };
  if (raw.now !== undefined) out.now = raw.now as Date | number;
  return out;
}

function grade(schedule: Schedule, nowSeconds: number, pollSeconds: number): UpcomingPayment["status"] {
  if (!schedule.active || schedule.runs_left <= 0) return "finished";
  const due = Number(schedule.next_run_at);
  if (nowSeconds < due) return "scheduled";
  return nowSeconds - due < 2 * pollSeconds ? "due" : "delayed";
}

export function listUpcoming(deps: ScheduleDeps): (options: unknown) => Promise<UpcomingPayment[]> {
  assertScheduleDeps(deps, "listUpcoming");
  if (typeof deps.guard.listSchedules !== "function") {
    throw notConfigured("listUpcoming requires a guard client with listSchedules()");
  }
  const pollSeconds = deps.pollSeconds ?? DEFAULT_POLL_SECONDS;
  if (typeof pollSeconds !== "number" || !Number.isFinite(pollSeconds) || pollSeconds <= 0) {
    throw new ScheduleRefusal("not_configured", "deps.pollSeconds must be a positive number");
  }
  return async (options: unknown): Promise<UpcomingPayment[]> => {
    const parsed = parseOptions(options);
    const now = coerceNow(parsed.now);
    const nowSeconds = Math.floor(now.getTime() / 1000);

    let schedules: Schedule[];
    try {
      schedules = await deps.guard.listSchedules(deps.ownerAddress);
    } catch (e) {
      throw scheduleRefusalFromGuard(e);
    }
    const aliases = reverseAliases(deps.aliases);

    return schedules
      .map((schedule): UpcomingPayment => {
        const due = Number(schedule.next_run_at);
        return {
          id: schedule.id,
          recipientAlias: aliases.get(schedule.to) ?? null,
          recipientAddress: schedule.to,
          asset: assetCodeFor(deps, schedule.asset),
          amountRaw: schedule.amount.toString(),
          amount: fromRawUnits(schedule.amount),
          nextRunUtc: new Date(due * 1000).toISOString(),
          nextRunLocal: formatInZone(due, parsed.timeZone),
          runsLeft: schedule.runs_left,
          intervalWords: intervalWords(Number(schedule.interval_secs)),
          status: grade(schedule, nowSeconds, pollSeconds),
        };
      })
      .sort((a, b) => (a.nextRunUtc === b.nextRunUtc ? a.id - b.id : a.nextRunUtc < b.nextRunUtc ? -1 : 1));
  };
}
