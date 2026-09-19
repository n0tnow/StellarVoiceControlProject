/**
 * Demo flows: whole deposit / withdraw journeys as one call, built from the
 * session's step methods. The agent may also call the steps individually.
 */
import type { ExplainRecord } from "./explain.ts";
import type { AnchorSession } from "./session.ts";
import type { PollOptions, PollResult } from "./sep6.ts";
import type { DepositInstructions, Quote, WithdrawInstructions } from "./types.ts";
import type { PreflightResult } from "./preflight.ts";

export interface DepositFlowOptions {
  /** Local-currency amount to deposit (TRY for the Turkish anchor), decimal string. */
  amountFiat: string;
  /** SANDBOX: play the bank via the mock's simulate endpoint. Leave false against a real anchor. */
  sandboxBank?: boolean;
  poll?: Omit<PollOptions, "onPendingTrust">;
}

export interface DepositFlowResult {
  preflight: PreflightResult;
  quote: Quote;
  deposit: DepositInstructions;
  poll: PollResult;
  balanceBefore: string;
  balanceAfter: string;
  explain: ExplainRecord[];
}

/**
 * quote -> deposit -> (sandbox: simulate bank) -> poll to a final status -> read
 * the resulting balance from Horizon. Preflight runs first so the deposit does
 * not stall in `pending_trust`.
 */
export async function runDepositFlow(session: AnchorSession, opts: DepositFlowOptions): Promise<DepositFlowResult> {
  const mark = session.explain.mark();
  const pre = await session.prepareAccount();
  const before = await session.balance();
  const quote = await session.quoteDeposit(opts.amountFiat);
  const dep = await session.startDeposit(opts.amountFiat);
  if (opts.sandboxBank) await session.simulateBank(dep.data.id, opts.amountFiat);
  const poll = await session.waitForTransaction(dep.data.id, opts.poll);
  const after = await session.balance();
  return {
    preflight: pre.data,
    quote: quote.data,
    deposit: dep.data,
    poll: poll.data,
    balanceBefore: before.data.balance,
    balanceAfter: after.data.balance,
    explain: session.explain.since(mark),
  };
}

export interface WithdrawFlowOptions {
  /** On-chain asset amount to cash out (USDC), decimal string. */
  amountAsset: string;
  poll?: Omit<PollOptions, "onPendingTrust">;
}

export interface WithdrawFlowResult {
  quote: Quote;
  withdraw: WithdrawInstructions;
  payment: { hash: string; explorerUrl: string };
  poll: PollResult;
  balanceBefore: string;
  balanceAfter: string;
  explain: ExplainRecord[];
}

/** quote -> withdraw request -> pay the anchor on-chain -> poll to a final status. */
export async function runWithdrawFlow(session: AnchorSession, opts: WithdrawFlowOptions): Promise<WithdrawFlowResult> {
  const mark = session.explain.mark();
  const before = await session.balance();
  const quote = await session.quoteWithdraw(opts.amountAsset);
  const w = await session.startWithdraw(opts.amountAsset);
  const payment = await session.payWithdrawal(opts.amountAsset);
  const poll = await session.waitForTransaction(w.data.id, opts.poll);
  const after = await session.balance();
  return {
    quote: quote.data,
    withdraw: w.data,
    payment: payment.data,
    poll: poll.data,
    balanceBefore: before.data.balance,
    balanceAfter: after.data.balance,
    explain: session.explain.since(mark),
  };
}
