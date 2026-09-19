/**
 * Builders for the auto-pay enable / disable / tighten flows (D10b/D10c).
 *
 * Every step is an **unsigned** owner-signed Soroban invocation plus a summary
 * decoded from that exact XDR — never from the caller's draft. The shell shows
 * ONE approval card listing all three enable steps and asks for ONE Touch ID,
 * then submits them in order.
 *
 * ARMED ORDER (enable) — the executor registration is ALWAYS LAST:
 *
 *   1. approve       — SAC allowance to the guard (the money).
 *   2. set_rule      — publish the limits (auto_approve_limit, per_tx, daily,
 *                      allowed assets, known-recipients-only).
 *   3. set_executor  — register the agent as executor; this is the step that
 *                      actually arms unattended payments.
 *
 * Why this order (coordinator decision, overriding the design doc's
 * "allowance last"): the SAC allowance is mandatory for every guard payment, so
 * the Always-ask baseline already has one. What arms unattended payments is the
 * executor registration together with a positive `auto_approve_limit`, so the
 * executor is the final arming step. Any prefix of the sequence therefore fails
 * closed:
 *
 *   • after 1 (approve): only the allowance changed. There is still no executor
 *     and the baseline rule's `auto_approve_limit` is 0, so no `pay_executor`.
 *   • after 2 (set_rule): the new positive rule is live but no executor is
 *     registered, so nobody can auto-pay.
 *   • after 3 (set_executor): armed — executor + positive rule + allowance.
 *
 * Disable reverses the arming first: `revoke_executor` (disarm), then the
 * optional `approve(0)` kill switch.
 *
 * Browser-safe: no `Buffer`, no `node:` imports.
 */
import { nativeToScVal } from "@stellar/stellar-sdk";
import {
  ALLOWANCE_WINDOW_DAYS,
  allowanceExpiryLedger,
  buildApproveAllowance,
  formatAllowance,
} from "../guard/allowance.ts";
import { buildGuardCallSummary, decodeInvocation, shortKey } from "../guard/describe.ts";
import { buildUnsignedInvoke } from "../guard/invoke.ts";
import type { GuardClient, GuardRpcLike, Rule } from "../guard/types.ts";
import {
  assertTightening,
  classifyChange,
  confirmationLevel,
  type ChangeKind,
  type ConfirmationLevel,
} from "./classify.ts";
import {
  ApprovalError,
  ruleFromDraft,
  validateAutoPayDraft,
  validateBaselineSetup,
  type AutoPayDraft,
  type BaselineSetupInput,
} from "./types.ts";

/** Each protocol ledger is ~5s (USDC guard demo window), used for card dates. */
export const LEDGER_SECONDS = 5;

/** Card copy: the allowance must cover every active schedule's total. */
const SCHEDULE_ALLOWANCE_NOTE =
  "Schedules need the allowance to cover their total: an active schedule whose total exceeds the allowance will fail.";
/** Card copy: revoking the executor does not touch already-created schedules. */
const REVOKE_EXECUTOR_SCHEDULE_CAVEAT =
  "Revoking the executor does not stop schedules that already exist (cancel them separately).";
/** Card copy: the allowance kill switch is global. */
const REVOKE_ALLOWANCE_KILL_SWITCH_CAVEAT =
  "Revoking the allowance disables ALL guard payments, including ones you approve yourself.";
/** Card copy: the baseline state leaves the executor unregistered. */
const ALWAYS_ASK_NOTE = "Always ask: every payment will need your approval.";
/**
 * Card copy: step 3 (`set_executor`) is the arming step. Placed first on the
 * enable card so the owner cannot miss what actually turns on unattended pay.
 */
export const ARMING_STEP_NOTE =
  "Step 3 (set_executor) registers the agent and arms unattended payments up to the threshold; until then nothing can be paid without your approval.";

export type ApprovalStepKind = "set_executor" | "set_rule" | "approve" | "revoke_executor";

/** One unsigned, assembled step of an approval flow. */
export interface BuiltApprovalStep {
  kind: ApprovalStepKind;
  unsignedXdr: string;
  /** hex sha256 of the transaction signature base (`tx.hash()`). */
  payloadHash: string;
}

/** One action on the approval card, with lines decoded from that step's XDR. */
export interface ApprovalActionSummary {
  kind: ApprovalStepKind;
  lines: string[];
  /** Marks the step that arms unattended payments (`set_executor` on enable). */
  arming?: boolean;
}

