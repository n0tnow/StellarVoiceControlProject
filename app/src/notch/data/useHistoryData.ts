/**
 * History page data (HISTORY-UI): the local voice-turn log, the owner's recent
 * Horizon payments, the active wallet's P2P offers and the anchor explain log,
 * merged into one rich, paginated timeline.
 *
 * Demo fallback is explicit and narrow: the mock timeline is shown **only** when
 * the app is not running inside Tauri or `stellar_config` has no owner address.
 * A failed real read never falls back to mock — it surfaces the error (with a
 * Retry action) so the page cannot quietly show fabricated history.
 *
 * On-chain reads page 20 at a time via Horizon's cursor and are capped at 200
 * rows in memory; "Load more" is the only way to grow the list. Nothing here
 * signs or moves value, and no read polls.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";

import {
  buildAliasEntries,
  fetchOwnerPayments,
  mapWalletTransactions,
} from "@/lib/history";
import { MOCK_HISTORY } from "@/lib/mockData";
import { getStellarConfig } from "@/lib/stellarConfig";
import { clearTurnLog, readTurnLog } from "@/lib/turnLog";
import { loadAnchorRows } from "../history/anchorHistory";
import {
  chainToHistoryRow,
  demoToHistoryRow,
  mergeRows,
  turnToHistoryRow,
  type HistoryRow,
} from "../history/model";
import { loadP2pRows } from "../history/p2pHistory";
import committedAliases from "../../../../stellar/config/aliases.json";

/** How many payments one Horizon page reads. */
const PAGE_SIZE = 20;

/** The in-memory cap: older rows are dropped rather than growing forever. */
export const MAX_ROWS = 200;

/** Where the displayed timeline came from. */
export type HistorySource = "live" | "demo";

export interface HistoryData {
  rows: HistoryRow[];
  /** `demo` only when Tauri is absent or no owner address is configured. */
  source: HistorySource;
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  /** A real-read failure, shown with Retry (never replaced by mock data). */
  error: string | null;
  /** True when the browser/Horizon could not be reached. */
  offline: boolean;
  refresh: () => void;
  loadMore: () => void;
  /** Clears the local turn log and reloads the timeline. */
  clearLocal: () => void;
}

interface LoadContext {
  horizonUrl: string;
  ownerAddress: string;
  aliasEntries: ReturnType<typeof buildAliasEntries>;
}

function messageOf(error: unknown): string {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return raw.split("\n")[0]?.trim() || "History could not be read";
}

export function useHistoryData(): HistoryData {
  const [turnRows, setTurnRows] = useState<HistoryRow[]>([]);
  const [chainRows, setChainRows] = useState<HistoryRow[]>([]);
  const [extraRows, setExtraRows] = useState<HistoryRow[]>([]);
  const [demoRows, setDemoRows] = useState<HistoryRow[]>([]);
  const [source, setSource] = useState<HistorySource>("demo");
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const contextRef = useRef<LoadContext | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setError(null);
      setOffline(false);
      setChainRows([]);
      setExtraRows([]);
      setDemoRows([]);
      setCursor(null);
      setHasMore(false);
      contextRef.current = null;

      // Local turns are a real source regardless of chain configuration.
      const localRows = readTurnLog().map(turnToHistoryRow);
      setTurnRows(localRows);
      const showDemo = (): void => {
        if (cancelled) return;
        setDemoRows(MOCK_HISTORY.map(demoToHistoryRow));
        setSource("demo");
        setLoading(false);
      };

      if (!isTauri()) {
        showDemo();
        return;
      }

      let config;
      try {
        config = await getStellarConfig();
      } catch (readError) {
        if (!cancelled) {
          setSource("live");
          setError(messageOf(readError));
          setLoading(false);
        }
        return;
      }
      if (!config.ownerAddress) {
        showDemo();
        return;
      }

      const context: LoadContext = {
        horizonUrl: config.horizonUrl,
        ownerAddress: config.ownerAddress,
        aliasEntries: buildAliasEntries(config.aliases, committedAliases),
      };
      contextRef.current = context;

      const payments = await fetchOwnerPayments(context.horizonUrl, context.ownerAddress, {
        limit: PAGE_SIZE,
      });
      if (cancelled) return;
      setSource("live");
      if (payments.status === "offline") {
        setOffline(true);
        setError(payments.message);
        setLoading(false);
      } else if (payments.status === "ok") {
        const next = payments.nextCursor ?? null;
        setChainRows(
          mapWalletTransactions(payments.payments, {
            ownerAddress: context.ownerAddress,
            aliasEntries: context.aliasEntries,
          }).map(chainToHistoryRow),
        );
        setCursor(next);
        setHasMore(next !== null);
        setLoading(false);
      } else {
        // An unfunded owner account: live, just empty.
        setLoading(false);
      }

      // Optional lanes load in the background so they never delay first paint.
      void Promise.all([loadP2pRows(), loadAnchorRows()]).then(([p2p, anchor]) => {
        if (!cancelled) setExtraRows([...p2p, ...anchor]);
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  const loadMore = useCallback(() => {
    const context = contextRef.current;
    if (context === null || cursor === null || loadingMore) return;
    setLoadingMore(true);
    void (async () => {
      const payments = await fetchOwnerPayments(context.horizonUrl, context.ownerAddress, {
        limit: PAGE_SIZE,
        cursor,
      });
      if (payments.status === "ok") {
        const nextRows = mapWalletTransactions(payments.payments, {
          ownerAddress: context.ownerAddress,
          aliasEntries: context.aliasEntries,
        }).map(chainToHistoryRow);
        const next = payments.nextCursor ?? null;
        setChainRows((current) => mergeRows(current, nextRows));
        setCursor(next);
        setHasMore(next !== null);
      } else if (payments.status === "offline") {
        setOffline(true);
        setError(payments.message);
        setHasMore(false);
      } else {
        setHasMore(false);
      }
      setLoadingMore(false);
    })();
  }, [cursor, loadingMore]);

  const refresh = useCallback(() => setReloadKey((key) => key + 1), []);
  const clearLocal = useCallback(() => {
    clearTurnLog();
    setReloadKey((key) => key + 1);
  }, []);

  useEffect(() => {
    const goOnline = (): void => setOffline(false);
    const goOffline = (): void => setOffline(true);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, []);

  const rows = useMemo(
    () =>
      (source === "demo" ? demoRows : mergeRows(turnRows, chainRows, extraRows)).slice(
        0,
        MAX_ROWS,
      ),
    [source, demoRows, turnRows, chainRows, extraRows],
  );

  return {
    rows,
    source,
    loading,
    loadingMore,
    hasMore,
    error,
    offline,
    refresh,
    loadMore,
    clearLocal,
  };
}
