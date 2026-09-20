/**
 * The app's contact store client and address checksum (task W10b).
 *
 * `contactsModel.ts` holds the pure rules and the injectable factory; this file
 * binds it to Tauri's `invoke` and to the Stellar SDK's `StrKey`. The SDK is
 * imported **lazily**, so the notch pays for it only when a recipient address is
 * actually validated — never at shell startup.
 */
import { invoke } from "@tauri-apps/api/core";

import { createContactsClient } from "./contactsModel.ts";

export const contactsClient = createContactsClient((command, args) => invoke(command, args));

/** Rust broadcasts this when the recipient book changes. */
export const CONTACTS_CHANGED_EVENT = "contacts_changed";

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
