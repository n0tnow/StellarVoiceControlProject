/**
 * Pure auto-pay policy for the shell (W11b).
 *
 * Three concerns live here, all dependency-free and unit-testable under
 * `node:test`:
 *
 *  1. `buildAutoPayPlan` — turn a spoken/typed rule proposal into the ordered
 *     setup plan (executor creation + funding, allowance, rule, executor last =
 *     arming, then the alias book). The order mirrors D13 and the builders in
 *     `@polaris/stellar/approval`; the plan only describes what will be built.
 *  2. `decideAutoPayRoute` — the fail-closed routing table for a `send`: an
 *     unattended `pay_executor` only when EVERY guard condition holds, the owner
 *     path otherwise. Any doubt falls back to MORE approval, never to silent pay.
 *  3. `mapAutoPayError` / `batchViewFromPlan` — the short human sentences and the
 *     batch approval card view model.
 *
 * Nothing here signs, submits or reaches Tauri. The live wiring lives in
 * `autopayLive.ts`.
 */
import { guard } from "@polaris/stellar";
import type { ApprovalRulePayload } from "@polaris/interfaces";

/** The asset assumed when a spoken rule names none. */
export const DEFAULT_AUTO_PAY_ASSET = "XLM";

/** Per-payment default ceiling, as a multiple of the auto-approve limit. */
export const DEFAULT_PER_TX_MULTIPLIER = 2n;
/** Daily default mandate, as a multiple of the auto-approve limit. */
export const DEFAULT_DAILY_MULTIPLIER = 10n;
/** XLM sent to a freshly created executor when Friendbot is not used. */
export const DEFAULT_EXECUTOR_FUND_XLM = "6";

/** One on-chain step the setup plan performs, in execution order. */
export type AutoPayPlanStepKind =
  | "executor_create"
  | "fund_executor"
  | "approve"
  | "set_rule"
  | "set_executor"
  | "set_alias"
  | "revoke_executor";

/** A plan step: a stable kind plus the labels the card renders. */
export interface AutoPayPlanStep {
  kind: AutoPayPlanStepKind;
  label: string;
  detail: string;
  /** Every `set_executor` is the arming step (D13). */
  arming?: boolean;
}

/** The limits the plan will publish, as display decimal strings. */
export interface AutoPayPlanLimits {
  threshold: string;
  perTx: string;
  daily: string;
  asset: string;
  knownRecipientsOnly: boolean;
}

export interface AutoPayPlan {
  mode: "auto_under_limit" | "always_ask";
  limits: AutoPayPlanLimits;
  /** Ordered steps. Auto-pay enable ends with `set_executor` (arming). */
  steps: AutoPayPlanStep[];
  /** Plain-language sentence spoken before the card. */
  readBack: string;
  /** True when the plan touches chain state and therefore needs the card. */
  requiresApproval: boolean;
}

/** A contact to mirror into the on-chain alias book. */
export interface AutoPayContact {
  alias: string;
  address: string;
}

/** Injected facts about the owner's current executor and contacts. */
export interface AutoPayContext {
  executor: { exists: boolean; address: string | null; funded: boolean | null };
  /** Asset used when the proposal names none. */
  defaultAsset?: string;
  contacts?: readonly AutoPayContact[];
  /** Testnet default: Friendbot funds the executor's fees. */
  useFriendbot?: boolean;
  /** XLM amount sent by the owner when Friendbot is not used. */
  fundAmountXlm?: string;
}

function multiply(value: string, factor: bigint): string {
  return guard.fromRawUnits(guard.toRawUnits(value) * factor);
}

function contactLines(contacts: readonly AutoPayContact[]): string {
  return contacts.length === 0
    ? "No saved contacts to sync."
    : contacts.map((contact) => contact.alias).join(", ");
}

/**
 * Build the ordered setup plan for a rule proposal. `always_ask` is the disable
 * path (revoke the executor first); `auto_under_limit` is the D13 enable order:
 * executor creation/funding, allowance, rule, executor LAST (arming), aliases.
 *
 * Throws a plain `Error` when the proposal is unusable (no threshold), so the
 * caller can surface one sentence without a typed error union.
 */
