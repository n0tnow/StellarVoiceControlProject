/**
 * Account switcher for the dashboard header (task W19).
 *
 * The header title opens this compact list: one row per saved account (nickname
 * plus short address, a check on the active one) and a final "+ Add account"
 * row. Rename and remove stay reachable behind "Manage". A flat list — no
 * nested cards — with the seed-store notice at the bottom. Selecting a row asks
 * the engine to make that account active.
 */
import { useState } from "react";
import { Check, Pencil, Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { WalletEntry } from "@/lib/wallet";
import { accountSwitcherRows } from "@/lib/walletFlows";
import { shortAddress } from "@/lib/address";

import { StoreNotice } from "./StoreNotice";
import { ACTIONS, ERROR, FIELD } from "./styles";

export type AddAccountMode = "create" | "import";

export interface AccountSwitcherProps {
  entries: readonly WalletEntry[];
  activeAddress: string | null;
  store?: string | null;
  onSelect: (address: string) => void;
  onRename: (address: string, label: string) => void;
  onRemove: (address: string) => void;
  onAdd: (mode: AddAccountMode) => void;
}

export function AccountSwitcher({
  entries,
  activeAddress,
  store,
  onSelect,
  onRename,
  onRemove,
  onAdd,
}: AccountSwitcherProps) {
  const [manage, setManage] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [draftLabel, setDraftLabel] = useState("");
  const [removing, setRemoving] = useState<string | null>(null);
  const rows = accountSwitcherRows(entries, activeAddress);

  return (
    <div className="space-y-1.5">
      <ul className="page-list" aria-label="Accounts">
        {rows.map((row) => (
          <li key={row.address}>
            <button
              type="button"
              className={`wallet-key w-full text-left${
                row.active ? " ring-1 ring-[var(--color-notch-accent)]" : ""
              }`}
              aria-pressed={row.active}
              onClick={() => onSelect(row.address)}
            >
              <span className="wallet-key-label">{row.label}</span>
              <code className="wallet-key-value selectable">{shortAddress(row.address)}</code>
              {row.active ? (
                <Check aria-hidden="true" className="h-3.5 w-3.5 text-[var(--color-notch-accent)]" />
              ) : null}
            </button>

            {manage && editing === row.address ? (
              <span className={`${ACTIONS} mt-1`}>
                <input
                  className={FIELD}
                  value={draftLabel}
                  onChange={(event) => setDraftLabel(event.target.value)}
                  aria-label="New account name"
                />
                <Button
                  size="sm"
                  onClick={() => {
                    onRename(row.address, draftLabel);
                    setEditing(null);
                  }}
                >
                  Save
                </Button>
              </span>
            ) : manage ? (
              <span className={`${ACTIONS} mt-1`}>
                <button
                  type="button"
                  className="page-icon-button"
                  aria-label="Rename account"
                  onClick={() => {
                    setEditing(row.address);
                    setDraftLabel(row.label);
                  }}
                >
                  <Pencil aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="page-icon-button"
                  aria-label="Remove account"
                  onClick={() => setRemoving(row.address)}
                >
                  <Trash2 aria-hidden="true" />
                </button>
                {removing === row.address ? (
                  <>
                    <span className={ERROR}>Remove?</span>
                    <Button
                      size="sm"
                      onClick={() => {
                        onRemove(row.address);
                        setRemoving(null);
                      }}
                    >
                      Yes
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setRemoving(null)}>
                      Keep
                    </Button>
                  </>
                ) : null}
              </span>
            ) : null}
          </li>
        ))}
      </ul>

      <button
        type="button"
        className="flex items-center gap-1 text-[11px] text-[var(--color-notch-muted)] hover:text-[var(--color-notch-text)]"
        onClick={() => onAdd("import")}
      >
        <Plus aria-hidden="true" className="h-3.5 w-3.5" />
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

      <StoreNotice store={store} />
    </div>
  );
}
