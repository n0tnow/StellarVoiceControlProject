/**
 * `schedulePayment` — a validated `ScheduleDraft` becomes an UNSIGNED
 * `create_schedule` invocation plus a summary decoded from that XDR.
 *
 * Boundaries (deliberate):
 *  - No signing, no submission. The owner must sign (`owner` is the source).
 *  - The recipient is resolved ONLY through the alias book; raw `G...`
 *    addresses are refused (same rule as `payments`).
 *  - Pre-checks run against the owner's on-chain rule, their active schedule
 *    count and the **mandatory** SAC allowance (`deps.getAllowance` is
 *    required; design §2 normative rule — every guard payment, schedule runs
 *    and XLM included, settles through `transfer_from`).
 *  - Warnings never block: F-03 recipient rules, DST ambiguity, a per-run
 *    amount at/above the daily limit, and the keeper dependency.
 *
 * A `repeat` with `runs` omitted becomes **one** run (safe default); the AGENT
 * layer must ask "for how many?" first (design §11b).
 */
import type { AssetSpec } from "../payments/assets.ts";
import { resolveAlias } from "../payments/aliases.ts";
import { toRawUnits } from "../guard/amount.ts";
import { resolveLocalTime } from "./time.ts";
import { buildCreateScheduleSummary } from "./summary.ts";
import { ScheduleRefusal } from "./errors.ts";
import {
  assertScheduleDeps,
  guardAssetContract,
  scheduleRefusalFromGuard,
} from "./internal.ts";
import type { ScheduleDeps, SchedulePaymentResult, FirstRun } from "./types.ts";

/** Max active schedules per owner (contract `TooManySchedules`, #114). */
export const MAX_SCHEDULES = 25;

/** 1-7 fraction digits, at most 12 integer digits, no sign/exponent/whitespace. */
const AMOUNT_RE = /^\d{1,12}(\.\d{1,7})?$/;
/** Stellar amounts are int64 stroops. */
const MAX_STROOPS = 9_223_372_036_854_775_807n;
const U32_MAX = 0xffff_ffff;

const DAY_SECONDS = 86_400;
const WEEK_SECONDS = 604_800;

const F03_WARNING =
  "Recipient rules are not re-checked at run time (F-03): polaris_guard schedules ignore " +
  "known_recipients_only; only the hard caps (per-tx, daily) and allowed assets apply.";
const KEEPER_WARNING =
  "Scheduled payments run only while a keeper is online; expect roughly 15-25 s after the due time.";

function invalidIntent(message: string): ScheduleRefusal {
  return new ScheduleRefusal("invalid_intent", message);
}

function assertPositiveAmount(amount: unknown): string {
  if (typeof amount !== "string" || !AMOUNT_RE.test(amount)) {
    throw new ScheduleRefusal(
      "invalid_amount",
      `amount must be a positive decimal string with 1-7 fraction digits and at most 12 integer digits, got ${JSON.stringify(amount)}`,
    );
  }
  const [whole, frac = ""] = amount.split(".") as [string, string?];
  const stroops = BigInt(whole) * 10_000_000n + BigInt(frac.padEnd(7, "0"));
  if (stroops <= 0n) {
    throw new ScheduleRefusal("invalid_amount", `amount must be greater than zero, got ${JSON.stringify(amount)}`);
  }
  if (stroops > MAX_STROOPS) {
    throw new ScheduleRefusal("invalid_amount", `amount ${JSON.stringify(amount)} exceeds the maximum Stellar amount`);
  }
  return amount;
}

function parseRuns(runs: unknown): number {
  if (typeof runs !== "number" || !Number.isInteger(runs) || runs < 1 || runs > U32_MAX) {
    throw invalidIntent(`runs must be an integer between 1 and ${U32_MAX}, got ${JSON.stringify(runs)}`);
  }
  return runs;
}

function parseFirstRun(value: unknown): FirstRun {
  if (value === null || value === undefined || typeof value !== "object") {
    throw new ScheduleRefusal(
      "invalid_time",
      `firstRun must be an object with localDate, localTime and timeZone, got ${JSON.stringify(value)}`,
    );
  }
  const first = value as Record<string, unknown>;
  const { localDate, localTime, timeZone } = first;
  if (typeof localDate !== "string" || typeof localTime !== "string" || typeof timeZone !== "string") {
    throw new ScheduleRefusal(
      "invalid_time",
      `firstRun must have string localDate, localTime and timeZone, got ${JSON.stringify(value)}`,
    );
  }
  return { localDate, localTime, timeZone };
}

interface IntervalResolution {
  intervalSecs: number;
  runs: number;
}

