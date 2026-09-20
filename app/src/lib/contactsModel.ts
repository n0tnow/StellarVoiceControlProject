/**
 * Pure recipient ("rumuz") model and IPC client factory (task W10b).
 *
 * A contact is a nickname plus a `G...` address. The nickname rules mirror the
 * Rust store (`app/src-tauri/src/contacts.rs`) exactly: lowercase charset
 * `[a-z][a-z0-9_-]{0,31}`, unique, and not a reserved word. The address checksum
 * needs the Stellar SDK, so it is **injected** as a boolean here; that keeps
 * this module SDK-free and testable under `node:test`, and keeps the lazy SDK
 * import in `contacts.ts` the only place it is loaded.
 */
import { isMissingCommandError } from "./walletEngine.ts";

export interface Contact {
  nickname: string;
  address: string;
}

export type ContactsFailureKind = "invalid" | "exists" | "notFound" | "limit" | "io" | "unavailable";

export class ContactsClientError extends Error {
  readonly kind: ContactsFailureKind;

  constructor(kind: ContactsFailureKind, message: string) {
    super(message);
    this.name = "ContactsClientError";
    this.kind = kind;
  }
}

/** The nickname charset from `stellar/src/payments/aliases.ts`. */
export const NICKNAME_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

/** Mirrors `RESERVED_NICKNAMES` in `app/src-tauri/src/contacts.rs`. */
export const RESERVED_NICKNAMES: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
  "send",
  "payment",
  "pay",
  "swap",
  "deposit",
  "withdraw",
  "schedule",
  "cancel",
  "balance",
  "history",
  "wallet",
  "contacts",
]);

/** The UI lowercases the field; the store normalizes again as the last gate. */
export function normalizeNickname(input: string): string {
  return input.trim().toLowerCase();
}

/** `null` when valid, else one short actionable sentence. */
export function validateNickname(nickname: string): string | null {
  if (!NICKNAME_PATTERN.test(nickname)) {
    return "Use a nickname starting with a letter: a-z, 0-9, _ or - (max 32).";
  }
  if (RESERVED_NICKNAMES.has(nickname)) {
    return `"${nickname}" is a reserved word.`;
  }
  return null;
}

export interface ContactDraft {
  nickname: string;
  address: string;
}

export type ContactDraftResult =
  | { ok: true; draft: ContactDraft }
  | { ok: false; field: "nickname" | "address"; error: string };

/**
 * Validates a form entry. `addressValid` comes from the async checksum check;
 * `existingNicknames` are the nicknames already saved (collision check).
 */
export function buildContactDraft(
  input: { nickname: string; address: string },
  context: { addressValid: boolean; existingNicknames: readonly string[] },
): ContactDraftResult {
  const nickname = normalizeNickname(input.nickname);
  const nicknameError = validateNickname(nickname);
  if (nicknameError !== null) return { ok: false, field: "nickname", error: nicknameError };
  if (context.existingNicknames.includes(nickname)) {
    return { ok: false, field: "nickname", error: `"${nickname}" is already saved.` };
  }
  const address = input.address.trim();
  if (!context.addressValid) {
    return { ok: false, field: "address", error: "That is not a valid Stellar G... address." };
  }
  return { ok: true, draft: { nickname, address } };
}

/** Normalises anything thrown by `invoke` into a typed contacts error. */
export function toContactsClientError(error: unknown): ContactsClientError {
  if (error instanceof ContactsClientError) return error;
  if (typeof error === "object" && error !== null) {
    const candidate = error as { kind?: unknown; message?: unknown };
    if (typeof candidate.kind === "string") {
      return new ContactsClientError(
        candidate.kind as ContactsFailureKind,
        typeof candidate.message === "string" ? candidate.message : "contacts command failed",
      );
    }
  }
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : "contacts command failed";
  return new ContactsClientError(isMissingCommandError(error) ? "unavailable" : "io", message);
}

export type ContactsInvokeFn = (
  command: string,
  args?: Record<string, unknown>,
) => Promise<unknown>;

/** The recipient-store surface; one method per Rust command. */
export interface ContactsClient {
  list(): Promise<Contact[]>;
  add(nickname: string, address: string): Promise<Contact>;
  remove(nickname: string): Promise<Contact>;
}

export function createContactsClient(invoke: ContactsInvokeFn): ContactsClient {
  const call = async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
    try {
      return (await invoke(command, args)) as T;
    } catch (error) {
      throw toContactsClientError(error);
    }
  };
  return {
    list: () => call<Contact[]>("contacts_list"),
    add: (nickname, address) => call<Contact>("contacts_add", { nickname, address }),
    remove: (nickname) => call<Contact>("contacts_remove", { nickname }),
  };
}
