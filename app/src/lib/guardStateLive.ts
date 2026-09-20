/**
 * Live reads and builder calls behind the Security panel (W6a).
 *
 * This is the only place the panel touches the chain: it reads the owner's
 * on-chain rule/executor/allowance/alias book through the `@polaris/stellar`
 * guard client, and it calls the approval builders to produce **unsigned** step
 * plans. Nothing is signed or submitted here — the panel pushes every plan
 * through `@/lib/txPipeline` (`runTxSequence`), which owns the approval card,
 * Touch ID and the wallet signing.
 *
 * The contract id, owner and network come from the read-only `stellar_config`
 * command (`@/lib/stellarConfig`); a missing guard id is a `warn`, never a
 * guess. Native XLM is the single allowed asset, resolved to its SAC id from the
 * native asset and the network passphrase.
 */
import { Asset, rpc } from "@stellar/stellar-sdk";
import { approval, guard } from "@polaris/stellar";
import type { Intent } from "@polaris/interfaces";

import { getStellarConfig } from "@/lib/stellarConfig";
import committedAliases from "../../../stellar/config/aliases.json";
import {
  BASELINE_STEP_ORDER,
  ENABLE_STEP_ORDER,
  disableStepOrder,
  matchesOrder,
  readBackBaseline,
  readBackDisable,
  readBackEnable,
  readBackTighten,
  stepIntent,
  stepLabel,
  validateBaseline,
  validateLimits,
  validateRuleFields,
  type AliasInput,
  type AliasLine,
  type LimitsFields,
  type PlanStep,
  type PlanStepKind,
  type SecurityState,
} from "./guardState.ts";

/** The native asset's SAC contract id for a network passphrase. */
export function nativeSacId(networkPassphrase: string): string {
  return Asset.native().contractId(networkPassphrase);
}

/** A loaded state, or why it could not be loaded. */
export type SecurityLoad =
  | { kind: "ok"; state: SecurityState }
  | { kind: "unconfigured"; detail: string }
  | { kind: "unreachable"; detail: string };

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function clientFor(state: SecurityState): { server: rpc.Server; client: guard.GuardClient } {
  const server = new rpc.Server(state.rpcUrl);
  const client = guard.createGuardClient({
    contractId: state.guardContractId,
    rpc: server,
    networkPassphrase: state.networkPassphrase,
    source: state.owner,
  });
  return { server, client };
}

/** Read the on-chain alias book for the owner, one `get_alias` per known name. */
async function readAliases(
  client: guard.GuardClient,
  owner: string,
  envAliases: Record<string, string>,
): Promise<AliasLine[]> {
  const names = [...new Set([...Object.keys(committedAliases), ...Object.keys(envAliases)])].sort();
  return Promise.all(
    names.map(async (alias): Promise<AliasLine> => {
      try {
        const onChain = await client.getAlias(owner, alias);
        return onChain
          ? { alias, onChain, status: "ok" }
          : { alias, onChain: null, status: "missing" };
      } catch {
        return { alias, onChain: null, status: "error" };
      }
    }),
  );
}

/**
 * Load the owner's current on-chain security state. `unconfigured` means the
 * guard id or owner is absent; `unreachable` means a read failed (RPC down,
 * malformed contract id). Both are surfaced as a `warn`/`fail` by the Debug
 * check, never as a crash.
 */
