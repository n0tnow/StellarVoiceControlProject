/**
 * The webview's typed window onto the Rust wallet session (task W13b).
 *
 * The state machine is `none` (no wallet stored) → `locked` (wallets exist,
 * nobody logged in; always the state at launch) → `unlocked`. The webview is
 * not trusted: Rust refuses every wallet command unless the session is
 * `unlocked` and drops `stellar_config.ownerAddress` on lock. This module only
 * mirrors that state for the UI — it holds no secret and moves no value.
 *
 * The engine is feature-detected (a build without `wallet_session` rejects with
 * "command not found"), so the pure modules and tests never import Tauri: the
 * factory takes an injected `invoke` and an injected event subscriber.
 */
import type { WalletSession, WalletSessionState } from "@polaris/interfaces";

import { isMissingCommandError } from "./walletEngine.ts";

/* ------------------------------------------------------------------ *
 * Session shape + pure selectors
 * ------------------------------------------------------------------ */

export type { WalletSession, WalletSessionState } from "@polaris/interfaces";

/** The UI screen a session resolves to; `loading` is "not read yet". */
export type WalletScreen = "loading" | "connect" | "unlock" | "dashboard";

export const DEFAULT_AUTO_LOCK_MINUTES = 30;

/** The auto-lock choices the settings row offers. */
export const AUTO_LOCK_OPTIONS: readonly { minutes: number; label: string }[] = [
  { minutes: 0, label: "Off" },
  { minutes: 5, label: "5 min" },
  { minutes: 15, label: "15 min" },
  { minutes: 30, label: "30 min" },
];

const STATES: readonly WalletSessionState[] = ["none", "locked", "unlocked"];

/** Validates an untrusted payload (a command result or an event) as a session. */
export function normalizeWalletSession(value: unknown): WalletSession | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Partial<WalletSession>;
  if (!STATES.includes(candidate.state as WalletSessionState)) return null;
  const active =
    candidate.active === null || candidate.active === undefined
      ? null
      : typeof candidate.active.address === "string" && typeof candidate.active.label === "string"
        ? { address: candidate.active.address, label: candidate.active.label }
        : null;
  return {
    state: candidate.state as WalletSessionState,
    active,
    count: typeof candidate.count === "number" ? candidate.count : 0,
    unlockedAt: typeof candidate.unlockedAt === "number" ? candidate.unlockedAt : null,
    autoLockMinutes:
      typeof candidate.autoLockMinutes === "number"
        ? candidate.autoLockMinutes
        : DEFAULT_AUTO_LOCK_MINUTES,
  };
}

export function isSessionUnlocked(session: WalletSession | null): boolean {
  return session?.state === "unlocked";
}

/**
 * Whether the UI must gate the non-wallet pages for this session. A `null`
 * session (engine absent or not read yet) does **not** gate: the Rust gate stays
 * the fail-closed authority, and a transient read failure must not lock the user
 * out of a build whose wallet engine is missing.
 */
export function shouldGateForSession(session: WalletSession | null): boolean {
  return session !== null && session.state !== "unlocked";
}

/**
 * The launch trigger: the first time the webview reads a session that is not
 * unlocked, the panel opens itself on the Wallet screen. The caller fires this
 * once (a ref guard), so closing the panel, or a later logout/auto-lock, never
 * re-forces it. The panel itself is always closable.
 */
export function shouldAutoOpenWallet(session: WalletSession | null): boolean {
  return session !== null && session.state !== "unlocked";
}

/**
 * Whether a session change is the logout/auto-lock edge (`unlocked` →
 * `locked`), which collapses the panel. Unlocking is not this edge, and neither
 * is the launch read (`null` → `locked`), which the auto-open handles instead.
 */
export function didSessionLock(
  previous: WalletSession | null,
  next: WalletSession | null,
): boolean {
  return previous?.state === "unlocked" && next?.state === "locked";
}

/** Maps a session (or its absence) to the Wallet page's one visible screen. */
export function walletScreenFor(session: WalletSession | null): WalletScreen {
  if (session === null) return "loading";
  if (session.state === "none") return "connect";
  if (session.state === "locked") return "unlock";
  return "dashboard";
}

/* ------------------------------------------------------------------ *
 * Engine (injectable invoke)
 * ------------------------------------------------------------------ */

export type WalletSessionInvokeFn = (
  command: string,
  args?: Record<string, unknown>,
) => Promise<unknown>;

/** The engine surface the UI uses. Every method maps to one Rust command. */
export interface WalletSessionEngine {
  /** `false` when the `wallet_session` commands are absent from this build. */
  available(): Promise<boolean>;
  current(): Promise<WalletSession>;
  unlock(address?: string): Promise<WalletSession>;
  lock(): Promise<WalletSession>;
  setAutoLock(minutes: number): Promise<WalletSession>;
}

