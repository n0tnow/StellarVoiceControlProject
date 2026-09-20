/**
 * Live data + actions behind the notch Rules editor (W11b).
 *
 * A read is the same `loadSecurityState` the Security panel uses; a write is a
 * `guard_policy` intent handed to `executeApprovedIntent`, so the Rules page and
 * the voice path share ONE approval flow (the batch card + one Touch ID).
 */
import { useCallback, useEffect, useState } from "react";

import { executeApprovedIntent } from "@/lib/chain";
import { createAutoPayCommands, isAutoPaySupported } from "@/lib/autopayLive";
import { loadSecurityState } from "@/lib/guardStateLive";
import type { SecurityState } from "@/lib/guardState";
import type { AutoPayContact } from "@/lib/autopay";

import { normalizeForm, ruleIntent, rulesFormFromState, type RulesForm } from "./rulesModel";

export type RulesLoadState = "loading" | "ready" | "unconfigured" | "not_set_up" | "error";

export interface RulesEditorData {
  state: RulesLoadState;
  detail: string;
  security: SecurityState | null;
  form: RulesForm;
  patch: (next: Partial<RulesForm>) => void;
  contacts: AutoPayContact[];
  executorFunded: boolean | null;
  autoPaySupported: boolean;
  busy: boolean;
  /** The last action's one-line result, or its failure reason. */
  message: string | null;
  /** The tx hash of the last submitted setup, or `null` when there is none. */
  resultHash: string | null;
  save: () => Promise<void>;
  disable: () => Promise<void>;
  syncContacts: () => Promise<void>;
  refresh: () => void;
}

const EMPTY_FORM: RulesForm = {
  mode: "always_ask",
  threshold: "10",
  perTx: "20",
  daily: "100",
  knownRecipientsOnly: true,
};

async function loadContacts(): Promise<AutoPayContact[]> {
  try {
    const { contactsClient } = await import("@/lib/contacts");
    const contacts = await contactsClient.list();
    return contacts.map((contact) => ({ alias: contact.nickname, address: contact.address }));
  } catch {
    return [];
  }
}

export function useRulesEditor(): RulesEditorData {
  const [state, setState] = useState<RulesLoadState>("loading");
  const [detail, setDetail] = useState("");
  const [security, setSecurity] = useState<SecurityState | null>(null);
  const [form, setForm] = useState<RulesForm>(EMPTY_FORM);
  const [contacts, setContacts] = useState<AutoPayContact[]>([]);
  const [executorFunded, setExecutorFunded] = useState<boolean | null>(null);
  const [autoPaySupported, setAutoPaySupported] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [resultHash, setResultHash] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const refresh = useCallback(() => setNonce((value) => value + 1), []);

  useEffect(() => {
    let cancelled = false;
    setState("loading");
    void (async () => {
      try {
        const { isTauri } = await import("@tauri-apps/api/core");
        if (!isTauri()) {
          if (!cancelled) {
            setSecurity(null);
            setState("unconfigured");
            setDetail("Open Autonomy to read the real rules.");
          }
          return;
        }
        const { getStellarConfig } = await import("@/lib/stellarConfig");
        const config = await getStellarConfig();
        if (!config.ownerAddress) {
          if (!cancelled) {
            setState("unconfigured");
            setDetail("Set POLARIS_OWNER_ADDRESS to manage rules.");
          }
          return;
        }
        const applied = await loadContacts();
        const supported = await isAutoPaySupported();
        const funded = supported ? (await createAutoPayCommands().executorStatus()).funded : null;
        const load = await loadSecurityState();
        if (cancelled) return;
        setContacts(applied);
        setExecutorFunded(funded);
        setAutoPaySupported(supported);
        if (load.kind === "unconfigured") {
          setState("unconfigured");
          setDetail(load.detail);
          return;
        }
        if (load.kind === "unreachable") {
          setState("error");
          setDetail(load.detail);
          return;
        }
        setSecurity(load.state);
        setForm(rulesFormFromState(load.state));
        setState(load.state.rule === null ? "not_set_up" : "ready");
        setDetail("");
      } catch (error) {
        if (!cancelled) {
          setState("error");
          setDetail(error instanceof Error ? error.message : String(error));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [nonce]);

  const run = useCallback(
    async (next: RulesForm, source: string) => {
      if (!security) return;
      setBusy(true);
      setMessage(null);
      setResultHash(null);
      const outcome = await executeApprovedIntent(ruleIntent(next, security.assetSymbol, source));
      setMessage(outcome.label ?? outcome.detail ?? "Done");
      setResultHash(outcome.txHash ?? null);
      setBusy(false);
      refresh();
    },
    [security, refresh],
  );

  // The single control collapses to "always ask" when the threshold is blank or
  // zero, so a cleared field can never accidentally arm automatic payments.
  const save = useCallback(() => run(normalizeForm(form), "rules page: save"), [run, form]);
  const disable = useCallback(() => run({ ...form, mode: "always_ask" }, "rules page: disable"), [run, form]);
  const syncContacts = useCallback(() => run(form, "rules page: sync contacts"), [run, form]);

  const patch = useCallback((next: Partial<RulesForm>) => {
    setForm((current) => ({ ...current, ...next }));
  }, []);

  return {
    state,
    detail,
    security,
    form,
    patch,
    contacts,
    executorFunded,
    autoPaySupported,
    busy,
    message,
    resultHash,
    save,
    disable,
    syncContacts,
    refresh,
  };
}
