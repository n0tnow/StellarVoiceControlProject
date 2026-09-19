/**
 * Typed, machine-readable errors for the schedule tools.
 *
 * Refusals are thrown (the shared `ChainToolResult` has no refusal field), and
 * the shell must match on `code`, never on the human `message`. Every public
 * entry point coerces hostile input (null, non-string, non-object) into one of
 * these types — a raw `TypeError` must never escape.
 *
 * `ScheduleAmbiguous` is deliberately a sibling type: it is not a refusal
 * (nothing was refused), it is the "I found more than one schedule, ask which"
 * signal the shell turns into a follow-up question.
 */

export type ScheduleRefusalCode =
  | "invalid_intent"
  | "invalid_amount"
  | "unsupported_asset"
  | "unknown_recipient"
  | "invalid_time"
  | "time_does_not_exist"
  | "time_in_past"
  | "unsupported_repeat"
  | "guard_rule_missing"
  | "amount_over_per_tx_limit"
  | "asset_not_allowed"
  | "too_many_schedules"
  | "allowance_insufficient"
  | "schedule_not_found"
  | "not_configured";

/** One schedule that could match a voice intent, for the "ask which" prompt. */
export interface ScheduleCandidate {
  id: number;
  recipientAlias: string | null;
  recipientAddress: string;
  asset: string;
  amountRaw: string;
  amount: string;
  nextRunUtc: string;
  intervalWords: string;
  runsLeft: number;
}

/** A typed schedule failure. Match on `code`; `details` is advisory context. */
export class ScheduleRefusal extends Error {
  readonly code: ScheduleRefusalCode;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(code: ScheduleRefusalCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "ScheduleRefusal";
    this.code = code;
    this.details = details;
  }
}

/** More than one schedule matches a recipient; the caller must ask which. */
export class ScheduleAmbiguous extends Error {
  readonly code = "schedule_ambiguous" as const;
  readonly candidates: ScheduleCandidate[];

  constructor(candidates: ScheduleCandidate[]) {
    super(
      `more than one active schedule matches this request (${candidates
        .map((c) => `#${c.id}`)
        .join(", ")}); ask which one before cancelling`,
    );
    this.name = "ScheduleAmbiguous";
    this.candidates = candidates;
  }
}

export function isScheduleRefusal(value: unknown): value is ScheduleRefusal {
  return value instanceof ScheduleRefusal;
}

export function isScheduleAmbiguous(value: unknown): value is ScheduleAmbiguous {
  return value instanceof ScheduleAmbiguous;
}
