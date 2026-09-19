/**
 * @polaris/interfaces — the ONLY typed seam between the two owners.
 *
 * Owner A — Brain & Shell (`app/`, `agent/`): Tauri shell, hotkey, voice pipeline,
 * agent core, approval UI.
 * Owner B — Chain (`stellar/`, `contracts/`): anchor client, protocol integration,
 * Soroban contracts, signing service.
 *
 * Source of truth: `docs/interfaces.md`. Change these types only by agreement in PR
 * review, and keep the Rust mirror (`app/src-tauri/src/interfaces.rs`,
 * `app/src-tauri/src/events.rs`) in sync in the same PR.
 */

/* ------------------------------------------------------------------ *
 * 1. Intent — structured value-moving request
 * ------------------------------------------------------------------ */

export type IntentKind =
  | "deposit"
  | "swap"
  | "send"
  | "guard_policy"
  | "raw_tx"
  | "withdraw"
  | "set_rule"
  | "schedule"
  | "cancel_schedule"
  | "p2p_offer";

export interface Intent {
  kind: IntentKind;
  /** e.g. "USDC" (testnet) */
  asset: string;
  /** Decimal string, never float. */
  amount: string;
  /** Address or alias. */
  recipient?: string;
  /** Alias book entry, e.g. "ada". */
  alias?: string;
  memo?: string;
  /** Voice transcript excerpt that produced it. */
  source?: string;
}

/* ------------------------------------------------------------------ *
 * 1b. Rules, schedules & guard errors (autonomous wallet)
 *     See docs/interfaces.md "Rules, schedules & the guard contract".
 * ------------------------------------------------------------------ */

/**
 * Mirror of the on-chain rule stored by `polaris_guard`.
 * All amounts are decimal strings (never floats) in the asset's display units.
 */
export interface Rule {
  /** Executor payments up to this amount run without Touch ID. */
  autoApproveLimit: string;
  /** Hard cap for a single payment (applies to owner and executor). */
  perTxLimit: string;
  /** Hard cap for the sum of payments in one day. */
  dailyLimit: string;
  /** Asset codes/contract ids the guard may move, e.g. ["USDC"]. */
  allowedAssets: string[];
  /** When true, executor payments may only go to aliased (known) recipients. */
  knownRecipientsOnly: boolean;
}

/**
 * What the LLM produces from speech BEFORE read-back and Touch ID.
 * Optional fields are filled with defaults (or asked about) by the agent core.
 */
export interface RuleDraft {
  /** Decimal string, e.g. "10" for "no approval needed under 10 USDC". */
  autoApproveLimit: string;
  perTxLimit?: string;
  dailyLimit?: string;
  /** Asset codes, e.g. ["USDC"]. */
  assets?: string[];
  knownRecipientsOnly?: boolean;
  /** Voice transcript excerpt that produced it. */
  source?: string;
}

/** Mirror of an on-chain scheduled payment (`create_schedule` / `get_schedule`). */
export interface Schedule {
  /** On-chain schedule id. */
  id: string;
  /** Owner (the user's G account). */
  owner: string;
  /** Resolved recipient address. */
  to: string;
  asset: string;
  /** Decimal string, never float. */
  amount: string;
  /** Unix seconds of the next run that is due. */
  nextRunAt: number;
  /** Seconds between runs; absent = one-shot. */
  intervalSecs?: number;
  /** Runs still to execute. */
  runsRemaining: number;
  active: boolean;
}

/** What the LLM produces from speech for "do X at time T" before read-back and Touch ID. */
export interface ScheduleDraft {
  /** Alias or address. */
  to: string;
  asset: string;
  /** Decimal string, never float. */
  amount: string;
  /** ISO-8601 with timezone, e.g. "2026-09-20T09:00:00+03:00". */
  firstRunAt: string;
  /** Seconds between runs; omit = one-shot. */
  intervalSecs?: number;
  /** Total number of runs (1 for a one-shot). */
  runs: number;
  /** Voice transcript excerpt that produced it. */
  source?: string;
}

/**
 * Typed reasons the guard contract can reject an action (string names only).
 * NOTE: the exact on-chain error codes come from the contract (worker W1,
 * `contracts/`); this union may be aligned with them later.
 */
export type GuardError =
  | "NeedsOwnerApproval"
  | "PerTxLimitExceeded"
  | "DailyLimitExceeded"
  | "AssetNotAllowed"
  | "RecipientNotKnown"
  | "ExecutorRevoked"
  | "AllowanceMissing"
  | "NotDue";

/* ------------------------------------------------------------------ *
 * 2. Chain tools exposed to the agent
 * ------------------------------------------------------------------ */

/**
 * Every tool returns an **unsigned XDR** plus a human-readable summary decoded from
 * that XDR — the summary is exactly what the approval card renders.
 */
export interface ChainToolResult {
  /** base64 XDR, unsigned */
  unsignedXdr: string;
  summary: {
    /** e.g. "Swap 500 USDC -> XLM" */
    title: string;
    /** decoded operation details */
    lines: string[];
    /** Stellar Lab / Stellar.Expert scene */
    explorerUrl?: string;
    estimatedFee: string;
  };
}

/** Owner B implements; Owner A's agent core calls these. */
export type ChainTool = (intent: Intent) => Promise<ChainToolResult>;

/* ------------------------------------------------------------------ *
 * 3. Signing service — Touch ID gated
 * ------------------------------------------------------------------ */

/**
 * Rust-side service exposed to the webview via a Tauri command.
 * Owner A owns the Touch ID approval flow; Owner B consumes signed envelopes.
 */
export interface SigningService {
  /** Rejects unless Touch ID approval succeeded for this `payloadHash`. */
  sign(payloadHash: string): Promise<{ signedXdr: string }>;
}

/* ------------------------------------------------------------------ *
 * 4. Status / event stream for the UI
 * ------------------------------------------------------------------ */

/** Tauri event channel name; the Rust side emits on the same channel. */
export const POLARIS_EVENT_NAME = "polaris-event";

export type HotkeyState = "down" | "up";
export type AgentStage = "thinking" | "tool_call" | "awaiting_approval" | "done";

export type PolarisEvent =
  | { type: "hotkey"; state: HotkeyState }
  | { type: "transcript"; text: string; final: boolean }
  | { type: "agent_status"; stage: AgentStage }
  | {
      type: "approval_request";
      intent: Intent;
      summary: ChainToolResult["summary"];
      payloadHash: string;
    }
  | { type: "approval_result"; payloadHash: string; approved: boolean }
  | { type: "tx_submitted"; hash: string; explorerUrl: string }
  | { type: "error"; message: string }
  /** Plain-English narration of one anchor step (the agent speaks it). */
  | { type: "anchor_step"; step: string; what: string; why: string }
  /** The guard rejected an executor action; the UI must ask for Touch ID. */
  | { type: "approval_required"; reason: GuardError; intent: Intent };

/**
 * Runtime guard for events arriving from Rust as `unknown`.
 * Cheap structural check: the wire contract is `{ type: string, ... }`.
 */
export function isPolarisEvent(value: unknown): value is PolarisEvent {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { type?: unknown }).type === "string"
  );
}

/* ------------------------------------------------------------------ *
 * 5. App metadata (Tauri `app_info` command)
 * ------------------------------------------------------------------ */

export interface AppInfo {
  name: string;
  version: string;
  /** e.g. "testnet" */
  network: string;
  tauriVersion: string;
}