export function buildAutoPayPlan(proposal: ApprovalRulePayload, ctx: AutoPayContext = { executor: { exists: false, address: null, funded: null } }): AutoPayPlan {
  const asset = proposal.asset && proposal.asset.length > 0
    ? proposal.asset
    : (ctx.defaultAsset ?? DEFAULT_AUTO_PAY_ASSET);
  const knownRecipientsOnly = proposal.knownRecipientsOnly ?? true;

  if (proposal.mode === "always_ask") {
    return {
      mode: "always_ask",
      limits: {
        threshold: "0",
        perTx: proposal.perTxLimit ?? "0",
        daily: proposal.dailyLimit ?? "0",
        asset,
        knownRecipientsOnly,
      },
      steps: [
        {
          kind: "revoke_executor",
          label: "Revoke the executor (disarm)",
          detail: "Automatic payments stop immediately. Existing schedules keep running until cancelled.",
        },
      ],
      readBack: "Stop automatic payments. Every payment will need your approval.",
      requiresApproval: true,
    };
  }

  const threshold = proposal.autoApproveLimit;
  if (threshold === undefined) {
    throw new Error("auto_under_limit needs an auto-approve limit");
  }
  const perTx = proposal.perTxLimit ?? multiply(threshold, DEFAULT_PER_TX_MULTIPLIER);
  const daily = proposal.dailyLimit ?? multiply(threshold, DEFAULT_DAILY_MULTIPLIER);
  const contacts = knownRecipientsOnly ? [...(ctx.contacts ?? [])] : [];

  const steps: AutoPayPlanStep[] = [];
  if (!ctx.executor.exists) {
    steps.push({
      kind: "executor_create",
      label: "Create the agent key",
      detail: "A separate Ed25519 key is generated in the Keychain; it can only sign guarded payments.",
    });
  }
  if (!ctx.executor.exists || ctx.executor.funded === false) {
    steps.push({
      kind: "fund_executor",
      label: "Fund the agent key (fees)",
      detail: ctx.useFriendbot === false
        ? `Send ${ctx.fundAmountXlm ?? DEFAULT_EXECUTOR_FUND_XLM} XLM from the owner so it can pay network fees.`
        : "Fund it with free testnet XLM (Friendbot) so it can pay network fees.",
    });
  }
  steps.push(
    {
      kind: "approve",
      label: "Approve the guard allowance",
      detail: `Allow the guard to move up to ${daily} ${asset} per day on your behalf.`,
    },
    {
      kind: "set_rule",
      label: "Publish the spending rule",
      detail: `Auto-approve ${threshold} ${asset}/payment, ${perTx} ${asset} per transaction, ${daily} ${asset} per day${knownRecipientsOnly ? ", saved contacts only" : ""}.`,
    },
    {
      kind: "set_executor",
      label: "Register the agent key (arms auto-pay)",
      detail: "Last step: this is what turns unattended payments on.",
      arming: true,
    },
  );
  for (const contact of contacts) {
    steps.push({
      kind: "set_alias",
      label: `Save contact ${contact.alias}`,
      detail: "Known-recipients-only payments resolve against the on-chain book.",
    });
  }

  const recipients = knownRecipientsOnly ? "saved contacts only" : "anyone";
  return {
    mode: "auto_under_limit",
    limits: { threshold, perTx, daily, asset, knownRecipientsOnly },
    steps,
    readBack: `Auto-approve up to ${threshold} ${asset} per payment, ${daily} a day, ${recipients}. Approve on the card.`,
    requiresApproval: true,
  };
}

/** The cached on-chain facts the routing table needs. */
export interface AutoPayRouteState {
  /** An executor is registered AND `auto_approve_limit > 0`. */
  armed: boolean;
  assetContractId: string;
  allowedAssets: readonly string[];
  autoApproveLimitRaw: bigint;
  perTxLimitRaw: bigint;
  dailyLimitRaw: bigint;
  spentTodayRaw: bigint;
  knownRecipientsOnly: boolean;
}

/** The payment being routed. */
export interface AutoPayPayment {
  amountRaw: bigint;
  assetContractId: string;
  /** The recipient resolves to an address already in the on-chain alias book. */
  recipientKnown: boolean;
}

export type AutoPayRoute = "auto" | "owner";
export interface AutoPayRouteDecision {
  route: AutoPayRoute;
  /** Short, log-safe explanation of the decision. */
  reason: string;
}

