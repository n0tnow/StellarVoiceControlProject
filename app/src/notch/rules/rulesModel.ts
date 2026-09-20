/**
 * Pure view model for the notch Rules editor (W11b).
 *
 * Everything here is a projection of the decoded on-chain state plus the local
 * contact list: the form's initial values, the read-back lines and the
 * `guard_policy` intent a save produces. The intent is handed straight to
 * `executeApprovedIntent`, so the Rules page and the voice path share ONE
 * approval flow (one batch card, one Touch ID).
 */
import { guard } from "@polaris/stellar";
import type { Intent } from "@polaris/interfaces";

import type { SecurityState } from "@/lib/guardState";
import type { AutoPayContact } from "@/lib/autopay";

/** The editable fields. `threshold`/`perTx`/`daily` are display decimal strings. */
export interface RulesForm {
  mode: "always_ask" | "auto_under_limit";
  threshold: string;
  perTx: string;
  daily: string;
  knownRecipientsOnly: boolean;
}

/** The form that matches the current on-chain state. */
export function rulesFormFromState(state: Pick<SecurityState, "rule" | "executor">): RulesForm {
  const rule = state.rule;
  const armed = rule !== null && (rule.auto_approve_limit ?? 0n) > 0n;
  return {
    mode: armed ? "auto_under_limit" : "always_ask",
    threshold: rule ? guard.fromRawUnits(rule.auto_approve_limit) : "10",
    perTx: rule ? guard.fromRawUnits(rule.per_tx_limit) : "20",
    daily: rule ? guard.fromRawUnits(rule.daily_limit) : "100",
    knownRecipientsOnly: rule?.known_recipients_only ?? true,
  };
}

/**
 * The `guard_policy` intent for a save. `always_ask` carries no limits (the
 * disable path); `auto_under_limit` carries the typed limit and the recipient
 * policy. The asset is resolved on the chain lane, never invented here.
 */
export function ruleIntent(form: RulesForm, assetSymbol: string, source: string): Intent {
  if (form.mode === "always_ask") {
    return { kind: "guard_policy", asset: assetSymbol, amount: "0", rule: { mode: "always_ask" }, source };
  }
  return {
    kind: "guard_policy",
    asset: assetSymbol,
    amount: form.threshold,
    rule: {
      mode: "auto_under_limit",
      asset: assetSymbol,
      autoApproveLimit: form.threshold,
      perTxLimit: form.perTx,
      dailyLimit: form.daily,
      knownRecipientsOnly: form.knownRecipientsOnly,
    },
    source,
  };
}

/** One label/value line the Rules page renders. */
export interface RuleLine {
  label: string;
  value: string;
}

/**
 * Count the saved contacts whose alias + address already match the on-chain
 * book, against the total saved (the "N of M" on the page).
 */
export function contactsSynced(
  state: Pick<SecurityState, "aliases">,
  contacts: readonly AutoPayContact[],
): { synced: number; total: number } {
  const synced = contacts.filter((contact) =>
    state.aliases.some((alias) => alias.alias === contact.alias && alias.onChain === contact.address),
  ).length;
  return { synced, total: contacts.length };
}

/** The status/limits/exposure lines, in the order the page shows them. */
export function rulesView(
  state: SecurityState,
  contacts: readonly AutoPayContact[],
  executorFunded: boolean | null,
): RuleLine[] {
  const rule = state.rule;
  const armed = state.executor !== null && (rule?.auto_approve_limit ?? 0n) > 0n;
  const symbol = state.assetSymbol;
  const synced = contactsSynced(state, contacts);
  const lines: RuleLine[] = [
    { label: "Status", value: armed ? "Auto under limit" : "Always ask" },
    {
      label: "Executor",
      value: state.executor
        ? `${guard.shortKey(state.executor)} · fees ${executorFunded === false ? "unfunded" : executorFunded === true ? "funded" : "unknown"}`
        : "not registered",
    },
    {
      label: "Auto limit",
      value: rule ? `${guard.fromRawUnits(rule.auto_approve_limit)} ${symbol}` : "—",
    },
    { label: "Per payment", value: rule ? `${guard.fromRawUnits(rule.per_tx_limit)} ${symbol}` : "—" },
    { label: "Per day", value: rule ? `${guard.fromRawUnits(rule.daily_limit)} ${symbol}` : "—" },
    { label: "Allowed asset", value: symbol },
    {
      label: "Recipients",
      value: rule?.known_recipients_only ? "saved contacts only" : "anyone",
    },
    { label: "Contacts synced", value: `${synced.synced} of ${synced.total}` },
    {
      label: "Spent today",
      value: rule
        ? `${guard.fromRawUnits(state.spentTodayRaw)} of ${guard.fromRawUnits(rule.daily_limit)} ${symbol}`
        : guard.fromRawUnits(state.spentTodayRaw) + ` ${symbol}`,
    },
  ];
  return lines;
}