/** The money/limits the card must surface, straight from the draft. */
export interface ApprovalExposure {
  thresholdRaw: bigint;
  dailyLimitRaw: bigint;
  allowanceRaw: bigint;
  /** `YYYY-MM-DD HH:mm` in the requested zone. */
  allowanceExpiresLocal: string;
  /** ISO-8601 UTC. */
  allowanceExpiresUtc: string;
}

export interface ApprovalCardSummary {
  title: string;
  actions: ApprovalActionSummary[];
  exposure?: ApprovalExposure;
  /** Extra card copy: caveats, warnings and allowance deltas (never signed). */
  notes: string[];
  confirmation: ConfirmationLevel;
}

export interface EnableAutoPayResult {
  steps: [BuiltApprovalStep, BuiltApprovalStep, BuiltApprovalStep];
  summary: ApprovalCardSummary;
  order: ["approve", "set_rule", "set_executor"];
}

export interface EnableAutoPayDeps {
  owner: string;
  guard: GuardClient;
  rpc: GuardRpcLike;
  networkPassphrase: string;
  /**
   * The allowance currently approved on the SAC, when known. Drives the
   * "Allowance: old -> new" line and the lower-allowance WARNING; it is never
   * used to build the XDR (the caller reads it read-only).
   */
  currentAllowanceRaw?: bigint;
  /**
   * The current on-chain arming state, when known. When provided and the
   * account is already armed (`executor` registered AND
   * `rule.auto_approve_limit > 0`), the builder refuses with
   * `ApprovalError("already_armed")` and builds nothing, pointing at the
   * tighten/disable flows. When omitted, behaviour is unchanged — but the
   * caller MUST ensure a not-armed baseline (no executor, threshold 0), or the
   * prefix-safety guarantee does not hold.
   */
  current?: { rule?: Rule | undefined; executor?: string | undefined };
  /** Injected clock for the exposure dates. */
  now?: () => Date;
  /** IANA zone for `allowanceExpiresLocal` (default UTC). */
  timeZone?: string;
  txTimeoutSeconds?: number;
  explorerBase?: string;
}

/** Result of the Always-ask baseline setup: allowance + rule, no executor. */
export interface BaselineSetupResult {
  steps: [BuiltApprovalStep, BuiltApprovalStep];
  summary: ApprovalCardSummary;
  order: ["approve", "set_rule"];
}

export interface DisableAutoPayDeps {
  owner: string;
  guard: GuardClient;
  rpc: GuardRpcLike;
  networkPassphrase: string;
  /** SAC contract id to approve 0 on; required only when revoking the allowance. */
  assetContractId?: string;
  /** Allowance window for the (irrelevant but valid) live_until of the revoke. */
  days?: number;
  txTimeoutSeconds?: number;
  explorerBase?: string;
}

export interface DisableAutoPayInput {
  /** Also approve 0 on the SAC to revoke the remaining allowance (kill switch). */
  revokeAllowance: boolean;
}

export interface DisableAutoPayResult {
  steps: BuiltApprovalStep[];
  summary: ApprovalCardSummary;
  order: ApprovalStepKind[];
  confirmation: "light";
}

export interface RuleChangeDeps {
  owner: string;
  guard: GuardClient;
  /** The rule currently on chain, if known; drives the classification. */
  current?: Rule | undefined;
}

export interface TightenRuleOptions {
  /**
   * Opt out of the default refusal of loosening/mixed/new-rule changes. When
   * `true`, the loosening step is still built and returned with the full
   * `card_and_touch_id` confirmation (it must not be submitted under the light
   * label). Defaults to `false`: loosening is refused with `use_enable_flow`.
   */
  allowLoosening?: boolean;
}

export interface TightenRuleResult {
  /** Empty when the change is a no-op (`classification === "same"`). */
  steps: BuiltApprovalStep[];
  classification: ChangeKind;
  confirmation: ConfirmationLevel;
}

/**
 * TODO(T1-fix): this duplicates `guard/describe.ts`'s private `describeValue`.
 * The guard module does not export it, and `stellar/src/guard/**` is outside
 * this task's scope, so it cannot be imported here. Export it from the guard
 * module (and delete this copy) when that module is next changed.
 *
 * Render a decoded argument for a one-line card summary.
 */
function describeValue(value: unknown): string {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return `[${value.map(describeValue).join(", ")}]`;
  if (value === null || value === undefined) return String(value);
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).map(([k, v]) => `${k}: ${describeValue(v)}`);
    return `{ ${entries.join(", ")} }`;
  }
  return String(value);
}

/**
 * Function name, contract and argument values decoded from the produced XDR.
 * These lines are the card's proof of what will be signed.
 */
