/**
 * Live data + actions behind the notch Rules editor (W11b).
 *
 * A read is the same `loadSecurityState` the Security panel uses; a write is a
 * `guard_policy` intent handed to `executeApprovedIntent`, so the Rules page and
 * the voice path share ONE approval flow (the batch card + one Touch ID).
 *
 * Performance: the contacts read, the executor probe and the guard read run in
 * PARALLEL (they are independent), and the executor is probed with a single
 * `executor_status` call. The last snapshot is kept in an **owner-scoped** cache
 * (keyed by `ownerAddress|networkPassphrase`) and concurrent mounts share one
 * in-flight load, so reopening the page paints the previous rule immediately and
 * revalidates in the background instead of blocking on the chain. The key means
 * a snapshot is never seeded or served after the active wallet account changes;
 * the cache is cleared on that edge and the effect refetches.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

import { executeApprovedIntent } from "@/lib/chain";
import { createAutoPayCommands } from "@/lib/autopayLive";
import { loadSecurityState } from "@/lib/guardStateLive";
import { walletSessionStore } from "@/lib/walletSessionLive";
import type { SecurityState } from "@/lib/guardState";
import type { AutoPayContact } from "@/lib/autopay";

import { normalizeForm, ruleIntent, type RulesForm } from "./rulesModel";
import { createSnapshotCache, type SnapshotLoad } from "../data/snapshotCache.ts";
import {
  EMPTY_FORM,
  editorSnapshotFrom,
  ownerGuardAllows,
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
  /** True while a background revalidation runs over an already-shown snapshot. */
  refreshing: boolean;
  /** A failed background revalidation's message, while the last good rule stays. */
  refreshError: string | null;
  /** The last action's one-line result, or its failure reason. */
  message: string | null;
  /** The tx hash of the last submitted setup, or `null` when there is none. */
  resultHash: string | null;
  save: () => Promise<void>;
  disable: () => Promise<void>;
  syncContacts: () => Promise<void>;
  refresh: () => void;
}

/* ------------------------------------------------------------------ *
 * Owner-scoped snapshot cache
 * ------------------------------------------------------------------ */

/** The cache key for the browser preview / a build without an owner. */
const PREVIEW_KEY = "preview";

/** Separator between the owner and the network in a scope key. */
const KEY_SEPARATOR = "|";

/** The scope key a snapshot is read for: `ownerAddress|networkPassphrase`. */
function scopeKey(owner: string, network: string): string {
  return `${owner}${KEY_SEPARATOR}${network}`;
}

/** The owner half of a scope key. */
function scopeOwner(key: string): string {
  const end = key.indexOf(KEY_SEPARATOR);
  return end === -1 ? key : key.slice(0, end);
}

/** The active wallet account, or `null` when locked/absent or in the preview. */
function useActiveOwner(): string | null {
  const read = (): string | null => walletSessionStore.getSnapshot().session?.active?.address ?? null;
  return useSyncExternalStore(walletSessionStore.subscribe, read, read);
}

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
 * are independent, so they resolve together. A transient chain failure is
 * returned as `{ ok: false }` (never as a snapshot), so the cache can keep the
 * last good rule instead of replacing it with an error.
 */
async function loadEditorSnapshot(_key: string): Promise<SnapshotLoad<EditorSnapshot>> {
  try {
    const { isTauri } = await import("@tauri-apps/api/core");
    if (!isTauri()) {
      return {
        ok: true,
        key: PREVIEW_KEY,
        value: editorSnapshotFrom({
          offTauri: true,
          ownerAddress: null,
          contacts: [],
          executor: { supported: false, funded: null },
          load: null,
        }),
      };
    }
    const { getStellarConfig } = await import("@/lib/stellarConfig");
    const config = await getStellarConfig();
    if (!config.ownerAddress) {
      return {
        ok: true,
        key: PREVIEW_KEY,
        value: editorSnapshotFrom({
          offTauri: false,
          ownerAddress: null,
          contacts: [],
          executor: { supported: false, funded: null },
          load: null,
        }),
      };
    }
    const key = scopeKey(config.ownerAddress, config.networkPassphrase);
    const [contacts, executor, load] = await Promise.all([
      loadContacts(),
      probeExecutor(createAutoPayCommands()),
      loadSecurityState(),
    ]);
    if (load.kind === "unreachable") return { ok: false, error: load.detail };
    return {
      ok: true,
      key,
      value: editorSnapshotFrom({ offTauri: false, ownerAddress: config.ownerAddress, contacts, executor, load }),
    };
  } catch (error) {
    return { ok: false, error: messageOf(error) };
  }
}