export async function loadSecurityState(): Promise<SecurityLoad> {
  let config: Awaited<ReturnType<typeof getStellarConfig>>;
  try {
    config = await getStellarConfig();
  } catch (error) {
    return { kind: "unconfigured", detail: `stellar_config failed: ${messageOf(error)}` };
  }
  if (!config.guardContractId) {
    return { kind: "unconfigured", detail: "GUARD_CONTRACT_ID is not set; the guard is not configured" };
  }
  if (!config.ownerAddress) {
    return { kind: "unconfigured", detail: "POLARIS_OWNER_ADDRESS is not set" };
  }
  const owner = config.ownerAddress;
  const passphrase = config.networkPassphrase;
  const assetContractId = nativeSacId(passphrase);
  const base = {
    owner,
    guardContractId: config.guardContractId,
    rpcUrl: config.rpcUrl,
    networkPassphrase: passphrase,
    assetSymbol: "XLM",
    assetContractId,
  } as const;

  try {
    const { server, client } = clientFor({ ...base, rule: null, executor: null, spentTodayRaw: 0n, allowanceRaw: null, aliases: [] });
    const rule = await client.getRule(owner);
    const executor = await client.getExecutor(owner);
    const spentTodayRaw = await client.spentToday(owner);
    const allowanceAsset = rule?.allowed_assets[0] ?? assetContractId;
    const allowanceRaw = await guard.getAllowance(server, {
      assetContractId: allowanceAsset,
      from: owner,
      spender: config.guardContractId,
      networkPassphrase: passphrase,
    });
    const aliases = await readAliases(client, owner, config.aliases);
    return { kind: "ok", state: { ...base, rule, executor, spentTodayRaw, allowanceRaw, aliases } };
  } catch (error) {
    return { kind: "unreachable", detail: messageOf(error) };
  }
}

/** A plan the panel can hand straight to `runTxSequence`. */
export interface BuiltPlan {
  steps: PlanStep[];
  readBack: string;
  order: PlanStepKind[];
  /** Human note about what is being signed, or why nothing is. */
  note: string;
}

/** Decode every step's summary from its own XDR and pair it with its intent. */
function toPlanSteps(
  steps: readonly approval.BuiltApprovalStep[],
  state: SecurityState,
  fields: LimitsFields,
): PlanStep[] {
  return steps.map((step) => {
    const { summary } = guard.buildGuardCallSummary({
      unsignedXdr: step.unsignedXdr,
      networkPassphrase: state.networkPassphrase,
    });
    return {
      result: { unsignedXdr: step.unsignedXdr, summary },
      intent: stepIntent(step.kind, fields, state.assetSymbol),
      label: stepLabel(step.kind),
    };
  });
}

/** Enable auto-pay: allowance → rule → executor (D13), executor last. */
export async function planEnable(
  fields: LimitsFields,
  executor: string,
  state: SecurityState,
): Promise<BuiltPlan> {
  const validation = validateLimits(fields, { executor, assetContractId: state.assetContractId });
  if (!validation.ok || !validation.draft) throw new Error(validation.errors.join("; "));
  const { server, client } = clientFor(state);
  const built = await approval.buildEnableAutoPay(
    {
      owner: state.owner,
      guard: client,
      rpc: server,
      networkPassphrase: state.networkPassphrase,
      currentAllowanceRaw: state.allowanceRaw ?? undefined,
      current: { rule: state.rule ?? undefined, executor: state.executor ?? undefined },
    },
    validation.draft,
  );
  const kinds = built.steps.map((step) => step.kind);
  if (!matchesOrder(kinds, ENABLE_STEP_ORDER)) throw new Error("unexpected enable step order");
  return {
    steps: toPlanSteps(built.steps, state, fields),
    readBack: readBackEnable(validation.draft, state.assetSymbol),
    order: [...ENABLE_STEP_ORDER],
    note: "3 owner signatures, one approval card + Touch ID per step (3). Step 3 arms unattended payments.",
  };
}

/** Always-ask baseline: allowance + zero-threshold rule, no executor. */
export async function planBaseline(fields: LimitsFields, state: SecurityState): Promise<BuiltPlan> {
  const validation = validateBaseline(fields, state.assetContractId);
  if (!validation.ok || !validation.rule || validation.allowanceRaw === null) {
    throw new Error(validation.errors.join("; "));
  }
  const { server, client } = clientFor(state);
  const built = await approval.buildBaselineSetup(
    {
      owner: state.owner,
      guard: client,
      rpc: server,
      networkPassphrase: state.networkPassphrase,
      currentAllowanceRaw: state.allowanceRaw ?? undefined,
    },
    {
      rule: validation.rule,
      allowanceRaw: validation.allowanceRaw,
      allowanceDays: fields.allowanceDays,
      assetContractId: state.assetContractId,
    },
  );
  const kinds = built.steps.map((step) => step.kind);
  if (!matchesOrder(kinds, BASELINE_STEP_ORDER)) throw new Error("unexpected baseline step order");
  return {
    steps: toPlanSteps(built.steps, state, { ...fields, threshold: "0" }),
    readBack: readBackBaseline(fields, state.assetSymbol),
    order: [...BASELINE_STEP_ORDER],
    note: "2 owner signatures, one approval card + Touch ID per step (2). No executor: every payment still needs approval.",
  };
}