function decodedLines(unsignedXdr: string, networkPassphrase: string): string[] {
  const decoded = decodeInvocation(unsignedXdr, networkPassphrase);
  return [
    `Function: ${decoded.functionName} (${shortKey(decoded.contractId)})`,
    `Args: ${decoded.args.map(describeValue).join(", ")}`,
  ];
}

/**
 * Decode the `Rule` argument of a built `set_rule` call back out of its XDR.
 * The card's exposure must be proof of the signed XDR, not of the caller's
 * draft (they are built from the same values, but only the XDR is signed).
 */
function ruleFromSetRuleXdr(unsignedXdr: string, networkPassphrase: string): Rule {
  const decoded = decodeInvocation(unsignedXdr, networkPassphrase);
  return decoded.args[1] as Rule;
}

/**
 * An account is already armed when an executor is registered **and** the rule's
 * `auto_approve_limit` is positive; either condition alone still fails closed.
 */
function isAlreadyArmed(current: EnableAutoPayDeps["current"]): boolean {
  if (!current) return false;
  const { rule, executor } = current;
  return typeof executor === "string" && executor.length > 0 && (rule?.auto_approve_limit ?? 0n) > 0n;
}

/** Deterministic `YYYY-MM-DD HH:mm` in an IANA zone (no locale surprises). */
function formatInTimeZone(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const pick = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
  return `${pick("year")}-${pick("month")}-${pick("day")} ${pick("hour")}:${pick("minute")}`;
}

/**
 * Card lines for a change to the SAC allowance: always the old -> new delta
 * when the current value is known, plus a WARNING when the allowance shrinks
 * (a smaller allowance can starve already-created schedules).
 */
function allowanceChangeNotes(currentAllowanceRaw: bigint | undefined, nextAllowanceRaw: bigint): string[] {
  if (currentAllowanceRaw === undefined) return [];
  const notes = [`Allowance: ${formatAllowance(currentAllowanceRaw)} -> ${formatAllowance(nextAllowanceRaw)}`];
  if (nextAllowanceRaw < currentAllowanceRaw) {
    notes.push("WARNING: the new allowance is lower than the current one and may break scheduled payments.");
  }
  return notes;
}

/**
 * Build the three-step enable flow. Validates the draft first; any failure is a
 * typed `ApprovalError` and nothing is built.
 */
export async function buildEnableAutoPay(
  deps: EnableAutoPayDeps,
  draft: AutoPayDraft,
): Promise<EnableAutoPayResult> {
  validateAutoPayDraft(draft);
  const assetContractId = draft.allowedAssets[0];
  if (!assetContractId) throw new ApprovalError("no_assets", "at least one allowed asset is required");

  // Fail closed on an already-armed account: the prefix-safety proof only holds
  // from a not-armed baseline, and re-enabling would re-sign an armed state.
  if (isAlreadyArmed(deps.current)) {
    throw new ApprovalError(
      "already_armed",
      "this account is already armed for unattended payments; use the tighten flow to lower the limits or the disable flow to revoke the executor before enabling again",
    );
  }

  const { owner, guard, networkPassphrase } = deps;
  const rule = ruleFromDraft(draft);

  // Built and submitted in arming order: allowance, rule, then executor last.
  const approveCall = await buildApproveAllowance(deps.rpc, {
    assetContractId,
    from: owner,
    spender: guard.contractId,
    amount: draft.allowanceRaw,
    networkPassphrase,
    days: draft.allowanceDays,
    ...(deps.txTimeoutSeconds !== undefined ? { txTimeoutSeconds: deps.txTimeoutSeconds } : {}),
    ...(deps.explorerBase ? { explorerBase: deps.explorerBase } : {}),
  });
  const setRuleCall = await guard.setRule(owner, rule);
  const setExecutorCall = await guard.setExecutor(owner, draft.executor);
  const decodedRule = ruleFromSetRuleXdr(setRuleCall.unsignedXdr, networkPassphrase);

  const steps: [BuiltApprovalStep, BuiltApprovalStep, BuiltApprovalStep] = [
    { kind: "approve", unsignedXdr: approveCall.unsignedXdr, payloadHash: approveCall.payloadHash },
    { kind: "set_rule", unsignedXdr: setRuleCall.unsignedXdr, payloadHash: setRuleCall.payloadHash },
    { kind: "set_executor", unsignedXdr: setExecutorCall.unsignedXdr, payloadHash: setExecutorCall.payloadHash },
  ];

  const now = deps.now ? deps.now() : new Date();
  const ledgersRemaining = approveCall.liveUntilLedger - approveCall.currentLedger;
  const expiresAt = new Date(now.getTime() + ledgersRemaining * LEDGER_SECONDS * 1000);

  return {
    steps,
    order: ["approve", "set_rule", "set_executor"],
    summary: {
      title: "Enable automatic payments (3 owner signatures, 1 approval)",
      actions: steps.map((step) => ({
        kind: step.kind,
        lines: decodedLines(step.unsignedXdr, networkPassphrase),
        ...(step.kind === "set_executor" ? { arming: true } : {}),
      })),
      exposure: {
        // Decoded back from the signed `set_rule` XDR, never the draft.
        thresholdRaw: decodedRule.auto_approve_limit,
        dailyLimitRaw: decodedRule.daily_limit,
        allowanceRaw: draft.allowanceRaw,
        allowanceExpiresLocal: formatInTimeZone(expiresAt, deps.timeZone ?? "UTC"),
        allowanceExpiresUtc: expiresAt.toISOString(),
      },
      notes: [
        ARMING_STEP_NOTE,
        SCHEDULE_ALLOWANCE_NOTE,
        ...allowanceChangeNotes(deps.currentAllowanceRaw, draft.allowanceRaw),
      ],
      confirmation: "card_and_touch_id",
    },
  };
}