/** The last loaded snapshot, shared across mounts of the page. */
const rulesCache = createSnapshotCache<EditorSnapshot>(loadEditorSnapshot);

/**
 * The cached snapshot's key, but only when it belongs to `owner`; `null`
 * otherwise. A network change also changes the key, so it can never seed.
 */
function seedKeyFor(owner: string | null): string | null {
  const stored = rulesCache.cachedKey();
  if (stored === null) return null;
  if (owner === null) return stored === PREVIEW_KEY ? PREVIEW_KEY : null;
  return scopeOwner(stored) === owner ? stored : null;
}

export function useRulesEditor(): RulesEditorData {
  const owner = useActiveOwner();
  const seed = rulesCache.peek(seedKeyFor(owner));
  const [state, setState] = useState<RulesLoadState>(seed?.state ?? "loading");
  const [detail, setDetail] = useState(seed?.detail ?? "");
  const [security, setSecurity] = useState<SecurityState | null>(seed?.security ?? null);
  const [form, setForm] = useState<RulesForm>(seed?.form ?? EMPTY_FORM);
  const [contacts, setContacts] = useState<AutoPayContact[]>(seed?.contacts ?? []);
  const [executorFunded, setExecutorFunded] = useState<boolean | null>(seed?.executorFunded ?? null);
  const [autoPaySupported, setAutoPaySupported] = useState(seed?.autoPaySupported ?? false);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [resultHash, setResultHash] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const firstRun = useRef(true);
  const previousOwner = useRef<string | null | undefined>(undefined);
  /** True once the user edits the form: a background refresh must not clobber it. */
  const dirty = useRef(false);

  const refresh = useCallback(() => setNonce((value) => value + 1), []);

  const apply = useCallback((next: EditorSnapshot) => {
    setState(next.state);
    setDetail(next.detail);
    setSecurity(next.security);
    setContacts(next.contacts);
    setExecutorFunded(next.executorFunded);
    setAutoPaySupported(next.autoPaySupported);
    if (!dirty.current) setForm(next.form);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const first = firstRun.current;
    firstRun.current = false;
    const ownerChanged = !first && previousOwner.current !== owner;
    previousOwner.current = owner;
    if (ownerChanged) {
      // The active account changed: no snapshot from the previous owner may be
      // seeded or acted on. Reset to a skeleton and load the new owner.
      rulesCache.clear();
      dirty.current = false;
      setState("loading");
      setDetail("");
      setSecurity(null);
      setContacts([]);
      setExecutorFunded(null);
      setAutoPaySupported(false);
      setForm(EMPTY_FORM);
      setRefreshError(null);
      setRefreshing(false);
    } else if (seedKeyFor(owner) !== null) {
      setRefreshing(true);
    }

    const seedKey = seedKeyFor(owner);
    const requestedKey = seedKey ?? (owner === null ? PREVIEW_KEY : `${owner}${KEY_SEPARATOR}`);
    void rulesCache.load(requestedKey, { force: !first }).then((read) => {
      if (cancelled) return;
      if (read.value === null) {
        setState("error");
        setDetail(read.error ?? "The rules could not be read.");
        setSecurity(null);
        setRefreshError(null);
      } else if (read.stale) {
        // Keep the last good rule; only hint that the refresh failed.
        apply(read.value);
        setRefreshError(read.error);
      } else {
        apply(read.value);
        setRefreshError(null);
      }
      setRefreshing(false);
    });
    return () => {
      cancelled = true;
    };
  }, [nonce, owner, apply]);

  const run = useCallback(
    async (next: RulesForm, source: string) => {
      // Fail closed: never act with a snapshot read for a different account.
      const liveOwner = walletSessionStore.getSnapshot().session?.active?.address ?? null;
      if (!security || !ownerGuardAllows(liveOwner, security.owner)) return;
      setBusy(true);
      setMessage(null);
      setResultHash(null);
      const outcome = await executeApprovedIntent(ruleIntent(next, security.assetSymbol, source));
      setMessage(outcome.label ?? outcome.detail ?? "Done");
      setResultHash(outcome.txHash ?? null);
      setBusy(false);
      // A published rule is the new source of truth; let the refresh re-seed it.
      if (outcome.status === "executed") dirty.current = false;
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
    dirty.current = true;
    setForm((current) => ({ ...current, ...next }));
  }, []);

  return {
    state,
    detail,
    // Gate the first frame after an account switch: never paint/act on another owner's rule.
    security: security !== null && ownerGuardAllows(owner, security.owner) ? security : null,
    form,
    patch,
    contacts,
    executorFunded,
    autoPaySupported,
    busy,
    refreshing,
    refreshError,
    message,
    resultHash,
    save,
    disable,
    syncContacts,
    refresh,
  };
}
