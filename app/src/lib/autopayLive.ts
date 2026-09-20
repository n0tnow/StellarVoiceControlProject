/**
 * Live, injectable face of the auto-pay Rust commands (W11b).
 *
 * Rust owns the executor key (`executor_create`, seed in the Keychain),
 * unattended signing (`executor_sign_pay`, no Touch ID) and the batch approval
 * gate (`approval_begin_batch` / `approval_authorize_batch`, ONE Touch ID for
 * many owner transactions). This module is the single place the webview names
 * those commands, mirroring `@/lib/approval`: every wrapper takes an injected
 * `invoke`, so the whole path is unit-testable with fakes.
 *
 * The Rust half ships in parallel (W11a). Until it lands, `isAutoPaySupported`
 * feature-detects `executor_status` and the shell keeps its current behaviour
 * instead of crashing on an unknown command.
 */
import { invoke } from "@tauri-apps/api/core";
import type { ApprovalRequestInput, ApprovalRulePayload } from "@polaris/interfaces";

import type { InvokeFn } from "./approval.ts";
import { isMissingCommandError } from "./walletEngine.ts";
import type { TxRunOutcome, TxRunStep } from "./txPipeline.ts";
import type { AutoPayPlan } from "./autopay.ts";

/** `executor_status()` — whether the owner has a funded agent key. */
export interface ExecutorStatus {
  exists: boolean;
  address: string | null;
  funded: boolean | null;
}

/** Why `executor_sign_pay` refused. Mirrors the Rust union. */
export type ExecutorSignFailureCode =
  | "locked"
  | "no_executor"
  | "not_pay_executor"
  | "wrong_source"
  | "wrong_contract"
  | "over_hard_cap"
  | "invalid"
  | "error";

export interface ExecutorSignSuccess {
  ok: true;
  signedXdr: string;
  txHash: string;
}
export interface ExecutorSignFailure {
  ok: false;
  code: ExecutorSignFailureCode;
  message: string;
}
export type ExecutorSignOutcome = ExecutorSignSuccess | ExecutorSignFailure;

/** `approval_begin_batch(...)` result: the batch id and one id per item, in order. */
export interface BatchBeginResult {
  batchId: string;
  ids: string[];
}
/** `approval_authorize_batch(...)` result: the ids the one Touch ID authorised. */
export interface BatchAuthorizeResult {
  authorized: string[];
}