/** Map `repeat` + `runs` to `(interval_secs, runs)`; monthly repeats are refused. */
function resolveInterval(repeat: unknown, runsInput: unknown): IntervalResolution {
  if (repeat === undefined || repeat === null) {
    if (runsInput !== undefined && runsInput !== null && runsInput !== 1) {
      throw new ScheduleRefusal(
        "unsupported_repeat",
        `a one-shot schedule has runs = 1; pass a repeat (day/week/custom) to run it more than once (got runs ${JSON.stringify(runsInput)})`,
      );
    }
    return { intervalSecs: 0, runs: 1 };
  }
  if (typeof repeat !== "object") {
    throw new ScheduleRefusal(
      "unsupported_repeat",
      `repeat must be an object ({ every: "day"|"week"|"custom" }), got ${JSON.stringify(repeat)}`,
    );
  }
  const every = (repeat as { every?: unknown }).every;
  const runs = runsInput === undefined || runsInput === null ? 1 : parseRuns(runsInput);
  if (every === "day") return { intervalSecs: DAY_SECONDS, runs };
  if (every === "week") return { intervalSecs: WEEK_SECONDS, runs };
  if (every === "custom") {
    const custom = (repeat as { customSeconds?: unknown }).customSeconds;
    if (
      typeof custom !== "number" ||
      !Number.isSafeInteger(custom) ||
      custom < 1
    ) {
      throw new ScheduleRefusal(
        "unsupported_repeat",
        `repeat.customSeconds must be a positive integer number of seconds, got ${JSON.stringify(custom)}`,
      );
    }
    return { intervalSecs: custom, runs };
  }
  throw new ScheduleRefusal(
    "unsupported_repeat",
    `repeat.every ${JSON.stringify(every)} is not supported; only fixed-second intervals (day/week/custom) can be scheduled — monthly or "end of month" repeats are out of scope`,
  );
}

interface ParsedDraft {
  alias: string;
  address: string;
  assetCode: string;
  assetSac: string;
  amount: string;
  amountRaw: bigint;
  intervalSecs: number;
  runs: number;
  firstRun: FirstRun;
}

function parseDraft(deps: ScheduleDeps, draft: unknown): ParsedDraft {
  if (draft === null || draft === undefined || typeof draft !== "object") {
    throw invalidIntent(`schedulePayment expects a ScheduleDraft object, got ${JSON.stringify(draft)}`);
  }
  const raw = draft as Record<string, unknown>;

  if (typeof raw.asset !== "string") {
    throw new ScheduleRefusal(
      "unsupported_asset",
      `asset must be a string code (allowed: USDC, XLM), got ${JSON.stringify(raw.asset)}`,
    );
  }
  const spec: AssetSpec | undefined = deps.assets.get(raw.asset);
  if (!spec) {
    throw new ScheduleRefusal(
      "unsupported_asset",
      `asset ${JSON.stringify(raw.asset)} is not supported (allowed: USDC, XLM)`,
    );
  }
  const assetSac = guardAssetContract(deps, spec.code);
  if (!assetSac) {
    throw new ScheduleRefusal(
      "unsupported_asset",
      `no SAC contract id is configured for scheduled ${spec.code} payments`,
    );
  }

  const amount = assertPositiveAmount(raw.amount);
  let amountRaw: bigint;
  try {
    amountRaw = toRawUnits(amount);
  } catch (e) {
    throw new ScheduleRefusal("invalid_amount", `amount ${JSON.stringify(amount)} is not representable: ${(e as Error).message}`);
  }

  if (typeof raw.recipient !== "string") {
    throw new ScheduleRefusal(
      "unknown_recipient",
      `recipient must be an alias string, got ${JSON.stringify(raw.recipient)}`,
    );
  }
  const alias = raw.recipient.trim().toLowerCase();
  if (!alias) {
    throw new ScheduleRefusal("unknown_recipient", "a recipient alias is required; raw addresses are not accepted");
  }
  const entry = resolveAlias(deps.aliases, alias);
  if (!entry) {
    throw new ScheduleRefusal(
      "unknown_recipient",
      `recipient ${JSON.stringify(alias)} is not a known alias; add it to the alias book first (raw addresses are not accepted)`,
    );
  }

  const { intervalSecs, runs } = resolveInterval(raw.repeat, raw.runs);
  const firstRun = parseFirstRun(raw.firstRun);

  return {
    alias,
    address: entry.address,
    assetCode: spec.code,
    assetSac,
    amount,
    amountRaw,
    intervalSecs,
    runs,
    firstRun,
  };
}

/**
 * Build the schedule tool. The returned function is safe against hostile
 * input: every failure is a typed `ScheduleRefusal`.
 */