const AUTO = (reason: string): AutoPayRouteDecision => ({ route: "auto", reason });
const OWNER = (reason: string): AutoPayRouteDecision => ({ route: "owner", reason });

/**
 * The fail-closed routing table. `auto` requires every condition; anything else
 * (including invalid input, an unknown asset and a daily-cap breach) returns
 * `owner`. `hardCapRaw`, when supplied, is the Rust-side independent cap: a
 * payment above it can never be auto-signed, even if the on-chain rule allows it.
 */
export function decideAutoPayRoute(
  state: AutoPayRouteState,
  payment: AutoPayPayment,
  hardCapRaw?: bigint,
): AutoPayRouteDecision {
  if (payment.amountRaw <= 0n) return OWNER("the amount is not positive");
  if (!state.armed) return OWNER("automatic payments are off");
  if (payment.assetContractId !== state.assetContractId || !state.allowedAssets.includes(payment.assetContractId)) {
    return OWNER("the asset is not in the allowed list");
  }
  if (payment.amountRaw > state.perTxLimitRaw) return OWNER("above the per-transaction limit");
  if (payment.amountRaw > state.autoApproveLimitRaw) return OWNER("above the auto-approve limit");
  if (state.knownRecipientsOnly && !payment.recipientKnown) {
    return OWNER("the recipient is not a saved contact");
  }
  if (state.spentTodayRaw + payment.amountRaw > state.dailyLimitRaw) {
    return OWNER("above today's remaining allowance");
  }
  if (hardCapRaw !== undefined && payment.amountRaw > hardCapRaw) {
    return OWNER("above the app's hard cap");
  }
  return AUTO("inside the on-chain mandate; the executor signs");
}

const GUARD_ERROR_SENTENCES: Readonly<Record<number, string>> = {
  103: "It is above your per-payment limit, so it needs your approval.",
  104: "It would go over your daily limit, so it needs your approval.",
  105: "It is above your auto-approve limit, so it needs your approval.",
  106: "That asset is not allowed by your rule, so it needs your approval.",
  107: "Automatic payments are off (no agent key registered); this needs your approval.",
  116: "The guard allowance is missing or too small; approve a new allowance first.",
};

/**
 * Map a guard error (code or name) to ONE sentence a non-developer can act on.
 * Anything unrecognised still falls back to the approval path.
 */
export function mapAutoPayError(input: { code?: number; name?: string }): string {
  const byCode = input.code !== undefined ? GUARD_ERROR_SENTENCES[input.code] : undefined;
  if (byCode !== undefined) return byCode;
  switch (input.name) {
    case "OverPerTxLimit":
      return GUARD_ERROR_SENTENCES[103]!;
    case "OverDailyLimit":
      return GUARD_ERROR_SENTENCES[104]!;
    case "NeedsOwnerApproval":
      return GUARD_ERROR_SENTENCES[105]!;
    case "AssetNotAllowed":
      return GUARD_ERROR_SENTENCES[106]!;
    case "NoExecutor":
      return GUARD_ERROR_SENTENCES[107]!;
    case "InsufficientAllowance":
      return GUARD_ERROR_SENTENCES[116]!;
    default:
      return "The chain refused this automatic payment, so it needs your approval.";
  }
}

/** One numbered line on the batch approval card. */
export interface BatchViewItem {
  index: number;
  title: string;
  detail: string;
  arming: boolean;
}

/** The batch approval card's view model, built from a setup plan. */
export interface BatchApprovalView {
  title: string;
  items: BatchViewItem[];
  total: number;
  readBack: string;
  approveLabel: string;
}

/** Build the view model the batch card renders (one Approve = one Touch ID). */
export function batchViewFromPlan(plan: AutoPayPlan): BatchApprovalView {
  return {
    title: plan.mode === "always_ask" ? "Turn off automatic payments" : "Turn on automatic payments",
    items: plan.steps.map((step, index) => ({
      index: index + 1,
      title: step.label,
      detail: step.detail,
      arming: step.arming === true,
    })),
    total: plan.steps.length,
    readBack: plan.readBack,
    approveLabel: "Approve with Touch ID",
  };
}

/** Human summary of the alias sync (for the Rules page and the card). */
export function contactsSyncedLine(contacts: readonly AutoPayContact[]): string {
  return `${contacts.length} saved contact${contacts.length === 1 ? "" : "s"} to sync: ${contactLines(contacts)}`;
}
