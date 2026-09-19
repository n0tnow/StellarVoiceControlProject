/**
 * `@polaris/stellar` approval namespace.
 *
 * The app-side approval policy (D10/D10b/D10c): profiles, the auto-pay draft
 * and its validation, pure loosening/tightening classification, read-back
 * sentences, and the builders for the Always-ask baseline, the three-step
 * enable, disable and tighten flows. Everything is pure or dependency-injected;
 * nothing signs or submits.
 */
export {
  ApprovalError,
  DEFAULT_ALLOWANCE_DAYS,
  DEFAULT_ALLOWANCE_MULTIPLIER,
  DEFAULT_APPROVAL_PROFILE,
  MAX_ALLOWED_ASSETS,
  MAX_ALLOWANCE_DAYS,
  MIN_ALLOWANCE_DAYS,
  assertAssetMatchesRule,
  makeAutoPayDraft,
  ruleFromDraft,
  validateAutoPayDraft,
  validateBaselineSetup,
  validateRuleAndAllowance,
  type ApprovalErrorCode,
  type ApprovalMode,
  type ApprovalProfile,
  type AutoPayDraft,
  type AutoPayDraftInput,
  type BaselineSetupInput,
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
  ARMING_STEP_NOTE,
  LEDGER_SECONDS,
  buildBaselineSetup,
  buildDisableAutoPay,
  buildEnableAutoPay,
  buildTightenRule,
  type ApprovalActionSummary,
  type ApprovalCardSummary,
  type ApprovalExposure,
  type ApprovalStepKind,
  type BaselineSetupResult,
  type BuiltApprovalStep,
  type DisableAutoPayDeps,
  type DisableAutoPayInput,
  type DisableAutoPayResult,
  type EnableAutoPayDeps,
  type EnableAutoPayResult,
  type RuleChangeDeps,
  type TightenRuleOptions,
  type TightenRuleResult,
} from "./enableAutoPay.ts";
