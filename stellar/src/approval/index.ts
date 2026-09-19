/**
 * `@polaris/stellar` approval namespace.
 *
 * The app-side approval policy (D10/D10b/D10c): profiles, the auto-pay draft
 * and its validation, pure loosening/tightening classification, read-back
 * sentences, and the builders for the three-step enable, disable and tighten
 * flows. Everything is pure or dependency-injected; nothing signs or submits.
 */
export {
  ApprovalError,
  DEFAULT_ALLOWANCE_DAYS,
  DEFAULT_ALLOWANCE_MULTIPLIER,
  DEFAULT_APPROVAL_PROFILE,
  MAX_ALLOWED_ASSETS,
  MAX_ALLOWANCE_DAYS,
  MIN_ALLOWANCE_DAYS,
  makeAutoPayDraft,
  ruleFromDraft,
  validateAutoPayDraft,
  type ApprovalErrorCode,
  type ApprovalMode,
  type ApprovalProfile,
  type AutoPayDraft,
  type AutoPayDraftInput,
} from "./types.ts";
export {
  assertTightening,
  classifyChange,
  confirmationLevel,
  profileFromChain,
  type ChangeKind,
  type ConfirmationLevel,
} from "./classify.ts";
export { requiresApprovalCard, resolveApprovalRoute, type GuardRoute } from "./routing.ts";
export { formatRawAmount, readBack, readBackDisable, type DisableReadBackInput, type ReadBackOptions } from "./readback.ts";
export {
  LEDGER_SECONDS,
  buildDisableAutoPay,
  buildEnableAutoPay,
  buildTightenRule,
  type ApprovalActionSummary,
  type ApprovalCardSummary,
  type ApprovalExposure,
  type ApprovalStepKind,
  type BuiltApprovalStep,
  type DisableAutoPayDeps,
  type DisableAutoPayInput,
  type DisableAutoPayResult,
  type EnableAutoPayDeps,
  type EnableAutoPayResult,
  type RuleChangeDeps,
  type TightenRuleResult,
} from "./enableAutoPay.ts";
