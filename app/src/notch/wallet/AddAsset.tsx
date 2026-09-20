/**
 * The Wallet dashboard's "Add asset" control (task W18).
 *
 * A small text button under the balance hero reveals the pinned asset list
 * (USDC, SRT); each row adds a trustline through the shared approval pipeline
 * (`runTx`: approval card → Touch ID → sign in Rust → submit). Once USDC is
 * enabled the faucet hint and its allow-listed link appear, since Circle's
 * testnet faucet cannot deliver USDC without a trustline.
 */
import { useState } from "react";
import { Check, Copy, ExternalLink } from "lucide-react";

import { Button } from "@/components/ui/button";
import { openExternal } from "@/lib/app";
import { runAddTrustline } from "@/lib/trustline";
import { trustlineRows, USDC_FAUCET_HINT, USDC_FAUCET_URL, type HorizonAccountDetail } from "@/lib/walletAssets";
import { ExplorerLink } from "@/notch/ExplorerLink";

import { ERROR, HINT } from "./styles";

/** How long the copy button shows its confirmation before reverting. */
const COPIED_MS = 1500;

type AddState =
  | { kind: "idle" }
  | { kind: "running"; code: string }
  | { kind: "ok"; code: string; txHash: string }
  | { kind: "failed"; label: string };

export interface AddAssetProps {
  detail: HorizonAccountDetail | null;
  /** The active account address, for the faucet's copy action. */
  address: string | null;
  /** Called after a successful trustline so the page re-reads balances. */
  onAdded: () => void;
}

export function AddAsset({ detail, address, onAdded }: AddAssetProps) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<AddState>({ kind: "idle" });
  const [copied, setCopied] = useState(false);

  const rows = trustlineRows(detail);
  const usdcAdded = rows.some((row) => row.code === "USDC" && row.added);
  const busy = state.kind === "running";

  const copyAddress = (): void => {
    if (!address) return;
    void navigator.clipboard?.writeText(address).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), COPIED_MS);
  };

  const add = async (code: string): Promise<void> => {
    setState({ kind: "running", code });
    const outcome = await runAddTrustline(code);
    if (outcome.status === "submitted") {
      setState({ kind: "ok", code, txHash: outcome.txHash });
      onAdded();
    } else {
      setState({ kind: "failed", label: outcome.detail });
    }
  };

  return (
    <div className="space-y-2">
      <button
        type="button"
        className="text-[11px] text-[var(--color-notch-accent)] underline"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        Add asset
      </button>

      {open ? (
        <ul className="space-y-1">
          {rows.map((row) => (
            <li key={row.code} className="flex items-center justify-between gap-2 text-[11px]">
              <span className="text-[var(--color-notch-muted)]">{row.label}</span>
              <Button
                size="sm"
                variant="outline"
                disabled={row.added || busy}
                onClick={() => void add(row.code)}
              >
                {row.added ? "Added" : state.kind === "running" && state.code === row.code ? "Adding…" : "Add"}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}

      {state.kind === "ok" ? (
        <p className={`${HINT} flex items-center gap-1`}>
          <Check aria-hidden="true" className="h-3 w-3 text-[var(--color-polaris-ok)]" />
          {state.code} added to your wallet.
          <ExplorerLink kind="tx" target={state.txHash} />
        </p>
      ) : null}
      {state.kind === "failed" ? <p className={ERROR}>{state.label}</p> : null}

      {usdcAdded ? (
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-[var(--color-notch-muted)]">
          <span>{USDC_FAUCET_HINT}</span>
          <button
            type="button"
            className="inline-flex items-center gap-1 text-[var(--color-notch-accent)] underline"
            onClick={() => void openExternal(USDC_FAUCET_URL).catch(() => {})}
          >
            <ExternalLink aria-hidden="true" className="h-3 w-3" />
            Open faucet
          </button>
          <button
            type="button"
            className="inline-flex items-center gap-1 text-[var(--color-notch-accent)] underline"
            disabled={!address}
            onClick={copyAddress}
          >
            {copied ? <Check aria-hidden="true" className="h-3 w-3" /> : <Copy aria-hidden="true" className="h-3 w-3" />}
            Copy address
          </button>
        </div>
      ) : null}
    </div>
  );
}
