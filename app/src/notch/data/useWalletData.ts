/**
 * Real data for the notch Wallet page (milestone NW1).
 *
 * The page was rendered from `@/lib/mockData`; this hook replaces that source
 * with the same read-only loaders the Wallet panel already uses: the non-secret
 * `stellar_config` (owner, network, aliases) plus Horizon balances and payments.
 * The decisions live in [`deriveWalletPageView`] so they run under `node:test`
 * with no DOM and no Tauri; the hook only owns the fetch/cache lifecycle and the
 * `tx_submitted` session subscription.
 *
 * Nothing here signs, holds a key or moves value.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { StellarConfig } from "@polaris/interfaces";

import {
  DEFAULT_EXPLORER_BASE,
  buildAliasEntries,
  explorerAccountUrl,
  fetchOwnerAccount,
  fetchOwnerPayments,
  friendbotUrl,
  mapWalletTransactions,
  type AccountFetchResult,
  type AliasEntryView,
  type CommittedAliases,
  type PaymentsFetchResult,
} from "../../lib/history.ts";
import { listenPolarisEvents } from "../../lib/polaris.ts";
import { getStellarConfig } from "../../lib/stellarConfig.ts";
import { shortAddress } from "../../panels/wallet/walletModel.ts";

/** The page's state machine; mirrors the Wallet panel's four read states. */
export type WalletPageStatus = "loading" | "unconfigured" | "offline" | "unfunded" | "ready";

/** One balance card. `note` is the honest sub-line (no price feed on testnet). */
export interface WalletPageAsset {
  code: string;
  balance: string;
  note: string;
}

/** One recent payment row, pre-resolved for display. */
export interface WalletPageTransaction {
  id: string;
  /** Unix epoch seconds, for `formatTimestamp`. */
  timestamp: number;
  summary: string;
  amount: string;
  direction: "in" | "out";
  status: "success" | "pending" | "failed";
  txHash: string | null;
  explorerUrl: string | null;
}

/** One alias-book entry, shortened for the notch width. */
export interface WalletPageAlias {
  name: string;
  address: string;
  source: "env" | "committed";
}

/** The `tx_submitted` event of this session, as the page shows it. */
export interface WalletPageLatestTx {
  hash: string;
  explorerUrl: string;
}

export interface WalletPageView {
  status: WalletPageStatus;
  /** One short sentence for the non-ready states (empty when ready). */
  message: string;
  network: string;
  ownerAddress: string | null;
  explorerUrl: string | null;
  friendbotUrl: string | null;
  assets: WalletPageAsset[];
  aliases: WalletPageAlias[];
  transactions: WalletPageTransaction[];
  latestTransaction: WalletPageLatestTx | null;
}

export interface WalletPageInput {
  /** `false` until `stellar_config` resolves, so no "unconfigured" flash. */
  configLoaded: boolean;
  network: string;
  ownerAddress: string | null;
  /** `null` while the first read is still in flight. */
  account: AccountFetchResult | null;
  payments: PaymentsFetchResult | null;
  aliasEntries?: readonly AliasEntryView[];
  latestTransaction?: WalletPageLatestTx | null;
  explorerBase?: string;
}

/** How many recent payments the notch height can show. */
export const WALLET_PAGE_TX_LIMIT = 5;

/**
 * Folds the loaded config and Horizon reads into the page's state. A missing
 * owner is `unconfigured`; a 404 is `unfunded` (Friendbot hint); a network
 * failure is `offline`; otherwise `ready`.
 */
