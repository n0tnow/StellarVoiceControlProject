/**
 * The active-account list (task W10b).
 *
 * One row per account: label (or shortened address), active badge, copy and
 * explorer affordances, plus inline rename and a two-step remove confirmation.
 * The list is read-only data; every action is a callback so this component
 * stays free of engine calls.
 */
import { useState } from "react";
import { Check, Copy, Pencil, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { WalletEntry } from "@/lib/wallet";
import { shortAddress } from "@/lib/address";
import { ExplorerLink } from "@/notch/ExplorerLink";

import { StoreNotice } from "./StoreNotice";
import { ACTIONS, ERROR, FIELD } from "./styles";

export interface AccountListProps {
  entries: readonly WalletEntry[];
  activeAddress: string | null;
  onSelect: (address: string) => void;
  onRename: (address: string, label: string) => void;
  onRemove: (address: string) => void;
  /** The `wallet_status.store` state; a weaker store is shown as a notice. */
  store?: string | null;
}

export function AccountList({
  entries,
  activeAddress,
  onSelect,
  onRename,
  onRemove,
  store,
}: AccountListProps) {
  const [copied, setCopied] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draftLabel, setDraftLabel] = useState("");
  const [removing, setRemoving] = useState<string | null>(null);

  if (entries.length === 0) return null;

  const copy = (address: string): void => {
    void navigator.clipboard?.writeText(address).catch(() => {});
    setCopied(address);
    setTimeout(() => setCopied((current) => (current === address ? null : current)), 1500);
  };

  return (
    <>
      <StoreNotice store={store} />
      <ul className="page-list" aria-label="Accounts">
        {entries.map((entry) => {
          const active = entry.address === activeAddress;
          return (
            <li key={entry.address} className="wallet-key">
              <span className="wallet-key-label">{entry.label ?? "Account"}</span>
              <code className="wallet-key-value selectable" title={entry.address}>
                {shortAddress(entry.address)}
              </code>
              {active ? <span className="wallet-key-label">active</span> : null}

              <button
                type="button"
                className="page-icon-button"
                onClick={() => copy(entry.address)}
                aria-label={copied === entry.address ? "Copied" : "Copy address"}
              >
                {copied === entry.address ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
              </button>
              <ExplorerLink target={entry.address} kind="account" iconOnly />

              {editing === entry.address ? (
                <span className={ACTIONS}>
                  <input
                    className={FIELD}
                    value={draftLabel}
                    onChange={(event) => setDraftLabel(event.target.value)}
                    aria-label="New label"
                  />
                  <button
                    type="button"
                    className="page-icon-button"
                    aria-label="Save label"
                    onClick={() => {
                      onRename(entry.address, draftLabel);
                      setEditing(null);
                    }}
                  >
                    <Check aria-hidden="true" />
                  </button>
                </span>
              ) : (
                <>
                  {!active ? (
                    <button
                      type="button"
                      className="page-icon-button"
                      onClick={() => onSelect(entry.address)}
                      aria-label="Use this account"
                      title="Use this account"
                    >
                      <Check aria-hidden="true" />
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="page-icon-button"
                    onClick={() => {
                      setEditing(entry.address);
                      setDraftLabel(entry.label ?? "");
                    }}
                    aria-label="Rename account"
                  >
                    <Pencil aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="page-icon-button"
                    onClick={() => setRemoving(entry.address)}
                    aria-label="Remove account"
                  >
                    <Trash2 aria-hidden="true" />
                  </button>
                </>
              )}

              {removing === entry.address ? (
                <span className={ACTIONS}>
                  <span className={ERROR}>Remove this account?</span>
                  <Button
                    size="sm"
                    onClick={() => {
                      onRemove(entry.address);
                      setRemoving(null);
                    }}
                  >
                    Yes, remove
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
    </>
  );
}
