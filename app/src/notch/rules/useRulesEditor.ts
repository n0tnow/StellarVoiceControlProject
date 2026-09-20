/**
 * Live data + actions behind the notch Rules editor (W11b).
 *
 * A read is the same `loadSecurityState` the Security panel uses; a write is a
 * `guard_policy` intent handed to `executeApprovedIntent`, so the Rules page and
 * the voice path share ONE approval flow (the batch card + one Touch ID).
 *
 * Performance: the contacts read, the executor probe and the guard read run in
 * PARALLEL (they are independent), and the executor is probed with a single
 * `executor_status` call. The last snapshot is kept in a module-level cache and
 * concurrent mounts share one in-flight load, so reopening the page paints the
 * previous rule immediately and revalidates in the background instead of
 * blocking on the chain.
 */
import { useCallback, useEffect, useState } from "react";

import { executeApprovedIntent } from "@/lib/chain";
import { createAutoPayCommands } from "@/lib/autopayLive";
import { loadSecurityState } from "@/lib/guardStateLive";
import type { SecurityState } from "@/lib/guardState";
import type { AutoPayContact } from "@/lib/autopay";

import { normalizeForm, ruleIntent, type RulesForm } from "./rulesModel";
import {
  EMPTY_FORM,
  LOADING_SNAPSHOT,
  editorSnapshotFrom,
  probeExecutor,
  type EditorSnapshot,
  type RulesLoadState,
} from "./rulesLoad";

export type { RulesLoadState } from "./rulesLoad";

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

/** The last loaded snapshot, shared across mounts of the page. */
let rulesCache: EditorSnapshot | null = null;

/** The read in flight, so two mounts (or a remount) never issue it twice. */
let rulesInFlight: Promise<EditorSnapshot> | null = null;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function loadContacts(): Promise<AutoPayContact[]> {
  try {
    const { contactsClient } = await import("@/lib/contacts");
    const contacts = await contactsClient.list();
    return contacts.map((contact) => ({ alias: contact.nickname, address: contact.address }));
  } catch {
    return [];
  }
}

/**
 * The whole read, in one pass. Contacts, the executor probe and the guard state
 * are independent, so they resolve together; a failure at any step becomes the
 * error snapshot instead of throwing into the render.
 */
async function loadEditorSnapshot(): Promise<EditorSnapshot> {
  try {
    const { isTauri } = await import("@tauri-apps/api/core");
    if (!isTauri()) {
      return editorSnapshotFrom({
        offTauri: true,
        ownerAddress: null,
        contacts: [],
        executor: { supported: false, funded: null },
        load: null,
      });
    }
    const { getStellarConfig } = await import("@/lib/stellarConfig");
    const config = await getStellarConfig();
    if (!config.ownerAddress) {
      return editorSnapshotFrom({
        offTauri: false,
        ownerAddress: null,
        contacts: [],
        executor: { supported: false, funded: null },
        load: null,
      });
    }
    const [contacts, executor, load] = await Promise.all([
      loadContacts(),
      probeExecutor(createAutoPayCommands()),
      loadSecurityState(),
    ]);
    return editorSnapshotFrom({ offTauri: false, ownerAddress: config.ownerAddress, contacts, executor, load });
  } catch (error) {
    return { ...LOADING_SNAPSHOT, state: "error", detail: messageOf(error) };
  }
}

/** Dedupes concurrent reads: every caller awaits the same in-flight promise. */
function fetchEditorSnapshot(): Promise<EditorSnapshot> {
  rulesInFlight ??= loadEditorSnapshot().finally(() => {
    rulesInFlight = null;
  });
  return rulesInFlight;
}

export function useRulesEditor(): RulesEditorData {
  const cached = rulesCache;
  const [state, setState] = useState<RulesLoadState>(cached?.state ?? "loading");
  const [detail, setDetail] = useState(cached?.detail ?? "");
  const [security, setSecurity] = useState<SecurityState | null>(cached?.security ?? null);
  const [form, setForm] = useState<RulesForm>(cached?.form ?? EMPTY_FORM);
  const [contacts, setContacts] = useState<AutoPayContact[]>(cached?.contacts ?? []);
  const [executorFunded, setExecutorFunded] = useState<boolean | null>(cached?.executorFunded ?? null);
  const [autoPaySupported, setAutoPaySupported] = useState(cached?.autoPaySupported ?? false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [resultHash, setResultHash] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const refresh = useCallback(() => setNonce((value) => value + 1), []);

  useEffect(() => {
    let cancelled = false;
    // The cached snapshot is already on screen; this call only revalidates it.
    void fetchEditorSnapshot().then((next) => {
      rulesCache = next;
      if (cancelled) return;
      setState(next.state);
      setDetail(next.detail);
      setSecurity(next.security);
      setForm(next.form);
      setContacts(next.contacts);
      setExecutorFunded(next.executorFunded);
      setAutoPaySupported(next.autoPaySupported);
    });
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
