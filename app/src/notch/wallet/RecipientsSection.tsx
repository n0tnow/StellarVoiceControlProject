/**
 * Recipients ("rumuz") section (task W10b).
 *
 * A nickname plus a `G...` address. The nickname field is lowercase-folded as
 * the user types; the address is checked by StrKey checksum before the Rust
 * store ever sees it. Saved recipients feed the agent's alias table, so adding
 * one here is what makes "send 5 XLM to ali" resolve on the next turn.
 */
import { useState, type FormEvent } from "react";
import { Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { NICKNAME_PATTERN } from "@/lib/contactsModel";
import { shortAddress } from "@/panels/wallet/walletModel";

import { useContacts } from "./useContacts";
import { ACTIONS, CARD, ERROR, FIELD, HINT } from "./styles";

export function RecipientsSection() {
  const { contacts, loading, error, add, remove } = useContacts();
  const [nickname, setNickname] = useState("");
  const [address, setAddress] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    try {
      const result = await add(nickname, address);
      if (!result.ok) {
        setFormError(result.error ?? "Could not save that recipient.");
        return;
      }
      setFormError(null);
      setNickname("");
      setAddress("");
    } finally {
      setBusy(false);
    }
  };

  const nicknameInvalid = nickname.length > 0 && !NICKNAME_PATTERN.test(nickname);

  return (
    <section className={CARD}>
      <h3 className="text-xs font-semibold">Recipients</h3>
      <p className={HINT}>Save a nickname for an address, then pay it by voice.</p>

      <form className="space-y-2" onSubmit={(event) => void submit(event)}>
        <label className="block text-[11px] text-polaris-muted">
          Nickname
          <input
            className={FIELD}
            value={nickname}
            placeholder="ali"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            onChange={(event) => setNickname(event.target.value.toLowerCase())}
          />
        </label>
        <label className="block text-[11px] text-polaris-muted">
          Address (G…)
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
        {nicknameInvalid ? <p className={ERROR}>Use a-z, 0-9, _ or -, starting with a letter.</p> : null}
        {formError !== null ? <p className={ERROR}>{formError}</p> : null}
        <div className={ACTIONS}>
          <Button size="sm" type="submit" disabled={busy}>
            {busy ? "Saving…" : "Add recipient"}
          </Button>
        </div>
      </form>

      {error !== null ? <p className={ERROR}>{error}</p> : null}
      {loading && contacts.length === 0 ? <p className={HINT}>Loading…</p> : null}
      {contacts.length > 0 ? (
        <ul className="page-list" aria-label="Saved recipients">
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
