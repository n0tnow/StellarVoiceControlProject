/**
 * The locked screen of the Wallet page (task W13b): the always-at-launch state.
 *
 * Nobody is logged in yet. If several wallets are stored, the user picks one;
 * `wallet_unlock` then runs the macOS Touch ID prompt in Rust. Cancel and a
 * refused fingerprint are shown inline. Nothing here touches the chain.
 */
import { useState } from "react";
import { Fingerprint, Wallet } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { WalletEntry } from "@/lib/wallet";
import { shortAddress } from "@/lib/address";

import { CARD, ERROR, HINT } from "./styles";

export interface UnlockScreenProps {
  entries: readonly WalletEntry[];
  /** The last active account, preselected in the picker. */
  activeAddress: string | null;
  busy: boolean;
  error: string | null;
  onUnlock: (address?: string) => void;
}

export function UnlockScreen({ entries, activeAddress, busy, error, onUnlock }: UnlockScreenProps) {
  const [selected, setSelected] = useState<string | null>(activeAddress ?? entries[0]?.address ?? null);
  const multiple = entries.length > 1;

  return (
    <section className={CARD}>
      <h2 className="flex items-center gap-2 text-sm font-semibold">
        <Wallet aria-hidden="true" className="h-4 w-4 text-[var(--color-notch-accent)]" />
        Log in to Polaris
      </h2>
      <p className={HINT}>
        Your wallet is locked. Unlock it with Touch ID to see balances and to sign.
      </p>

      {multiple ? (
        <ul className="page-list" aria-label="Choose a wallet">
          {entries.map((entry) => (
            <li key={entry.address}>
              <button
                type="button"
                className={`wallet-key w-full text-left${
                  selected === entry.address ? " ring-1 ring-[var(--color-notch-accent)]" : ""
                }`}
                aria-pressed={selected === entry.address}
                onClick={() => setSelected(entry.address)}
              >
                <span className="wallet-key-label">{entry.label || "Account"}</span>
                <code className="wallet-key-value selectable">{shortAddress(entry.address)}</code>
                {entry.active ? <span className="wallet-key-label">last used</span> : null}
              </button>
            </li>
          ))}
        </ul>
      ) : entries.length === 1 ? (
        <p className={HINT}>
          Wallet: <span className="text-[var(--color-notch-text)]">{entries[0]?.label || "Account"}</span>{" "}
          <code className="selectable">{shortAddress(entries[0]?.address ?? "")}</code>
        </p>
      ) : null}

      {error !== null ? <p className={ERROR}>{error}</p> : null}

      <Button
        size="sm"
        disabled={busy}
        onClick={() => onUnlock(selected ?? undefined)}
      >
        <Fingerprint aria-hidden="true" className="h-4 w-4" />
        {busy ? "Waiting for Touch ID…" : "Unlock with Touch ID"}
      </Button>
    </section>
  );
}
