import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import type { PolarisEvent, StellarConfig } from "@polaris/interfaces";

import { Button } from "@/components/ui/button";
import {
  buildAliasEntries,
  fetchOwnerAccount,
  fetchOwnerPayments,
  type AccountFetchResult,
  type PaymentsFetchResult,
} from "@/lib/history";
import { getStellarConfig } from "@/lib/stellarConfig";
import { usePolarisEvents } from "@/panels/events";
import { PanelShell } from "@/panels/PanelShell";
import { deriveWalletView, formatTransactionTime, type WalletView } from "@/panels/wallet/walletModel";
import committedAliases from "../../../stellar/config/aliases.json";

/** A titled block so every section shares one visual frame. */
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2 rounded-lg border border-polaris-line bg-polaris-panel/40 p-3">
      <h2 className="text-sm font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function NetworkBadge({ network }: { network: string }) {
  return (
    <span className="rounded-md border border-polaris-accent/40 bg-polaris-accent/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-polaris-accent">
      {network}
    </span>
  );
}

/** A 56-char address with a copy button and an explorer link. */
function AddressLine({
  label,
  address,
  explorerUrl,
  onCopy,
}: {
  label: string;
  address: string;
  explorerUrl?: string | null;
  onCopy: (text: string) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <span className="text-polaris-muted">{label}</span>
      <code className="selectable break-all font-mono">{address}</code>
      <Button variant="ghost" size="sm" onClick={() => onCopy(address)}>
        Copy
      </Button>
      {explorerUrl ? (
        <a
          className="text-polaris-accent underline-offset-2 hover:underline"
          href={explorerUrl}
          target="_blank"
          rel="noreferrer"
        >
          Explorer
        </a>
      ) : null}
    </div>
  );
}

function Balances({ balances }: { balances: WalletView["balances"] }) {
  if (balances.length === 0) {
    return <p className="text-xs text-polaris-muted">No balances reported.</p>;
  }
  return (
    <ul className="space-y-1 text-xs">
      {balances.map((balance) => (
        <li key={`${balance.asset}-${balance.balance}`} className="flex justify-between gap-3">
          <span>{balance.asset}</span>
          <span className="selectable font-mono">{balance.balance}</span>
        </li>
      ))}
    </ul>
  );
}

