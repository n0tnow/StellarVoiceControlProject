/**
 * Builders for the auto-pay enable / disable / tighten flows (D10b/D10c).
 *
 * Every step is an **unsigned** owner-signed Soroban invocation plus a summary
 * decoded from that exact XDR — never from the caller's draft. The shell shows
 * ONE approval card listing all three enable steps and asks for ONE Touch ID,
 * then submits them in order.
 *
 * SAFE ORDERING (enable) — the allowance (the money) is ALWAYS LAST:
 *
 *   1. set_executor  — register the agent as executor.
 *   2. set_rule      — publish the limits (auto_approve_limit, per_tx, daily,
 *                      allowed assets, known-recipients-only).
 *   3. approve       — SAC allowance to the guard; this is what actually funds
 *                      the unattended path.
 *
 * Failure states:
 *   • step 1 fails: nothing changed. No executor, no rule change, no allowance.
 *   • step 1 ok, step 2 fails: the executor is registered but the policy is
 *     whatever it was. From the expected `always_ask` starting state (no rule,
 *     or `auto_approve_limit == 0`) no unattended payment is possible. Caveat:
 *     if a previous positive-threshold rule and an unexpired allowance already
 *     existed, the freshly registered executor could act under the OLD rule —
 *     this flow is meant to start from `always_ask` (see report).
 *   • step 2 ok, step 3 fails: executor + rule are armed but the guard has no
 *     allowance, so `transfer_from` reverts with `InsufficientAllowance` and no
 *     money can move. Retry only the approve step.
 *
 * Browser-safe: no `Buffer`, no `node:` imports.
 */
import { nativeToScVal } from "@stellar/stellar-sdk";
import { ALLOWANCE_WINDOW_DAYS, allowanceExpiryLedger, buildApproveAllowance } from "../guard/allowance.ts";
import { buildGuardCallSummary, decodeInvocation, shortKey } from "../guard/describe.ts";
import { buildUnsignedInvoke } from "../guard/invoke.ts";
import type { GuardClient, GuardRpcLike, Rule } from "../guard/types.ts";
import {
  classifyChange,
  confirmationLevel,
  type ChangeKind,
  type ConfirmationLevel,
} from "./classify.ts";
import { ApprovalError, ruleFromDraft, validateAutoPayDraft, type AutoPayDraft } from "./types.ts";

/** Each protocol ledger is ~5s (USDC guard demo window), used for card dates. */
export const LEDGER_SECONDS = 5;

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
  confirmation: ConfirmationLevel;
}

export interface EnableAutoPayResult {
  steps: [BuiltApprovalStep, BuiltApprovalStep, BuiltApprovalStep];
  summary: ApprovalCardSummary;
  order: ["set_executor", "set_rule", "approve"];
}

export interface EnableAutoPayDeps {
  owner: string;
  guard: GuardClient;
  rpc: GuardRpcLike;
  networkPassphrase: string;
  /** Injected clock for the exposure dates. */
  now?: () => Date;
  /** IANA zone for `allowanceExpiresLocal` (default UTC). */
  timeZone?: string;
  txTimeoutSeconds?: number;
  explorerBase?: string;
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

export interface TightenRuleResult {
  step: BuiltApprovalStep;
  classification: ChangeKind;
  confirmation: ConfirmationLevel;
}

/** Render a decoded argument for a one-line card summary. */
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

  const { owner, guard, networkPassphrase } = deps;
  const rule = ruleFromDraft(draft);

  const setExecutorCall = await guard.setExecutor(owner, draft.executor);
  const setRuleCall = await guard.setRule(owner, rule);
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

  const steps: [BuiltApprovalStep, BuiltApprovalStep, BuiltApprovalStep] = [
    { kind: "set_executor", unsignedXdr: setExecutorCall.unsignedXdr, payloadHash: setExecutorCall.payloadHash },
    { kind: "set_rule", unsignedXdr: setRuleCall.unsignedXdr, payloadHash: setRuleCall.payloadHash },
    { kind: "approve", unsignedXdr: approveCall.unsignedXdr, payloadHash: approveCall.payloadHash },
  ];

  const now = deps.now ? deps.now() : new Date();
  const ledgersRemaining = approveCall.liveUntilLedger - approveCall.currentLedger;
  const expiresAt = new Date(now.getTime() + ledgersRemaining * LEDGER_SECONDS * 1000);

  return {
    steps,
    order: ["set_executor", "set_rule", "approve"],
    summary: {
      title: "Enable automatic payments (3 owner signatures, 1 approval)",
      actions: steps.map((step) => ({ kind: step.kind, lines: decodedLines(step.unsignedXdr, networkPassphrase) })),
      exposure: {
        thresholdRaw: draft.thresholdRaw,
        dailyLimitRaw: draft.dailyLimitRaw,
        allowanceRaw: draft.allowanceRaw,
        allowanceExpiresLocal: formatInTimeZone(expiresAt, deps.timeZone ?? "UTC"),
        allowanceExpiresUtc: expiresAt.toISOString(),
      },
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
      confirmation: "light",
    },
  };
}

/**
 * Tighten a rule: one `set_rule` step. The classification is returned so the
 * shell can decide; callers that must not loosen should guard with
 * `assertTightening(classification)`.
 */
export async function buildTightenRule(
  deps: RuleChangeDeps,
  nextRule: Rule,
): Promise<TightenRuleResult> {
  const classification = classifyChange(deps.current, nextRule);
  const call = await deps.guard.setRule(deps.owner, nextRule);
  return {
    step: { kind: "set_rule", unsignedXdr: call.unsignedXdr, payloadHash: call.payloadHash },
    classification,
    confirmation: confirmationLevel(classification),
  };
}
