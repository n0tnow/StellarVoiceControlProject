/**
 * Pure load model behind the notch Rules editor.
 *
 * Everything here is free of React and Tauri so it runs under `node:test`: the
 * single executor probe (`executor_status` called ONCE, not the previous
 * `isAutoPaySupported()` + `executorStatus()` double round trip) and the mapping
 * from a decoded guard read to the editor's one snapshot. The React hook
 * (`useRulesEditor`) only wires these to effects and actions.
 */
import type { AutoPayContact } from "../../lib/autopay.ts";
import type { SecurityState } from "../../lib/guardState.ts";
import type { SecurityLoad } from "../../lib/guardStateLive.ts";
import { isMissingCommandError } from "../../lib/walletEngine.ts";

import { rulesFormFromState, type RulesForm } from "./rulesModel.ts";

/** Which of the page's five states is showing. */
export type RulesLoadState = "loading" | "ready" | "unconfigured" | "not_set_up" | "error";

/**
 * Whether a snapshot read for `snapshotOwner` may be shown/acted on under the
 * live wallet owner. Fail closed on a real account switch (different owners),
 * but allow when the wallet engine is absent and no live owner is known (a
 * build configured only by `POLARIS_OWNER_ADDRESS`): `null` means "unknown",
 * not "different". Pure so the guard is tested without a runtime.
 */
export function ownerGuardAllows(liveOwner: string | null, snapshotOwner: string | null): boolean {
  return liveOwner === null || snapshotOwner === liveOwner;
}

/** The form a fresh editor starts from (the page never invents a rule). */
export const EMPTY_FORM: RulesForm = {
  mode: "always_ask",
  threshold: "10",
  perTx: "20",
  daily: "100",
  knownRecipientsOnly: true,
};

/** The one snapshot the Rules editor renders and acts on. */
export interface EditorSnapshot {
  state: RulesLoadState;
  detail: string;
  security: SecurityState | null;
  form: RulesForm;
  contacts: AutoPayContact[];
  executorFunded: boolean | null;
  autoPaySupported: boolean;
}

export const LOADING_SNAPSHOT: EditorSnapshot = {
  state: "loading",
  detail: "",
  security: null,
  form: EMPTY_FORM,
  contacts: [],
  executorFunded: null,
  autoPaySupported: false,
};

/** Whether the auto-pay command surface exists, and whether the key is funded. */
export interface ExecutorProbe {
  supported: boolean;
  funded: boolean | null;
}

/** The one command `probeExecutor` needs; injectable for tests. */
export interface ExecutorProbeCommands {
  executorStatus(): Promise<{ funded: boolean | null }>;
}

export const UNSUPPORTED_EXECUTOR: ExecutorProbe = { supported: false, funded: null };

/**
 * One `executor_status` call decides both facts: a resolved status means the
 * command surface exists (and reports funding), a "command not found" rejection
 * means it does not. Any other rejection is a real error and is rethrown, so the
 * caller surfaces it instead of silently disabling auto-pay.
 */
export async function probeExecutor(commands: ExecutorProbeCommands): Promise<ExecutorProbe> {
  try {
    const status = await commands.executorStatus();
    return { supported: true, funded: status.funded ?? null };
  } catch (error) {
    if (isMissingCommandError(error)) return UNSUPPORTED_EXECUTOR;
    throw error;
  }
}

/** The inputs `editorSnapshotFrom` reduces to one snapshot. */
export interface EditorLoadInput {
  /** True outside Tauri (the browser preview): no chain, no owner. */
  offTauri: boolean;
  ownerAddress: string | null;
  contacts: AutoPayContact[];
  executor: ExecutorProbe;
  /** The decoded guard read, or `null` when it was never attempted. */
  load: SecurityLoad | null;
}

function unconfigured(base: Omit<EditorSnapshot, "state" | "detail" | "security">, detail: string): EditorSnapshot {
  return { ...base, state: "unconfigured", detail, security: null };
}

function withForm(
  base: Omit<EditorSnapshot, "state" | "detail" | "security">,
  state: RulesLoadState,
  detail: string,
  security: SecurityState | null,
  form: RulesForm,
): EditorSnapshot {
  return { ...base, state, detail, security, form };
}

/**
 * Reduces the load inputs to the editor snapshot. Pure so the five states and
 * the "never a mock rule for a real owner" rule are tested without a runtime.
 */
export function editorSnapshotFrom(input: EditorLoadInput): EditorSnapshot {
  const base = {
    contacts: input.contacts,
    executorFunded: input.executor.funded,
    autoPaySupported: input.executor.supported,
    form: EMPTY_FORM,
  };
  if (input.offTauri) return unconfigured(base, "Open Autonomy to read the real rules.");
  if (!input.ownerAddress) {
    return unconfigured(base, "Set POLARIS_OWNER_ADDRESS to manage rules.");
  }
  const load = input.load;
  if (load === null || load.kind === "unreachable") {
    return withForm(base, "error", load?.detail ?? "The rules could not be read.", null, EMPTY_FORM);
  }
  if (load.kind === "unconfigured") return unconfigured(base, load.detail);
  return withForm(
    base,
    load.state.rule === null ? "not_set_up" : "ready",
    "",
    load.state,
    rulesFormFromState(load.state),
  );
}
