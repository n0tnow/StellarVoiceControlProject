/**
 * The Trade page's deposit/withdraw lane (task W15c).
 *
 * It reuses the bank↔anchor automation (`@/lib/bankAnchor`) unchanged and only
 * adds the React state the compact page needs: the live step map, the demo-bank
 * balance and the owner's wallet balance. Every value-moving step stays inside
 * the automation — the SEP-10 login is wallet-only and the withdrawal payment
 * goes through the shared Touch ID pipeline; nothing here signs or holds a key.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { StellarConfig } from "@polaris/interfaces";

import { getBankAccount, bankSetCurrency, subscribeBankChanged } from "@/lib/bank";
import {
  activeAnchorInfo,
  anchorSelectionDetails,
  bankDeposit,
  bankWithdraw,
  NO_ANCHOR_MESSAGE,
  readBankLimits,
  type ActiveAnchorInfo,
  type BankLimits,
} from "@/lib/bankAnchor";
import type { BankAccount, BankFlowResult, BankStepId, BankStepStatus } from "@/lib/bankFlow";
import { getStellarConfig } from "@/lib/stellarConfig";
import { fetchAccountDetail, type HorizonAccountDetail } from "@/lib/walletAssets";

import { freshBankSteps, walletBalanceLabel, type TradeDirection } from "./tradeModel";

export interface AnchorTradeState {
  steps: Record<BankStepId, BankStepStatus>;
  busy: boolean;
  error: string | null;
  /** Per-anchor reasons behind the error's "Details" toggle (selection failures only). */
  errorDetails: string[] | null;
  result: BankFlowResult | null;
  bankBalance: string | null;
  bankCurrency: string | null;
  walletBalance: string | null;
  walletAsset: string;
  /** The chosen anchor's home domain, shown as the "via …" caption. */
  anchorHomeDomain: string | null;
  max: number | undefined;
  run: (amount: string) => Promise<void>;
  cancel: () => void;
}

function messageOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split("\n")[0]?.trim() || "The anchor step failed.";
}

export function useAnchorTrade(direction: TradeDirection): AnchorTradeState {
  const [steps, setSteps] = useState<Record<BankStepId, BankStepStatus>>(freshBankSteps);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BankFlowResult | null>(null);
  const [errorDetails, setErrorDetails] = useState<string[] | null>(null);
  const [account, setAccount] = useState<BankAccount | null>(null);
  const [detail, setDetail] = useState<HorizonAccountDetail | null>(null);
  const [limits, setLimits] = useState<BankLimits | null>(null);
  const [anchor, setAnchor] = useState<ActiveAnchorInfo | null>(null);
  const cancelRef = useRef(false);
  const configRef = useRef<StellarConfig | null>(null);

  const refreshWallet = useCallback(async () => {
    try {
      const config = configRef.current ?? (await getStellarConfig());
      configRef.current = config;
      if (!config.ownerAddress) {
        setDetail(null);
        return;
      }
      const read = await fetchAccountDetail(config.horizonUrl, config.ownerAddress);
      setDetail(read.status === "ok" ? read.detail : null);
    } catch {
      // A failed read just leaves the wallet side of the balance line blank.
      setDetail(null);
    }
  }, []);

  useEffect(() => {
    void refreshWallet();
    void getBankAccount().then(setAccount).catch(() => {});
    const subscription = subscribeBankChanged(setAccount);
    void (async () => {
      try {
        const info = await activeAnchorInfo();
        setAnchor(info);
        setLimits(await readBankLimits());
        // Keep the demo ledger's label on the active scenario's fiat, so the
        // balances line and the flow's credit label never mix currencies.
        const current = await getBankAccount();
        setAccount(current);
        if (info.fiat && current.currency !== info.fiat) {
          setAccount(await bankSetCurrency(info.fiat));
        }
      } catch (failure) {
        const reasons = anchorSelectionDetails(failure);
        if (reasons) {
          setError(NO_ANCHOR_MESSAGE);
          setErrorDetails(reasons);
        }
      }
    })();
    return () => {
      void subscription.then((off) => off()).catch(() => {});
    };
  }, [refreshWallet]);

  const run = useCallback(
    async (amount: string) => {
      if (busy) return;
      setBusy(true);
      setError(null);
      setErrorDetails(null);
      setResult(null);
      setSteps(freshBankSteps());
      cancelRef.current = false;
      const report = (id: BankStepId, status: BankStepStatus): void =>
        setSteps((current) => ({ ...current, [id]: status }));
      const options = { shouldCancel: () => cancelRef.current };
      try {
        const outcome =
          direction === "deposit"
            ? await bankDeposit(amount, options, report)
            : await bankWithdraw(amount, options, report);
        setResult(outcome);
        if (outcome.status !== "completed") setError(outcome.detail);
      } catch (failure) {
        const reasons = anchorSelectionDetails(failure);
        if (reasons) {
          setError(NO_ANCHOR_MESSAGE);
          setErrorDetails(reasons);
        } else {
          setError(messageOf(failure));
        }
      } finally {
        await refreshWallet();
        // Reflect a selection that succeeded on a Retry (cached; no extra probe).
        void activeAnchorInfo().then(setAnchor).catch(() => {});
        setBusy(false);
      }
    },
    [busy, direction, refreshWallet],
  );

  const cancel = useCallback(() => {
    cancelRef.current = true;
  }, []);

  // The active scenario drives the labels: its asset for the wallet side, its
  // fiat for the bank side (falling back to the ledger only before selection).
  const walletAsset = anchor?.assetCode ?? limits?.assetCode ?? "USDC";
  const bankCurrency = anchor?.fiat ?? account?.currency ?? null;

  return {
    steps,
    busy,
    error,
    errorDetails,
    result,
    bankBalance: account?.balanceTry ?? null,
    bankCurrency,
    walletBalance: detail ? walletBalanceLabel(detail, walletAsset) : null,
    walletAsset,
    anchorHomeDomain: anchor?.homeDomain ?? null,
    max: direction === "deposit" ? limits?.depositMax : limits?.withdrawMax,
    run,
    cancel,
  };
}