/**
 * Build the **Always-ask baseline setup**: the mandatory SAC allowance plus the
 * default rule, with **no executor**. This is the state every owner needs even
 * for owner-signed payments; enabling auto-pay later adds `set_executor` on top.
 *
 * Steps: `[approve, set_rule]`. Both are decoded back into the card summary,
 * and the card states that every payment will still need approval.
 */
export async function buildBaselineSetup(
  deps: EnableAutoPayDeps,
  input: BaselineSetupInput,
): Promise<BaselineSetupResult> {
  validateBaselineSetup(input);

  const { owner, guard, networkPassphrase } = deps;
  const approveCall = await buildApproveAllowance(deps.rpc, {
    assetContractId: input.assetContractId,
    from: owner,
    spender: guard.contractId,
    amount: input.allowanceRaw,
    networkPassphrase,
    days: input.allowanceDays,
    ...(deps.txTimeoutSeconds !== undefined ? { txTimeoutSeconds: deps.txTimeoutSeconds } : {}),
    ...(deps.explorerBase ? { explorerBase: deps.explorerBase } : {}),
  });
  const setRuleCall = await guard.setRule(owner, input.rule);
  const decodedRule = ruleFromSetRuleXdr(setRuleCall.unsignedXdr, networkPassphrase);

  const steps: [BuiltApprovalStep, BuiltApprovalStep] = [
    { kind: "approve", unsignedXdr: approveCall.unsignedXdr, payloadHash: approveCall.payloadHash },
    { kind: "set_rule", unsignedXdr: setRuleCall.unsignedXdr, payloadHash: setRuleCall.payloadHash },
  ];

  const now = deps.now ? deps.now() : new Date();
  const ledgersRemaining = approveCall.liveUntilLedger - approveCall.currentLedger;
  const expiresAt = new Date(now.getTime() + ledgersRemaining * LEDGER_SECONDS * 1000);

  return {
    steps,
    order: ["approve", "set_rule"],
    summary: {
      title: "Set up the Always-ask baseline (allowance + rule, no executor)",
      actions: steps.map((step) => ({ kind: step.kind, lines: decodedLines(step.unsignedXdr, networkPassphrase) })),
      exposure: {
        // Decoded back from the signed `set_rule` XDR, never the input rule.
        thresholdRaw: decodedRule.auto_approve_limit,
        dailyLimitRaw: decodedRule.daily_limit,
        allowanceRaw: input.allowanceRaw,
        allowanceExpiresLocal: formatInTimeZone(expiresAt, deps.timeZone ?? "UTC"),
        allowanceExpiresUtc: expiresAt.toISOString(),
      },
      notes: [
        ALWAYS_ASK_NOTE,
        SCHEDULE_ALLOWANCE_NOTE,
        ...allowanceChangeNotes(deps.currentAllowanceRaw, input.allowanceRaw),
      ],
      confirmation: "card_and_touch_id",
    },
  };
}

/**
 * Build the local `approve(owner, guard, 0, live_until)` revoke call.
 *
 * `guard/allowance.ts::buildApproveAllowance` deliberately refuses `amount <= 0`,
 * so the revoke cannot go through it. Rather than copy the transaction-building
 * plumbing, this reuses the guard's `buildUnsignedInvoke` + `buildGuardCallSummary`
 * read-only. See the report's Unfinished section: a `revokeAllowance` helper (or
 * allowing 0) in `guard/allowance.ts` would remove this duplication.
 */
