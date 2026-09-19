/**
 * `cancelSchedule` — resolve one of the owner's **active** schedules and build
 * an UNSIGNED `cancel_schedule(owner, id)` invocation plus a decoded summary.
 *
 * Resolution is explicit and never guesses: by id, or by recipient alias
 * (reverse-mapped through the alias book). If more than one active schedule
 * matches a recipient, `ScheduleAmbiguous` is thrown with the candidate list so
 * the shell can ask "which one?".
 *
 * Cancelling only tightens limits, so the result carries
 * `confirmation: "light"` (owner auth only; the contract does not mandate
 * Touch ID for `cancel_schedule`).
 */
import { resolveAlias } from "../payments/aliases.ts";
import { fromRawUnits } from "../guard/amount.ts";
import { ScheduleAmbiguous, ScheduleRefusal } from "./errors.ts";
import { assertScheduleDeps, notConfigured, reverseAliases, scheduleRefusalFromGuard } from "./internal.ts";
import { buildCancelScheduleSummary } from "./summary.ts";
import { assetCodeFor, candidateFor, nextRunUtc } from "./view.ts";
import type { ScheduleDeps, CancelScheduleResult } from "./types.ts";
import type { Schedule } from "../guard/types.ts";

const U32_MAX = 0xffff_ffff;

interface CancelRequest {
  id?: number;
  recipient?: string;
  which?: "last" | "next";
}

function parseRequest(request: unknown): CancelRequest {
  if (request === null || request === undefined || typeof request !== "object") {
    throw new ScheduleRefusal(
      "invalid_intent",
      `cancelSchedule expects { id } or { recipient, which? }, got ${JSON.stringify(request)}`,
    );
  }
  const raw = request as Record<string, unknown>;
  const out: CancelRequest = {};
  if (raw.id !== undefined && raw.id !== null) {
    if (typeof raw.id !== "number" || !Number.isInteger(raw.id) || raw.id < 0 || raw.id > U32_MAX) {
      throw new ScheduleRefusal(
        "invalid_intent",
        `schedule id must be an integer between 0 and ${U32_MAX}, got ${JSON.stringify(raw.id)}`,
      );
    }
    out.id = raw.id;
  }
  if (raw.recipient !== undefined && raw.recipient !== null) {
    if (typeof raw.recipient !== "string") {
      throw new ScheduleRefusal(
        "unknown_recipient",
        `recipient must be an alias string, got ${JSON.stringify(raw.recipient)}`,
      );
    }
    out.recipient = raw.recipient;
  }
  if (raw.which !== undefined && raw.which !== null) {
    if (raw.which !== "last" && raw.which !== "next") {
      throw new ScheduleRefusal("invalid_intent", `which must be "last" or "next", got ${JSON.stringify(raw.which)}`);
    }
    out.which = raw.which;
  }
  if (out.id === undefined && out.recipient === undefined) {
    throw new ScheduleRefusal("invalid_intent", "cancelSchedule needs a schedule id or a recipient alias");
  }
  return out;
}

function pickByRecipient(
  deps: ScheduleDeps,
  schedules: Schedule[],
  recipient: string,
  which: "last" | "next" | undefined,
): { schedule: Schedule; alias: string } {
  const alias = recipient.trim().toLowerCase();
  if (!alias) {
    throw new ScheduleRefusal("unknown_recipient", "a recipient alias is required; raw addresses are not accepted");
  }
  const entry = resolveAlias(deps.aliases, alias);
  if (!entry) {
    throw new ScheduleRefusal(
      "unknown_recipient",
      `recipient ${JSON.stringify(alias)} is not a known alias; raw addresses are not accepted`,
    );
  }
  const matches = schedules.filter((s) => s.to === entry.address);
  if (matches.length === 0) {
    throw new ScheduleRefusal(
      "schedule_not_found",
      `no active schedule pays ${alias}; nothing to cancel`,
    );
  }
  if (matches.length === 1) return { schedule: matches[0] as Schedule, alias };
  if (which === undefined) {
    const aliases = reverseAliases(deps.aliases);
    throw new ScheduleAmbiguous(matches.map((s) => candidateFor(deps, s, aliases)));
  }
  const sorted = [...matches].sort((a, b) =>
    Number(a.next_run_at) === Number(b.next_run_at) ? a.id - b.id : Number(a.next_run_at) - Number(b.next_run_at),
  );
  const schedule = which === "next" ? (sorted[0] as Schedule) : (sorted[sorted.length - 1] as Schedule);
  return { schedule, alias };
}

/**
 * Build the cancel tool. Safe against hostile input: every failure is a typed
 * `ScheduleRefusal`, or `ScheduleAmbiguous` for the "ask which" case.
 */
export function cancelSchedule(deps: ScheduleDeps): (request: unknown) => Promise<CancelScheduleResult> {
  assertScheduleDeps(deps, "cancelSchedule");
  if (typeof deps.guard.cancelSchedule !== "function" || typeof deps.guard.listSchedules !== "function") {
    throw notConfigured("cancelSchedule requires a guard client with cancelSchedule() and listSchedules()");
  }
  return async (request: unknown): Promise<CancelScheduleResult> => {
    const parsed = parseRequest(request);

    let schedules: Schedule[];
    try {
      schedules = await deps.guard.listSchedules(deps.ownerAddress);
    } catch (e) {
      throw scheduleRefusalFromGuard(e);
    }
    const active = schedules.filter((s) => s.active);

    let schedule: Schedule;
    let recipientAlias: string | null = null;
    if (parsed.id !== undefined) {
      const found = active.find((s) => s.id === parsed.id);
      if (!found) {
        throw new ScheduleRefusal(
          "schedule_not_found",
          `no active schedule with id ${parsed.id} for ${deps.ownerAddress}`,
        );
      }
      schedule = found;
      recipientAlias = reverseAliases(deps.aliases).get(schedule.to) ?? null;
    } else {
      const picked = pickByRecipient(deps, active, parsed.recipient as string, parsed.which);
      schedule = picked.schedule;
      recipientAlias = picked.alias;
    }

    let call: Awaited<ReturnType<ScheduleDeps["guard"]["cancelSchedule"]>>;
    try {
      call = await deps.guard.cancelSchedule(deps.ownerAddress, schedule.id);
    } catch (e) {
      throw scheduleRefusalFromGuard(e);
    }

    const { summary, payloadHash } = buildCancelScheduleSummary({
      unsignedXdr: call.unsignedXdr,
      networkPassphrase: deps.networkPassphrase,
      contractId: deps.guard.contractId,
      alias: recipientAlias,
      recipientAddress: schedule.to,
      assetCode: assetCodeFor(deps, schedule.asset),
      amount: fromRawUnits(schedule.amount),
      nextRunUtc: nextRunUtc(schedule),
      ...(deps.explorerBase ? { explorerBase: deps.explorerBase } : {}),
    });

    return {
      unsignedXdr: call.unsignedXdr,
      summary,
      payloadHash,
      confirmation: "light",
      id: schedule.id,
      recipientAlias,
    };
  };
}
