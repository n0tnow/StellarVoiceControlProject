/**
 * Contacts section (task W15b, formerly "Recipients").
 *
 * A compact list of saved names and their short addresses, with a small
 * "Add contact" text button that reveals two inputs (Name, Address). The
 * nickname and the address checksum are validated by `useContacts` before Rust
 * ever sees them; a saved contact is what makes "send 5 XLM to ada" resolve.
 */
import { useState, type FormEvent } from "react";
import { Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { shortAddress } from "@/lib/address";

import { useContacts } from "./useContacts";
import { ACTIONS, CARD, ERROR, FIELD, HINT } from "./styles";

export function RecipientsSection() {
  const { contacts, loading, error, add, remove } = useContacts();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    try {
      const result = await add(name, address);
      if (!result.ok) {
        setFormError(result.error ?? "Could not save that contact.");
        return;
      }
      setFormError(null);
      setName("");
      setAddress("");
      setOpen(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={CARD}>
      <div className="flex items-center gap-2">
        <h3 className="text-xs font-semibold">Contacts</h3>
        <button
          type="button"
          className="ml-auto text-[11px] text-[var(--color-notch-muted)] hover:text-[var(--color-notch-text)]"
          onClick={() => {
            setOpen((value) => !value);
            setFormError(null);
          }}
        >
          {open ? "Cancel" : "Add contact"}
        </button>
      </div>

      {open ? (
        <form className="space-y-2" onSubmit={(event) => void submit(event)}>
          <div className="flex gap-2">
            <label className="block w-24 text-[11px] text-polaris-muted">
              Name
              <input
                className={FIELD}
                value={name}
                placeholder="ada"
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
                onChange={(event) => setName(event.target.value.toLowerCase())}
              />
            </label>
            <label className="block flex-1 text-[11px] text-polaris-muted">
              Address
              <input
                className={FIELD}
                value={address}
                placeholder="G…"
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
                onChange={(event) => setAddress(event.target.value)}
              />
            </label>
          </div>
          {formError !== null ? <p className={ERROR}>{formError}</p> : null}
          <div className={ACTIONS}>
            <Button size="sm" type="submit" disabled={busy}>
              {busy ? "Saving…" : "Save"}
            </Button>
          </div>
        </form>
      ) : null}

      {error !== null ? <p className={ERROR}>{error}</p> : null}
      {loading && contacts.length === 0 ? <p className={HINT}>Loading…</p> : null}
      {!loading && contacts.length === 0 ? <p className={HINT}>No contacts yet.</p> : null}
      {contacts.length > 0 ? (
        <ul className="page-list" aria-label="Contacts">
          {contacts.map((contact) => (
            <li key={contact.nickname} className="wallet-key">
              <span className="wallet-key-label">{contact.nickname}</span>
              <code className="wallet-key-value selectable" title={contact.address}>
                {shortAddress(contact.address)}
              </code>
              <button
                type="button"
                className="page-icon-button"
                onClick={() => void remove(contact.nickname)}
                aria-label={`Remove ${contact.nickname}`}
              >
                <Trash2 aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