export function deriveWalletPageView(input: WalletPageInput): WalletPageView {
  const explorerBase = input.explorerBase ?? DEFAULT_EXPLORER_BASE;
  const ownerAddress =
    input.ownerAddress && input.ownerAddress.length > 0 ? input.ownerAddress : null;
  const base: Omit<
    WalletPageView,
    "status" | "message" | "assets" | "transactions"
  > = {
    network: input.network,
    ownerAddress,
    explorerUrl: ownerAddress ? explorerAccountUrl(explorerBase, ownerAddress) : null,
    friendbotUrl: null,
    aliases: (input.aliasEntries ?? []).map((entry) => ({
      name: entry.name,
      address: entry.address,
      source: entry.source,
    })),
    latestTransaction: input.latestTransaction ?? null,
  };

  if (!input.configLoaded) {
    return {
      ...base,
      status: "loading",
      message: "Reading wallet configuration…",
      assets: [],
      transactions: [],
    };
  }
  if (!ownerAddress) {
    return {
      ...base,
      status: "unconfigured",
      message: "Set POLARIS_OWNER_ADDRESS to see balances and history.",
      assets: [],
      transactions: [],
    };
  }
  if (input.account === null) {
    return {
      ...base,
      status: "loading",
      message: "Reading balances from Horizon…",
      assets: [],
      transactions: [],
    };
  }
  if (input.account.status === "offline") {
    return {
      ...base,
      status: "offline",
      message: `Horizon is unreachable: ${input.account.message}.`,
      assets: [],
      transactions: [],
    };
  }
  if (input.account.status === "not_found") {
    return {
      ...base,
      status: "unfunded",
      message: "This account is not funded on testnet yet.",
      friendbotUrl: friendbotUrl(ownerAddress),
      assets: [],
      transactions: [],
    };
  }

  const payments = input.payments?.status === "ok" ? input.payments.payments : [];
  const rows = mapWalletTransactions(payments, {
    ownerAddress,
    aliasEntries: input.aliasEntries ?? [],
    explorerBase,
  }).slice(0, WALLET_PAGE_TX_LIMIT);

  return {
    ...base,
    status: "ready",
    message:
      input.payments?.status === "offline"
        ? "Balances loaded; recent transactions are unavailable."
        : "",
    assets: input.account.balances.map((balance) => ({
      code: balance.asset,
      balance: balance.balance,
      note: balance.native ? "native" : "credit",
    })),
    transactions: rows.map((row) => ({
      id: row.id,
      timestamp: Math.floor(row.createdAtMs / 1000),
      summary:
        `${row.direction === "sent" ? "Sent to" : "Received from"} ` +
        (row.counterpartyAlias ?? shortAddress(row.counterparty)),
      amount: `${row.direction === "sent" ? "-" : "+"}${row.amount} ${row.asset}`,
      direction: row.direction === "sent" ? "out" : "in",
      status: "success",
      txHash: row.hash,
      explorerUrl: row.explorerUrl,
    })),
  };
}

/** The loaded data plus the two controls the page needs. */
export interface WalletData extends WalletPageView {
  refreshing: boolean;
  refresh: () => void;
}

/**
 * Loads and caches the wallet read for the session. Mount is the first load;
 * the page's Refresh button is the only other trigger (no polling). The
 * `tx_submitted` subscription is independent of Horizon: a submission from this
 * session stays visible even when the next read is still in flight.
 */
export function useWalletData(
  committedAliases?: CommittedAliases,
  ownerAddressOverride?: string | null,
): WalletData {
  const [config, setConfig] = useState<StellarConfig | null>(null);
  const [configLoaded, setConfigLoaded] = useState(false);
  const [account, setAccount] = useState<AccountFetchResult | null>(null);
  const [payments, setPayments] = useState<PaymentsFetchResult | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [latestTransaction, setLatestTransaction] = useState<WalletPageLatestTx | null>(null);

  // W10b: the active wallet address (from the wallet engine) wins over the env
  // owner, so the page shows the wallet the user actually selected. When no
  // override is supplied the NW1 behaviour (env `POLARIS_OWNER_ADDRESS`) is kept.
  const effectiveOwner = ownerAddressOverride ?? config?.ownerAddress ?? null;

  useEffect(() => {
    let cancelled = false;
    void getStellarConfig()
      .catch(() => null)
      .then((value) => {
        if (cancelled) return;
        setConfig(value);
        setConfigLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const refresh = useCallback(async () => {
    if (!config || !effectiveOwner) return;
    setRefreshing(true);
    try {
      const [nextAccount, nextPayments] = await Promise.all([
        fetchOwnerAccount(config.horizonUrl, effectiveOwner),
        fetchOwnerPayments(config.horizonUrl, effectiveOwner, {
          limit: WALLET_PAGE_TX_LIMIT,
        }),
      ]);
      setAccount(nextAccount);
      setPayments(nextPayments);
    } finally {
      setRefreshing(false);
    }
  }, [config, effectiveOwner]);

  useEffect(() => {
    if (config) void refresh();
  }, [config, refresh]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listenPolarisEvents((event) => {
      if (event.type === "tx_submitted") {
        setLatestTransaction({ hash: event.hash, explorerUrl: event.explorerUrl });
      }
    })
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch((error: unknown) => {
        console.warn("wallet page could not subscribe to polaris-event", error);
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const aliasEntries = useMemo(
    () => buildAliasEntries(config?.aliases, committedAliases),
    [config, committedAliases],
  );

  const view = useMemo(
    () =>
      deriveWalletPageView({
        configLoaded,
        network: config?.network ?? "testnet",
        ownerAddress: effectiveOwner,
        account,
        payments,
        aliasEntries,
        latestTransaction,
      }),
    [account, aliasEntries, config, configLoaded, effectiveOwner, latestTransaction, payments],
  );

  const doRefresh = useCallback(() => {
    void refresh();
  }, [refresh]);

  return { ...view, refreshing, refresh: doRefresh };
}
