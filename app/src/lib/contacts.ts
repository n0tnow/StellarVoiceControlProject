/**
 * The app's contact store client and address checksum (task W10b).
 *
 * `contactsModel.ts` holds the pure rules and the injectable factory; this file
 * binds it to Tauri's `invoke` and to the Stellar SDK's `StrKey`. The SDK is
 * imported **lazily**, so the notch pays for it only when a recipient address is
 * actually validated — never at shell startup.
 */
import { invoke } from "@tauri-apps/api/core";
import type { ContactStore, RemoveContactResult, SaveContactResult } from "@polaris/agent";

import {
  ContactsClientError,
  createContactsClient,
  normalizeNickname,
  validateNickname,
  type ContactsClient,
} from "./contactsModel.ts";

export const contactsClient = createContactsClient((command, args) => invoke(command, args));

/** Rust broadcasts this when the recipient book changes. */
export const CONTACTS_CHANGED_EVENT = "contacts_changed";

/**
 * The webview-level event every contact mutation broadcasts (task W15b). Any
 * view that adds or removes a contact calls `notifyContactsChanged`; any view
 * showing contacts listens for it and reloads. It is deliberately independent of
 * Tauri so "Ask Polaris" and the Wallet page share one signal.
 */
export const CONTACTS_CHANGED_DOM_EVENT = "polaris:contacts-changed";

/** Broadcasts a contact mutation to every listening view. */
export function notifyContactsChanged(): void {
  window.dispatchEvent(new CustomEvent(CONTACTS_CHANGED_DOM_EVENT));
}

/** Injectable edges of the agent store, so the rules are unit-testable. */
export interface AgentContactStoreDeps {
  client?: ContactsClient;
  isValidAddress?: (address: string) => Promise<boolean>;
  announce?: () => void;
}

/**
 * The agent's address-book store (W15f), backed by the same `contacts_*`
 * commands and the same StrKey checksum as the Wallet page. It validates the
 * name and the address before the round trip and never overwrites a name that
 * already maps to a different address.
 */
export function createAgentContactStore(deps: AgentContactStoreDeps = {}): ContactStore {
  const client = deps.client ?? contactsClient;
  const isValidAddress = deps.isValidAddress ?? isValidStellarAddress;
  const announce = deps.announce ?? notifyContactsChanged;
  return {
    async save(nickname, address): Promise<SaveContactResult> {
      const normalized = normalizeNickname(nickname);
      if (validateNickname(normalized) !== null) return { status: "invalidName" };
      const trimmed = address.trim();
      if (!(await isValidAddress(trimmed))) return { status: "invalidAddress" };
      try {
        const existing = await client.list();
        const match = existing.find((contact) => contact.nickname === normalized);
        if (match) {
          return match.address === trimmed
            ? { status: "alreadySaved", nickname: normalized }
            : { status: "nameTaken", nickname: normalized };
        }
        const saved = await client.add(normalized, trimmed);
        announce();
        return { status: "saved", nickname: saved.nickname, address: saved.address };
      } catch (error) {
        // A race with another writer can still return `exists`; fail closed and
        // never overwrite, exactly as the pre-check does.
        if (error instanceof ContactsClientError && error.kind === "exists") {
          return { status: "nameTaken", nickname: normalized };
        }
        if (error instanceof ContactsClientError && error.kind === "invalid") {
          return { status: "invalidAddress" };
        }
        return { status: "unavailable" };
      }
    },
    list: () => client.list(),
    async remove(nickname): Promise<RemoveContactResult> {
      try {
        const removed = await client.remove(normalizeNickname(nickname));
        announce();
        return { status: "removed", nickname: removed.nickname };
      } catch (error) {
        return {
          status:
            error instanceof ContactsClientError && error.kind === "notFound" ? "missing" : "unavailable",
        };
      }
    },
  };
}

/**
 * Checks a `G...` address by StrKey checksum, not by shape. A missing SDK or a
 * malformed value resolves `false` (fail-closed) rather than throwing.
 */
export async function isValidStellarAddress(address: string): Promise<boolean> {
  try {
    const { StrKey } = await import("@stellar/stellar-sdk");
    return StrKey.isValidEd25519PublicKey(address.trim());
  } catch {
    return false;
  }
}

export {
  ContactsClientError,
  buildContactDraft,
  createContactsClient,
  normalizeNickname,
  toContactsClientError,
  validateNickname,
} from "./contactsModel.ts";
export type { Contact, ContactsClient } from "./contactsModel.ts";