function Transactions({ view }: { view: WalletView }) {
  if (view.transactions.length === 0) {
    return <p className="text-xs text-polaris-muted">No recent payments.</p>;
  }
  return (
    <ul className="space-y-2 text-xs">
      {view.transactions.map((tx) => (
        <li key={tx.id} className="space-y-0.5 border-b border-polaris-line/60 pb-2 last:border-0">
          <div className="flex items-center justify-between gap-2">
            <span className="font-medium">
              {tx.direction === "sent" ? "Sent" : "Received"} {tx.amount} {tx.asset}
            </span>
            <span className="text-polaris-muted">{formatTransactionTime(tx.createdAtMs)}</span>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="break-all text-polaris-muted">
              {tx.direction === "sent" ? "to " : "from "}
              {tx.counterpartyAlias ?? `${tx.counterparty.slice(0, 6)}…${tx.counterparty.slice(-4)}`}
            </span>
            {tx.explorerUrl ? (
              <a
                className="shrink-0 text-polaris-accent underline-offset-2 hover:underline"
                href={tx.explorerUrl}
                target="_blank"
                rel="noreferrer"
              >
                Explorer
              </a>
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  );
}

/**
 * Wallet panel (step W6c).
 *
 * Read-only: balances, the alias book and the last ten payments, all read from
 * Horizon via the non-secret `stellar_config`. It never signs, never holds a key
 * and never submits. A missing owner, an unfunded account, an unreachable
 * Horizon and a successful read each get their own clear state.
 */
export function WalletPanel() {
  const [config, setConfig] = useState<StellarConfig | null>(null);
  const [configured, setConfigured] = useState(false);
  const [account, setAccount] = useState<AccountFetchResult | null>(null);
  const [payments, setPayments] = useState<PaymentsFetchResult | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [copied, setCopied] = useState(false);
  // The most recent `tx_submitted` the app reported this session. It is display
  // input only — the event is shape-validated, not proof — so it is labelled as
  // reported by the app rather than as a verified Horizon fact (W4b-2 MINOR-2).
  const [lastSubmitted, setLastSubmitted] = useState<{ hash: string; explorerUrl: string } | null>(
    null,
  );

  const onEvent = useCallback((event: PolarisEvent) => {
    if (event.type === "tx_submitted") {
      setLastSubmitted({ hash: event.hash, explorerUrl: event.explorerUrl });
    }
  }, []);
  usePolarisEvents(onEvent);

  useEffect(() => {
    let cancelled = false;
    void getStellarConfig()
      .catch(() => null)
      .then((value) => {
        if (cancelled) return;
        setConfig(value);
        setConfigured(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const refresh = useCallback(async () => {
    if (!config?.ownerAddress) return;
    setRefreshing(true);
    try {
      const [nextAccount, nextPayments] = await Promise.all([
        fetchOwnerAccount(config.horizonUrl, config.ownerAddress),
        fetchOwnerPayments(config.horizonUrl, config.ownerAddress, { limit: 10 }),
      ]);
      setAccount(nextAccount);
      setPayments(nextPayments);
    } finally {
      setRefreshing(false);
    }
  }, [config]);

  useEffect(() => {
    if (config) void refresh();
  }, [config, refresh]);

  const aliasEntries = useMemo(
    () => buildAliasEntries(config?.aliases, committedAliases),
    [config],
  );

  const view = useMemo(
    () =>
      deriveWalletView({
        ownerAddress: config?.ownerAddress ?? null,
        account,
        payments,
        aliasEntries,
      }),
    [account, aliasEntries, config, payments],
  );

  const copy = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch (error: unknown) {
      console.warn("wallet could not copy", error);
      setCopied(false);
    }
  }, []);

  return (
    <PanelShell title="Wallet" subtitle="Balances, aliases and recent payments">
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <NetworkBadge network={config?.network ?? "testnet"} />
            {copied ? <span className="text-xs text-polaris-ok">Copied</span> : null}
          </div>
          <Button
            variant="secondary"
            size="sm"
            sound={false}
            disabled={refreshing || !config?.ownerAddress}
            onClick={() => void refresh()}
          >
            {refreshing ? "Refreshing…" : "Refresh"}
          </Button>
        </div>

        {lastSubmitted ? (
          <Section title="Latest transaction (reported by the app)">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <code className="selectable break-all font-mono">{lastSubmitted.hash}</code>
              <a
                className="shrink-0 text-polaris-accent underline-offset-2 hover:underline"
                href={lastSubmitted.explorerUrl}
                target="_blank"
                rel="noreferrer"
              >
                Explorer
              </a>
            </div>
            <p className="text-[10px] text-polaris-muted">
              Reported by the signing flow this session; the explorer is authoritative.
            </p>
          </Section>
        ) : null}

        {configured && view.ownerAddress === null ? (
          <p className="rounded-lg border border-polaris-line bg-polaris-panel/60 px-3 py-2 text-xs text-polaris-muted">
            {view.message}
          </p>
        ) : null}

        {view.ownerAddress ? (
          <Section title="Owner">
            <AddressLine
              label="Address"
              address={view.ownerAddress}
              explorerUrl={view.explorerUrl}
              onCopy={(text) => void copy(text)}
            />
          </Section>
        ) : null}

        {view.status === "loading" ? (
          <p className="text-xs text-polaris-muted">{view.message}</p>
        ) : null}

        {view.status === "offline" ? (
          <p className="rounded-lg border border-polaris-danger/40 bg-polaris-danger/10 px-3 py-2 text-xs text-polaris-danger">
            {view.message}
          </p>
        ) : null}

        {view.status === "unfunded" ? (
          <div className="space-y-1 rounded-lg border border-polaris-warn/40 bg-polaris-warn/10 px-3 py-2 text-xs text-polaris-warn">
            <p>{view.message}</p>
            {view.friendbotUrl ? (
              <a className="underline underline-offset-2" href={view.friendbotUrl} target="_blank" rel="noreferrer">
                Fund it with Friendbot (testnet)
              </a>
            ) : null}
          </div>
        ) : null}

        {view.status === "ready" ? (
          <>
            <Section title="Balances">
              <Balances balances={view.balances} />
            </Section>
            <Section title="Recent payments">
              {view.message ? <p className="text-xs text-polaris-warn">{view.message}</p> : null}
              <Transactions view={view} />
            </Section>
          </>
        ) : null}

        <Section title="Aliases">
          {aliasEntries.length === 0 ? (
            <p className="text-xs text-polaris-muted">No aliases configured.</p>
          ) : (
            <ul className="space-y-2 text-xs">
              {aliasEntries.map((entry) => (
                <li key={entry.name} className="space-y-0.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">{entry.name}</span>
                    <span className="text-[10px] uppercase tracking-wide text-polaris-muted">
                      {entry.source}
                    </span>
                  </div>
                  <code className="selectable block break-all font-mono text-polaris-muted">
                    {entry.address}
                  </code>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
    </PanelShell>
  );
}