/** A typed session rejection. `locked` is the new Rust refusal kind. */
export class WalletSessionError extends Error {
  readonly kind: string;

  constructor(kind: string, message: string) {
    super(message);
    this.name = "WalletSessionError";
    this.kind = kind;
  }
}

/** Normalises anything thrown by `invoke` into a typed session error. */
export function toWalletSessionError(error: unknown): WalletSessionError {
  if (error instanceof WalletSessionError) return error;
  if (typeof error === "object" && error !== null) {
    const candidate = error as { kind?: unknown; message?: unknown };
    if (typeof candidate.kind === "string") {
      const message =
        typeof candidate.message === "string" && candidate.message.length > 0
          ? candidate.message
          : `wallet session error: ${candidate.kind}`;
      return new WalletSessionError(candidate.kind, message);
    }
  }
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : "wallet session failed";
  return new WalletSessionError(isMissingCommandError(error) ? "unavailable" : "unknown", message);
}

/** Builds an engine over an injected `invoke`, so the UI and tests share one path. */
export function createWalletSessionEngine(invoke: WalletSessionInvokeFn): WalletSessionEngine {
  const call = async (command: string, args?: Record<string, unknown>): Promise<WalletSession> => {
    let raw: unknown;
    try {
      raw = await invoke(command, args);
    } catch (error) {
      throw toWalletSessionError(error);
    }
    const session = normalizeWalletSession(raw);
    if (session === null) throw new WalletSessionError("unknown", "wallet session answer was malformed");
    return session;
  };

  return {
    async available() {
      try {
        await call("wallet_session");
        return true;
      } catch (error) {
        if (error instanceof WalletSessionError && error.kind === "unavailable") return false;
        throw error;
      }
    },
    current: () => call("wallet_session"),
    unlock: (address) =>
      call("wallet_unlock", address === undefined ? {} : { address }),
    lock: () => call("wallet_lock"),
    setAutoLock: (minutes) => call("wallet_set_auto_lock", { minutes }),
  };
}

/* ------------------------------------------------------------------ *
 * Observable store (one subscription for the whole webview)
 * ------------------------------------------------------------------ */

/** What React reads; replaced only when something actually changed. */
export interface WalletSessionSnapshot {
  session: WalletSession | null;
  /** `null` until the first probe; `false` means "not in this build". */
  available: boolean | null;
  loading: boolean;
}

/** The injected event subscription; returns its unsubscribe function. */
export type WalletSessionListenFn = (
  handler: (session: WalletSession) => void,
) => Promise<() => void>;

export interface WalletSessionStore {
  getSnapshot(): WalletSessionSnapshot;
  subscribe(listener: () => void): () => void;
  /** Idempotent: subscribes once, then reads the launch snapshot. */
  start(): Promise<void>;
  refresh(): Promise<void>;
  unlock(address?: string): Promise<WalletSession>;
  lock(): Promise<WalletSession>;
  setAutoLock(minutes: number): Promise<WalletSession>;
}

const INITIAL: WalletSessionSnapshot = { session: null, available: null, loading: true };

export function createWalletSessionStore(
  engine: WalletSessionEngine,
  listen?: WalletSessionListenFn,
): WalletSessionStore {
  let snapshot = INITIAL;
  let started: Promise<void> | null = null;
  const listeners = new Set<() => void>();

  const set = (next: WalletSessionSnapshot): void => {
    snapshot = next;
    listeners.forEach((listener) => listener());
  };

  const apply = (session: WalletSession): void => {
    set({ session, available: true, loading: false });
  };

  const refresh = async (): Promise<void> => {
    try {
      const session = await engine.current();
      apply(session);
    } catch (error) {
      const kind = error instanceof WalletSessionError ? error.kind : "unknown";
      set({ session: null, available: kind === "unavailable" ? false : snapshot.available, loading: false });
    }
  };

  const start = (): Promise<void> => {
    started ??= (async () => {
      let available = true;
      try {
        available = await engine.available();
      } catch {
        available = false;
      }
      if (!available) {
        set({ session: null, available: false, loading: false });
        return;
      }
      if (listen) {
        // Subscribe before the snapshot read so no transition is missed.
        try {
          await listen((session) => apply(session));
        } catch (error) {
          console.warn("wallet session could not subscribe to wallet_session_changed", error);
        }
      }
      await refresh();
    })();
    return started;
  };

  const action = async (run: () => Promise<WalletSession>): Promise<WalletSession> => {
    const session = await run();
    apply(session);
    return session;
  };

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start,
    refresh,
    unlock: (address) => action(() => engine.unlock(address)),
    lock: () => action(() => engine.lock()),
    setAutoLock: (minutes) => action(() => engine.setAutoLock(minutes)),
  };
}
