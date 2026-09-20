/**
 * Recipient-book state for the Wallet page (task W10b, cross-view event W15b).
 *
 * Loads the saved contacts and refreshes on the Rust `contacts_changed` event
 * and on the webview-level `polaris:contacts-changed` DOM event. The latter lets
 * any view that adds/removes a contact (the Wallet page, "Ask Polaris") notify
 * every other view without a shared store. `add` validates the nickname locally
 * and the address by checksum (lazily importing the SDK) before it ever reaches
 * Rust, so an obvious typo never makes a round trip.
 */
import { useCallback, useEffect, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import {
  CONTACTS_CHANGED_DOM_EVENT,
  CONTACTS_CHANGED_EVENT,
  contactsClient,
  isValidStellarAddress,
  notifyContactsChanged,
} from "@/lib/contacts";
import { buildContactDraft, type Contact } from "@/lib/contactsModel";

export interface AddContactResult {
  ok: boolean;
  field?: "nickname" | "address";
  error?: string;
}

export interface ContactsState {
  contacts: Contact[];
  loading: boolean;
  error: string | null;
  add: (nickname: string, address: string) => Promise<AddContactResult>;
  remove: (nickname: string) => Promise<void>;
  reload: () => Promise<void>;
}

export function useContacts(): ContactsState {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setContacts(await contactsClient.list());
      setError(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    let disposed = false;
    let unlisten: UnlistenFn | undefined;
    void listen(CONTACTS_CHANGED_EVENT, () => {
      void reload();
    })
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch((failure: unknown) => {
        console.warn("wallet page could not subscribe to contacts_changed", failure);
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [reload]);

  useEffect(() => {
    const onChanged = (): void => {
      void reload();
    };
    window.addEventListener(CONTACTS_CHANGED_DOM_EVENT, onChanged);
    return () => window.removeEventListener(CONTACTS_CHANGED_DOM_EVENT, onChanged);
  }, [reload]);

  const add = useCallback(
    async (nickname: string, address: string): Promise<AddContactResult> => {
      const draft = buildContactDraft(
        { nickname, address },
        {
          addressValid: await isValidStellarAddress(address),
          existingNicknames: contacts.map((contact) => contact.nickname),
        },
      );
      if (!draft.ok) return { ok: false, field: draft.field, error: draft.error };
      try {
        await contactsClient.add(draft.draft.nickname, draft.draft.address);
        notifyContactsChanged();
        return { ok: true };
      } catch (failure) {
        return {
          ok: false,
          error: failure instanceof Error ? failure.message : String(failure),
        };
      }
    },
    [contacts],
  );

  const remove = useCallback(async (nickname: string): Promise<void> => {
    await contactsClient.remove(nickname);
    notifyContactsChanged();
  }, []);

  return { contacts, loading, error, add, remove, reload };
}
