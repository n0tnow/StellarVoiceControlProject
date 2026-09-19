/**
 * Public types for the schedule tools.
 *
 * The chain ABI is `create_schedule(owner,to,asset,amount,first_run_at,
 * interval_secs,runs)`; a one-shot is `interval_secs 0, runs 1`. Everything
 * time-related is stored as **UTC epoch seconds** — local time only ever
 * appears in drafts (with an explicit IANA timezone) and in decoded summaries.
 */
import type { ChainToolResult } from "@polaris/interfaces";
import type { AssetRegistry } from "../payments/assets.ts";
import type { AliasBook } from "../payments/aliases.ts";
import type { GuardClient } from "../guard/types.ts";

/** Wall-clock first run: an explicit zone is mandatory — never the machine zone. */
export interface FirstRun {
  /** `YYYY-MM-DD`. */
  localDate: string;
  /** `HH:mm` (24-hour). */
  localTime: string;
  /** IANA zone, e.g. `Europe/Istanbul`. */
  timeZone: string;
}

/**
 * Repeats are fixed-second intervals only. Monthly / "end of month" repeats
 * are NOT representable and are refused with `unsupported_repeat`.
 */
export interface Repeat {
  every: "day" | "week" | "custom";
  /** Required (and only used) when `every === "custom"`. */
  customSeconds?: number;
}

/** A speech-derived, unsigned schedule request, read back before signing. */
export interface ScheduleDraft {
  /** Alias book name; raw `G...` addresses are refused. */
  recipient: string;
  asset: "USDC" | "XLM";
  /** Decimal string, positive, at most 7 fraction digits. */
  amount: string;
  firstRun: FirstRun;
  /** Absent = a one-shot (`interval_secs 0, runs 1`). */
  repeat?: Repeat;
  /**
   * Number of executions. Defaults to 1; for a one-shot it must be 1.
   *
   * A `repeat` with `runs` omitted becomes **one** run here; the AGENT layer
   * must first ask "for how many?" (design §11b) — never assume an infinite or
   * open-ended repeat.
   */
  runs?: number;
}

/** The resolved local time, in both zones, plus the ambiguity flag. */
export interface ResolvedLocalTime {
  /** Unix seconds (integer) — the value sent as `first_run_at`. */
  epochSeconds: number;
  /** UTC ISO-8601, e.g. `2026-09-20T12:00:00.000Z`. */
  utcIso: string;
  /** Local ISO-8601 with offset, e.g. `2026-09-20T15:00:00+03:00`. */
  localIso: string;
  /** Minutes east of UTC (330 for Asia/Kolkata). */
  offsetMinutes: number;
  /** True when the local time occurs twice (fall-back overlap); the earlier instant wins. */
  ambiguous: boolean;
}

/** Dependencies shared by all three schedule tools. */
export interface ScheduleDeps {
  /** Owner address; also the transaction source and the address that signs. */
  ownerAddress: string;
  aliases: AliasBook;
  /**
   * Owner-side guard client built with the deployed contract id (D9). The
   * contract id is read from `guard.contractId`, never hard-coded here.
   */
  guard: GuardClient;
  assets: AssetRegistry;
  /** Asset code -> SAC contract id used by `polaris_guard` (`{ USDC: "C..." }`). */
  guardAssetContracts: Record<string, string>;
  networkPassphrase: string;
  explorerBase?: string;
  /** Injected clock. Defaults to the wall clock. */
  now?: () => Date;
  txTimeoutSeconds?: number;
  /** Keeper poll interval used to grade "due" vs "delayed" (default 15 s). */
  pollSeconds?: number;
  /**
   * SEP-41 allowance reader for the asset's SAC. **Mandatory**: the SAC
   * allowance (`approve(owner -> guard)`) is required for EVERY guard payment,
   * including schedule runs and XLM (all settle through `transfer_from`), so
   * `schedulePayment` cannot pre-check without it. The app wires this to
   * `getAllowance(rpc, { assetContractId, from: owner, spender:
   * guard.contractId, networkPassphrase })`.
   */
  getAllowance: (assetContractId: string) => Promise<bigint>;
}

/** Result of building an unsigned `create_schedule` call. */
export interface SchedulePaymentResult {
  /** base64 XDR, unsigned; the owner must sign it. */
  unsignedXdr: string;
  /** Approval-card summary decoded from that exact XDR. */
  summary: ChainToolResult["summary"];
  /** hex sha256 of the transaction signature base (the Touch ID payload). */
  payloadHash: string;
  /** Non-blocking cautions (F-03, DST ambiguity, daily limit, keeper dependency). */
  warnings: string[];
}

/** Result of building an unsigned `cancel_schedule` call. */
export interface CancelScheduleResult {
  unsignedXdr: string;
  summary: ChainToolResult["summary"];
  payloadHash: string;
  /** Cancelling tightens limits, so only the lighter confirmation is required. */
  confirmation: "light";
  /** The resolved schedule id. */
  id: number;
  /** Alias for the payee when the schedule was matched by recipient. */
  recipientAlias: string | null;
}

/** One row of the "Upcoming payments" list. */
export interface UpcomingPayment {
  id: number;
  recipientAlias: string | null;
  recipientAddress: string;
  asset: string;
  /** Raw token units (7 decimals) as a decimal string. */
  amountRaw: string;
  /** Human amount, e.g. `50`. */
  amount: string;
  /** Next run, UTC ISO-8601. */
  nextRunUtc: string;
  /** Next run in the requested zone, ISO-8601 with offset. */
  nextRunLocal: string;
  runsLeft: number;
  intervalWords: string;
  /**
   * `scheduled` / `due` / `delayed` / `finished` only. The design's
   * "failing/retrying" status is **not modelled**: the contract exposes no
   * on-chain failure signal (only an active flag and `runs_left`), so a failed
   * run is indistinguishable from a keeper that has not fired yet. The UI lane
   * (T5) must treat a long-`delayed` row as "possibly failing" instead.
   */
  status: "scheduled" | "due" | "delayed" | "finished";
}

/** Options for `listUpcoming`. */
export interface ListUpcomingOptions {
  now?: Date | number;
  timeZone: string;
}

/** Curried tool signatures (the shell calls `tool(deps)(request)`). */
export type SchedulePaymentTool = (draft: unknown) => Promise<SchedulePaymentResult>;
export type CancelScheduleTool = (request: unknown) => Promise<CancelScheduleResult>;
export type ListUpcomingTool = (options: unknown) => Promise<UpcomingPayment[]>;
