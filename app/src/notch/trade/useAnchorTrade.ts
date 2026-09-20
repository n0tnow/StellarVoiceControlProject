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

import { getBankAccount, subscribeBankChanged } from "@/lib/bank";
import { bankDeposit, bankWithdraw, readBankLimits, type BankLimits } from "@/lib/bankAnchor";
import type { BankAccount, BankFlowResult, BankStepId, BankStepStatus } from "@/lib/bankFlow";
import { getStellarConfig } from "@/lib/stellarConfig";
import { fetchAccountDetail, type HorizonAccountDetail } from "@/lib/walletAssets";

import { freshBankSteps, walletBalanceLabel, type TradeDirection } from "./tradeModel";

export interface AnchorTradeState {
  steps: Record<BankStepId, BankStepStatus>;
  busy: boolean;
  error: string | null;
  result: BankFlowResult | null;
  bankBalance: string | null;
  bankCurrency: string | null;
  walletBalance: string | null;
  walletAsset: string;
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
  const [account, setAccount] = useState<BankAccount | null>(null);
  const [detail, setDetail] = useState<HorizonAccountDetail | null>(null);
  const [limits, setLimits] = useState<BankLimits | null>(null);
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
    void readBankLimits().then(setLimits).catch(() => {});
    const subscription = subscribeBankChanged(setAccount);
    return () => {
      void subscription.then((off) => off()).catch(() => {});
    };
  }, [refreshWallet]);

  const run = useCallback(
    async (amount: string) => {
      if (busy) return;
      setBusy(true);
      setError(null);
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
        setError(messageOf(failure));
      } finally {
        await refreshWallet();
        setBusy(false);
      }
    },
    [busy, direction, refreshWallet],
  );

  const cancel = useCallback(() => {
    cancelRef.current = true;
  }, []);

  const walletAsset = limits?.assetCode ?? "USDC";

  return {
    steps,
    busy,
    error,
    result,
    bankBalance: account?.balanceTry ?? null,
    bankCurrency: account?.currency ?? null,
    walletBalance: detail ? walletBalanceLabel(detail, walletAsset) : null,
    walletAsset,
    max: direction === "deposit" ? limits?.depositMax : limits?.withdrawMax,
    run,
    cancel,
  };
}
