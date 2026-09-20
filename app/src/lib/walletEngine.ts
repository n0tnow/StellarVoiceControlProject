/**
 * The webview's typed window onto the Rust wallet engine (task W10b).
 *
 * The engine itself is the Rust `wallet_*` command set; this file only knows its
 * **fixed contract** (the `@polaris/interfaces` wallet types) and wraps `invoke`
 * so the UI never calls an untyped command string. The `invoke` function is
 * injected, which is what lets the pure decision tests run under `node:test`
 * with a fake and no Tauri.
 *
 * The engine is **feature-detected**: a build without the wallet commands
 * rejects with a "command not found" error, which [`isMissingCommandError`]
 * turns into a normal "not in this build" state instead of a crash.
 */
import type {
  WalletAccount,
  WalletAddressOutcome,
  WalletCreateOutcome,
  WalletErrorKind,
  WalletStatus,
} from "@polaris/interfaces";

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
  list(): Promise<WalletAccount[]>;
  create(input?: { label?: string }): Promise<WalletCreateOutcome>;
  importPreview(input: ImportInput): Promise<WalletAddressOutcome>;
  import(input: ImportInput): Promise<WalletAddressOutcome>;
  select(address: string): Promise<WalletAddressOutcome>;
  rename(address: string, label: string): Promise<WalletAddressOutcome>;
  remove(address: string): Promise<WalletAddressOutcome>;
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
  "file",
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
    list: () => call<WalletAccount[]>("wallet_list"),
    create: (input) => call<WalletCreateOutcome>("wallet_create", input ? { ...input } : {}),
    importPreview: (input) => call<WalletAddressOutcome>("wallet_import_preview", { ...input }),
    import: (input) => call<WalletAddressOutcome>("wallet_import", { ...input }),
    select: (address) => call<WalletAddressOutcome>("wallet_select", { address }),
    rename: (address, label) => call<WalletAddressOutcome>("wallet_rename", { address, label }),
    remove: (address) => call<WalletAddressOutcome>("wallet_remove", { address }),
  };
}
