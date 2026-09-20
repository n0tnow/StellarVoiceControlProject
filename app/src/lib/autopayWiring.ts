/**
 * The composition root that binds the pure auto-pay policy (`autopay.ts`) and
 * the injectable Rust commands (`autopayLive.ts`) to the real shell (W11b).
 *
 * It owns two entry points:
 *
 *  - `runGuardPolicySetup` — a voice/UI rule proposal becomes the ordered owner
 *    transaction plan, gets ONE batch approval card + ONE Touch ID, then submits
 *    every step through `wallet_sign`.
 *  - `tryAutoPaySend` — the unattended `send` route. It reads the cached on-chain
 *    state, applies `decideAutoPayRoute`, and, only when the chain would allow it
 *    AND the executor key is present, builds `pay_executor`, signs with
 *    `executor_sign_pay` (no Touch ID) and submits. Anything else returns `null`
 *    so the caller keeps the normal owner path (fail closed toward MORE approval).
 *
 * Every Tauri chain dependency is imported lazily inside the functions, matching
 * `chain.ts`, so a turn that never reaches auto-pay pays for nothing.
 */
import type { ExecutionOutcome } from "@polaris/agent";
import type { Intent, ApprovalRulePayload } from "@polaris/interfaces";
import { guard } from "@polaris/stellar";

import { buildAutoPayPlan, decideAutoPayRoute } from "./autopay.ts";
import {
  createAutoPayCommands,
  isAutoPaySupported,
  runAutoPaySetup,
  type AutoPaySetupOutcome,
} from "./autopayLive.ts";
import type { AutoPayContact } from "./autopay.ts";
import type { LimitsFields, SecurityState } from "./guardState.ts";
import { planDisable, planEnable, planSetAliases, planTighten, loadSecurityState } from "./guardStateLive.ts";
import { defaultSigningDeps, explorerTxUrl, signAndSubmit, type SubmittedOutcome } from "./signing.ts";
import type { TxRunOutcome, TxRunStep } from "./txPipeline.ts";
import committedAliases from "../../../stellar/config/aliases.json";

const OWNER_MISSING = "POLARIS_OWNER_ADDRESS is not set";

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Allowance = one week of the daily mandate (source notes D10c). */
const ALLOWANCE_DAYS = 30;

function fieldsFromPlan(plan: { limits: { threshold: string; perTx: string; daily: string; knownRecipientsOnly: boolean } }): LimitsFields {
  const dailyRaw = guard.toRawUnits(plan.limits.daily);
  return {
    threshold: plan.limits.threshold,
    perTx: plan.limits.perTx,
    daily: plan.limits.daily,
    allowance: guard.fromRawUnits(dailyRaw * 7n),
    allowanceDays: ALLOWANCE_DAYS,
    knownRecipientsOnly: plan.limits.knownRecipientsOnly,
  };
}

function envAliasEntries(aliases: Record<string, string>): Record<string, { address: string; network: "testnet" }> {
  return Object.fromEntries(
    Object.entries(aliases).map(([alias, address]) => [alias, { address, network: "testnet" as const }]),
  );
}

/** The local contact store as alias-book entries; a failed read yields none. */
async function loadContacts(): Promise<AutoPayContact[]> {
  try {
    const { contactsClient } = await import("./contacts.ts");
    const contacts = await contactsClient.list();
    return contacts.map((contact) => ({ alias: contact.nickname, address: contact.address }));
  } catch {
    return [];
  }
}

/** The recipient's address from the local contacts, then the alias book. */
async function resolveRecipientAddress(alias: string, aliases: Record<string, string>): Promise<string | null> {
  const contacts = await loadContacts();
  const contact = contacts.find((entry) => entry.alias === alias);
  if (contact) return contact.address;
  const { parseAliasBook } = await import("@polaris/stellar");
  const { book } = parseAliasBook({ ...committedAliases, ...envAliasEntries(aliases) });
  return book[alias]?.address ?? null;
}

function isArmed(state: SecurityState): boolean {
  return state.executor !== null && (state.rule?.auto_approve_limit ?? 0n) > 0n;
}

/**
 * Give every step of the batch its own incremental sequence (base+1, base+2, …)
 * BEFORE it is approved. A batch is approved as one unit and submitted in order,
 * so embedding the same base sequence in every step would fail `txBadSeq` after
 * the first; this is the up-front equivalent of `txPipeline`'s per-step
 * resequencing. The summary/explorer is recomputed because the tx hash changes.
 */
