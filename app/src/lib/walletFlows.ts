/**
 * Pure reducers and validators for the Wallet page's onboarding (task W10b).
 *
 * The Create and Import flows are the only places in the UI that ever hold a
 * recovery phrase or a secret key, and they hold it for as short a time as
 * possible: the phrase state exists only while it is on screen and is cleared on
 * confirmation, and the import field is cleared the instant it is submitted or
 * cancelled. Keeping those transitions here (no React, no Tauri) makes the
 * "shown once / never retained" rules testable under `node:test`.
 *
 * Nothing here signs, stores or transmits anything: the reducers only describe
 * screen state, and the caller is what actually calls the wallet engine.
 */

/* ------------------------------------------------------------------ *
 * Connect-existing copy (task W14)
 * ------------------------------------------------------------------ */

/**
 * The user-facing wording of the "connect an existing wallet" path (task W14).
 * Kept here so the primary first-run copy is testable and cannot silently drift
 * back to presenting wallet creation first.
 */
export const CONNECT_COPY = {
  screenTitle: "Connect your wallet",
  screenBody:
    "Already use Freighter, Lobstr or xBull? Paste that account's secret key once. " +
    "Autonomy keeps it in the macOS Keychain, asks for Touch ID, and signs every " +
    "payment here — you never go back to the other wallet app.",
  connectExisting: "Connect existing wallet",
  createNew: "Create new wallet",
  importHeading: "Connect existing wallet",
  previewHeading: "Connect this account?",
  confirm: "Connect and store in Keychain",
} as const;

/* ------------------------------------------------------------------ *
 * Create flow
 * ------------------------------------------------------------------ */

export type CreateStep = "idle" | "working" | "phrase" | "saved";

export interface CreateState {
  step: CreateStep;
  address: string | null;
  /** The 24 words, present only while `step === "phrase"`. Cleared after. */
  phrase: string[] | null;
  error: string | null;
}

export const initialCreateState: CreateState = {
  step: "idle",
  address: null,
  phrase: null,
  error: null,
};

export type CreateAction =
  | { type: "start" }
  | { type: "created"; address: string; recoveryPhrase: string }
  | { type: "failed"; error: string }
  | { type: "confirmed" }
  | { type: "reset" };

/** Splits a recovery phrase into words, ignoring extra whitespace. */
export function splitPhrase(value: string): string[] {
  return value.trim().split(/\s+/).filter((word) => word.length > 0);
}

export function reduceCreate(state: CreateState, action: CreateAction): CreateState {
  switch (action.type) {
    case "start":
      return { ...initialCreateState, step: "working" };
    case "created":
      return {
        step: "phrase",
        address: action.address,
        phrase: splitPhrase(action.recoveryPhrase),
        error: null,
      };
    case "failed":
      // Never keep a phrase alongside a failure.
      return { ...initialCreateState, error: action.error };
    case "confirmed":
      // The "I saved it" gate: only a phrase on screen can be confirmed, and
      // confirming is what drops it from state for good.
      if (state.step !== "phrase") return state;
      return { step: "saved", address: state.address, phrase: null, error: null };
    case "reset":
      return initialCreateState;
  }
}

/* ------------------------------------------------------------------ *
 * Import flow
 * ------------------------------------------------------------------ */

export type ImportMode = "secret" | "phrase";
export type ImportStep = "input" | "previewing" | "preview" | "storing" | "stored";

export interface ImportState {
  step: ImportStep;
  mode: ImportMode;
  /** The secret key or recovery phrase; cleared on submit/cancel/failure. */
  secret: string;
  /** Optional derivation index, kept as the raw field text. */
  index: string;
  /** The previewed address, present once derivation has happened. */
  address: string | null;
  error: string | null;
}

export const initialImportState: ImportState = {
  step: "input",
  mode: "secret",
  secret: "",
  index: "",
  address: null,
  error: null,
};

export type ImportAction =
  | { type: "mode"; mode: ImportMode }
  | { type: "secret"; value: string }
  | { type: "index"; value: string }
  | { type: "preview" }
  | { type: "previewed"; address: string }
  | { type: "failed"; error: string }
  | { type: "back" }
  | { type: "store" }
  | { type: "stored"; address: string }
  | { type: "reset" };

export function reduceImport(state: ImportState, action: ImportAction): ImportState {
  switch (action.type) {
    case "mode":
      // Switching modes clears the entry: it belongs to the other shape.
      return { ...state, mode: action.mode, secret: "", error: null };
    case "secret":
      return { ...state, secret: action.value, error: null };
    case "index":
      return { ...state, index: action.value, error: null };
    case "preview":
      return { ...state, step: "previewing", error: null };
    case "previewed":
      return { ...state, step: "preview", address: action.address, error: null };
    case "failed":
      // A failed derive/store drops the field rather than keeping it around.
      return { ...initialImportState, mode: state.mode, error: action.error };
    case "back":
      return { ...initialImportState, mode: state.mode };
    case "store":
      // Cleared *before* the async store resolves, so the secret never outlives
      // the submit gesture in this state machine.
      return { ...state, step: "storing", secret: "", error: null };
    case "stored":
      return { ...initialImportState, mode: state.mode, step: "stored", address: action.address };
    case "reset":
      return initialImportState;
  }
}

/** A secret key is `S` + 55 base32 chars; a phrase is 12 or 24 words. */
export function validateImportValue(mode: ImportMode, value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return mode === "secret" ? "Enter a secret key." : "Enter a recovery phrase.";
  }
  if (mode === "secret") {
    if (!/^S[A-Z2-7]{55}$/.test(trimmed)) {
      return "That is not a valid secret key (S…, 56 characters).";
    }
    return null;
  }
  const words = splitPhrase(trimmed);
  if (words.length !== 12 && words.length !== 24) {
    return `Enter 12 or 24 words (got ${words.length}).`;
  }
  return null;
}

/** The optional account index must be a non-negative integer. */
export function validateImportIndex(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (!/^\d+$/.test(trimmed)) return "Account index must be a whole number.";
  return null;
}

/** Parses the index field to a number, or `undefined` when unset. */
export function parseImportIndex(value: string): number | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return Number.parseInt(trimmed, 10);
}
