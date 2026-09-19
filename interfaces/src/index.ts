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

export type IntentKind = "deposit" | "swap" | "send" | "guard_policy" | "raw_tx";

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
  | { type: "error"; message: string };

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