async function buildRevokeAllowanceCall(
  deps: DisableAutoPayDeps,
  assetContractId: string,
): Promise<{ unsignedXdr: string; payloadHash: string }> {
  const latest = await deps.rpc.getLatestLedger();
  const currentLedger = Number(latest.sequence);
  const liveUntilLedger = allowanceExpiryLedger(currentLedger, deps.days ?? ALLOWANCE_WINDOW_DAYS);
  const { unsignedXdr } = await buildUnsignedInvoke(deps.rpc, {
    contractId: assetContractId,
    method: "approve",
    args: [
      nativeToScVal(deps.owner, { type: "address" }),
      nativeToScVal(deps.guard.contractId, { type: "address" }),
      nativeToScVal(0n, { type: "i128" }),
      nativeToScVal(liveUntilLedger, { type: "u32" }),
    ],
    source: deps.owner,
    networkPassphrase: deps.networkPassphrase,
    ...(deps.txTimeoutSeconds !== undefined ? { txTimeoutSeconds: deps.txTimeoutSeconds } : {}),
  });
  const { payloadHash } = buildGuardCallSummary({
    unsignedXdr,
    networkPassphrase: deps.networkPassphrase,
    ...(deps.explorerBase ? { explorerBase: deps.explorerBase } : {}),
  });
  return { unsignedXdr, payloadHash };
}

/**
 * Disable auto-pay: revoke the executor, and optionally revoke the SAC
 * allowance (`approve` with 0, the off-contract kill switch). Disabling is a
 * tightening, so the card uses the lighter confirmation.
 */
export async function buildDisableAutoPay(
  deps: DisableAutoPayDeps,
  input: DisableAutoPayInput,
): Promise<DisableAutoPayResult> {
  const steps: BuiltApprovalStep[] = [];
  const actions: ApprovalActionSummary[] = [];

  const revoke = await deps.guard.revokeExecutor(deps.owner);
  steps.push({ kind: "revoke_executor", unsignedXdr: revoke.unsignedXdr, payloadHash: revoke.payloadHash });
  actions.push({ kind: "revoke_executor", lines: decodedLines(revoke.unsignedXdr, deps.networkPassphrase) });

  if (input.revokeAllowance) {
    if (!deps.assetContractId) {
      throw new ApprovalError("missing_asset", "assetContractId is required to revoke the allowance");
    }
    const approveZero = await buildRevokeAllowanceCall(deps, deps.assetContractId);
    steps.push({ kind: "approve", unsignedXdr: approveZero.unsignedXdr, payloadHash: approveZero.payloadHash });
    actions.push({ kind: "approve", lines: decodedLines(approveZero.unsignedXdr, deps.networkPassphrase) });
  }

  return {
    steps,
    order: steps.map((step) => step.kind),
    confirmation: "light",
    summary: {
      title: "Disable automatic payments",
      actions,
      notes: input.revokeAllowance
        ? [REVOKE_EXECUTOR_SCHEDULE_CAVEAT, REVOKE_ALLOWANCE_KILL_SWITCH_CAVEAT]
        : [REVOKE_EXECUTOR_SCHEDULE_CAVEAT],
      confirmation: "light",
    },
  };
}

/**
 * Tighten a rule: one `set_rule` step. By default this calls
 * `assertTightening` and refuses loosening/mixed/new-rule changes with a typed
 * `ApprovalError("use_enable_flow")` — a careless shell must not submit a
 * loosening under the light label. Pass `{ allowLoosening: true }` to build the
 * loosening step explicitly; it still returns the full `card_and_touch_id`
 * confirmation so it can only be submitted after a real approval.
 *
 * An identical rule (`classification === "same"`) builds NOTHING and returns
 * `{ steps: [], confirmation: "none" }`: there is no point asking the owner to
 * sign a no-op `set_rule`.
 */
export async function buildTightenRule(
  deps: RuleChangeDeps,
  nextRule: Rule,
  options: TightenRuleOptions = {},
): Promise<TightenRuleResult> {
  const classification = classifyChange(deps.current, nextRule);
  if (classification === "same") {
    return { steps: [], classification, confirmation: "none" };
  }
  if (!options.allowLoosening) assertTightening(classification);
  const call = await deps.guard.setRule(deps.owner, nextRule);
  return {
    steps: [{ kind: "set_rule", unsignedXdr: call.unsignedXdr, payloadHash: call.payloadHash }],
    classification,
    confirmation: confirmationLevel(classification),
  };
}