/** The auto-pay command surface; one method per Rust command. */
export interface AutoPayCommands {
  executorStatus(): Promise<ExecutorStatus>;
  executorCreate(): Promise<{ address: string }>;
  executorSignPay(xdr: string): Promise<ExecutorSignOutcome>;
  approvalBeginBatch(title: string, items: ApprovalRequestInput[]): Promise<BatchBeginResult>;
  approvalAuthorizeBatch(batchId: string): Promise<BatchAuthorizeResult>;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Binds the real Tauri commands; tests inject a fake `invoke`. */
export function createAutoPayCommands(invokeImpl: InvokeFn = invoke): AutoPayCommands {
  return {
    executorStatus: () => invokeImpl<ExecutorStatus>("executor_status"),
    executorCreate: () => invokeImpl<{ address: string }>("executor_create"),
    executorSignPay: (xdr) => invokeImpl<ExecutorSignOutcome>("executor_sign_pay", { xdr }),
    approvalBeginBatch: (title, items) =>
      invokeImpl<BatchBeginResult>("approval_begin_batch", { title, items }),
    approvalAuthorizeBatch: (batchId) =>
      invokeImpl<BatchAuthorizeResult>("approval_authorize_batch", { batchId }),
  };
}

/**
 * True only when the Rust auto-pay commands are present on this build. A missing
 * `executor_status` is the feature-absence signal; any other failure is a real
 * error the caller must surface, so it is rethrown.
 */
export async function isAutoPaySupported(invokeImpl: InvokeFn = invoke): Promise<boolean> {
  try {
    await invokeImpl<ExecutorStatus>("executor_status");
    return true;
  } catch (error) {
    if (isMissingCommandError(error)) return false;
    throw error;
  }
}

/** The outcome of a full setup run, plus per-step detail. */
export interface AutoPaySetupOutcome {
  status: "submitted" | "denied" | "failed" | "unsupported";
  /** One short sentence for the notch/History. */
  label: string;
  detail?: string;
  outcomes: TxRunOutcome[];
  plan?: AutoPayPlan;
}

/** The injected seams of a setup run; production defaults build and sign for real. */
export interface AutoPaySetupDeps {
  commands: AutoPayCommands;
  /**
   * Reads the owner's current state and builds the ordered owner-signed steps
   * for the validated plan (approve / set_rule / set_executor / set_alias).
   * Called after any `executor_create`, so the executor address is already live.
   */
  buildPlan: (rule: ApprovalRulePayload) => Promise<{ plan: AutoPayPlan; steps: TxRunStep[] }>;
  /** Signs one authorised batch item and submits it. */
  signAndSubmitItem: (id: string, step: TxRunStep) => Promise<TxRunOutcome>;
  /**
   * The XDR digest the batch gate binds each item to. Defaults to the agent's
   * `xdrDigest`; injected so a `node:test` fake needs no SDK.
   */
  digest?: (unsignedXdr: string) => string;
}

function titleOf(plan: AutoPayPlan): string {
  return plan.mode === "always_ask" ? "Turn off automatic payments" : "Turn on automatic payments";
}

/**
 * Drive one auto-pay change end to end: create the executor if missing, build
 * the ordered owner transactions, show ONE batch approval card, obtain ONE Touch
 * ID, then sign and submit every step in order. Never throws; every failure is a
 * short labelled outcome. Stops at the first non-submitted step (fail closed).
 */
export async function runAutoPaySetup(
  rule: ApprovalRulePayload,
  deps: AutoPaySetupDeps,
): Promise<AutoPaySetupOutcome> {
  try {
    if (!(await isAutoPaySupportedFor(deps))) {
      return {
        status: "unsupported",
        label: "Automatic payments aren't enabled in this build yet.",
        detail: "The agent-key commands are not present.",
        outcomes: [],
      };
    }

    const before = await deps.commands.executorStatus();
    if (!before.exists) {
      // The executor key is created under its own Touch ID; the batch card below
      // then authorises the owner-signed transactions.
      await deps.commands.executorCreate();
    }

    const { plan, steps } = await deps.buildPlan(rule);
    if (steps.length === 0) {
      return { status: "failed", label: "Nothing to change.", outcomes: [], plan };
    }

    const items = await withDigests(steps, deps.digest);
    const batch = await deps.commands.approvalBeginBatch(titleOf(plan), items);
    const authorized = await deps.commands.approvalAuthorizeBatch(batch.batchId);
    const authorised = new Set(authorized.authorized);

    const outcomes: TxRunOutcome[] = [];
    for (let index = 0; index < steps.length; index++) {
      const step = steps[index]!;
      const id = batch.ids[index];
      if (id === undefined || !authorised.has(id)) {
        outcomes.push({ status: "denied", label: step.label, detail: "not authorised", atMs: Date.now() });
        break;
      }
      const outcome = await deps.signAndSubmitItem(id, step);
      outcomes.push(outcome);
      if (outcome.status !== "submitted") break;
    }

    const firstFailure = outcomes.find((outcome) => outcome.status !== "submitted");
    if (firstFailure && firstFailure.status === "denied") {
      return { status: "denied", label: `Setup stopped on ${firstFailure.label}.`, outcomes, plan };
    }
    if (firstFailure) {
      return {
        status: "failed",
        label: `Setup stopped on ${firstFailure.label}.`,
        detail: firstFailure.detail,
        outcomes,
        plan,
      };
    }
    return {
      status: "submitted",
      label: successLabel(plan),
      outcomes,
      plan,
    };
  } catch (error) {
    return { status: "failed", label: "Setup failed", detail: messageOf(error), outcomes: [] };
  }
}

/** A local feature probe that keeps the fakes honest. */
async function isAutoPaySupportedFor(deps: AutoPaySetupDeps): Promise<boolean> {
  try {
    await deps.commands.executorStatus();
    return true;
  } catch (error) {
    return !isMissingCommandError(error);
  }
}

/**
 * Fill each step's XDR digest (SHA-256 of the base64 unsigned XDR) before the
 * batch gate sees it. Imported lazily so this module stays loadable under
 * `node:test` without loading the agent bundle; the gate recomputes and verifies
 * every digest, so a mismatch is a fail-closed rejection.
 */
export async function withDigests(
  steps: readonly TxRunStep[],
  digest?: (unsignedXdr: string) => string,
): Promise<ApprovalRequestInput[]> {
  const hasher = digest ?? (await import("@polaris/agent")).xdrDigest;
  return steps.map((step) => ({
    payloadHash: hasher(step.result.unsignedXdr),
    unsignedXdr: step.result.unsignedXdr,
    summary: step.result.summary,
    intent: step.intent,
  }));
}

function successLabel(plan: AutoPayPlan): string {
  if (plan.mode === "always_ask") return "Done — every payment will ask for approval again.";
  const recipients = plan.limits.knownRecipientsOnly ? " to saved contacts" : "";
  return `Done — payments under ${plan.limits.threshold} ${plan.limits.asset}${recipients} go through automatically.`;
}