async function withSequences(
  steps: readonly TxRunStep[],
  owner: string,
  networkPassphrase: string,
  rpcUrl: string,
): Promise<TxRunStep[]> {
  if (steps.length === 0) return [];
  const [{ rpc }, stellar] = await Promise.all([
    import("@stellar/stellar-sdk"),
    import("@polaris/stellar"),
  ]);
  const account = await new rpc.Server(rpcUrl).getAccount(owner);
  const base = BigInt(account.sequenceNumber());
  return steps.map((step, index) => {
    const unsignedXdr = stellar.setSequence(step.result.unsignedXdr, networkPassphrase, base + BigInt(index) + 1n);
    const { summary } = stellar.guard.buildGuardCallSummary({ unsignedXdr, networkPassphrase });
    return { ...step, result: { unsignedXdr, summary } };
  });
}

/**
 * Build the real owner-signed steps for a validated plan. The executor key is
 * created before this runs, so the fresh `executor_status` address is used even
 * though the on-chain `set_executor` is still one of the steps.
 */
async function buildSetupSteps(rule: ApprovalRulePayload): Promise<{ plan: ReturnType<typeof buildAutoPayPlan>; steps: TxRunStep[] }> {
  const load = await loadSecurityState();
  if (load.kind !== "ok") throw new Error(load.detail);
  const state = load.state;
  const commands = createAutoPayCommands();
  const status = await commands.executorStatus();
  const contacts = await loadContacts();
  const plan = buildAutoPayPlan(rule, {
    executor: status,
    defaultAsset: state.assetSymbol,
    contacts,
    useFriendbot: true,
  });

  if (plan.mode === "always_ask") {
    const built = await planDisable(false, state);
    const steps = await withSequences(built.steps, state.owner, state.networkPassphrase, state.rpcUrl);
    return { plan, steps };
  }

  const fields = fieldsFromPlan(plan);
  const built = isArmed(state)
    ? await planTighten(fields, state)
    : await planEnable(fields, status.address ?? "", state);
  const steps: TxRunStep[] = [...built.steps];
  if (plan.limits.knownRecipientsOnly && contacts.length > 0) {
    const aliases = await planSetAliases(contacts, state);
    steps.push(...aliases.steps);
  }
  return { plan, steps: await withSequences(steps, state.owner, state.networkPassphrase, state.rpcUrl) };
}

/** Sign one approved batch item with the owner wallet and submit it. */
async function signAndSubmitItem(id: string, step: TxRunStep): Promise<TxRunOutcome> {
  const { xdrDigest } = await import("@polaris/agent");
  const execution: ExecutionOutcome = {
    status: "executed",
    intent: step.intent,
    result: step.result,
    approvalId: id,
    payloadHash: xdrDigest(step.result.unsignedXdr),
  };
  const signed = await signAndSubmit(execution, defaultSigningDeps);
  if (signed.status === "executed" && signed.txHash && signed.explorerUrl) {
    return { status: "submitted", txHash: signed.txHash, explorerUrl: signed.explorerUrl, atMs: Date.now() };
  }
  return {
    status: "failed",
    label: signed.label ?? step.label,
    detail: signed.detail ?? "the transaction was not submitted",
    atMs: Date.now(),
  };
}

/** Map the setup outcome onto the shell's `SubmittedOutcome`. */
function toSubmitted(setup: AutoPaySetupOutcome, intent: Intent): SubmittedOutcome {
  if (setup.status === "submitted") {
    const last = [...setup.outcomes].reverse().find((outcome) => outcome.status === "submitted");
    return {
      status: "executed",
      intent,
      label: setup.label,
      ...(last && last.status === "submitted" ? { txHash: last.txHash, explorerUrl: last.explorerUrl } : {}),
    };
  }
  if (setup.status === "unsupported") {
    return { status: "unavailable", intent, label: setup.label, detail: setup.detail };
  }
  return { status: "failed", intent, label: setup.label, detail: setup.detail };
}

/**
 * Enable/tighten/disable auto-pay from a spoken proposal. Never throws; a missing
 * owner, a failed read and every command failure come back as a labelled outcome.
 */
export async function runGuardPolicySetup(intent: Intent): Promise<SubmittedOutcome> {
  if (!intent.rule) {
    return {
      status: "unavailable",
      intent,
      label: "Autonomous rules aren't enabled in this build yet.",
      detail: "This guard_policy intent carries no rule proposal.",
    };
  }
  try {
    const outcome = await runAutoPaySetup(intent.rule, {
      commands: createAutoPayCommands(),
      buildPlan: (rule) => buildSetupSteps(rule),
      signAndSubmitItem,
    });
    return toSubmitted(outcome, intent);
  } catch (error) {
    const detail = messageOf(error);
    return {
      status: "failed",
      intent,
      label: detail.includes("POLARIS_OWNER_ADDRESS") ? OWNER_MISSING : "Auto-pay setup failed",
      detail,
    };
  }
}