/** Change the limits with `set_rule`; loosening still needs the full card. */
export async function planTighten(fields: LimitsFields, state: SecurityState): Promise<BuiltPlan> {
  const validation = validateRuleFields(fields, state.assetContractId);
  if (!validation.ok || !validation.rule) throw new Error(validation.errors.join("; "));
  const classification = approval.classifyChange(state.rule ?? undefined, validation.rule);
  const { client } = clientFor(state);
  const built = await approval.buildTightenRule(
    { owner: state.owner, guard: client, current: state.rule ?? undefined },
    validation.rule,
    { allowLoosening: classification !== "tightening" },
  );
  if (built.steps.length === 0) {
    return {
      steps: [],
      readBack: readBackTighten(fields, state.assetSymbol),
      order: [],
      note: "No change to apply: the rule already matches these limits.",
    };
  }
  return {
    steps: toPlanSteps(built.steps, state, fields),
    readBack: readBackTighten(fields, state.assetSymbol),
    order: ["set_rule"],
    note:
      classification === "tightening"
        ? "Tightening: one set_rule, lighter confirmation."
        : "Loosening: one set_rule, but it needs the full approval card + Touch ID.",
  };
}

/** Disable auto-pay: revoke the executor first, the allowance revoke is optional. */
export async function planDisable(revokeAllowance: boolean, state: SecurityState): Promise<BuiltPlan> {
  const { server, client } = clientFor(state);
  const built = await approval.buildDisableAutoPay(
    {
      owner: state.owner,
      guard: client,
      rpc: server,
      networkPassphrase: state.networkPassphrase,
      assetContractId: state.assetContractId,
    },
    { revokeAllowance },
  );
  const expected = disableStepOrder(revokeAllowance);
  const kinds = built.steps.map((step) => step.kind);
  if (!matchesOrder(kinds, expected)) throw new Error("unexpected disable step order");
  return {
    steps: toPlanSteps(built.steps, state, { ...fieldsForDisable(), knownRecipientsOnly: false }),
    readBack: readBackDisable(revokeAllowance, state.assetSymbol),
    order: expected,
    note: revokeAllowance
      ? "Disarm first; the allowance revoke is the global kill switch."
      : "Disarm only: existing schedules keep running until cancelled.",
  };
}

/** A minimal field set for flows that carry no limits (disable). */
function fieldsForDisable(): LimitsFields {
  return {
    threshold: "0",
    perTx: "0",
    daily: "0",
    allowance: "0",
    allowanceDays: 30,
    knownRecipientsOnly: false,
  };
}

/** Add/update alias-book entries with one `set_alias` per entry. */
export async function planSetAliases(entries: readonly AliasInput[], state: SecurityState): Promise<BuiltPlan> {
  const { client } = clientFor(state);
  const steps: PlanStep[] = [];
  for (const entry of entries) {
    const call = await client.setAlias(state.owner, entry.alias, entry.address);
    const { summary } = guard.buildGuardCallSummary({
      unsignedXdr: call.unsignedXdr,
      networkPassphrase: state.networkPassphrase,
    });
    const intent: Intent = {
      kind: "guard_policy",
      asset: state.assetSymbol,
      amount: "0",
      source: `security panel: set_alias ${entry.alias}`,
    };
    steps.push({
      result: { unsignedXdr: call.unsignedXdr, summary },
      intent,
      label: `Save alias ${entry.alias}`,
    });
  }
  return {
    steps,
    readBack: `Save ${entries.length} alias${entries.length === 1 ? "" : "es"} to the on-chain book?`,
    order: entries.map(() => "set_alias" as const),
    note: "Known-recipients-only payments resolve against this book.",
  };
}
