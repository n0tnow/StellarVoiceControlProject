/**
 * Accounts section of the dashboard (task W15b).
 *
 * Kept deliberately small: a switcher only when more than one account exists,
 * an "Add account" button (Connect existing / Create new), and one "Manage"
 * disclosure holding rename and remove. The store notice stays visible so the
 * user always knows where the seed lives.
 */
import { useState } from "react";
import { Check, Pencil, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { WalletEntry } from "@/lib/wallet";
import { shortAddress } from "@/lib/address";

import { StoreNotice } from "./StoreNotice";
import { ACTIONS, CARD, ERROR, FIELD, HINT } from "./styles";

export type AddAccountMode = "create" | "import";

export interface AccountsSectionProps {
  entries: readonly WalletEntry[];
  activeAddress: string | null;
  store?: string | null;
  onSelect: (address: string) => void;
  onRename: (address: string, label: string) => void;
  onRemove: (address: string) => void;
  onAdd: (mode: AddAccountMode) => void;
}

export function AccountsSection({
  entries,
  activeAddress,
  store,
  onSelect,
  onRename,
  onRemove,
  onAdd,
}: AccountsSectionProps) {
  const [manage, setManage] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [draftLabel, setDraftLabel] = useState("");
  const [removing, setRemoving] = useState<string | null>(null);

  return (
    <section className={CARD}>
      <div className="flex items-center gap-2">
        <h3 className="text-xs font-semibold">Accounts</h3>
        <button
          type="button"
          className="ml-auto text-[11px] text-[var(--color-notch-muted)] hover:text-[var(--color-notch-text)]"
          onClick={() => setAddOpen((value) => !value)}
        >
          Add account
        </button>
        {entries.length > 0 ? (
          <button
            type="button"
            className="text-[11px] text-[var(--color-notch-muted)] hover:text-[var(--color-notch-text)]"
            onClick={() => setManage((value) => !value)}
          >
            {manage ? "Done" : "Manage"}
          </button>
        ) : null}
      </div>

      <StoreNotice store={store} />

      {entries.length > 1 ? (
        <label className="block text-[11px] text-polaris-muted">
          Active account
          <select
            className={FIELD}
            value={activeAddress ?? ""}
            onChange={(event) => onSelect(event.target.value)}
          >
            {entries.map((entry) => (
              <option key={entry.address} value={entry.address}>
                {entry.label || shortAddress(entry.address)}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      {addOpen ? (
        <div className={ACTIONS}>
          <Button size="sm" variant="secondary" onClick={() => onAdd("import")}>
            Connect existing
          </Button>
          <Button size="sm" variant="ghost" onClick={() => onAdd("create")}>
            Create new
          </Button>
        </div>
      ) : null}

      {manage ? (
        <ul className="page-list" aria-label="Manage accounts">
          {entries.map((entry) => {
            const active = entry.address === activeAddress;
            return (
              <li key={entry.address} className="wallet-key">
                {editing === entry.address ? (
                  <>
                    <input
                      className={FIELD}
                      value={draftLabel}
                      onChange={(event) => setDraftLabel(event.target.value)}
                      aria-label="New account name"
                    />
                    <button
                      type="button"
                      className="page-icon-button"
                      aria-label="Save name"
                      onClick={() => {
                        onRename(entry.address, draftLabel);
                        setEditing(null);
                      }}
                    >
                      <Check aria-hidden="true" />
                    </button>
                  </>
                ) : (
                  <>
                    <span className="wallet-key-label">{entry.label || "Account"}</span>
                    <code className="wallet-key-value selectable" title={entry.address}>
                      {shortAddress(entry.address)}
                    </code>
                    {active ? <span className="wallet-key-label">active</span> : null}
                    <button
                      type="button"
                      className="page-icon-button"
                      aria-label="Rename account"
                      onClick={() => {
                        setEditing(entry.address);
                        setDraftLabel(entry.label ?? "");
                      }}
                    >
                      <Pencil aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      className="page-icon-button"
                      aria-label="Remove account"
                      onClick={() => setRemoving(entry.address)}
                    >
                      <Trash2 aria-hidden="true" />
                    </button>
                  </>
                )}
                {removing === entry.address ? (
                  <span className={ACTIONS}>
                    <span className={ERROR}>Remove?</span>
                    <Button
                      size="sm"
                      onClick={() => {
                        onRemove(entry.address);
                        setRemoving(null);
                      }}
                    >
                      Yes
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setRemoving(null)}>
                      Keep
                    </Button>
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : entries.length === 1 ? (
        <p className={HINT}>
          {entries[0]?.label || "Account"}{" "}
          <code className="selectable">{shortAddress(entries[0]?.address ?? "")}</code>
        </p>
      ) : null}
    </section>
  );
}