export function schedulePayment(deps: ScheduleDeps): (draft: unknown) => Promise<SchedulePaymentResult> {
  assertScheduleDeps(deps, "schedulePayment");
  if (typeof deps.guard.createSchedule !== "function") {
    throw new ScheduleRefusal("not_configured", "schedulePayment requires a guard client with createSchedule()");
  }
  // The SAC allowance is mandatory for every guard payment; this defensive
  // runtime check covers plain-JS callers that bypass the required TS field.
  if (typeof deps.getAllowance !== "function") {
    throw new ScheduleRefusal(
      "not_configured",
      "the SAC allowance is mandatory for every guard payment; inject getAllowance",
    );
  }
  return async (draft: unknown): Promise<SchedulePaymentResult> => {
    const parsed = parseDraft(deps, draft);

    const now = deps.now ? deps.now() : new Date();
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
      throw new ScheduleRefusal("invalid_time", "the injected clock returned an invalid Date");
    }
    const resolved = resolveLocalTime({ ...parsed.firstRun, now });

    // -- guard pre-checks, in the documented order -------------------------
    let rule: Awaited<ReturnType<ScheduleDeps["guard"]["getRule"]>>;
    try {
      rule = await deps.guard.getRule(deps.ownerAddress);
    } catch (e) {
      throw scheduleRefusalFromGuard(e);
    }
    if (!rule) {
      throw new ScheduleRefusal(
        "guard_rule_missing",
        `no polaris_guard rule is published for ${deps.ownerAddress}`,
      );
    }

    if (!rule.allowed_assets.includes(parsed.assetSac)) {
      throw new ScheduleRefusal(
        "asset_not_allowed",
        `asset ${parsed.assetCode} (${parsed.assetSac}) is not in the owner's allowed_assets`,
        { assetSac: parsed.assetSac },
      );
    }

    if (parsed.amountRaw > rule.per_tx_limit) {
      throw new ScheduleRefusal(
        "amount_over_per_tx_limit",
        `amount ${parsed.amount} ${parsed.assetCode} exceeds the per-transaction limit`,
        { amountRaw: parsed.amountRaw, perTxLimit: rule.per_tx_limit },
      );
    }

    let schedules: Awaited<ReturnType<ScheduleDeps["guard"]["listSchedules"]>>;
    try {
      schedules = await deps.guard.listSchedules(deps.ownerAddress);
    } catch (e) {
      throw scheduleRefusalFromGuard(e);
    }
    const activeCount = schedules.filter((s) => s.active).length;
    if (activeCount >= MAX_SCHEDULES) {
      throw new ScheduleRefusal(
        "too_many_schedules",
        `the owner already has ${activeCount} active schedules (max ${MAX_SCHEDULES}); cancel one first`,
        { activeCount, max: MAX_SCHEDULES },
      );
    }

    const neededRaw = parsed.amountRaw * BigInt(parsed.runs);
    let availableRaw: bigint;
    try {
      availableRaw = await deps.getAllowance(parsed.assetSac);
    } catch (e) {
      throw scheduleRefusalFromGuard(e);
    }
    if (availableRaw < neededRaw) {
      throw new ScheduleRefusal(
        "allowance_insufficient",
        `the SAC allowance is ${availableRaw} raw units but this schedule needs ${neededRaw}; approve a larger allowance first`,
        { neededRaw, availableRaw, assetSac: parsed.assetSac },
      );
    }

    // -- build the unsigned invocation -------------------------------------
    let call: Awaited<ReturnType<ScheduleDeps["guard"]["createSchedule"]>>;
    try {
      call = await deps.guard.createSchedule(
        deps.ownerAddress,
        parsed.address,
        parsed.assetSac,
        parsed.amountRaw,
        BigInt(resolved.epochSeconds),
        BigInt(parsed.intervalSecs),
        parsed.runs,
      );
    } catch (e) {
      throw scheduleRefusalFromGuard(e);
    }

    const { summary, payloadHash } = buildCreateScheduleSummary({
      unsignedXdr: call.unsignedXdr,
      networkPassphrase: deps.networkPassphrase,
      contractId: deps.guard.contractId,
      alias: parsed.alias,
      assetCode: parsed.assetCode,
      timeZone: parsed.firstRun.timeZone,
      ...(deps.explorerBase ? { explorerBase: deps.explorerBase } : {}),
    });

    const warnings: string[] = [F03_WARNING];
    if (resolved.ambiguous) {
      warnings.push(
        `The local time ${resolved.localIso} is ambiguous (the clocks fall back); the earlier of the two possible instants was selected — double-check the first run.`,
      );
    }
    if (parsed.amountRaw >= rule.daily_limit) {
      warnings.push(
        `A single run of ${parsed.amount} ${parsed.assetCode} meets or exceeds the daily limit; the scheduled run may be rejected at run time.`,
      );
    }
    warnings.push(KEEPER_WARNING);

    return { unsignedXdr: call.unsignedXdr, summary, payloadHash, warnings };
  };
}
