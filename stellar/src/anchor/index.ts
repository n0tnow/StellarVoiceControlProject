/** Anchor client (SEP-1 / 10 / 12 / 38 / 6). See README.md in this folder. */
export * from "./config.ts";
export * from "./explain.ts";
export * from "./types.ts";
export { assertAmount, toStroops } from "./amount.ts";
export { safeHttpsUrl, safeId, sanitizeAnchorText, type AnchorOwnedLink } from "./text.ts";
export { assertSafeEndpoint, parseHomeDomain, UnsafeAnchorError, type NetPolicy } from "./net.ts";
export { AnchorHttpError, MAX_JSON_BYTES, MAX_TOML_BYTES, readCapped } from "./http.ts";
export { discoverAnchor, findAsset, parseStellarToml, TomlError } from "./sep1.ts";
export {
  authenticate,
  ChallengeError,
  completeChallenge,
  decodeJwt,
  isExpired,
  MAX_CHALLENGE_WINDOW_SECONDS,
  requestChallenge,
  validateChallenge,
} from "./sep10.ts";
export { ensureCustomer, ensureTransactionCustomer, getCustomer, KycRequiredError, type CustomerInfo, type CustomerStatus } from "./sep12.ts";
export { getPrice, QuoteError, type PriceRequest } from "./sep38.ts";
export {
  buildWithdrawPayment,
  classifyStatus,
  cleanFieldNames,
  explainStatus,
  FINAL_STATUSES,
  getInfo,
  getTransaction,
  listTransactions,
  parseTransaction,
  parseWithdrawMemo,
  pollTransaction,
  PollInterruptedError,
  PollTimeoutError,
  quoteNumericMemo,
  startDeposit,
  startWithdraw,
  TransactionInfoRequiredError,
  TR_MOCK_PAYOUT_HINT,
  type DepositParams,
  type PollOptions,
  type PollOutcome,
  type PollResult,
  type Sep6Info,
  type StatusClass,
  type WithdrawParams,
} from "./sep6.ts";
export { assertSameTransaction, describeXdr, withdrawalSummary, type ApprovalSummary } from "./describe.ts";
export { buildTrustlineTx, inspectAccount, preflight, type AccountState, type PreflightOptions, type PreflightResult } from "./preflight.ts";
export { balanceOf, explorerAccountUrl, explorerTxUrl, hasTrustline, loadAccount, submitEnvelope } from "./horizon.ts";
export { simulateBankTransfer } from "./sandbox.ts";
export {
  assertPlainAnchorDomain,
  demoCustomerFields,
  describeAnchorScenario,
  SDF_DEMO_CUSTOMER,
  SDF_TEST_ANCHOR_HOME_DOMAIN,
  TR_MOCK_HOME_DOMAIN,
  type AnchorScenario,
  type ScenarioId,
} from "./scenarios.ts";
export {
  ANCHOR_PREFLIGHT_TIMEOUT_MS,
  approvedAnchorCandidates,
  NO_ANCHOR_MESSAGE,
  NoHealthyAnchorError,
  preflightAnchor,
  selectAnchor,
  type AnchorCandidate,
  type AnchorHealth,
  type AnchorPreflightDeps,
  type AnchorSelection,
} from "./selection.ts";
export {
  classifyPayoutHealth,
  findTreasuryAddress,
  parseHorizonPayments,
  PAYMENT_HISTORY_LIMIT,
  PAYOUT_FLOWING_WITHIN_MS,
  PAYOUT_STALLED_AFTER_MS,
  readPayoutHealth,
  TR_MOCK_TREASURY,
  type PayoutHealth,
  type PayoutHealthResult,
  type PayoutPayment,
  type PayoutVerdict,
} from "./payoutHealth.ts";
export { AnchorSession, type AnchorSessionConfig } from "./session.ts";
export { runDepositFlow, runWithdrawFlow, type DepositFlowOptions, type DepositFlowResult, type WithdrawFlowOptions, type WithdrawFlowResult } from "./flows.ts";
// EnvSigner (test-only) lives behind `@polaris/stellar/anchor/testing`, never in this barrel.
export {
  configureAnchor,
  depositTry,
  getAnchorSession,
  submitSignedTx,
  withdrawTry,
  type AnchorIntent,
  type AnchorIntentKind,
  type SubmitResult,
} from "./chainTools.ts";