/** Record the automatic route on the newest in-progress History turn. */
function recordAutoApproval(): void {
  void (async () => {
    try {
      const { readTurnLog, recordTurnMeta } = await import("./turnLog.ts");
      const running = readTurnLog().find((entry) => entry.outcome === "in_progress");
      if (running) recordTurnMeta(running.id, { approvalMode: "auto", route: "pay_executor" });
    } catch {
      // History metadata is best-effort; a storage failure never fails a payment.
    }
  })();
}

/**
 * The unattended `send` route. Returns a submitted outcome when the payment ran
 * as `pay_executor` with no card; `null` means "use the normal owner path".
 * Never moves funds without a successful `executor_sign_pay`.
 */
export async function tryAutoPaySend(intent: Intent): Promise<SubmittedOutcome | null> {
  if (intent.kind !== "send") return null;
  try {
    if (!(await isAutoPaySupported())) return null;
    const { getStellarConfig } = await import("./stellarConfig.ts");
    const config = await getStellarConfig();
    if (!config.ownerAddress || !config.guardContractId) return null;
    const owner = config.ownerAddress;

    const { rpc } = await import("@stellar/stellar-sdk");
    const server = new rpc.Server(config.rpcUrl);
    const client = guard.createGuardClient({
      contractId: config.guardContractId,
      rpc: server,
      networkPassphrase: config.networkPassphrase,
      source: owner,
    });
    const rule = await client.getRule(owner);
    const executor = await client.getExecutor(owner);
    if (!rule || !executor || rule.auto_approve_limit <= 0n) return null;

    const alias = (intent.recipient ?? intent.alias ?? "").trim().toLowerCase();
    const address = await resolveRecipientAddress(alias, config.aliases);
    if (!address) return null;

    const assetContractId = rule.allowed_assets[0];
    if (!assetContractId) return null;
    const assetCode = (intent.asset ?? "").toUpperCase();
    const { Asset } = await import("@stellar/stellar-sdk");
    const nativeSac = Asset.native().contractId(config.networkPassphrase);
    // Only the native XLM SAC is auto-signed by this build; any other asset (or
    // a mismatch between the intent's code and the rule's asset) falls back to
    // the owner path, so we never move a token with the wrong decimal scale.
    if (assetContractId !== nativeSac) return null;
    if (assetCode !== "" && assetCode !== "XLM") return null;

    const amountRaw = guard.toRawUnits(intent.amount);
    const spentTodayRaw = await client.spentToday(owner);
    const recipientKnown = await client.isKnownRecipient(owner, address);
    const decision = decideAutoPayRoute(
      {
        armed: true,
        assetContractId,
        allowedAssets: rule.allowed_assets,
        autoApproveLimitRaw: rule.auto_approve_limit,
        perTxLimitRaw: rule.per_tx_limit,
        dailyLimitRaw: rule.daily_limit,
        spentTodayRaw,
        knownRecipientsOnly: rule.known_recipients_only,
      },
      { amountRaw, assetContractId, recipientKnown },
    );
    if (decision.route !== "auto") return null;

    const call = await client.payExecutor(executor, owner, address, assetContractId, amountRaw);
    const commands = createAutoPayCommands();
    const signed = await commands.executorSignPay(call.unsignedXdr);
    if (!signed.ok) return null;

    const { submitSignedTx } = await import("@polaris/stellar");
    const { webLog } = await import("./weblog.ts");
    const submitted = await submitSignedTx(signed.signedXdr, call.unsignedXdr);
    if (submitted.hash.toLowerCase() !== signed.txHash.toLowerCase()) {
      webLog("error", "auto-pay hash mismatch; refusing to report success", true);
      return null;
    }
    recordAutoApproval();
    const explorerUrl = submitted.explorerUrl || explorerTxUrl(submitted.hash.toLowerCase());
    return {
      status: "executed",
      intent,
      label: `Sent ${intent.amount} ${intent.asset} to ${alias} (automatic)`,
      txHash: submitted.hash.toLowerCase(),
      explorerUrl,
      signerAddress: executor,
    };
  } catch (error) {
    const { webLog } = await import("./weblog.ts");
    webLog("warn", `auto-pay route skipped: ${messageOf(error)}`);
    return null;
  }
}
