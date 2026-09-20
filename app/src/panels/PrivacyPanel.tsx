import { useEffect, useState } from "react";

import {
  SPP_CONTRACTS,
  SPP_PRIVACY,
  SPP_SPIKE_TXS,
  loadSppStatus,
  sppContractUrl,
  sppTxUrl,
  summarizeSppStatus,
  type SppStatusSummary,
} from "@/lib/spp";
import { PanelNote, PanelShell } from "@/panels/PanelShell";
import { cn } from "@/lib/utils";

const STATUS_STYLES: Record<SppStatusSummary["status"], string> = {
  ok: "text-polaris-ok",
  warn: "text-polaris-warn",
  fail: "text-polaris-danger",
};

/**
 * Privacy panel (W9): what Stellar Private Payments are, and the verifiable
 * testnet evidence for them.
 *
 * Read-only by construction. The full SPP client is the upstream **Rust** SDK
 * and every `transact` needs a Soroban auth-entry signature in addition to the
 * envelope signature; Polaris' wallet signs only an envelope, so no
 * value-moving form exists here yet. Deposit / private transfer / withdraw are
 * shown disabled, with the reason, rather than shipped half-wired.
 */
export function PrivacyPanel() {
  const [status, setStatus] = useState<SppStatusSummary | null>(null);

  useEffect(() => {
    let cancelled = false;
    void loadSppStatus().then((facts) => {
      if (!cancelled) setStatus(summarizeSppStatus(facts));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <PanelShell title="Privacy" subtitle="Stellar Private Payments (testnet, unaudited)">
      <div className="space-y-5">
        <PanelNote>
          Testnet-only and an unaudited upstream developer preview. Nothing in this
          window signs or moves value yet.
        </PanelNote>

        <section className="space-y-1">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-polaris-muted">
            Pool status
          </h2>
          <p
            className={cn(
              "text-xs",
              status ? STATUS_STYLES[status.status] : "text-polaris-muted",
            )}
          >
            {status?.detail ?? "Checking the testnet RPC…"}
          </p>
        </section>

        <section className="space-y-1">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-polaris-muted">
            What is private
          </h2>
          <ul className="list-disc space-y-1 pl-4 text-xs leading-5">
            {SPP_PRIVACY.hiddenInPool.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <h3 className="pt-2 text-xs font-semibold uppercase tracking-wide text-polaris-muted">
            What stays public
          </h3>
          <ul className="list-disc space-y-1 pl-4 text-xs leading-5">
            {SPP_PRIVACY.publicOnChain.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </section>

        <section className="space-y-1">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-polaris-muted">
            Contracts
          </h2>
          {Object.entries(SPP_CONTRACTS).map(([name, id]) => (
            <a
              key={name}
              href={sppContractUrl(id)}
              target="_blank"
              rel="noreferrer"
              className="block selectable break-all font-mono text-[11px] text-polaris-accent underline-offset-2 hover:underline"
            >
              {name}: {id}
            </a>
          ))}
        </section>

        <section className="space-y-1">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-polaris-muted">
            Verified testnet evidence
          </h2>
          {SPP_SPIKE_TXS.map((tx) => (
            <a
              key={tx.hash}
              href={sppTxUrl(tx.hash)}
              target="_blank"
              rel="noreferrer"
              className="block text-xs underline-offset-2 hover:underline"
            >
              <span className="font-medium">{tx.step}</span>
              <span className="text-polaris-muted"> · ledger {tx.ledger}</span>
              <span className="block selectable break-all font-mono text-[11px] text-polaris-muted">
                {tx.hash}
              </span>
            </a>
          ))}
        </section>

        <section className="space-y-2">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-polaris-muted">
            Move value (not enabled)
          </h2>
          <p className="text-xs leading-5 text-polaris-muted">
            Deposit, private transfer and withdraw become available once the SPP
            signer is wired to the wallet. Proving takes ~10–15 s per
            operation. The upstream client is the Rust SDK and needs a Soroban
            auth-entry signature on top of the envelope signature.
          </p>
          {["Deposit", "Private transfer", "Withdraw"].map((label) => (
            <button
              key={label}
              type="button"
              disabled
              className="mr-2 rounded-md border border-polaris-line bg-polaris-panel/60 px-3 py-1.5 text-xs text-polaris-muted opacity-60"
            >
              {label}
            </button>
          ))}
        </section>

        <section className="space-y-1">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-polaris-muted">
            Caveats
          </h2>
          <ul className="list-disc space-y-1 pl-4 text-xs leading-5">
            {SPP_PRIVACY.caveats.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </section>
      </div>
    </PanelShell>
  );
}
