/**
 * The Anchor panel's bank card state (BANK-SIM).
 *
 * It owns the demo-bank account + history (Rust commands), subscribes to
 * `bank_changed`, tracks the live step list of a running deposit/withdraw, and
 * reconciles any flow left in flight by a previous app run. All value-moving
 * work goes through `@/lib/bankAnchor`, which drives the shell `AnchorSession`
 * (SEP-10 wallet-only, every other step through the Touch ID pipeline).
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { getBankHistory, getBankAccount, bankReset, subscribeBankChanged } from "@/lib/bank";
import {
  bankDeposit,
  bankWithdraw,
  bankAnchorScenario,
  readBankLimits,
  readBankPayoutHealth,
  reconcileBankFlows,
} from "@/lib/bankAnchor";
import {
  BANK_STEPS,
  type BankAccount,
  type BankFlowResult,
  type BankStepId,
  type BankStepStatus,
  type BankTransaction,
} from "@/lib/bankFlow";

export interface BankView {
  account: BankAccount | null;
  history: BankTransaction[];
  steps: Record<BankStepId, BankStepStatus>;
  busy: boolean;
  error: string | null;
  lastResult: BankFlowResult | null;
  scenarioLabel: string;
  payoutWarning: string | null;
  assetCode: string;
  depositMax?: number;
  withdrawMax?: number;
  deposit: (amount: string) => Promise<void>;
  withdraw: (amount: string) => Promise<void>;
  cancel: () => void;
  reset: () => Promise<void>;
  refresh: () => Promise<void>;
}

function freshSteps(): Record<BankStepId, BankStepStatus> {
  const steps = {} as Record<BankStepId, BankStepStatus>;
  for (const step of BANK_STEPS) steps[step.id] = "pending";
  return steps;
}

/** One line about a thrown value, safe to show. */
function messageOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split("\n")[0]?.trim() || "The bank step failed.";
}

export function useBank(): BankView {
  const [account, setAccount] = useState<BankAccount | null>(null);
  const [history, setHistory] = useState<BankTransaction[]>([]);
  const [steps, setSteps] = useState<Record<BankStepId, BankStepStatus>>(freshSteps);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<BankFlowResult | null>(null);
  const [scenarioLabel, setScenarioLabel] = useState("loading…");
  const [payoutWarning, setPayoutWarning] = useState<string | null>(null);
  const [assetCode, setAssetCode] = useState("USDC");
  const [depositMax, setDepositMax] = useState<number | undefined>(undefined);
  const [withdrawMax, setWithdrawMax] = useState<number | undefined>(undefined);
  const reconciled = useRef(false);
  const cancelRef = useRef(false);

  const refresh = useCallback(async () => {
    const [nextAccount, nextHistory] = await Promise.all([getBankAccount(), getBankHistory(50)]);
    setAccount(nextAccount);
    setHistory(nextHistory);
  }, []);

  useEffect(() => {
    void refresh().catch((failure) => setError(messageOf(failure)));
    const unsubscribe = subscribeBankChanged((next) => {
      setAccount(next);
      void getBankHistory(50).then(setHistory).catch(() => {});
    });
    void bankAnchorScenario()
      .then(async (scenario) => {
        setScenarioLabel(scenario.label);
        const health = await readBankPayoutHealth();
        if (health?.verdict === "payouts-stalled") {
          setPayoutWarning(health.reasons[0] ?? "The anchor's deposit payouts look stalled.");
        }
      })
      .catch(() => setScenarioLabel("unknown anchor"));
    void readBankLimits()
      .then((limits) => {
        setAssetCode(limits.assetCode);
        setDepositMax(limits.depositMax);
        setWithdrawMax(limits.withdrawMax);
      })
      .catch(() => {
        // Keep the conservative default cap when /info is unreachable.
      });
    return () => {
      void unsubscribe.then((off) => off()).catch(() => {});
    };
  }, [refresh]);

  // Reconcile once per mount: settle/refund/credit anything left in flight.
  useEffect(() => {
    if (reconciled.current) return;
    reconciled.current = true;
    void reconcileBankFlows(undefined, (id, status) =>
      setSteps((current) => ({ ...current, [id]: status === "pending" ? current[id] : status })),
    )
      .then(async (results) => {
        if (results.length > 0) {
          setLastResult(results[0] ?? null);
          await refresh();
        }
      })
      .catch(() => {
        // A failed reconciliation is retried on the next app start.
      });
  }, [refresh]);

  const report = useCallback((id: BankStepId, status: BankStepStatus) => {
    setSteps((current) => ({ ...current, [id]: status }));
  }, []);

  const run = useCallback(
    async (kind: "deposit" | "withdraw", amount: string) => {
      if (busy) return;
      setBusy(true);
      setError(null);
      setLastResult(null);
      setSteps(freshSteps());
      cancelRef.current = false;
      const options = { shouldCancel: () => cancelRef.current };
      try {
        const result =
          kind === "deposit"
            ? await bankDeposit(amount, options, report)
            : await bankWithdraw(amount, options, report);
        setLastResult(result);
        if (result.status !== "completed") setError(result.detail);
      } catch (failure) {
        setError(messageOf(failure));
      } finally {
        await refresh().catch(() => {});
        setBusy(false);
      }
    },
    [busy, refresh, report],
  );

  const deposit = useCallback((amount: string) => run("deposit", amount), [run]);
  const withdraw = useCallback((amount: string) => run("withdraw", amount), [run]);
  const cancel = useCallback(() => {
    cancelRef.current = true;
  }, []);

  const reset = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      await bankReset();
      await refresh();
    } catch (failure) {
      setError(messageOf(failure));
    } finally {
      setBusy(false);
    }
  }, [busy, refresh]);

  return {
    account,
    history,
    steps,
    busy,
    error,
    lastResult,
    scenarioLabel,
    payoutWarning,
    assetCode,
    depositMax,
    withdrawMax,
    deposit,
    withdraw,
    cancel,
    reset,
    refresh,
  };
}
