/**
 * Approval-card summaries DECODED from the unsigned XDR.
 *
 * Function name and every numeric argument (amount, `first_run_at`,
 * `interval_secs`, `runs`, `id`) are read back out of the transaction, never
 * copied from the caller's intent. The alias and asset code are display labels
 * supplied after alias/asset resolution; the SAC id is decoded from the XDR.
 */
import { Transaction, TransactionBuilder } from "@stellar/stellar-sdk";
import type { ChainToolResult } from "@polaris/interfaces";
import { fromRawUnits } from "../guard/amount.ts";
import { decodeInvocation, shortKey, stroopsToXlm, toHex } from "../guard/describe.ts";
import { formatInZone, intervalWords } from "./time.ts";

const DEFAULT_EXPLORER_BASE = "https://stellar.expert/explorer/testnet";

export interface BuiltScheduleSummary {
  summary: ChainToolResult["summary"];
  payloadHash: string;
}

function decodeTx(unsignedXdr: string, networkPassphrase: string): Transaction {
  const tx = TransactionBuilder.fromXDR(unsignedXdr, networkPassphrase);
  if (!(tx instanceof Transaction)) throw new Error("fee-bump envelopes are not supported for schedule calls");
  return tx;
}

function decodeArgs(unsignedXdr: string, networkPassphrase: string, contractId: string, fn: string): unknown[] {
  const invocation = decodeInvocation(unsignedXdr, networkPassphrase);
  if (invocation.contractId !== contractId) {
    throw new Error(
      `schedule summary mismatch: XDR targets ${invocation.contractId}, client is ${contractId}`,
    );
  }
  if (invocation.functionName !== fn) {
    throw new Error(`schedule summary mismatch: XDR calls ${invocation.functionName}, expected ${fn}`);
  }
  return invocation.args;
}

export interface CreateScheduleSummaryInput {
  unsignedXdr: string;
  networkPassphrase: string;
  /** Contract id the client was built with; asserted against the decoded op. */
  contractId: string;
  /** Resolved alias name (display only). */
  alias: string;
  /** Human asset code ("USDC") for display; the SAC id is decoded from the XDR. */
  assetCode: string;
  /** Explicit IANA zone used to render the local first run. */
  timeZone: string;
  explorerBase?: string;
}

/** Summary for an unsigned `create_schedule`. */
export function buildCreateScheduleSummary(input: CreateScheduleSummaryInput): BuiltScheduleSummary {
  const tx = decodeTx(input.unsignedXdr, input.networkPassphrase);
  const args = decodeArgs(input.unsignedXdr, input.networkPassphrase, input.contractId, "create_schedule");
  const to = String(args[1]);
  const assetSac = String(args[2]);
  const amountRaw = args[3];
  const firstRunAt = args[4];
  const intervalSecs = args[5];
  const runs = args[6];
  if (typeof amountRaw !== "bigint" || typeof firstRunAt !== "bigint" || typeof intervalSecs !== "bigint") {
    throw new Error("create_schedule summary: amount/first_run_at/interval_secs are not integers");
  }
  if (typeof runs !== "number" || !Number.isInteger(runs) || runs < 1) {
    throw new Error(`create_schedule summary: runs is not a positive integer (${String(runs)})`);
  }
  const amount = fromRawUnits(amountRaw);
  const totalRaw = amountRaw * BigInt(runs);
  const total = fromRawUnits(totalRaw);
  const firstRunEpoch = Number(firstRunAt);
  const repeat = intervalWords(Number(intervalSecs));
  const utcIso = new Date(firstRunEpoch * 1000).toISOString();
  const localIso = formatInZone(firstRunEpoch, input.timeZone);
  const payloadHash = toHex(tx.hash());
  const fee = `${stroopsToXlm(tx.fee)} XLM`;
  const summary: ChainToolResult["summary"] = {
    title: `Schedule ${amount} ${input.assetCode} to ${input.alias} — ${repeat}`,
    lines: [
      `Schedule payment via polaris_guard (${shortKey(input.contractId)}) — create_schedule`,
      `To ${input.alias} (${to})`,
      `Per run: ${amount} ${input.assetCode}`,
      `Asset (SAC): ${assetSac}`,
      `First run: ${localIso} (${input.timeZone}) — ${utcIso} UTC`,
      `Repeat: ${repeat}`,
      `Runs: ${runs}`,
      `Total: ${total} ${input.assetCode} (${runs} × ${amount})`,
      `Funding needed: ${total} ${input.assetCode} (SAC allowance to the guard)`,
      `Network: ${input.networkPassphrase}`,
      `Fee: ${fee}`,
      `Approval: owner signature required`,
    ],
    explorerUrl: `${input.explorerBase ?? DEFAULT_EXPLORER_BASE}/tx/${payloadHash}`,
    estimatedFee: fee,
  };
  return { summary, payloadHash };
}

export interface CancelScheduleSummaryInput {
  unsignedXdr: string;
  networkPassphrase: string;
  contractId: string;
  /** Resolved alias name, when the schedule was matched by recipient. */
  alias: string | null;
  recipientAddress: string;
  assetCode: string;
  amount: string;
  nextRunUtc: string;
  explorerBase?: string;
}

/** Summary for an unsigned `cancel_schedule`. */
export function buildCancelScheduleSummary(input: CancelScheduleSummaryInput): BuiltScheduleSummary {
  const tx = decodeTx(input.unsignedXdr, input.networkPassphrase);
  const args = decodeArgs(input.unsignedXdr, input.networkPassphrase, input.contractId, "cancel_schedule");
  const owner = String(args[0]);
  const id = args[1];
  if (typeof id !== "number") throw new Error("cancel_schedule summary: id is not a u32");
  const payloadHash = toHex(tx.hash());
  const fee = `${stroopsToXlm(tx.fee)} XLM`;
  const recipient = input.alias
    ? `${input.alias} (${input.recipientAddress})`
    : (input.recipientAddress || "unknown");
  const summary: ChainToolResult["summary"] = {
    title: `Cancel scheduled payment #${id} (${input.amount} ${input.assetCode} to ${input.alias ?? recipient})`,
    lines: [
      `Cancel scheduled payment via polaris_guard (${shortKey(input.contractId)}) — cancel_schedule`,
      `Schedule id: ${id}`,
      `Recipient: ${recipient}`,
      `Amount: ${input.amount} ${input.assetCode} per run`,
      `Next run: ${input.nextRunUtc} UTC`,
      `Owner: ${owner}`,
      `Network: ${input.networkPassphrase}`,
      `Fee: ${fee}`,
      `Confirmation: light — cancelling a schedule only tightens limits (owner auth only)`,
      `Approval: owner signature required`,
    ],
    explorerUrl: `${input.explorerBase ?? DEFAULT_EXPLORER_BASE}/tx/${payloadHash}`,
    estimatedFee: fee,
  };
  return { summary, payloadHash };
}
