/**
 * The webview's typed window onto the Rust wallet engine (task W10b).
 *
 * The engine itself lives in another module and is built in parallel; this file
 * only knows its **fixed command contract** (camelCase, `docs/interfaces.md`
 * style) and wraps `invoke` so the UI never calls an untyped command string.
 * The `invoke` function is injected, which is what lets the pure decision tests
 * run under `node:test` with a fake and no Tauri.
 *
 * The engine is **feature-detected**: a build without the wallet commands
 * rejects with a "command not found" error, which [`isMissingCommandError`]
 * turns into a normal "not in this build" state instead of a crash.
 */

/** Every error kind the wallet engine contract documents. */
export type WalletErrorKind =
  | "exists"
  | "invalid"
  | "notFound"
  | "cancelled"
  | "keychain"
  | "unauthorized";

/** Kinds this wrapper adds for its own states. */
export type WalletFailureKind = WalletErrorKind | "unavailable" | "unknown";

/** A typed engine rejection. `message` is human-readable and never a secret. */
export class WalletEngineError extends Error {
  readonly kind: WalletFailureKind;

  constructor(kind: WalletFailureKind, message: string) {
    super(message);
    this.name = "WalletEngineError";
    this.kind = kind;
  }
}

export interface WalletActive {
  address: string;
  label: string | null;
}

/** `wallet_status()` reply. */
export interface WalletStatus {
  signer: "embedded";
  active: WalletActive | null;
  count: number;
  store: string;
}

/** `wallet_list()` row. */
export interface WalletEntry {
  address: string;
  label: string | null;
  createdAt: number;
  active: boolean;
}

export interface WalletCreateResult {
  address: string;
  /** 24 words, shown once; never persisted by this module. */
  recoveryPhrase: string;
}

export interface WalletImportPreview {
  address: string;
}

export type ImportInput = {
  secretOrPhrase: string;
  index?: number;
  label?: string;
};

/** The minimal `invoke` shape, so tests inject a spy without Tauri. */
export type WalletInvokeFn = (
  command: string,
  args?: Record<string, unknown>,
) => Promise<unknown>;

/** The engine surface the UI uses. Every method maps to one Rust command. */
export interface WalletEngine {
  /** `false` when the wallet commands are absent from this build. */
  available(): Promise<boolean>;
  status(): Promise<WalletStatus>;
  list(): Promise<WalletEntry[]>;
  create(input?: { label?: string }): Promise<WalletCreateResult>;
  importPreview(input: ImportInput): Promise<WalletImportPreview>;
  import(input: ImportInput): Promise<{ address: string }>;
  select(address: string): Promise<void>;
  rename(address: string, label: string): Promise<void>;
  remove(address: string): Promise<void>;
}

/**
 * A "no such command" rejection. Tauri rejects an unregistered command with a
 * message, not a structured error; matching it here is the feature-detect seam.
 */
export function isMissingCommandError(error: unknown): boolean {
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return /(not found|unknown command|no such command|command .* not)/i.test(message);
}

const ERROR_KINDS: readonly WalletErrorKind[] = [
  "exists",
  "invalid",
  "notFound",
  "cancelled",
  "keychain",
  "unauthorized",
];

/** Normalises anything thrown by `invoke` into a typed engine error. */
export function toWalletEngineError(error: unknown): WalletEngineError {
  if (error instanceof WalletEngineError) return error;
  if (typeof error === "object" && error !== null) {
    const candidate = error as { kind?: unknown; message?: unknown };
    if (ERROR_KINDS.includes(candidate.kind as WalletErrorKind)) {
      const message =
        typeof candidate.message === "string" && candidate.message.length > 0
          ? candidate.message
          : `wallet engine error: ${String(candidate.kind)}`;
      return new WalletEngineError(candidate.kind as WalletErrorKind, message);
    }
  }
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : "wallet engine failed";
  return new WalletEngineError(isMissingCommandError(error) ? "unavailable" : "unknown", message);
}

/** Builds an engine over an injected `invoke`, so the UI and tests share one path. */
export function createWalletEngine(invoke: WalletInvokeFn): WalletEngine {
  const call = async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
    try {
      return (await invoke(command, args)) as T;
    } catch (error) {
      throw toWalletEngineError(error);
    }
  };

  return {
    async available() {
      try {
        await call<WalletStatus>("wallet_status");
        return true;
      } catch (error) {
        if (error instanceof WalletEngineError && error.kind === "unavailable") return false;
        throw error;
      }
    },
    status: () => call<WalletStatus>("wallet_status"),
    list: () => call<WalletEntry[]>("wallet_list"),
    create: (input) => call<WalletCreateResult>("wallet_create", input ? { ...input } : {}),
    importPreview: (input) => call<WalletImportPreview>("wallet_import_preview", { ...input }),
    import: (input) => call<{ address: string }>("wallet_import", { ...input }),
    select: (address) => call<void>("wallet_select", { address }),
    rename: (address, label) => call<void>("wallet_rename", { address, label }),
    remove: (address) => call<void>("wallet_remove", { address }),
  };
}
