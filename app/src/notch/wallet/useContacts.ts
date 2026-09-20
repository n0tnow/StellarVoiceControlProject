/**
 * Recipient-book state for the Wallet page (task W10b).
 *
 * Loads the saved contacts and refreshes on `contacts_changed`. `add` validates
 * the nickname locally and the address by checksum (lazily importing the SDK)
 * before it ever reaches Rust, so an obvious typo never makes a round trip.
 */
import { useCallback, useEffect, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { CONTACTS_CHANGED_EVENT, contactsClient, isValidStellarAddress } from "@/lib/contacts";
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
        await reload();
        return { ok: true };
      } catch (failure) {
        return {
          ok: false,
          error: failure instanceof Error ? failure.message : String(failure),
        };
      }
    },
    [contacts, reload],
  );

  const remove = useCallback(
    async (nickname: string): Promise<void> => {
      await contactsClient.remove(nickname);
      await reload();
    },
    [reload],
  );

  return { contacts, loading, error, add, remove, reload };
}
